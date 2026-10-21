import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, copyFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect } from '../src/auth.js';

test('dsh_status distinguishes a stopped DSH from first-time authentication', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-status-e2e-'));
  const stateDir = path.join(root, 'state');
  await copyFile(path.resolve('plugins/codex-subagent-dsh/runtime/server.mjs'), path.join(root, 'server.mjs'));
  await copyFile(path.resolve('plugins/codex-subagent-dsh/runtime/connect.mjs'), path.join(root, 'connect.mjs'));
  const http = createServer((_req, res) => { res.writeHead(401); res.end(); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (http.address() as any).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'server.mjs')],
    cwd: root,
    env: { PATH: process.env.PATH!, DSH_SUBAGENT_HOME: stateDir, DSH_SUBAGENT_URL: origin },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'status-test', version: '1' });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
    http.closeAllConnections();
    if (http.listening) await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const status = async () => {
    const result = await client.callTool({ name: 'dsh_status', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as any)[0].text);
  };

  const authenticationRequired = await status();
  assert.equal(authenticationRequired.state, 'authentication_required');
  assert.equal(authenticationRequired.connectionMode, 'web');
  assert.equal(authenticationRequired.capabilities.taskConnection, false);
  const conflict = await client.callTool({ name: 'dsh_status', arguments: { connectionMode: 'desktop' } });
  assert.equal(JSON.parse((conflict.content as any)[0].text).code, 'DSH_BACKEND_BOUND', 'authentication failure never switches backends');
  assert.equal(authenticationRequired.dshRunning, true);
  assert.equal(authenticationRequired.connectCommand, `node ${JSON.stringify(path.join(await realpath(root), 'connect.mjs'))}`);

  http.closeAllConnections();
  await new Promise<void>(resolve => http.close(() => resolve()));
  const stopped = await status();
  assert.equal(stopped.state, 'dsh_not_running');
  assert.equal(stopped.code, 'DSH_NOT_RUNNING');
  assert.equal(stopped.dshRunning, false);
});

test('relocated bundled MCP: authenticate, five tools, correlated result, concurrent cancel and shutdown recovery', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-mcp-e2e-'));
  const sessions = new Map<string, { running: boolean; seq: number; ws?: WebSocket; streamId?: string; requestId?: string }>();
  let promptCount = 0;
  const clients: Client[] = [];
  const timers: NodeJS.Timeout[] = [];
  const emit = (sid: string, type: string, data: any) => {
    const s = sessions.get(sid)!;
    s.ws?.send(JSON.stringify({ type: 'item', streamId: s.streamId, value: { type: 'event', event: { type, seq: ++s.seq, time: Date.now(), data } } }));
  };
  const http = createServer(async (req, res) => {
    if (req.url === '/?token=test-only-login') { res.writeHead(303, { location: '/', 'set-cookie': 'dsh-test=local-test-only; HttpOnly; SameSite=Strict; Path=/' }); res.end(); return; }
    if (req.headers.cookie !== 'dsh-test=local-test-only') { res.writeHead(401); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const envelope = JSON.parse(raw), r = envelope.payload.args.request;
    let value: any;
    if (envelope.method === 'session/create') { sessions.set(r.sessionId, { running: false, seq: 0 }); value = { sessionId: r.sessionId }; }
    else if (envelope.method === 'session/list') value = { items: [...sessions].map(([sessionId, s]) => ({ sessionId, running: s.running, projections: { asOfSeq: s.seq, values: { inbox: { 'next-turn': [], 'next-step': [] } } } })) };
    else if (envelope.method === 'session/prompt') {
      promptCount++; const s = sessions.get(r.sessionId)!; s.running = true; s.requestId = r.requestId;
      emit(r.sessionId, 'turn/start', { turn: 1 });
      emit(r.sessionId, 'user/message', { source: { kind: 'user', rpcId: r.requestId } });
      if (!r.content[0].text.includes('hold-open')) timers.push(setTimeout(() => {
        if (!s.running) return;
        emit(r.sessionId, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'MCP_CHAIN_OK' }] } });
        s.running = false; emit(r.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
      }, 80));
      value = { accepted: true };
    } else if (envelope.method === 'session/cancel') {
      sessions.get(r.sessionId)!.running = false;
      emit(r.sessionId, 'turn/end', { turn: 1, reason: { kind: 'aborted' } });
      value = { accepted: true };
    } else { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie !== 'dsh-test=local-test-only') { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(String(raw)); if (frame.type !== 'open') return;
    const sid = frame.payload.args.request.address.sessionId, s = sessions.get(sid)!;
    s.ws = ws; s.streamId = frame.streamId;
    ws.send(JSON.stringify({ type: 'item', streamId: s.streamId, value: { type: 'snapshot', header: { id: sid }, cursor: s.seq, records: [], hasMore: false, projections: { asOfSeq: s.seq, values: {} } } }));
  }));
  await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + (http.address() as any).port;
  const stateDir = path.join(root, 'state');
  await connect(origin + '/?token=test-only-login', { origin, stateDir, rpcTimeoutMs: 2000, maxWaitMs: 2000, taskTimeoutMs: 30000 });
  // No node_modules or source files exist beside this copy. Exercise the exact distribution bundle.
  await copyFile(path.resolve('plugins/codex-subagent-dsh/runtime/server.mjs'), path.join(root, 'server.mjs'));
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    for (const timer of timers) clearTimeout(timer);
    for (const ws of wss.clients) ws.terminate();
    wss.close(); http.closeAllConnections();
    await new Promise<void>(r => http.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });
  const openClient = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server.mjs')], cwd: root, env: { PATH: process.env.PATH!, DSH_SUBAGENT_HOME: stateDir, DSH_SUBAGENT_URL: origin }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'integration-test', version: '1' });
    await client.connect(transport); clients.push(client); return client;
  };
  const call = async (c: Client, name: string, args: any) => {
    const result = await c.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse((result.content as any)[0].text);
  };
  const client = await openClient();
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['dsh_cancel', 'dsh_connect', 'dsh_status', 'dsh_submit', 'dsh_task']);
  assert.equal((await call(client, 'dsh_status', {})).connected, true);
  const input = { conversationKey: 'mcp-e2e', requestId: 'complete', goal: 'Return MCP_CHAIN_OK without using tools.', cwd: root, mode: 'read', acceptanceCriteria: ['exact marker'] };
  const submitted = await call(client, 'dsh_submit', input);
  const scope = { conversationKey: input.conversationKey, taskId: submitted.taskId };
  const final = await call(client, 'dsh_task', { ...scope, waitMs: 2000 });
  assert.equal(final.state, 'completed'); assert.equal(final.result, 'MCP_CHAIN_OK');
  assert.equal((await call(client, 'dsh_submit', input)).taskId, submitted.taskId); assert.equal(promptCount, 1);
  assert.equal((await client.callTool({ name: 'dsh_task', arguments: { ...scope, conversationKey: 'wrong' } })).isError, true);
  const hold = await call(client, 'dsh_submit', { ...input, requestId: 'cancel', goal: 'hold-open' });
  const heldScope = { conversationKey: input.conversationKey, taskId: hold.taskId };
  for (let i = 0; i < 50 && promptCount < 2; i++) await new Promise(r => setTimeout(r, 20));
  const waiting = call(client, 'dsh_task', { ...heldScope, waitMs: 2000 });
  await call(client, 'dsh_cancel', heldScope);
  assert.equal((await waiting).state, 'cancelled');
  const interrupted = await call(client, 'dsh_submit', { ...input, requestId: 'interrupt', goal: 'hold-open' });
  for (let i = 0; i < 50 && promptCount < 3; i++) await new Promise(r => setTimeout(r, 20));
  await client.close();
  const restarted = await openClient();
  const unknown = await call(restarted, 'dsh_task', { conversationKey: input.conversationKey, taskId: interrupted.taskId });
  assert.equal(unknown.state, 'unknown'); assert.equal(promptCount, 3);
  assert.equal((await call(restarted, 'dsh_submit', { ...input, requestId: 'interrupt', goal: 'hold-open' })).taskId, interrupted.taskId);
  assert.equal(promptCount, 3);
});

test('desktop MCP consumes authorized discovery without pairing routes, and fails closed after restart', async t => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { saveCredential } = await import('../src/auth.js');
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-desktop-mcp-'));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { mode: 0o700 });
  let requests = 0;
  let authorized = true;
  const http = createServer(async (req, res) => {
    requests++;
    assert.equal(req.url, '/api/session/list', 'desktop connection must not call the browser pairing verification route');
    if (!authorized || req.headers.cookie !== 'dsh-test=authorized') { res.writeHead(401); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const envelope = JSON.parse(raw);
    assert.equal(envelope.method, 'session/list');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(http.address() as any).port}`;
  const metadata = { version: 1, consumer: 'codex-subagent-dsh', origin, pid: process.pid, approvedAt: new Date().toISOString(), dshHome: root, instanceId: 'desktop-test' };
  const desktopDir = path.join(stateDir, 'codex-desktop');
  await mkdir(desktopDir, { mode: 0o700 });
  const metadataPath = path.join(desktopDir, 'desktop-connection.json');
  await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  await saveCredential({ origin, stateDir, rpcTimeoutMs: 1000, taskTimeoutMs: 1000, maxWaitMs: 1000 }, { version: 1, origin, cookie: 'dsh-test=authorized', connectedAt: Date.now() });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('plugins/codex-subagent-dsh/runtime/server.mjs')], env: { PATH: process.env.PATH!, DSH_SUBAGENT_URL: origin, DSH_HOME: root, DSH_SUBAGENT_HOME: stateDir }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'desktop-test', version: '1' });
  t.after(async () => { await client.close().catch(() => {}); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = async (name: string, args = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as any)[0].text);
  const rootOnly = await call('dsh_status', { connectionMode: 'desktop' });
  assert.equal(rootOnly.connected, false, 'legacy root credential must never authorize Desktop');
  assert.equal(rootOnly.state, 'authentication_required');
  assert.equal(requests, 0, 'missing private credential must not issue RPC with root credential');
  await saveCredential({ origin, stateDir: desktopDir, rpcTimeoutMs: 1000, taskTimeoutMs: 1000, maxWaitMs: 1000 }, { version: 1, origin, cookie: 'dsh-test=authorized', connectedAt: Date.now() });
  const ready = await call('dsh_status');
  assert.equal(ready.connected, true);
  assert.equal(ready.connectionMode, 'desktop');
  assert.equal(ready.capabilities.modelSelection, 'not_checked');
  const conflict = await call('dsh_connect', { connectionMode: 'web' });
  assert.equal(conflict.code, 'DSH_BACKEND_BOUND');
  assert.equal(conflict.nextAction, 'open_new_conversation');
  assert.equal((await call('dsh_connect')).state, 'ready');
  assert.equal((await call('dsh_connect', { action: 'cancel' })).state, 'no_pending_pairing');
  assert.equal((await call('dsh_connect', { action: 'check' })).connected, true);
  assert.equal(requests, 3);
  authorized = false;
  const unauthenticated = await call('dsh_connect', { action: 'check' });
  assert.equal(unauthenticated.state, 'authentication_required');
  assert.equal(unauthenticated.nextAction, 'authorize_desktop_bridge');
  assert.equal(unauthenticated.connectCommand, undefined);
  authorized = true;
  assert.equal((await call('dsh_connect', { action: 'check' })).connected, true);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, instanceId: 'restarted' }), { mode: 0o600 });
  const changed = await call('dsh_status');
  assert.equal(changed.state, 'connection_unavailable');
  assert.equal(changed.code, 'DESKTOP_INSTANCE_CHANGED');
  assert.equal(changed.nextAction, 'open_new_conversation');
  assert.equal(requests, 5, 'changed desktop must not receive RPC');
});

test('missing desktop discovery keeps MCP tools responsive without creating tasks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-missing-desktop-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('plugins/codex-subagent-dsh/runtime/server.mjs')], env: { PATH: process.env.PATH!, DSH_CONNECTION_MODE: 'desktop', DSH_SUBAGENT_HOME: root }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'missing-desktop-test', version: '1' });
  t.after(async () => { await client.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  const result = await client.callTool({ name: 'dsh_status', arguments: {} });
  const missing = JSON.parse((result.content as any)[0].text);
  assert.equal(missing.state, 'connection_unavailable');
  assert.equal(missing.code, 'DESKTOP_DISCOVERY_MISSING');
  assert.equal(missing.nextAction, 'install_or_authorize_desktop_bridge');
});
