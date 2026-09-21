#!/usr/bin/env node
// Backend-only isolated real-DSH pairing feasibility gate. Never reads user credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.env.DSH_INSTALL_ROOT;
if (!root) throw Error('DSH_INSTALL_ROOT required');
const bin = join(root, 'lib/bin.js');
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/dsh-pairing-fixture');
const profile = 'codex-pairing-gate';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let home, child;
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGINT');
    for (let i = 0; i < 40 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  if (home) await rm(home, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(1)); });
const globalTimeout = setTimeout(() => { void stop().finally(() => process.exit(1)); }, 90_000).unref();
try {
  home = await mkdtemp(join(tmpdir(), 'codex-dsh-pairing-'));
  await chmod(home, 0o700);
  const env = { ...process.env, DSH_HOME: home };
  function run(args) { const p = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 20_000 }); assert.equal(p.status, 0, 'isolated setup failed (output intentionally suppressed)'); }
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config']);
  run(['plugin', '--profile', profile, 'add', '-w', fixture]);
  child = spawn(process.execPath, [bin, '--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-200000); });
  let login;
  for (let i = 0; i < 400; i++) { login = /^dsh web: (http:\/\/[^\s]+)$/m.exec(output)?.[1]; if (login) break; assert.equal(child.exitCode, null, 'isolated DSH exited'); await sleep(50); }
  assert(login, 'isolated startup timed out');
  const origin = new URL(login).origin;
  const fetchBounded = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const logged = await fetchBounded(login, { redirect: 'manual' });
  assert.equal(logged.status, 303);
  const cookie = logged.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie);
  const post = (path, body, headers = {}) => fetchBounded(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const start = async () => { const r = await post('/pairing-fixture/start', {}); assert.equal(r.status, 200); return r.json(); };
  const poll = pairing => post('/pairing-fixture/poll', pairing);
  const approve = (pairing, headers = { cookie, origin }) => post('/api/pairing-fixture/approve', { id: pairing.id }, headers);
  assert.equal((await fetchBounded(origin + '/pairing-fixture')).status, 200);
  const pair = await start();
  assert.equal((await poll(pair)).status, 202);
  assert.equal((await poll({ ...pair, pollSecret: '0'.repeat(64) })).status, 403);
  assert.equal((await approve(pair, { origin })).status, 401);
  assert.equal((await approve(pair, { cookie, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await approve(pair, { cookie })).status, 403);
  assert.equal((await approve(pair, { cookie, origin: origin.replace('http:', 'https:') })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(origin + '/api/pairing-fixture/approve', { method: 'POST', headers: { cookie, origin, host: 'evil.invalid', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(5000, () => req.destroy(new Error('host probe timeout'))); req.on('error', reject); req.end(JSON.stringify({ id: pair.id }));
  });
  assert.equal(hostStatus, 403);
  assert.equal((await approve(pair, { cookie: `unrelated=must-not-transfer; ${cookie}`, origin })).status, 200);
  assert.equal((await approve(pair)).status, 409);
  const claimed = await poll(pair); assert.equal(claimed.status, 200);
  const received = (await claimed.json()).cookie;
  assert(received === cookie, 'transferred credential mismatch');
  assert.equal((await poll(pair)).status, 403);
  // A native DSH protected resource, not the fixture, validates the transferred credential.
  assert.equal((await fetchBounded(origin + '/', { headers: { cookie: received } })).status, 200);
  assert.equal((await fetchBounded(origin + '/')).status, 401);
  const native = await post('/api/session/list', { type: 'client-request', rpcId: 'pairing-probe', method: 'session/list', payload: { args: { _request: {} } } }, { cookie: received, origin });
  assert.equal(native.status, 200);
  const nativeResult = await native.json();
  assert.equal(nativeResult.result?.ok, true, 'native session/list failed');
  const rejected = await start();
  assert.equal((await post('/api/pairing-fixture/reject', { id: rejected.id }, { cookie, origin })).status, 200);
  assert.equal((await poll(rejected)).status, 410);
  assert.equal((await approve(rejected)).status, 409);
  const expired = await start(); await sleep(1400);
  assert.equal((await approve(expired)).status, 409);
  assert.equal((await poll(expired)).status, 403);
  assert.equal((await post('/pairing-fixture/start', {}, { origin })).status, 403);
  const bounded = await start();
  for (let i = 0; i < 10; i++) assert.equal((await poll(bounded)).status, 202);
  assert.equal((await poll(bounded)).status, 429);
  const full = await Promise.all([start(), start(), start(), start()]);
  assert.equal(full.length, 4);
  assert.equal((await post('/pairing-fixture/start', {})).status, 429);
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  console.log(JSON.stringify({ ok: true, dsh: version, backendOnly: true, browserE2E: false, isolatedHome: true, noPaidModel: true, checks: ['public page', 'pending does not release cookie', 'wrong poll secret denied', 'native unauthenticated 401', 'cross-origin 403', 'missing origin 403', 'untrusted host 403', 'explicit approval', 'approve replay denied', 'one-time claim', 'native protected index and session/list accept transferred cookie', 'rejected denied', 'expired denied', 'browser-origin initiation denied', 'same host wrong scheme denied', 'unrelated cookie excluded', 'poll and pending limits'] }, null, 2));
} catch (error) {
  // Assertions may contain only HTTP status values; never include response bodies or cookies.
  console.error(error instanceof Error ? error.stack : 'pairing probe failed');
  process.exitCode = 1;
} finally { clearTimeout(globalTimeout); await stop(); }
