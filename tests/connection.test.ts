import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { resolveDshEndpoint } from '../src/dsh-endpoint.js';
import { EndpointBinding } from '../src/connection.js';

test('connection mode defaults and explicit URL precedence', () => {
  assert.equal(loadConfig({}).connectionMode, 'auto');
  assert.equal(loadConfig({ DSH_SUBAGENT_URL: 'http://127.0.0.1:4000' }).connectionMode, 'web');
  assert.equal(loadConfig({ DSH_SUBAGENT_URL: 'http://127.0.0.1:4000', DSH_CONNECTION_MODE: 'desktop' }).connectionMode, 'desktop');
  assert.throws(() => loadConfig({ DSH_CONNECTION_MODE: 'unknown' }));
});

test('desktop discovery validates metadata and never switches a bound backend', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-endpoint-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const directory = path.join(stateDir, 'codex-desktop');
  await mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, 'desktop-connection.json');
  const options = { mode: 'desktop' as const, stateDir, webUrl: 'http://127.0.0.1:3080', expectedDshHome: '/test/dsh' };
  const metadata = { version: 1, consumer: 'codex-subagent-dsh', pid: process.pid, approvedAt: new Date().toISOString(), dshHome: '/test/dsh', instanceId: 'test-one', origin: 'http://127.0.0.1:45678' };
  const deps = { probe: async () => true, isAlive: () => true };
  const save = async (value: unknown) => { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await chmod(file, 0o600); };
  await assert.rejects(resolveDshEndpoint(options, deps), /未找到/);
  await writeFile(file, '{', { mode: 0o600 });
  await assert.rejects(resolveDshEndpoint(options, deps), /格式无效/);
  await save(metadata);
  assert.equal((await resolveDshEndpoint(options, deps)).origin, metadata.origin);
  await chmod(file, 0o644);
  await assert.rejects(resolveDshEndpoint(options, deps), /0600/);
  await save({ ...metadata, dshHome: '/wrong' });
  await assert.rejects(resolveDshEndpoint(options, deps), /目录不匹配/);
  await save(metadata);
  await assert.rejects(resolveDshEndpoint(options, { ...deps, isAlive: () => false }), /进程不存在/);
  for (const origin of ['https://example.com', 'http://127.0.0.1:45678/?token=secret', 'http://127.0.0.1:45678/a/..', 'http://user@127.0.0.1:45678']) {
    await save({ ...metadata, origin });
    await assert.rejects(resolveDshEndpoint(options, deps), /本机 HTTP origin/);
  }
  await save({ ...metadata, consumer: 'aotu' });
  await assert.rejects(resolveDshEndpoint(options, deps), /无效/);
  await save({ ...metadata, instanceId: undefined });
  await assert.rejects(resolveDshEndpoint(options, deps), /无效/);
  await rm(file); await symlink('/does-not-exist', file);
  await assert.rejects(resolveDshEndpoint(options, deps), /符号链接/);
  await rm(file); await save(metadata);
  const binding = new EndpointBinding({ ...loadConfig({}), connectionMode: 'desktop', stateDir, expectedDshHome: '/test/dsh' }, deps);
  assert.equal((await binding.get()).origin, metadata.origin);
  await save({ ...metadata, instanceId: 'test-two' });
  await assert.rejects(binding.get(), /instance changed/);
  await chmod(stateDir, 0o777);
  await assert.rejects(resolveDshEndpoint(options, deps), /目录/);
});

test('auto prefers reachable web regardless of authentication and retries only unbound discovery', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-endpoint-auto-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({}), stateDir, expectedDshHome: '/test/dsh' };
  let reachable = true, calls = 0;
  const binding = new EndpointBinding(cfg, { probe: async () => { calls++; return reachable; } });
  assert.equal((await binding.get()).mode, 'web');
  reachable = false;
  assert.equal((await binding.get()).mode, 'web');
  assert.equal(calls, 1, 'a bound web backend never falls back on later failure');
  const waiting = new EndpointBinding(cfg, { probe: async origin => origin !== cfg.origin, isAlive: () => true });
  await assert.rejects(waiting.get());
  await mkdir(path.join(stateDir, 'codex-desktop'), { mode: 0o700 });
  await writeFile(path.join(stateDir, 'codex-desktop', 'desktop-connection.json'), JSON.stringify({ version: 1, consumer: 'codex-subagent-dsh', origin: 'http://127.0.0.1:45678', pid: process.pid, approvedAt: new Date().toISOString(), dshHome: '/test/dsh', instanceId: 'instance' }), { mode: 0o600 });
  assert.equal((await waiting.get()).mode, 'desktop');
});


test('explicit tool choice overrides the default and concurrent choices cannot change backend', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-choice-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const cfg = { ...loadConfig({ DSH_SUBAGENT_URL: 'http://127.0.0.1:3080' }), stateDir, expectedDshHome: '/test/dsh' };
  await mkdir(path.join(stateDir, 'codex-desktop'), { mode: 0o700 });
  await writeFile(path.join(stateDir, 'codex-desktop', 'desktop-connection.json'), JSON.stringify({ version: 1, consumer: 'codex-subagent-dsh', origin: 'http://127.0.0.1:45678', pid: process.pid, approvedAt: new Date().toISOString(), dshHome: '/test/dsh', instanceId: 'instance' }), { mode: 0o600 });
  let release!: (value: boolean) => void;
  const binding = new EndpointBinding(cfg, { probe: async () => new Promise<boolean>(resolve => { release = resolve; }), isAlive: () => true });
  const first = binding.get('desktop');
  // The selection is reserved synchronously, before metadata and network work finish.
  await assert.rejects(binding.get('web'), { code: 'DSH_BACKEND_BOUND' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release(true);
  assert.equal((await first).mode, 'desktop');
  assert.equal((await binding.get('auto')).mode, 'desktop');
  await assert.rejects(binding.get('web'), { code: 'DSH_BACKEND_BOUND' });
  const auto = new EndpointBinding(cfg, { probe: async () => true, isAlive: () => true });
  assert.equal((await auto.get('auto')).mode, 'web', 'when both endpoints are reachable auto prefers Web');
});

test('discovery errors distinguish missing, invalid, stale and unreachable Desktop', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-diagnostics-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { mode: 'desktop' as const, stateDir, webUrl: 'http://127.0.0.1:3080', expectedDshHome: '/test/dsh' };
  const directory = path.join(stateDir, 'codex-desktop');
  await mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, 'desktop-connection.json');
  await assert.rejects(resolveDshEndpoint(options), { code: 'DESKTOP_DISCOVERY_MISSING', nextAction: 'install_or_authorize_desktop_bridge' });
  await writeFile(file, '{', { mode: 0o600 });
  await assert.rejects(resolveDshEndpoint(options), { code: 'DESKTOP_DISCOVERY_INVALID' });
  await writeFile(file, JSON.stringify({ version: 1, consumer: 'codex-subagent-dsh', origin: 'http://127.0.0.1:45678', pid: process.pid, approvedAt: new Date().toISOString(), dshHome: '/test/dsh', instanceId: 'instance' }));
  await assert.rejects(resolveDshEndpoint(options, { isAlive: () => false }), { code: 'DESKTOP_DISCOVERY_STALE', nextAction: 'reauthorize_desktop_bridge' });
  await assert.rejects(resolveDshEndpoint(options, { isAlive: () => true, probe: async () => false }), { code: 'DESKTOP_UNREACHABLE' });
});


test('legacy root discovery cannot authorize Codex and cannot replace an already bound Codex instance', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-legacy-isolation-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const metadata = { version: 1, origin: 'http://127.0.0.1:45678', pid: process.pid, approvedAt: new Date().toISOString(), dshHome: '/test/dsh', instanceId: 'legacy' };
  const legacyFile = path.join(stateDir, 'desktop-connection.json');
  await writeFile(legacyFile, JSON.stringify(metadata), { mode: 0o600 });
  const binding = new EndpointBinding({ ...loadConfig({}), connectionMode: 'desktop', stateDir, expectedDshHome: '/test/dsh' }, { probe: async () => true, isAlive: () => true });
  await assert.rejects(binding.get(), (error: any) => error.code === 'DESKTOP_DISCOVERY_MISSING');
  await mkdir(path.join(stateDir, 'codex-desktop'), { mode: 0o700 });
  const privateFile = path.join(stateDir, 'codex-desktop', 'desktop-connection.json');
  await writeFile(privateFile, JSON.stringify(metadata), { mode: 0o600 });
  await assert.rejects(binding.get(), (error: any) => error.code === 'DESKTOP_DISCOVERY_INVALID');
  await writeFile(privateFile, JSON.stringify({ ...metadata, consumer: 'codex-subagent-dsh', instanceId: 'codex' }), { mode: 0o600 });
  assert.equal((await binding.get()).instanceId, 'codex');
  await writeFile(legacyFile, JSON.stringify({ ...metadata, instanceId: 'legacy-new', origin: 'http://127.0.0.1:45679' }), { mode: 0o600 });
  assert.equal((await binding.get()).instanceId, 'codex');
});
