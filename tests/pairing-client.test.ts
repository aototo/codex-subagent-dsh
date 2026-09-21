import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PairingClient, type PairingDependencies } from '../src/pairing-client.js';
import { loadCredential, saveCredential } from '../src/auth.js';
import type { BridgeConfig } from '../src/config.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, deps: PairingDependencies = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'pairing-client-'));
  let origin = '';
  const calls: { path: string; body: Record<string, unknown>; cookie?: string; fetchMode?: string }[] = [];
  const state = { claim: 'pending', cookie: 'dsh-auth=SECRET_COOKIE', beginCount: 0, opened: 0, badAuth: false, redirect: false, unsupported: false, fallbackStatus: 0, badUrl: false, corrupt: false, large: false, clock: Date.now() };
  let claimHash = '';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url!, body, cookie: req.headers.cookie, fetchMode: req.headers['sec-fetch-mode'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (state.redirect) { res.writeHead(302, { location: 'https://example.com/secret' }).end(); return; }
    if (state.corrupt) { res.end('SECRET_BAD_JSON'); return; }
    if (state.large) { res.end(JSON.stringify('X'.repeat(70000))); return; }
    if (req.url?.endsWith('/capabilities')) {
      if (state.fallbackStatus) { res.writeHead(state.fallbackStatus).end(); return; }
      if (state.unsupported) { res.writeHead(404).end(); return; }
      res.end(JSON.stringify({ protocol: 1, pairing: true })); return;
    }
    if (req.url?.endsWith('/begin')) {
      state.beginCount++; claimHash = body.claimHash;
      res.end(JSON.stringify({ protocol: 1, pairingId: '0123456789abcdef0123456789abcdef', matchingCode: 'ABCD-1234', expiresAt: state.clock + 300000, confirmationUrl: state.badUrl ? 'http://evil.example/SECRET' : `${origin}/codex-pairing/v1/confirm?id=0123456789abcdef0123456789abcdef` })); return;
    }
    if (req.url?.endsWith('/claim') || req.url?.endsWith('/cancel')) {
      assert.equal(createHash('sha256').update(body.claimSecret).digest('hex'), claimHash);
      if (req.url?.endsWith('/cancel')) state.claim = 'cancelled';
      res.end(JSON.stringify({ state: state.claim, ...(state.claim === 'claimed' ? { cookie: state.cookie } : {}) })); return;
    }
    if (req.url === '/api/session/list') {
      res.end(JSON.stringify({ sessions: Array.from({ length: 1000 }, () => ({ title: 'X'.repeat(1000) })) })); return;
    }
    if (req.url === '/codex-pairing/v1/verify') {
      assert.deepEqual(body, {});
      assert.equal(req.headers.origin, origin);
      if (state.badAuth) { res.writeHead(401).end(); return; }
      res.end(JSON.stringify({ protocol: 1, authenticated: true })); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const config: BridgeConfig = { origin, stateDir, rpcTimeoutMs: 1000, taskTimeoutMs: 5000, maxWaitMs: 1000 };
  const client = new PairingClient(config, { now: () => state.clock, openBrowser: async () => { state.opened++; return true; }, ...deps });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(stateDir, { recursive: true, force: true }); });
  return { client, config, state, calls };
}

test('pairing capability is anonymous and never creates requests or credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).available, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.cookie, undefined);
  assert.equal(f.calls[0]?.fetchMode, undefined);
  assert.equal(await loadCredential(f.config), undefined);
});

test('start is concurrent-idempotent, opens only once, check saves verified private credential', async (t) => {
  const f = await fixture(t);
  const values = await Promise.all([f.client.connect('start'), f.client.connect('start')]);
  assert.deepEqual(values[0], values[1]);
  assert.equal(f.state.beginCount, 1); assert.equal(f.state.opened, 1);
  assert.equal((await f.client.connect('check')).state, 'pending');
  assert.equal(await loadCredential(f.config), undefined);
  f.state.claim = 'claimed';
  const result = await f.client.connect('check');
  assert.deepEqual(result, { state: 'ready', connected: true });
  assert.equal((await loadCredential(f.config))?.cookie, f.state.cookie);
  const directory = join(f.config.stateDir, 'credentials');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, (await readdir(directory))[0]!))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(values).includes('claimSecret'));
  assert.ok(!JSON.stringify(result).includes(f.state.cookie));
  assert.equal((await f.client.connect('start')).state, 'ready');
  assert.equal(f.state.beginCount, 1);
});

for (const terminal of ['rejected', 'expired', 'cancelled']) test(`pairing ${terminal} never persists credentials`, async (t) => {
  const f = await fixture(t); await f.client.connect('start', false); f.state.claim = terminal;
  assert.equal((await f.client.connect('check')).state, terminal);
  assert.equal(await loadCredential(f.config), undefined);
  assert.equal((await f.client.connect('check')).state, 'no_pending_pairing');
});

test('cancel and shutdown prove ownership and clear local pending', async (t) => {
  const f = await fixture(t); await f.client.connect('start', false); await f.client.shutdown();
  assert.equal(f.state.claim, 'cancelled');
  assert.equal((await f.client.connect('check')).state, 'no_pending_pairing');
});

test('local timeout and restarted process never restore or automatically recreate pairing', async (t) => {
  const f = await fixture(t); await f.client.connect('start', false);
  const restarted = new PairingClient(f.config);
  assert.equal((await restarted.connect('check')).state, 'no_pending_pairing');
  f.state.clock += 300001;
  assert.equal((await f.client.connect('check')).state, 'expired'); assert.equal(f.state.beginCount, 1);
});

test('browser opening failure returns safe confirmation URL', async (t) => {
  const f = await fixture(t, { openBrowser: async () => { throw new Error('SECRET'); } });
  const result = await f.client.connect('start');
  assert.equal(result.state, 'pending'); assert.equal(result.browserOpened, false); assert.ok(result.confirmationUrl?.startsWith(f.config.origin));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});

for (const flag of ['badUrl', 'redirect', 'corrupt', 'large'] as const) test(`rejects ${flag} without opening browser or exposing remote content`, async (t) => {
  const f = await fixture(t); f.state[flag] = true;
  const result = await f.client.connect('start');
  assert.equal(result.state, flag === 'badUrl' ? 'invalid_response' : 'pairing_unsupported'); assert.equal(f.state.opened, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET')); assert.equal(await loadCredential(f.config), undefined);
});

test('missing companion is distinct from authentication failure', async (t) => {
  const f = await fixture(t); f.state.unsupported = true;
  assert.equal((await f.client.connect('start')).state, 'pairing_unsupported'); assert.equal(f.state.beginCount, 0);
});

test('claimed cookie must authenticate before it can be saved', async (t) => {
  const f = await fixture(t); await f.client.connect('start', false); f.state.claim = 'claimed'; f.state.badAuth = true;
  assert.equal((await f.client.connect('check')).state, 'authentication_required');
  assert.equal(await loadCredential(f.config), undefined);
  assert.equal((await f.client.connect('check')).state, 'no_pending_pairing');
});

test('failed credential write yields explicit fresh-pairing instruction with no secret', async (t) => {
  const f = await fixture(t, { saveCredential: async () => { throw new Error('SECRET_COOKIE'); } });
  await f.client.connect('start', false); f.state.claim = 'claimed';
  const result = await f.client.connect('check');
  assert.equal(result.state, 'credential_save_failed'); assert.ok(result.nextAction?.includes('new pairing')); assert.ok(!JSON.stringify(result).includes('SECRET_COOKIE'));
  assert.equal(await loadCredential(f.config), undefined);
});

test('expired old credential permits pairing while valid credential avoids capability/begin', async (t) => {
  const f = await fixture(t);
  await saveCredential(f.config, { version: 1, origin: f.config.origin, cookie: 'old=credential', connectedAt: Date.now() });
  f.state.badAuth = true;
  assert.equal((await f.client.connect('start', false)).state, 'pending');
  assert.equal(f.state.beginCount, 1);
});

test('transport exceptions and one-shot claim failure never leak secrets or auto-retry', async (t) => {
  let fail = false;
  const f = await fixture(t, { fetch: async (...args) => { if (fail) throw new Error('PRIVATE_CLAIM_SECRET'); return fetch(...args); } });
  await f.client.connect('start', false); fail = true;
  const result = await f.client.connect('check');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CLAIM_SECRET'));
  assert.equal((await f.client.connect('check')).state, 'no_pending_pairing');
  assert.equal(f.state.beginCount, 1);
});

for (const cookie of ['', 'bad\r\ncookie=value', 'x=' + 'A'.repeat(17000)]) test('malformed claimed cookie is never sent to native API or saved', async (t) => {
  const f = await fixture(t); await f.client.connect('start', false);
  f.state.claim = 'claimed'; f.state.cookie = cookie;
  assert.equal((await f.client.connect('check')).state, 'pairing_already_claimed');
  assert.equal(f.calls.filter((c) => c.path === '/api/session/list').length, 0);
  assert.equal(await loadCredential(f.config), undefined);
});

test('bounded timeout returns safe state with no automatic retry', async (t) => {
  const f = await fixture(t, { fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT_BODY')), { once: true });
  }) });
  const result = await f.client.status();
  assert.equal(result.state, 'connection_timeout');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TIMEOUT_BODY'));
});

test('credential write rejects mismatched origin before creating files', async (t) => {
  const f = await fixture(t);
  await assert.rejects(saveCredential(f.config, { version: 1, origin: 'http://127.0.0.1:1', cookie: 'auth=value', connectedAt: 1 }));
  assert.deepEqual(await readdir(f.config.stateDir), []);
});


test('large session history is never read and repeated check returns verified ready', async (t) => {
  const f = await fixture(t);
  await f.client.connect('start', false); f.state.claim = 'claimed';
  assert.equal((await f.client.connect('check')).state, 'ready');
  assert.deepEqual(await f.client.connect('check'), { state: 'ready', connected: true });
  assert.equal(f.calls.filter((c) => c.path === '/api/session/list').length, 0);
  assert.equal(f.calls.filter((c) => c.path === '/codex-pairing/v1/verify').length, 2);
  const restarted = new PairingClient(f.config);
  assert.deepEqual(await restarted.connect('check'), { state: 'ready', connected: true });
});

test('cancel without pending leaves connected credentials intact without claiming disconnection', async (t) => {
  const f = await fixture(t);
  await saveCredential(f.config, { version: 1, origin: f.config.origin, cookie: 'auth=keep', connectedAt: 1 });
  const result = await f.client.connect('cancel');
  assert.equal(result.state, 'no_pending_pairing');
  assert.equal(result.connected, undefined);
  assert.equal((await loadCredential(f.config))?.cookie, 'auth=keep');
  assert.deepEqual(await f.client.connect('check'), { state: 'ready', connected: true });
});


test('legacy DSH SPA 401 fallback is reported as missing pairing companion', async (t) => {
  const f = await fixture(t); f.state.fallbackStatus = 401;
  const result = await f.client.status();
  assert.equal(result.state, 'pairing_unsupported'); assert.equal(result.available, false);
  assert.match(result.nextAction!, /Install or upgrade/);
});

test('403 capability rejection remains access failure, not a missing companion', async (t) => {
  const f = await fixture(t); f.state.fallbackStatus = 403;
  const result = await f.client.status();
  assert.equal(result.state, 'pairing_forbidden'); assert.equal(result.available, false);
  assert.match(result.nextAction!, /origin or access/);
});
