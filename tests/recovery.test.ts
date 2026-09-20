import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { BridgeConfig } from '../src/config.js';
import { TaskManager } from '../src/task-manager.js';
import { TaskStore } from '../src/task-store.js';
import type { DshApi, FollowHandlers, SessionSnapshot, SubmitInput, TaskRecord } from '../src/types.js';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = value => done(value as T); });
  return { promise, resolve };
}

function history(task: TaskRecord, reason: 'completed' | 'aborted' = 'completed'): SessionSnapshot {
  const events = [
    { type: 'session/title', seq: 0, data: {} },
    { type: 'turn/start', seq: 1, data: { turn: 7 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'system' } } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'user', rpcId: task.taskId } } },
    { type: 'assistant/message', seq: 4, data: { turn: 7, message: { content: [{ type: 'text', text: 'recovered result' }] } } },
    { type: 'turn/end', seq: 5, data: { turn: 7, reason: { kind: reason } } },
  ];
  return {
    type: 'snapshot',
    header: { id: task.sessionId },
    cursor: 5,
    records: events.map(event => ({ type: 'event', event })),
    hasMore: false,
    projections: { asOfSeq: 5, values: {} },
  };
}

class RecoveryDsh implements DshApi {
  origin = 'http://127.0.0.1:3080';
  snapshot!: SessionSnapshot;
  methods: string[] = [];
  followed: string[] = [];
  closes = 0;
  disconnected = false;
  running = false;
  queued = false;
  projectionDelta = 0;
  cancelFails = false;
  listEntered?: ReturnType<typeof deferred>;
  listRelease?: ReturnType<typeof deferred>;
  eventDuringList = false;
  handlers?: FollowHandlers;

  async rpc<T = any>(method: string, _request: any): Promise<T> {
    this.methods.push(method);
    if (method === 'session/cancel') {
      if (this.cancelFails) throw new Error('already stopped');
      return { accepted: true } as T;
    }
    if (method !== 'session/list') throw new Error(`unexpected mutating RPC: ${method}`);
    this.listEntered?.resolve();
    if (this.listRelease) await this.listRelease.promise;
    if (this.eventDuringList) this.handlers?.event({ type: 'session/title', seq: 6, data: {} });
    return {
      items: [{
        sessionId: this.snapshot.header.id,
        running: this.running,
        projections: {
          asOfSeq: this.snapshot.cursor + this.projectionDelta,
          values: { inbox: { 'next-turn': this.queued ? ['pending'] : [], 'next-step': [] } },
        },
      }],
    } as T;
  }

  async follow(sessionId: string, handlers: FollowHandlers) {
    this.followed.push(sessionId);
    if (this.disconnected) throw new Error('disconnected');
    this.handlers = handlers;
    handlers.snapshot(this.snapshot);
    return { close: () => { this.closes++; } };
  }
}

async function fixture(t: any, endReason?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-recovery-'));
  const config: BridgeConfig = {
    origin: 'http://127.0.0.1:3080',
    stateDir: path.join(root, 'state'),
    taskTimeoutMs: 10_000,
    rpcTimeoutMs: 500,
    maxWaitMs: 1_000,
  };
  const input: SubmitInput = {
    conversationKey: 'recovery',
    requestId: 'request',
    goal: 'recover',
    cwd: root,
    mode: 'read',
    acceptanceCriteria: ['return evidence'],
  };
  const now = Date.now();
  const task: TaskRecord = {
    taskId: 'task-recovery', requestId: input.requestId, conversationKey: input.conversationKey,
    origin: config.origin, inputHash: 'hash', input, cwd: root, sessionId: 'session-recovery',
    state: 'unknown', ownerId: 'dead-owner', ownerPid: 999_999_999, createdAt: now - 1000,
    updatedAt: now, deadlineAt: now + 10_000, attempt: 1, error: 'MCP_PROCESS_CLOSED',
    guidance: 'stale guidance', ...(endReason === undefined ? {} : { endReason }),
  };
  const store = new TaskStore(config.stateDir);
  store.reserve(task);
  const client = new RecoveryDsh();
  client.snapshot = history(task);
  const manager = new TaskManager(config, client, store);
  let closed = false;
  t.after(async () => {
    manager.shutdown();
    if (!closed) store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { client, config, manager, store, task, closeStore: () => { store.close(); closed = true; } };
}

test('dsh_task recovers completed result with only follow and session/list reads', async t => {
  const { client, manager, task } = await fixture(t);
  const recovered = await manager.task(task.conversationKey, task.taskId);
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.result, 'recovered result');
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.sessionId, task.sessionId);
  assert.equal(recovered.attempt, 1);
  assert.deepEqual(client.followed, [task.sessionId]);
  assert.deepEqual(client.methods, ['session/list']);
  assert.equal(client.closes >= 1, true);
});

test('failed nonowner cancellation can subsequently recover observed aborted history', async t => {
  const { client, manager, task } = await fixture(t);
  client.snapshot = history(task, 'aborted');
  client.cancelFails = true;
  const requested = await manager.cancel(task.conversationKey, task.taskId);
  assert.equal(requested.state, 'unknown');
  assert.equal(requested.endReason, 'cancellation_requested');
  const recovered = await manager.task(task.conversationKey, task.taskId);
  assert.equal(recovered.state, 'cancelled');
  assert.equal(recovered.error, undefined);
  assert.deepEqual(client.methods, ['session/cancel', 'session/list']);
});

test('disconnect and post-snapshot events leave unknown state unchanged', async t => {
  await t.test('disconnected follow', async t => {
    const { client, manager, task } = await fixture(t);
    client.disconnected = true;
    const result = await manager.task(task.conversationKey, task.taskId);
    assert.equal(result.state, 'unknown');
    assert.equal(result.error, 'MCP_PROCESS_CLOSED');
    assert.deepEqual(client.methods, []);
  });
  await t.test('event races with list proof', async t => {
    const { client, manager, task } = await fixture(t);
    client.eventDuringList = true;
    const result = await manager.task(task.conversationKey, task.taskId);
    assert.equal(result.state, 'unknown');
    assert.equal(result.error, 'MCP_PROCESS_CLOSED');
  });
});

test('running, pending queue and changed projection cannot release an unknown task', async t => {
  for (const scenario of ['running', 'queue', 'projection'] as const) {
    await t.test(scenario, async t => {
      const { client, manager, task, store } = await fixture(t);
      if (scenario === 'running') client.running = true;
      if (scenario === 'queue') client.queued = true;
      if (scenario === 'projection') client.projectionDelta = 1;
      const returned = await manager.task(task.conversationKey, task.taskId);
      assert.equal(returned.state, 'unknown');
      assert.equal(store.get(task.origin, task.conversationKey, task.taskId).state, 'unknown');
      assert.deepEqual(new Set(client.methods), new Set(['session/list']));
    });
  }
});

test('aborted turn without durable cancellation intent stays unknown; completed turn resolves old cancellation intent', async t => {
  await t.test('no cancellation intent', async t => {
    const { client, manager, task } = await fixture(t);
    client.snapshot = history(task, 'aborted');
    assert.equal((await manager.task(task.conversationKey, task.taskId)).state, 'unknown');
  });
  await t.test('execution completed after intent', async t => {
    const { manager, task } = await fixture(t, 'cancellation_requested');
    const recovered = await manager.task(task.conversationKey, task.taskId);
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.error, undefined);
  });
});

test('concurrent cancel wins recovery CAS and shutdown prevents a late store write', async t => {
  await t.test('concurrent cancel', async t => {
    const { client, manager, task } = await fixture(t);
    client.listEntered = deferred();
    client.listRelease = deferred();
    const recovery = manager.task(task.conversationKey, task.taskId);
    await client.listEntered.promise;
    const cancel = await manager.cancel(task.conversationKey, task.taskId);
    assert.equal(cancel.state, 'cancel_requested');
    client.listRelease.resolve();
    assert.equal((await recovery).state, 'cancel_requested');
  });
  await t.test('shutdown with closed store', async t => {
    const { client, manager, task, closeStore } = await fixture(t);
    client.listEntered = deferred();
    client.listRelease = deferred();
    const recovery = manager.task(task.conversationKey, task.taskId);
    await client.listEntered.promise;
    manager.shutdown();
    closeStore();
    client.listRelease.resolve();
    const result = await recovery;
    assert.equal(result.state, 'unknown');
  });
  await t.test('budget expires before stalled list resolves', async t => {
    const { client, manager, task, store } = await fixture(t);
    client.listEntered = deferred();
    client.listRelease = deferred();
    const recovery = manager.task(task.conversationKey, task.taskId);
    await client.listEntered.promise;
    const keepAlive = setTimeout(() => {}, 700);
    try {
      const result = await recovery;
      assert.equal(result.state, 'unknown');
      client.listRelease.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(store.get(task.origin, task.conversationKey, task.taskId).state, 'unknown');
      assert.equal(client.closes >= 1, true);
    } finally { clearTimeout(keepAlive); }
  });
});
