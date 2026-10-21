#!/usr/bin/env node
// Backend-only isolated probe of the runtime shipped in a Desktop app. No user credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = process.env.DSH_DESKTOP_APP;
if (!app) throw Error('Set DSH_DESKTOP_APP to the installed .app directory. This probe never launches its UI.');
const resource = path.join(app, 'Contents/Resources');
const archive = path.join(resource, 'app.asar');
const node = path.join(resource, 'runtime/primary-runtime/dependencies/node/bin/node');
const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/codex-subagent-dsh/dsh-desktop-bridge');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let temporary, child;
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGTERM');
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(1)); });
const timeout = setTimeout(() => { void stop().finally(() => process.exit(1)); }, 120_000).unref();
// Extract only the bundled dsh runtime; reject path traversal and unsupported archive links.
async function extractRuntime(target) {
  const handle = await open(archive, 'r');
  try {
    const head = Buffer.alloc(16); await handle.read(head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12), dataStart = 8 + head.readUInt32LE(4);
    assert(headerSize > 0 && headerSize < 32 * 1024 * 1024, 'Invalid ASAR header size');
    const header = Buffer.alloc(headerSize); await handle.read(header, 0, headerSize, 16);
    const root = JSON.parse(header.toString());
    async function extract(entry, relative) {
      const output = path.resolve(target, relative);
      assert(output === target || output.startsWith(target + path.sep), 'Unsafe ASAR path');
      assert(!entry.link, 'ASAR links are unsupported by this probe');
      if (entry.files) {
        await mkdir(output, { recursive: true });
        for (const [name, nested] of Object.entries(entry.files)) {
          assert(!['.', '..'].includes(name) && !/[\\/]/.test(name), 'Unsafe ASAR segment');
          await extract(nested, path.join(relative, name));
        }
      } else {
        assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 256 * 1024 * 1024, 'Invalid ASAR entry size');
        if (entry.unpacked) {
          const source = path.join(archive + '.unpacked', 'dsh', relative);
          assert((await lstat(source)).isFile(), 'Unpacked entry must be a regular file');
          await copyFile(source, output);
        } else {
          const offset = Number(entry.offset); assert(Number.isSafeInteger(offset) && offset >= 0, 'Invalid ASAR offset');
          const data = Buffer.alloc(entry.size);
          let read = 0;
          while (read < data.length) { const value = await handle.read(data, read, data.length - read, dataStart + offset + read); assert(value.bytesRead, 'Truncated ASAR entry'); read += value.bytesRead; }
          await writeFile(output, data);
        }
        if (entry.executable) await chmod(output, 0o755);
      }
    }
    assert(root.files?.dsh?.files, 'Desktop app has no bundled dsh runtime');
    await extract(root.files.dsh, '');
  } finally { await handle.close(); }
}
try {
  temporary = await mkdtemp(path.join(tmpdir(), 'codex-desktop-host-probe-'));
  const runtime = path.join(temporary, 'runtime'), home = path.join(temporary, 'dsh-home'), state = path.join(temporary, 'bridge-state'), profile = path.join(home, 'profiles/desktop');
  await extractRuntime(runtime);
  await mkdir(profile, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(bundle, 'package.json'), 'utf8'));
  await mkdir(path.join(profile, 'node_modules/@aototo'), { recursive: true });
  await symlink(bundle, path.join(profile, 'node_modules', manifest.name));
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'isolated-desktop-bridge-probe', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', manifest.name] } } }));
  await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const env = { ...process.env, DSH_HOME: home, DSH_SUBAGENT_HOME: state };
  child = spawn(node, ['--expose-internals', path.join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), runtime, profile, path.join(resource, 'runtime/primary-runtime')], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Keep diagnostics private: host output can contain launch URLs and secrets.
  child.stdout.resume(); child.stderr.resume();
  let ready, fatal;
  child.on('message', message => { if (message?.type === 'ready') ready = message; if (message?.type === 'fatal') { fatal = true; if (process.env.DSH_PROBE_DIAGNOSTICS === '1') console.error(String(message.message).replace(/https?:\/\/[^\s]+/g, '[URL suppressed]')); } });
  child.on('error', () => { fatal = true; });
  for (let i = 0; i < 600 && !ready; i++) { assert(!fatal && child.exitCode === null, 'Isolated Desktop host failed (diagnostics suppressed)'); await sleep(50); }
  assert(ready, 'Isolated Desktop startup timed out');
  const origin = new URL(ready.url).origin, root = origin + '/codex-desktop-bridge/v1';
  const bounded = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const login = await bounded(ready.url, { redirect: 'manual' }); assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]; assert(cookie, 'Missing isolated host cookie');
  const get = headers => bounded(root + '/status', { headers });
  const post = (operation, csrf, headers = { cookie, origin }) => bounded(root + '/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ csrf }) });
  const issue = async () => { const response = await get({ cookie, origin }); assert.equal(response.status, 200); return (await response.json()).csrf; };
  const missing = async file => { await assert.rejects(lstat(file), { code: 'ENOENT' }); };
  const discovery = path.join(state, 'codex-desktop', 'desktop-connection.json');
  const credential = path.join(state, 'codex-desktop', 'credentials', createHash('sha256').update(origin).digest('hex') + '.json');
  // Seed the old assistant's same-origin grant; a new Codex grant must never replace it.
  const legacyDiscovery = path.join(state, 'desktop-connection.json');
  const legacyCredential = path.join(state, 'credentials', createHash('sha256').update(origin).digest('hex') + '.json');
  await mkdir(path.dirname(legacyCredential), { recursive: true, mode: 0o700 });
  const legacyMetadata = JSON.stringify({ version: 1, origin, pid: child.pid, dshHome: home, instanceId: 'legacy-fixture', approvedAt: new Date().toISOString() });
  const legacyAuth = JSON.stringify({ version: 1, origin, cookie: 'legacy-fixture-not-used', connectedAt: 1 });
  await writeFile(legacyDiscovery, legacyMetadata, { mode: 0o600 });
  await writeFile(legacyCredential, legacyAuth, { mode: 0o600 });
  const unchangedLegacy = async () => {
    assert.equal(await readFile(legacyDiscovery, 'utf8'), legacyMetadata);
    assert.equal(await readFile(legacyCredential, 'utf8'), legacyAuth);
  };
  assert.equal((await get({})).status, 401);
  assert.equal((await get({ cookie, origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await post('approve', await issue(), { origin })).status, 401);
  assert.equal((await post('approve', await issue(), { cookie, origin: 'https://evil.invalid' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(root + '/status', { headers: { cookie, host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.setTimeout(5000, () => req.destroy(new Error('Host probe timed out'))); req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await post('approve', '0'.repeat(64))).status, 400);
  const deny = await issue(); assert.equal((await post('deny', deny)).status, 200);
  await missing(discovery); await missing(credential); await unchangedLegacy();
  assert.equal((await post('approve', deny)).status, 400);
  const csrf = await issue(); assert.equal((await post('approve', csrf, { cookie })).status, 200);
  assert.equal((await post('approve', csrf)).status, 400);
  const saved = JSON.parse(await readFile(credential, 'utf8')), metadata = JSON.parse(await readFile(discovery, 'utf8'));
  assert(saved.cookie === cookie && saved.origin === origin, 'Saved authorization must match isolated host');
  assert.equal(metadata.consumer, 'codex-subagent-dsh'); await unchangedLegacy();
  assert.equal(metadata.origin, origin); assert.equal(metadata.pid, child.pid); assert.equal(metadata.dshHome, home);
  assert.equal((await lstat(credential)).mode & 0o777, 0o600); assert.equal((await lstat(discovery)).mode & 0o777, 0o600);
  const native = await bounded(origin + '/api/session/list', { method: 'POST', headers: { cookie: saved.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-probe', method: 'session/list', payload: { args: { _request: {} } } }) });
  assert.equal(native.status, 200); assert.equal((await native.json()).result?.ok, true, 'Native session/list rejected saved grant');
  const version = JSON.parse(await readFile(path.join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host/package.json'), 'utf8')).version;
  // Shutdown leaves private metadata stale; never unlink a discovery file another instance may have replaced.
  child.send({ type: 'shutdown' });
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
  assert(child.exitCode !== null || child.signalCode !== null, 'Desktop host did not shut down');
  const stoppedMetadata = JSON.parse(await readFile(discovery, 'utf8'));
  assert.equal(stoppedMetadata.pid, child.pid); await unchangedLegacy();
  assert.throws(() => process.kill(stoppedMetadata.pid, 0), { code: 'ESRCH' }, 'Saved discovery must refer to a stopped process');
  console.log(JSON.stringify({ ok: true, desktopHost: version, bridge: manifest.version, backendOnly: true, electronUiVerified: false, isolatedHome: true, paidModelUsed: false, checks: ['legacy same-origin grant unchanged after denial approval and exit', 'consumer-labelled private namespace', 'bundle loaded by packaged Desktop host', 'anonymous denied', 'cross-origin denied', 'host mismatch denied', 'CSRF invalid and replay denied', 'deny writes no credential or discovery', 'Origin-stripped Desktop request accepted only with cookie and valid CSRF', 'explicit isolated grant saved mode0600', 'native session/list accepted saved grant', 'graceful exit leaves stale metadata with a dead PID'] }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Desktop probe failed');
  process.exitCode = 1;
} finally { clearTimeout(timeout); await stop(); }
