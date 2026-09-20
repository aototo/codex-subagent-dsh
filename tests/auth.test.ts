import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connect, disconnect, DshAuthError, loadCredential } from '../src/auth.js';
import { loadConfig, type BridgeConfig } from '../src/config.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function config(origin: string, stateDir: string, timeout = 500): BridgeConfig {
  return { origin, stateDir, rpcTimeoutMs: timeout, taskTimeoutMs: 900_000, maxWaitMs: 20_000 };
}

test('loadConfig applies defaults and accepts only a canonical loopback origin', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.origin, 'http://127.0.0.1:3080');
  assert.equal(defaults.rpcTimeoutMs, 10_000);
  assert.equal(defaults.taskTimeoutMs, 900_000);
  assert.equal(defaults.maxWaitMs, 20_000);

  const configured = loadConfig({ DSH_SUBAGENT_URL: 'http://127.2.3.4:4000/', DSH_SUBAGENT_HOME: './state' });
  assert.equal(configured.origin, 'http://127.2.3.4:4000');
  assert.equal(configured.stateDir, join(process.cwd(), 'state'));

  for (const value of [
    'https://example.com',
    'http://0.0.0.0:3080',
    'http://127.0.0.1:3080/path',
    'http://127.0.0.1:3080/?token=secret',
    'http://user:pass@127.0.0.1:3080',
  ]) {
    assert.throws(() => loadConfig({ DSH_SUBAGENT_URL: value }), /loopback HTTP/);
  }
});

test('connect exchanges a same-origin launch token and atomically stores a private per-origin cookie', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auth-test-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(stateDir, { recursive: true, force: true })));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/?token=current-token') {
      response.writeHead(303, {
        location: '/',
        'set-cookie': 'dsh_session=signed-value; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict',
      });
      response.end();
      return;
    }
    response.writeHead(401).end();
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const bridge = config(origin, stateDir);

  const credential = await connect(`${origin}/?token=current-token`, bridge);
  assert.equal(credential.origin, origin);
  assert.equal(credential.cookie, 'dsh_session=signed-value');
  assert.deepEqual(await loadCredential(bridge), credential);
  assert.deepEqual(requests, ['/?token=current-token']);

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  const credentialsDir = join(stateDir, 'credentials');
  assert.equal((await stat(credentialsDir)).mode & 0o777, 0o700);
  const files = await readdir(credentialsDir);
  assert.equal(files.length, 1);
  assert.equal((await stat(join(credentialsDir, files[0]!))).mode & 0o777, 0o600);

  await chmod(join(credentialsDir, files[0]!), 0o644);
  assert.equal((await loadCredential(bridge))?.cookie, 'dsh_session=signed-value');
  assert.equal((await stat(join(credentialsDir, files[0]!))).mode & 0o777, 0o600);

  await disconnect(bridge);
  assert.equal(await loadCredential(bridge), undefined);
});

test('connect blocks cross-origin redirects without forwarding the token or replacing a credential', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auth-redirect-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(stateDir, { recursive: true, force: true })));
  let externalHits = 0;
  const external = createServer((_request, response) => {
    externalHits += 1;
    response.writeHead(200).end();
  });
  const externalOrigin = await listen(external);
  t.after(() => close(external));

  let redirectOutside = false;
  const server = createServer((request, response) => {
    if (request.url === '/?token=first') {
      response.writeHead(303, { location: '/', 'set-cookie': 'auth=first; Path=/; HttpOnly' }).end();
      return;
    }
    if (request.url === '/?token=second' && redirectOutside) {
      response.writeHead(303, { location: `${externalOrigin}/steal`, 'set-cookie': 'auth=second; Path=/; HttpOnly' }).end();
      return;
    }
    response.writeHead(401).end();
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const bridge = config(origin, stateDir);
  await connect(`${origin}/?token=first`, bridge);
  redirectOutside = true;

  await assert.rejects(
    connect(`${origin}/?token=second`, bridge),
    (error: unknown) => error instanceof DshAuthError && error.code === 'AUTH_REDIRECT_BLOCKED' && !error.message.includes('second'),
  );
  assert.equal(externalHits, 0);
  assert.equal((await loadCredential(bridge))?.cookie, 'auth=first');
});

test('connect rejects foreign, malformed, and stale login URLs without disclosing tokens', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auth-negative-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(stateDir, { recursive: true, force: true })));
  const server = createServer((_request, response) => response.writeHead(401).end());
  const origin = await listen(server);
  t.after(() => close(server));
  const bridge = config(origin, stateDir);

  await assert.rejects(connect('https://example.com/?token=do-not-leak', bridge), (error: unknown) => {
    return error instanceof DshAuthError && error.code === 'LOGIN_URL_INVALID' && !error.message.includes('do-not-leak');
  });
  await assert.rejects(connect(`${origin}/path?token=do-not-leak`, bridge), { code: 'LOGIN_URL_INVALID' });
  await assert.rejects(connect(`${origin}/?token=do-not-leak&extra=1`, bridge), { code: 'LOGIN_URL_INVALID' });
  await assert.rejects(connect(`${origin}/?token=do-not-leak`, bridge), (error: unknown) => {
    return error instanceof DshAuthError && error.code === 'AUTH_REJECTED' && !error.message.includes('do-not-leak');
  });
  assert.equal(await loadCredential(bridge), undefined);
  await assert.rejects(
    connect('https://example.com/?token=do-not-leak', { ...bridge, origin: 'https://example.com' }),
    { code: 'ORIGIN_INVALID' },
  );
});

test('credentials are separated by exact origin', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auth-origins-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(stateDir, { recursive: true, force: true })));
  const makeServer = (cookie: string) => createServer((request, response) => {
    if (request.url === '/?token=token') response.writeHead(303, { location: '/', 'set-cookie': `${cookie}; Path=/` }).end();
    else response.writeHead(401).end();
  });
  const first = makeServer('one=value-1');
  const second = makeServer('two=value-2');
  const firstOrigin = await listen(first);
  const secondOrigin = await listen(second);
  t.after(() => Promise.all([close(first), close(second)]));

  const firstConfig = config(firstOrigin, stateDir);
  const secondConfig = config(secondOrigin, stateDir);
  await connect(`${firstOrigin}/?token=token`, firstConfig);
  await connect(`${secondOrigin}/?token=token`, secondConfig);
  assert.equal((await loadCredential(firstConfig))?.cookie, 'one=value-1');
  assert.equal((await loadCredential(secondConfig))?.cookie, 'two=value-2');
  assert.equal((await readdir(join(stateDir, 'credentials'))).length, 2);
});

test('loadCredential rejects a symlink without changing its target permissions', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auth-symlink-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(stateDir, { recursive: true, force: true })));
  const server = createServer((request, response) => {
    if (request.url === '/?token=token') response.writeHead(303, { location: '/', 'set-cookie': 'auth=value; Path=/' }).end();
    else response.writeHead(401).end();
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const bridge = config(origin, stateDir);
  await connect(`${origin}/?token=token`, bridge);
  const directory = join(stateDir, 'credentials');
  const [credentialFile] = await readdir(directory);
  assert(credentialFile);
  const original = join(directory, `${credentialFile}.original`);
  await rename(join(directory, credentialFile), original);
  const outside = join(stateDir, 'outside.json');
  await writeFile(outside, '{}', { mode: 0o644 });
  await symlink(outside, join(directory, credentialFile));

  await assert.rejects(loadCredential(bridge), { code: 'CREDENTIAL_INVALID' });
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
});
