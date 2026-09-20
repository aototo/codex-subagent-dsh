#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dshRoot = process.env.DSH_INSTALL_ROOT;
if (!dshRoot) throw new Error('DSH_INSTALL_ROOT must point to an installed @deepseek-ai/dsh package');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const companion = join(repoRoot, 'plugins/codex-subagent-dsh/dsh-companion');
const adapter = join(repoRoot, 'scripts/fixtures/dsh-fake-adapter');
const bin = join(dshRoot, 'lib/bin.js');
const profile = 'codex-model-routing-gate';
const selectionA = { provider: 'codex-fixture', model: 'fixture-model-a', reasoningEffort: 'fixture-high' };
const selectionB = { provider: 'codex-fixture', model: 'fixture-model-b', reasoningEffort: 'fixture-low' };
const selectionC = { provider: 'codex-fixture', model: 'fixture-model-c', reasoningEffort: 'fixture-medium' };

function safeOutput(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&]+/g, '$1<redacted>')
    .replaceAll(repoRoot, '<repo>')
    .slice(-2_000);
}

function run(args, env) {
  const result = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`dsh command failed (${result.status}): ${safeOutput(result.stderr || result.stdout)}`);
  }
}

async function startHost(env) {
  const child = spawn(process.execPath, [
    bin,
    '--profile', profile,
    '--no-open',
    '--host', '127.0.0.1',
    '--port', '0',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = /^dsh web: (http:\/\/[^\s]+)$/m.exec(output);
    if (match) return { child, loginUrl: match[1] };
    if (child.exitCode !== null) throw new Error(`isolated DSH exited during startup: ${safeOutput(output)}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  child.kill('SIGKILL');
  throw new Error(`isolated DSH startup timed out: ${safeOutput(output)}`);
}

async function stopHost(host) {
  if (!host || host.child.exitCode !== null) return;
  host.child.kill('SIGINT');
  await Promise.race([
    new Promise(resolveExit => host.child.once('exit', resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 5_000)),
  ]);
  if (host.child.exitCode === null) host.child.kill('SIGKILL');
  if (host.child.exitCode === null) {
    await new Promise(resolveExit => host.child.once('exit', resolveExit));
  }
}

async function authenticate(loginUrl) {
  const response = await fetch(loginUrl, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie, 'isolated login did not issue a cookie');
  return { origin: new URL(loginUrl).origin, cookie };
}

async function rawRpc(auth, path, method, payload, authenticated = true) {
  return await fetch(`${auth.origin}${path}`, {
    method: 'POST',
    headers: {
      origin: auth.origin,
      'content-type': 'application/json',
      ...(authenticated ? { cookie: auth.cookie } : {}),
    },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  });
}

async function rpc(auth, path, method, payload) {
  const response = await rawRpc(auth, path, method, payload);
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.result?.ok, true, `${method} failed: ${envelope.result?.error?.code ?? 'invalid response'}`);
  return envelope.result.value;
}

const companionRpc = (auth, operation, payload) => rpc(
  auth,
  `/api/codex-session-model/${operation}`,
  operation,
  payload,
);

const apiRpc = (auth, method, request) => rpc(
  auth,
  `/api/${method}`,
  method,
  { args: { request } },
);

function sameSelection(left, right) {
  return left?.provider === right.provider
    && left?.model === right.model
    && left?.reasoningEffort === right.reasoningEffort;
}

async function waitForActual(auth, sessionId, selection) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await companionRpc(auth, 'selection.get', { sessionId });
    if (sameSelection(observed.actualRequest, selection)) return observed;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`request/header was not observed for ${selection.model}`);
}

let home;
let host;
let mcpClient;
try {
  home = await mkdtemp(join(tmpdir(), 'codex-dsh-model-routing-'));
  await chmod(home, 0o700);
  const env = { ...process.env, DSH_HOME: home };
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env);
  run(['plugin', '--profile', profile, 'add', '-w', companion], env);
  run(['plugin', '--profile', profile, 'add', '-w', adapter], env);
  await writeFile(join(home, 'profiles', profile, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: codex-fixture',
    '    model: fixture-model-c',
    '',
  ].join('\n'), { mode: 0o600 });
  const profileManifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'));
  assert(profileManifest.dsh.profile.bundles.includes('@aototo/codex-subagent-dsh-companion'));
  assert(profileManifest.dsh.profile.bundles.includes('@aototo/codex-subagent-dsh-fake-adapter'));

  await mkdir(join(home, 'workspaces', 'a'), { recursive: true });
  await mkdir(join(home, 'workspaces', 'b'), { recursive: true });
  await mkdir(join(home, 'workspaces', 'c'), { recursive: true });
  host = await startHost(env);
  let auth = await authenticate(host.loginUrl);
  const unauthenticated = await rawRpc(auth, '/api/codex-session-model/capabilities.get', 'capabilities.get', {}, false);
  assert.equal(unauthenticated.status, 401);
  const before = await companionRpc(auth, 'capabilities.get', {});
  assert.equal(before.protocol, 1);
  assert.deepEqual(before.operations, ['capabilities.get', 'selection.set', 'selection.get']);
  assert(before.catalog.routableProviders.includes('codex-fixture'));

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const sessionC = randomUUID();
  await Promise.all([
    apiRpc(auth, 'session/create', { sessionId: sessionA, cwd: join(home, 'workspaces', 'a'), agentPreset: 'standard' }),
    apiRpc(auth, 'session/create', { sessionId: sessionB, cwd: join(home, 'workspaces', 'b'), agentPreset: 'standard' }),
    apiRpc(auth, 'session/create', { sessionId: sessionC, cwd: join(home, 'workspaces', 'c'), agentPreset: 'standard' }),
  ]);
  const [receiptA, receiptB] = await Promise.all([
    companionRpc(auth, 'selection.set', { sessionId: sessionA, selection: selectionA }),
    companionRpc(auth, 'selection.set', { sessionId: sessionB, selection: selectionB }),
  ]);
  assert.equal(receiptA.sessionId, sessionA);
  assert.equal(receiptB.sessionId, sessionB);
  assert.equal(receiptA.persisted, true);
  assert.equal(receiptB.persisted, true);
  assert.equal((await companionRpc(auth, 'selection.get', { sessionId: sessionC })).pinned, false);

  await stopHost(host);
  host = await startHost(env);
  auth = await authenticate(host.loginUrl);
  const after = await companionRpc(auth, 'capabilities.get', {});
  assert.deepEqual(after.catalog.default, before.catalog.default, 'companion changed the shared default model');
  const [restoredA, restoredB, restoredC] = await Promise.all([
    companionRpc(auth, 'selection.get', { sessionId: sessionA }),
    companionRpc(auth, 'selection.get', { sessionId: sessionB }),
    companionRpc(auth, 'selection.get', { sessionId: sessionC }),
  ]);
  assert.equal(restoredA.pinned, true);
  assert.equal(restoredB.pinned, true);
  assert.equal(restoredC.pinned, false);
  assert(sameSelection(restoredA.requested, selectionA));
  assert(sameSelection(restoredB.requested, selectionB));

  await Promise.all([
    apiRpc(auth, 'session/prompt', {
      sessionId: sessionA,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Return the isolated fixture response.' }],
      clientTimeZone: 'UTC',
    }),
    apiRpc(auth, 'session/prompt', {
      sessionId: sessionB,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Return the isolated fixture response.' }],
      clientTimeZone: 'UTC',
    }),
  ]);
  const [actualA, actualB] = await Promise.all([
    waitForActual(auth, sessionA, selectionA),
    waitForActual(auth, sessionB, selectionB),
  ]);
  await apiRpc(auth, 'session/prompt', {
    sessionId: sessionC,
    requestId: randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'Return the isolated default fixture response.' }],
    clientTimeZone: 'UTC',
  });
  const actualC = await waitForActual(auth, sessionC, selectionC);
  assert.equal((await companionRpc(auth, 'selection.get', { sessionId: sessionC })).pinned, false);
  const afterRequests = await companionRpc(auth, 'capabilities.get', {});
  assert.deepEqual(afterRequests.catalog.default, before.catalog.default, 'requests changed the shared default model');

  // Exercise the shipped MCP bundle, its authenticated transport, event
  // correlation, and request/header parser against this same real host.
  const bridgeState = join(home, 'bridge-state');
  const bridgeWorkspace = join(home, 'workspaces', 'bridge');
  await mkdir(bridgeWorkspace, { recursive: true });
  const bridgeEnv = {
    ...process.env,
    DSH_SUBAGENT_HOME: bridgeState,
    DSH_SUBAGENT_URL: auth.origin,
  };
  const connected = spawnSync(process.execPath, [join(repoRoot, 'plugins/codex-subagent-dsh/runtime/connect.mjs')], {
    env: bridgeEnv,
    input: `${host.loginUrl}\n`,
    encoding: 'utf8',
  });
  assert.equal(connected.status, 0, `bundled connect failed: ${safeOutput(connected.stderr)}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'plugins/codex-subagent-dsh/runtime/server.mjs')],
    cwd: bridgeWorkspace,
    env: { ...bridgeEnv, PATH: process.env.PATH },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  mcpClient = new Client({ name: 'model-routing-host-gate', version: '1' });
  await mcpClient.connect(transport);
  const callTool = async (name, args) => {
    const result = await mcpClient.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed`);
    return JSON.parse(result.content[0].text);
  };
  const submitted = await callTool('dsh_submit', {
    conversationKey: 'host-gate',
    requestId: 'model-routing',
    goal: 'Return the isolated fixture response.',
    cwd: bridgeWorkspace,
    mode: 'read',
    acceptanceCriteria: ['return one fixture response'],
    modelSelection: selectionA,
  });
  const completed = await callTool('dsh_task', {
    conversationKey: 'host-gate',
    taskId: submitted.taskId,
    waitMs: 10_000,
  });
  assert.equal(completed.state, 'completed');
  assert(sameSelection(completed.modelRouting.requested, selectionA));
  assert(sameSelection(completed.modelRouting.configured, selectionA));
  assert(sameSelection(completed.modelRouting.actualRequest, selectionA));
  await mcpClient.close();
  mcpClient = undefined;

  const topVersion = JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8')).version;
  const agentVersion = JSON.parse(await readFile(join(dshRoot, 'node_modules/@deepseek-ai/dsh-agent/package.json'), 'utf8')).version;
  console.log(JSON.stringify({
    ok: true,
    installedVersions: { dsh: topVersion, dshAgent: agentVersion },
    authentication: { unauthenticatedStatus: 401, authenticated: true },
    persistence: { restarted: true, sessionA: restoredA.pinned, sessionB: restoredB.pinned },
    isolation: {
      sessionA: actualA.actualRequest,
      sessionB: actualB.actualRequest,
      sessionC: actualC.actualRequest,
      sessionCUnpinned: restoredC.pinned === false,
    },
    sharedDefaultUnchanged: true,
    bundledMcp: {
      completed: completed.state === 'completed',
      requested: completed.modelRouting.requested,
      configured: completed.modelRouting.configured,
      actualRequest: completed.modelRouting.actualRequest,
    },
  }, null, 2));
} finally {
  await mcpClient?.close().catch(() => {});
  await stopHost(host);
  if (home) await rm(home, { recursive: true, force: true });
}
