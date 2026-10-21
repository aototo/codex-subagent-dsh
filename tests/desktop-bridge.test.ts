import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const base = new URL('../src/desktop-bridge/', import.meta.url);
const { DesktopGrant } = await import(new URL('grant.mjs', base).href);
const { apply } = await import(new URL('index.mjs', base).href);
const origin = 'http://127.0.0.1:45678';
const cookie = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url') + '=test_session';

test('desktop bridge requires one-shot explicit approval; denial and expiry preserve existing data', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desktop-grant-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = Date.now();
  const grant = new DesktopGrant({ origin, stateDir, dshHome: '/test/.dsh', now: () => now });
  assert.throws(() => grant.issue(''), /authentication/);
  const denied = grant.issue(cookie);
  assert.deepEqual(grant.deny(denied.csrf, cookie), { denied: true, granted: false });
  assert.deepEqual(await readdir(stateDir), []);
  await assert.rejects(grant.approve(denied.csrf, cookie));
  const expired = grant.issue(cookie); now += 300_001;
  await assert.rejects(grant.approve(expired.csrf, cookie));
  const challenge = grant.issue(cookie);
  assert.equal(JSON.stringify(challenge).includes('test_session'), false);
  await assert.rejects(grant.approve(challenge.csrf, cookie.replace('test_session', 'other')));
  await grant.approve(challenge.csrf, cookie);
  const metadataPath = join(stateDir, 'codex-desktop', 'desktop-connection.json');
  const credentialPath = join(stateDir, 'codex-desktop', 'credentials', createHash('sha256').update(origin).digest('hex') + '.json');
  const before = await readFile(credentialPath, 'utf8');
  assert.equal(JSON.parse(before).cookie, cookie);
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'codex-desktop', 'credentials'))).mode & 0o777, 0o700);
  assert.equal((await readFile(metadataPath, 'utf8')).includes('test_session'), false);
  grant.deny(grant.issue(cookie).csrf, cookie);
  assert.equal(await readFile(credentialPath, 'utf8'), before);
  const other = { ...JSON.parse(await readFile(metadataPath, 'utf8')), instanceId: 'another-instance' };
  await writeFile(metadataPath, JSON.stringify(other));
  await grant.close();
  assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).instanceId, 'another-instance');
  assert.equal(await readFile(credentialPath, 'utf8'), before);
});

test('desktop bridge close prevents new authorization and preserves shared discovery and credentials', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desktop-grant-close-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const grant = new DesktopGrant({ origin, stateDir, dshHome: '/test/.dsh' });
  await grant.approve(grant.issue(cookie).csrf, cookie);
  const discoveryBeforeClose = await readFile(join(stateDir, 'codex-desktop', 'desktop-connection.json'), 'utf8');
  await grant.close();
  assert.equal(await readFile(join(stateDir, 'codex-desktop', 'desktop-connection.json'), 'utf8'), discoveryBeforeClose);
  assert.equal((await readdir(join(stateDir, 'codex-desktop', 'credentials'))).length, 1);
  assert.throws(() => grant.issue(cookie), /stopped/);
  const racing = new DesktopGrant({ origin, stateDir, dshHome: '/test/.dsh' });
  const pending = racing.approve(racing.issue(cookie).csrf, cookie);
  const closing = racing.close();
  await assert.rejects(pending, /stopped/);
  await closing;
  assert.equal(await readFile(join(stateDir, 'codex-desktop', 'desktop-connection.json'), 'utf8'), discoveryBeforeClose);
  assert.equal((await readdir(join(stateDir, 'codex-desktop', 'credentials'))).length, 1);
});

test('desktop host routes reject unauthenticated, non-loopback, cross-origin, and invalid writes', async () => {
  const routes = new Map<string, Function>();
  const scope = {
    webServer: { port: 45678, register: (route: { path: string; handler: Function }) => { routes.set(route.path, route.handler); return () => {}; } },
    connection: { requestRejection: (req: any) => req.headers.cookie ? undefined : 401 },
    effect: (callback: Function) => callback(),
  };
  apply({ inject: (_: unknown, callback: Function) => callback(scope) });
  assert.deepEqual([...routes.keys()].map(v => v.split('/').at(-1)), ['status', 'approve', 'deny']);
  const call = async (operation: string, method: string, headers: object, remote = '127.0.0.1', body = '{}') => {
    const req = Object.assign(Readable.from([body]), { method, headers, socket: { remoteAddress: remote } });
    const res = { statusCode: 200, data: '', setHeader() {}, end(value: string) { this.data = value; } };
    await routes.get('/codex-desktop-bridge/v1/' + operation)!(req, res);
    return res;
  };
  assert.equal((await call('status', 'GET', {})).statusCode, 401);
  assert.equal((await call('status', 'GET', { cookie }, '8.8.8.8')).statusCode, 403);
  assert.equal((await call('status', 'GET', { cookie, origin: 'http://attacker.invalid' })).statusCode, 403);
  assert.equal((await call('approve', 'GET', { cookie })).statusCode, 405);
  assert.equal((await call('approve', 'POST', { cookie })).statusCode, 415);
  assert.equal((await call('approve', 'POST', { cookie, 'content-type': 'application/json' })).statusCode, 400);
  const response = await call('status', 'GET', { cookie });
  assert.equal(response.statusCode, 200);
  assert.equal(response.data.includes('test_session'), false);
});


test('same-origin legacy grants and Codex desktop grants coexist without overwriting each other', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'desktop-coexist-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const credentialName = createHash('sha256').update(origin).digest('hex') + '.json';
  const legacyPaths = [join(stateDir, 'desktop-connection.json'), join(stateDir, 'credentials', credentialName)];
  const desktopPaths = [join(stateDir, 'codex-desktop', 'desktop-connection.json'), join(stateDir, 'codex-desktop', 'credentials', credentialName)];
  const snapshot = (paths: string[]) => Promise.all(paths.map(file => readFile(file, 'utf8')));
  // Fixture follows the installed legacy bridge file contract, including no consumer field.
  const legacyPublish = async (instanceId: string) => {
    await mkdir(join(stateDir, 'credentials'), { recursive: true, mode: 0o700 });
    await writeFile(legacyPaths[0], JSON.stringify({ version: 1, origin, instanceId, pid: process.pid, dshHome: '/test/.dsh', approvedAt: new Date().toISOString() }), { mode: 0o600 });
    await writeFile(legacyPaths[1], JSON.stringify({ version: 1, origin, cookie: cookie.replace('test_session', instanceId), connectedAt: Date.now() }), { mode: 0o600 });
  };
  await legacyPublish('legacy-first');
  const legacyBefore = await snapshot(legacyPaths);
  const grant = new DesktopGrant({ origin, stateDir, dshHome: '/test/.dsh' });
  grant.deny(grant.issue(cookie).csrf, cookie);
  assert.deepEqual(await snapshot(legacyPaths), legacyBefore);
  await assert.rejects(readFile(desktopPaths[0]), { code: 'ENOENT' });
  await grant.approve(grant.issue(cookie).csrf, cookie);
  assert.deepEqual(await snapshot(legacyPaths), legacyBefore);
  const desktopBefore = await snapshot(desktopPaths);
  assert.equal(JSON.parse(desktopBefore[0]).consumer, 'codex-subagent-dsh');
  await legacyPublish('legacy-replaced');
  assert.deepEqual(await snapshot(desktopPaths), desktopBefore);
  const legacyAfter = await snapshot(legacyPaths);
  grant.deny(grant.issue(cookie).csrf, cookie);
  await grant.close();
  assert.deepEqual(await snapshot(desktopPaths), desktopBefore);
  assert.deepEqual(await snapshot(legacyPaths), legacyAfter);
  // A new Codex instance replaces only its private metadata, at the same server origin.
  const replacement = new DesktopGrant({ origin, stateDir, dshHome: '/test/.dsh' });
  await replacement.approve(replacement.issue(cookie).csrf, cookie);
  assert.notEqual(JSON.parse(await readFile(desktopPaths[0], 'utf8')).instanceId, grant.instanceId);
  assert.deepEqual(await snapshot(legacyPaths), legacyAfter);
  await replacement.close();
});
