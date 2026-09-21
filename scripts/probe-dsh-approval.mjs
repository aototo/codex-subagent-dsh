#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dshRoot = process.env.DSH_INSTALL_ROOT;
if (!dshRoot) throw new Error('DSH_INSTALL_ROOT must point to an installed @deepseek-ai/dsh package');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const adapter = join(repoRoot, 'scripts/fixtures/dsh-approval-fixture');
const bin = join(dshRoot, 'lib/bin.js');
const profile = 'codex-approval-gate';
const rejectOnly = process.argv.includes('--manual-reject');
const manual = process.argv.includes('--manual') || rejectOnly;
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });
function safeOutput(value) {
  return String(value)
    .replace(/([?&]token=)[^\s&]+/g, '$1<redacted>')
    .replaceAll(repoRoot, '<repo>')
    .slice(-2_000);
}

function run(args, env) {
  const result = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 60000 });
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
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated DSH exited during startup: ${safeOutput(output)}`);
    if (interrupted) { await stopHost({ child }); throw new Error('Probe interrupted'); }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  await stopHost({ child });
  throw new Error(`isolated DSH startup timed out: ${safeOutput(output)}`);
}

async function stopHost(host) {
  if (!host || host.child.exitCode !== null || host.child.signalCode !== null) return;
  host.child.kill('SIGINT');
  await Promise.race([
    new Promise(resolveExit => host.child.once('exit', resolveExit)),
    new Promise(resolveWait => setTimeout(resolveWait, 5_000)),
  ]);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
  if (host.child.exitCode === null && host.child.signalCode === null) {
    await new Promise(resolveExit => host.child.once('exit', resolveExit));
  }
}

async function authenticate(loginUrl) {
  const response = await fetch(loginUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie, 'isolated login did not issue a cookie');
  return { origin: new URL(loginUrl).origin, cookie };
}

async function rawRpc(auth, path, method, payload, authenticated = true) {
  return await fetch(`${auth.origin}${path}`, {
    signal: AbortSignal.timeout(10000),
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

const apiRpc = (auth, method, request) => rpc(
  auth,
  `/api/${method}`,
  method,
  { args: { request } },
);


const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Probe interrupted');
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const sockets = [];
async function follow(auth, sessionId) {
  const url = new URL('/api/remote.mux', auth.origin); url.protocol = 'ws:';
  const ws = new WebSocket(url, { headers: { origin: auth.origin, cookie: auth.cookie } });
  sockets.push(ws);
  const streamId = randomUUID();
  const values = []; let error;
  ws.on('error', cause => { error = cause; });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 100 } } } })));
  ws.on('message', data => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'error') error = new Error(JSON.stringify(frame.error));
    if (frame.type === 'item') values.push(frame.value);
  });
  await until(() => error || values.length, 'follow snapshot');
  if (error) throw error;
  assert.equal(values[0].type, 'snapshot');
  assert.equal(values[0].cursor, values[0].projections?.asOfSeq, 'snapshot cursor and projection cursor differ');
  return { ws, values, events: () => values.filter(v => v.type === 'event').map(v => v.event) };
}
let home, host, mcpClient;
try {
  home = await mkdtemp(join(tmpdir(), 'codex-dsh-approval-'));
  await chmod(home, 0o700);
  const env = { ...process.env, DSH_HOME: home };
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env);
  run(['plugin', '--profile', profile, 'add', '-w', adapter], env);
  run(['plugin', '--profile', profile, 'add', '-w', join(repoRoot, 'plugins/codex-subagent-dsh/dsh-companion')], env);
  await writeFile(join(home, 'profiles', profile, 'cordis.patch.yml'), '- id: agent-default-model\n  config:\n    provider: codex-fixture\n    model: fixture-model-c\n', { mode: 0o600 });
  host = await startHost(env);
  const auth = await authenticate(host.loginUrl);
  const results = [];
  for (const scenario of manual ? [] : ['allow', 'reject', 'cancel', 'never', 'unavailable']) {
    const cwd = join(home, 'workspaces', scenario); await mkdir(cwd, { recursive: true });
    const sessionId = randomUUID();
    await apiRpc(auth, 'session/create', { sessionId, cwd, agentPreset: 'standard' });
    const live = await follow(auth, sessionId);
    await apiRpc(auth, 'session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Run isolated fixture.' }], clientTimeZone: 'UTC' });
    await until(() => live.events().some(e => e.type === 'approval/asked'), `${scenario} asked`);
    const asked = live.events().find(e => e.type === 'approval/asked');
    let pendingSnapshot = false;
    if (['allow', 'reject', 'cancel'].includes(scenario)) {
      assert(!live.events().some(e => e.type === 'approval/decided'), 'expected observable pending interval');
      const pending = await follow(auth, sessionId);
      const events = pending.values[0].records.map(r => r.event);
      pendingSnapshot = events.some(e => e.type === 'approval/asked' && e.data.id === asked.data.id) && !events.some(e => e.type === 'approval/decided');
      assert(pendingSnapshot, 'pending snapshot must retain real asked event');
      pending.ws.close();
    }
    await until(() => live.events().some(e => e.type === 'turn/end'), `${scenario} completed`);
    const decided = live.events().find(e => e.type === 'approval/decided');
    assert(decided); assert.equal(decided.data.id, asked.data.id);
    const expected = { allow: 'allowed-once', reject: 'rejected', cancel: 'cancelled', never: 'rejected', unavailable: 'unavailable' }[scenario];
    assert.equal(decided.data.outcome, expected);
    assert(asked.seq < decided.seq);
    const after = await follow(auth, sessionId);
    const audit = after.values[0].records.map(r => r.event).filter(e => e.type.startsWith('approval/'));
    assert(audit.some(e => e.type === 'approval/asked' && e.data.id === asked.data.id));
    assert(audit.some(e => e.type === 'approval/decided' && e.data.id === asked.data.id));
    live.ws.close(); after.ws.close();
    const result = { scenario, livePair: true, snapshotPair: true, pendingSnapshot, outcome: decided.data.outcome };
    results.push(result); console.log(JSON.stringify(result));
  }
  // Exercise the actual shipped MCP bundle against the same isolated host.
  const bridgeWorkspace = join(home, 'bridge'); await mkdir(bridgeWorkspace);
  const bridgeEnv = { ...process.env, DSH_SUBAGENT_HOME: join(home, 'bridge-state'), DSH_SUBAGENT_URL: auth.origin };
  const connected = spawnSync(process.execPath, [join(repoRoot, 'plugins/codex-subagent-dsh/runtime/connect.mjs')], {
    env: bridgeEnv, input: `${host.loginUrl}\n`, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(connected.status, 0, `connect failed: ${safeOutput(connected.stderr)}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'plugins/codex-subagent-dsh/runtime/server.mjs')], cwd: bridgeWorkspace, env: bridgeEnv, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  mcpClient = new Client({ name: 'approval-host-gate', version: '1' }); await mcpClient.connect(transport);
  const callTool = async (name, args) => {
    const result = await mcpClient.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  };
  const conversationKey = 'approval-host-gate';
  const modelSelection = { provider: 'codex-fixture', model: 'fixture-model-a', reasoningEffort: 'fixture-high' };
  const submit = async scenario => {
    const cwd = join(home, 'mcp-workspaces', scenario); await mkdir(cwd, { recursive: true });
    return callTool('dsh_submit', { conversationKey, requestId: randomUUID(), goal: 'Run isolated fixture.', cwd, mode: 'read', acceptanceCriteria: ['Return fixture response'], modelSelection });
  };
  const query = (task, waitMs = 10000) => callTool('dsh_task', { conversationKey, taskId: task.taskId, waitMs });
  const waitTerminal = async task => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (interrupted) throw new Error('Probe interrupted');
      const value = await query(task);
      if (['completed', 'failed', 'cancelled', 'unknown'].includes(value.state)) return value;
      await delay(100);
    }
    throw new Error('MCP terminal timeout');
  };
  if (manual) {
    // Pass the launch credential directly to the OS opener, never to stdout.
    const opened = spawnSync('open', [host.loginUrl], { stdio: 'ignore' });
    assert.equal(opened.status, 0, 'Could not open the isolated DSH browser');
    console.log(JSON.stringify({ manual: true, origin: auth.origin, action: 'Wait until the DSH page finishes loading, then enter ready. No files or shell commands will be executed.' }));
    const reader = createInterface({ input: process.stdin });
    let ready = false;
    reader.on('line', line => { if (line.trim() === 'ready') ready = true; });
    const readyDeadline = Date.now() + 300000;
    try {
      while (!ready && Date.now() < readyDeadline) {
        if (interrupted) throw new Error('Probe interrupted');
        await delay(100);
      }
    } finally { reader.close(); }
    assert(ready, 'Manual browser readiness timed out');
    for (const expected of (rejectOnly ? ['rejected'] : ['allowed-once', 'rejected'])) {
      const task = await submit('native');
      const waiting = await query(task);
      assert.equal(waiting.state, 'waiting_permission', JSON.stringify(waiting));
      console.log(JSON.stringify({ manual: true, origin: auth.origin, sessionId: task.sessionId, state: waiting.state, requestedAction: expected === 'allowed-once' ? 'Allow once' : 'Reject' }));
      const deadline = Date.now() + 300000;
      let finished;
      while (Date.now() < deadline) {
        if (interrupted) throw new Error('Probe interrupted');
        const value = await query(task, 0);
        if (['completed', 'failed', 'cancelled', 'unknown'].includes(value.state)) { finished = value; break; }
        await delay(300);
      }
      assert(finished, 'Manual approval timed out');
      assert.equal(finished.state, 'completed', JSON.stringify(finished));
      const snapshot = await follow(auth, task.sessionId);
      const decision = snapshot.values[0].records.find(r => r.event.type === 'approval/decided')?.event.data.outcome;
      snapshot.ws.close();
      assert.equal(decision, expected, 'The browser decision differs from the requested test action');
      console.log(JSON.stringify({ manual: true, sessionId: task.sessionId, actualOutcome: decision, state: finished.state }));
    }
  } else {
    const [allowTask, rejectTask] = await Promise.all([submit('allow'), submit('reject')]);
    assert.notEqual(allowTask.sessionId, rejectTask.sessionId);
    const startWait = Date.now();
    const waits = await Promise.all([query(allowTask), query(rejectTask)]);
    const earlyReturnMs = Date.now() - startWait;
    assert(earlyReturnMs < 1500, 'approval wait did not return early before decision');
    assert.deepEqual(waits.map(v => v.state), ['waiting_permission', 'waiting_permission'], JSON.stringify(waits));
    const terminals = await Promise.all([waitTerminal(allowTask), waitTerminal(rejectTask)]);
    for (const completed of terminals) {
      assert.equal(completed.state, 'completed');
      for (const field of ['requested', 'configured', 'actualRequest']) assert.deepEqual(completed.modelRouting[field], modelSelection);
    }
    const cancelTask = await submit('mcp-cancel');
    assert.equal((await query(cancelTask)).state, 'waiting_permission');
    const cancelledRequest = await callTool('dsh_cancel', { conversationKey, taskId: cancelTask.taskId });
    assert(['cancel_requested', 'cancelled'].includes(cancelledRequest.state));
    const cancelled = await waitTerminal(cancelTask); assert.equal(cancelled.state, 'cancelled');
    const cancelledSnapshot = await follow(auth, cancelTask.sessionId);
    assert(cancelledSnapshot.values[0].records.some(r => r.event.type === 'approval/decided' && r.event.data.outcome === 'cancelled'));
    cancelledSnapshot.ws.close();
    const disconnectTask = await submit('disconnect');
    assert.equal((await query(disconnectTask)).state, 'waiting_permission');
    const exited = new Promise(resolveExit => host.child.once('exit', resolveExit));
    host.child.kill('SIGKILL'); await exited;
    const disconnected = await waitTerminal(disconnectTask);
    assert.equal(disconnected.state, 'unknown');
    assert.equal(disconnected.attempt, 1);
    console.log(JSON.stringify({ isolatedHostKilled: true, disconnectedState: disconnected.state, attempt: disconnected.attempt }));
    console.log(JSON.stringify({ bundledMcp: true, parallelSessions: 2, waitingPermission: true, earlyReturnMs, allowAndRejectCompleted: true, modelRoutingMatched: true, mcpCancel: cancelled.state }));
  }
  await mcpClient.close(); mcpClient = undefined;
  const installedVersions = {};
  for (const name of ['dsh', 'dsh-user-approval', 'dsh-api-session-controller']) {
    const packagePath = name === 'dsh' ? join(dshRoot, 'package.json') : join(dshRoot, 'node_modules/@deepseek-ai', name, 'package.json');
    installedVersions[name] = JSON.parse(await readFile(packagePath, 'utf8')).version;
  }
  console.log(JSON.stringify({ ok: true, installedVersions, snapshotCursorsMatch: true, gate: 'real-approval-service-session-follow', scenarios: results.length, manual, noPaidModel: true, isolatedHome: true }));
} finally {
  await mcpClient?.close().catch(() => {});
  for (const socket of sockets) socket.terminate();
  await stopHost(host);
  if (home) await rm(home, { recursive: true, force: true });
}
