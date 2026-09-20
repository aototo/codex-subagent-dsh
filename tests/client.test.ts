import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { connect, disconnect } from '../src/auth.js';
import type { BridgeConfig } from '../src/config.js';
import { DshClient, DshError } from '../src/dsh-client.js';
import type { SessionSnapshot, WireEvent } from '../src/types.js';

interface Harness {
  origin: string;
  config: BridgeConfig;
  server: Server;
  wss: WebSocketServer;
  sockets: Set<WebSocket>;
}

async function startHarness(
  stateDir: string,
  httpHandler?: (request: IncomingMessage, response: ServerResponse) => void,
  websocketHandler?: (socket: WebSocket, request: IncomingMessage) => void,
  timeout = 500,
): Promise<Harness> {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  const server = createServer((request, response) => {
    if (request.url === '/?token=launch-token') {
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh_auth=signed; Path=/; HttpOnly; SameSite=Strict' }).end();
      return;
    }
    httpHandler?.(request, response);
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/remote.mux' || request.headers.cookie !== 'dsh_auth=signed') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (websocket) => {
      sockets.add(websocket);
      websocket.once('close', () => sockets.delete(websocket));
      websocketHandler?.(websocket, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const config: BridgeConfig = {
    origin,
    stateDir,
    rpcTimeoutMs: timeout,
    taskTimeoutMs: 900_000,
    maxWaitMs: 20_000,
  };
  await connect(`${origin}/?token=launch-token`, config);
  return { origin, config, server, wss, sockets };
}

async function stopHarness(harness: Harness): Promise<void> {
  for (const socket of harness.sockets) socket.terminate();
  harness.wss.close();
  await new Promise<void>((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function reply(response: ServerResponse, rpcId: unknown, result: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ type: 'server-response', rpcId, result }));
}

function snapshot(sessionId: string): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 3, id: sessionId, createdAt: Date.now(), isSeeded: false },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
  };
}

function after<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('rpc uses real HTTP transport and the required request wrappers', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-rpc-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const received: Record<string, unknown>[] = [];
  const harness = await startHarness(stateDir, (request, response) => {
    assert.equal(request.headers.cookie, 'dsh_auth=signed');
    assert.equal(request.headers.origin, harness.origin);
    void readJson(request).then((body) => {
      received.push(body);
      reply(response, body.rpcId, { ok: true, value: { method: body.method } });
    });
  });
  t.after(() => stopHarness(harness));
  const client = new DshClient(harness.config);

  assert.deepEqual(await client.rpc('session/create', { cwd: '/tmp/work' }), { method: 'session/create' });
  assert.deepEqual(await client.rpc('session/list', { limit: 5 }), { method: 'session/list' });

  assert.deepEqual((received[0]!.payload as any).args, { request: { cwd: '/tmp/work' } });
  assert.deepEqual((received[1]!.payload as any).args, { _request: { limit: 5 } });
  assert.equal(received[0]!.type, 'client-request');
  assert.equal(typeof received[0]!.rpcId, 'string');
});

test('client constructor rejects a non-loopback origin', () => {
  assert.throws(
    () => new DshClient({ origin: 'https://example.com', stateDir: '/tmp/unused', rpcTimeoutMs: 10, taskTimeoutMs: 10, maxWaitMs: 10 }),
    (error: unknown) => error instanceof DshError && error.code === 'INVALID_ORIGIN' && error.ambiguous === false,
  );
});

test('rpc distinguishes explicit authentication and remote failures from ambiguous transport failures', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-errors-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let mode: 'auth' | 'remote' | 'internal' | 'unsafe-code' = 'auth';
  const harness = await startHarness(stateDir, (request, response) => {
    void readJson(request).then((body) => {
      if (mode === 'auth') response.writeHead(401).end();
      else if (mode === 'remote') reply(response, body.rpcId, { ok: false, error: { code: 'session/not-found', message: 'secret detail', details: {} } });
      else if (mode === 'internal') reply(response, body.rpcId, { ok: false, error: { code: 'gateway/internal', message: 'secret detail', details: {} } });
      else reply(response, body.rpcId, { ok: false, error: { code: 'cookie=credential-value\n', message: 'secret detail', details: {} } });
    });
  });
  t.after(() => stopHarness(harness));
  const client = new DshClient(harness.config);

  await assert.rejects(client.rpc('session/create', {}), (error: unknown) => {
    return error instanceof DshError && error.code === 'AUTH_REQUIRED' && error.ambiguous === false;
  });
  mode = 'remote';
  await assert.rejects(client.rpc('session/create', {}), (error: unknown) => {
    return error instanceof DshError && error.code === 'session/not-found' && error.ambiguous === false && !error.message.includes('secret detail');
  });
  mode = 'internal';
  await assert.rejects(client.rpc('session/create', {}), (error: unknown) => {
    return error instanceof DshError && error.code === 'gateway/internal' && error.ambiguous === true;
  });
  mode = 'unsafe-code';
  await assert.rejects(client.rpc('session/create', {}), (error: unknown) => {
    return error instanceof DshError && error.code === 'RPC_FAILED' && error.ambiguous === true && !error.message.includes('credential-value');
  });
});

test('rpc timeout is ambiguous and a mutating request is never retried', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-timeout-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let count = 0;
  const harness = await startHarness(stateDir, (request) => {
    count += 1;
    request.resume();
  }, undefined, 40);
  t.after(() => stopHarness(harness));

  await assert.rejects(new DshClient(harness.config).rpc('session/prompt', { sessionId: 'one' }), (error: unknown) => {
    return error instanceof DshError && error.code === 'RPC_TIMEOUT' && error.ambiguous === true;
  });
  assert.equal(count, 1);
});

test('rpc fails explicitly before transport when no per-origin credential exists', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-no-auth-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0;
  const harness = await startHarness(stateDir, (_request, response) => {
    calls += 1;
    response.writeHead(500).end();
  });
  t.after(() => stopHarness(harness));
  await disconnect(harness.config);

  await assert.rejects(new DshClient(harness.config).rpc('session/list', {}), (error: unknown) => {
    return error instanceof DshError && error.code === 'AUTH_REQUIRED' && error.ambiguous === false;
  });
  assert.equal(calls, 0);
});

test('rpc rejects a non-JSON request before transport', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-invalid-request-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0;
  const harness = await startHarness(stateDir, (_request, response) => {
    calls += 1;
    response.writeHead(500).end();
  });
  t.after(() => stopHarness(harness));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  await assert.rejects(new DshClient(harness.config).rpc('session/prompt', cyclic), (error: unknown) => {
    return error instanceof DshError && error.code === 'INVALID_REQUEST' && error.ambiguous === false;
  });
  assert.equal(calls, 0);
});

test('follow resolves only after the matching snapshot and preserves immediate event order', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-follow-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const closed = after<void>();
  let openFrame: any;
  const harness = await startHarness(stateDir, undefined, (socket) => {
    socket.once('message', (data) => {
      openFrame = JSON.parse(data.toString());
      const streamId = openFrame.streamId;
      socket.send(JSON.stringify({ type: 'item', streamId, value: snapshot('session-one') }));
      socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'event', event: { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } } } }));
      socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'event', event: { type: 'turn/end', seq: 2, time: 20, data: { turn: 1 } } } }));
      socket.send(JSON.stringify({ type: 'end', streamId }));
    });
  });
  t.after(() => stopHarness(harness));
  const callbacks: string[] = [];
  const events: WireEvent[] = [];

  await new DshClient(harness.config).follow('session-one', {
    snapshot(value: SessionSnapshot) {
      callbacks.push(`snapshot:${value.header.id}`);
    },
    event(value) {
      callbacks.push(`event:${value.seq}`);
      events.push(value);
    },
    error(error) {
      assert.fail(error);
    },
    closed() {
      callbacks.push('closed');
      closed.resolve();
    },
  });
  await closed.promise;

  assert.equal(openFrame.endpoint, 'session/follow');
  assert.deepEqual(openFrame.payload.args.request.address, { kind: 'session', sessionId: 'session-one' });
  assert.deepEqual(callbacks, ['snapshot:session-one', 'event:1', 'event:2', 'closed']);
  assert.deepEqual(events.map((event) => event.type), ['turn/start', 'turn/end']);
});

test('follow rejects a snapshot belonging to another session without exposing it', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-mismatch-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const harness = await startHarness(stateDir, undefined, (socket) => {
    socket.once('message', (data) => {
      const open = JSON.parse(data.toString());
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: snapshot('other-session') }));
    });
  });
  t.after(() => stopHarness(harness));
  let snapshots = 0;
  let observedError: Error | undefined;

  await assert.rejects(new DshClient(harness.config).follow('owned-session', {
    snapshot() { snapshots += 1; },
    event() { assert.fail('mismatched session event was exposed'); },
    error(error) { observedError = error; },
    closed() {},
  }), (error: unknown) => error instanceof DshError && error.code === 'INVALID_SNAPSHOT');
  assert.equal(snapshots, 0);
  assert(observedError instanceof DshError);
});

test('follow times out when the server never supplies a snapshot', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-follow-timeout-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let opens = 0;
  const harness = await startHarness(stateDir, undefined, (socket) => {
    socket.on('message', () => { opens += 1; });
  }, 40);
  t.after(() => stopHarness(harness));

  await assert.rejects(new DshClient(harness.config).follow('session-timeout', {
    snapshot() { assert.fail('unexpected snapshot'); },
    event() { assert.fail('unexpected event'); },
    error() {},
    closed() {},
  }), (error: unknown) => error instanceof DshError && error.code === 'FOLLOW_TIMEOUT' && error.ambiguous === true);
  assert.equal(opens, 1);
});

test('follow close sends a scoped cancellation and reports closure', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-cancel-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const cancelled = after<Record<string, unknown>>();
  const closed = after<void>();
  const harness = await startHarness(stateDir, undefined, (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === 'open') socket.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: snapshot('session-cancel') }));
      if (frame.type === 'cancel') cancelled.resolve(frame);
    });
  });
  t.after(() => stopHarness(harness));
  const subscription = await new DshClient(harness.config).follow('session-cancel', {
    snapshot() {},
    event() {},
    error(error) { assert.fail(error); },
    closed() { closed.resolve(); },
  });
  subscription.close();
  const cancelFrame = await cancelled.promise;
  await closed.promise;
  assert.equal(cancelFrame.type, 'cancel');
  assert.equal(typeof cancelFrame.streamId, 'string');
});

test('follow enforces the maximum WebSocket frame size', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-client-frame-limit-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const harness = await startHarness(stateDir, undefined, (socket) => {
    socket.once('message', (data) => {
      const open = JSON.parse(data.toString());
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { ...snapshot('session-large'), padding: 'x'.repeat(4 * 1024 * 1024) } }));
    });
  });
  t.after(() => stopHarness(harness));

  await assert.rejects(new DshClient(harness.config).follow('session-large', {
    snapshot() { assert.fail('oversized snapshot was exposed'); },
    event() {},
    error() {},
    closed() {},
  }), (error: unknown) => error instanceof DshError && error.ambiguous === true);
});
