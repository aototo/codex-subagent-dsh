import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskManager } from '../src/task-manager.js';
import { TaskStore } from '../src/task-store.js';
import type { BridgeConfig } from '../src/config.js';
import type { DshApi, FollowHandlers, ModelSelection, SubmitInput, WireEvent } from '../src/types.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const secret = 'SENSITIVE_APPROVAL_REASON_token=not-for-output';
class ApprovalDsh implements DshApi {
  origin = 'http://127.0.0.1:3080';
  handlers?: FollowHandlers;
  sid = '';
  seq = 1;
  running = false;
  cancels = 0;
  deferCancelEnd = false;
  cancelDecisionLimit = Infinity;
  seenPrompt = true;
  pending = new Set<string>();
  selection?: ModelSelection;
  async probe() { return true; }
  async rpc<T = any>(method: string, request: any): Promise<T> {
    if (method === 'session/create') { this.sid = request.sessionId; return { sessionId: this.sid } as T; }
    if (method === 'session/prompt') {
      this.running = true;
      this.emit('turn/start', { turn: 1 });
      if (this.seenPrompt) this.emit('user/message', { source: { kind: 'user', rpcId: request.requestId } });
      if (this.selection) this.emit('request/header', { header: { config: this.selection }, reason: 'initial' });
      return { accepted: true } as T;
    }
    if (method === 'session/cancel') {
      this.cancels++;
      // DSH resolves its approval promise before emitting the aborted turn end.
      for (const id of [...this.pending].slice(0, this.cancelDecisionLimit)) this.decide(id, 'cancelled');
      if (!this.deferCancelEnd) {
        this.running = false;
        this.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } });
      }
      return { accepted: true } as T;
    }
    if (method === 'session/list') return { items: [{ sessionId: this.sid, running: this.running,
      projections: { asOfSeq: this.seq - 1, values: { inbox: { 'next-step': [], 'next-turn': [] } } } }] } as T;
    throw new Error('unexpected RPC');
  }
  async companionRpc<T = any>(method: string, request: any): Promise<T> {
    if (method === 'capabilities.get') return { protocol: 1, operations: ['capabilities.get', 'selection.set', 'selection.get'],
      persistence: 'session-log', catalog: { default: { provider: 'fixture', model: 'model' }, routableProviders: ['fixture'],
        groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] } } as T;
    if (method === 'selection.set') { this.selection = request.selection; return { protocol: 1, sessionId: request.sessionId, persisted: true, selection: request.selection } as T; }
    throw new Error('unexpected companion RPC');
  }
  async follow(sessionId: string, handlers: FollowHandlers) {
    this.handlers = handlers;
    handlers.snapshot({ type: 'snapshot', header: { id: sessionId }, records: [], projections: { asOfSeq: 0 } });
    return { close() {} };
  }
  emit(type: string, data: any): WireEvent {
    const event = { type, data, seq: this.seq++ };
    this.handlers?.event(event);
    return event;
  }
  ask(id = 'approval-1', extra: Record<string, unknown> = {}) {
    this.pending.add(id);
    return this.emit('approval/asked', { id, toolName: 'shell', reason: secret, ...extra });
  }
  decide(id = 'approval-1', outcome = 'allowed-once') {
    this.pending.delete(id);
    this.emit('approval/decided', { id, outcome });
  }
  complete() {
    this.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'verified output' }] } });
    this.running = false;
    this.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  }
}
async function fixture(t: any, options: { timeout?: number; seenPrompt?: boolean; model?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-approval-'));
  const config: BridgeConfig = { origin: 'http://127.0.0.1:3080', stateDir: path.join(root, 'state'), taskTimeoutMs: options.timeout ?? 10000, rpcTimeoutMs: 50, maxWaitMs: 1500 };
  const client = new ApprovalDsh(); client.seenPrompt = options.seenPrompt ?? true;
  const store = new TaskStore(config.stateDir), manager = new TaskManager(config, client, store);
  t.after(async () => { manager.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const input: SubmitInput = { conversationKey: 'approval-test', requestId: 'request', goal: 'inspect', cwd: root, mode: 'read', acceptanceCriteria: ['report evidence'],
    ...(options.model ? { modelSelection: { provider: 'fixture', model: 'model', reasoningEffort: 'high' } } : {}) };
  const task = await manager.submit(input);
  // Wait for dispatch, avoiding a timing assumption about temporary-directory I/O.
  for (let n = 0; n < 100 && !client.running; n++) await pause(5);
  assert.equal(client.running, true);
  const read = (waitMs = 0) => manager.task(input.conversationKey, task.taskId, waitMs);
  return { root, config, client, store, manager, input, task, read };
}

test('a sustained approval returns waiting_permission before a bounded wait expires, with safe guidance', async t => {
  const { client, read, task } = await fixture(t);
  client.ask();
  const started = Date.now();
  const result = await read(1500);
  assert.equal(result.state, 'waiting_permission');
  assert.ok(Date.now() - started < 1200, 'waiting caller must receive actionable status early');
  assert.equal(result.sessionId, task.sessionId);
  assert.match(result.guidance ?? '', /DSH/i);
  assert.ok(!JSON.stringify(result).includes(secret));
});

for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
  test(`${outcome} clears the last approval without deciding the task outcome`, async t => {
    const { client, read } = await fixture(t);
    client.ask(); await pause(550);
    assert.equal((await read()).state, 'waiting_permission');
    client.decide('approval-1', outcome);
    assert.equal((await read()).state, 'running');
    client.complete();
    assert.equal((await read(1000)).state, 'completed');
  });
}

test('an immediate decision never flashes waiting_permission', async t => {
  const { client, read } = await fixture(t);
  client.ask(); client.decide('approval-1', 'rejected');
  for (let i = 0; i < 6; i++) { await pause(100); assert.equal((await read()).state, 'running'); }
});

test('multiple requests remain waiting until the last decision arrives', async t => {
  const { client, read } = await fixture(t);
  client.ask('one'); client.ask('two'); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  client.decide('two'); assert.equal((await read()).state, 'waiting_permission');
  client.decide('one', 'rejected'); assert.equal((await read()).state, 'running');
});

test('replayed sequence and identical pending request are idempotent', async t => {
  const { client, read } = await fixture(t);
  const event = client.ask(); client.handlers?.event(event); client.ask(); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  client.decide(); assert.equal((await read()).state, 'running');
});

test('explicit cancellation has priority over approval decisions and settles cancelled', async t => {
  const { client, read, manager, input, task } = await fixture(t);
  client.ask(); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  await manager.cancel(input.conversationKey, task.taskId);
  assert.equal((await read(1000)).state, 'cancelled');
  assert.equal(client.cancels, 1);
  await pause(450); assert.equal((await read()).state, 'cancelled');
});

test('the original deadline still cancels while awaiting permission', async t => {
  const { client, read } = await fixture(t, { timeout: 850 });
  client.ask(); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  await pause(450);
  assert.equal((await read(1000)).state, 'cancelled');
  assert.equal(client.cancels, 1);
});

test('disconnect invalidates live pending evidence and no delayed timer restores waiting', async t => {
  const { client, read } = await fixture(t);
  client.ask(); client.handlers?.closed(); await pause(550);
  assert.equal((await read()).state, 'unknown');
});

test('manager shutdown and restart never resurrect a persisted permission wait', async t => {
  const { client, read, manager, config, store, task, input } = await fixture(t);
  client.ask(); await pause(550); assert.equal((await read()).state, 'waiting_permission');
  manager.shutdown();
  const next = new TaskManager(config, client, store);
  try { assert.equal((await next.task(input.conversationKey, task.taskId)).state, 'unknown'); }
  finally { next.shutdown(); }
});

for (const kind of ['gap', 'unmatched-decision', 'conflicting-request', 'reused-decided-id', 'invalid-outcome', 'oversized-id', 'too-many-ids'] as const) {
  test(`uncertain approval evidence fails closed: ${kind}`, async t => {
    const { client, read } = await fixture(t);
    if (kind === 'gap') { client.seq++; client.ask(); }
    if (kind === 'unmatched-decision') client.decide('unknown');
    if (kind === 'conflicting-request') { client.ask(); client.ask('approval-1', { toolName: 'different-tool' }); }
    if (kind === 'reused-decided-id') { client.ask(); client.decide(); client.ask(); }
    if (kind === 'invalid-outcome') { client.ask(); client.decide('approval-1', 'not-an-outcome'); }
    if (kind === 'oversized-id') client.ask('a'.repeat(257));
    if (kind === 'too-many-ids') for (let i = 0; i < 1025; i++) { client.ask(`request-${i}`); client.decide(`request-${i}`); }
    await pause(450);
    const result = await read();
    assert.equal(result.state, 'unknown');
    assert.ok(!JSON.stringify(result).includes(secret));
  });
}

test('approval before the matching submitted user message has uncertain ownership', async t => {
  const { client, read } = await fixture(t, { seenPrompt: false });
  client.ask(); await pause(450);
  assert.equal((await read()).state, 'unknown');
});

test('a terminal turn with unresolved approval cannot be accepted as completed', async t => {
  const { client, read } = await fixture(t);
  client.ask(); client.complete();
  assert.equal((await read(1000)).state, 'unknown');
});

test('approval handling preserves per-session model verification', async t => {
  const { client, read, input } = await fixture(t, { model: true });
  client.ask(); await pause(550); assert.equal((await read()).state, 'waiting_permission');
  client.decide(); client.complete();
  const result = await read(1000);
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.actualModel, input.modelSelection);
});

test('cancellation before debounce cannot be overwritten by the delayed wait timer', async t => {
  const { client, read, manager, input, task } = await fixture(t);
  client.ask();
  await manager.cancel(input.conversationKey, task.taskId);
  assert.equal((await read(1000)).state, 'cancelled');
  await pause(550);
  assert.equal((await read()).state, 'cancelled');
});

test('conflicting decisions at a new sequence make the evidence uncertain', async t => {
  const { client, read } = await fixture(t);
  client.ask(); client.decide(); client.decide('approval-1', 'rejected');
  assert.equal((await read()).state, 'unknown');
});

test('a model mismatch while waiting cannot be restored to running by a later decision', async t => {
  const { client, read } = await fixture(t, { model: true });
  client.ask(); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  client.emit('request/header', { header: { config: { provider: 'unexpected', model: 'wrong' } }, reason: 'change' });
  client.decide(); client.complete();
  assert.equal((await read(1000)).state, 'unknown');
});


test('an identical repeated decision does not decrement another pending approval', async t => {
  const { client, read } = await fixture(t);
  client.ask('one'); client.ask('two'); await pause(550);
  client.decide('one'); client.decide('one');
  assert.equal((await read()).state, 'waiting_permission');
  client.decide('two'); assert.equal((await read()).state, 'running');
});

test('another manager cancellation is not overwritten by a decision or a delayed wait timer', async t => {
  const { client, read, config, input, task } = await fixture(t);
  client.deferCancelEnd = true;
  client.ask();
  const otherStore = new TaskStore(config.stateDir);
  const other = new TaskManager(config, client, otherStore);
  try {
    await other.cancel(input.conversationKey, task.taskId);
    assert.equal((await read()).state, 'cancel_requested');
    await pause(550);
    assert.equal((await read()).state, 'cancel_requested');
    client.running = false;
    client.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } });
    assert.equal((await read(1000)).state, 'cancelled');
  } finally { other.shutdown(); otherStore.close(); }
});

test('a second turn start cannot clear a live permission wait even when its turn number matches', async t => {
  const { client, read } = await fixture(t);
  client.ask(); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  client.emit('turn/start', { turn: 1 });
  assert.equal((await read()).state, 'unknown');
});


test('a partial approval decision during another manager cancellation preserves cancellation', async t => {
  const { client, read, config, input, task } = await fixture(t);
  client.deferCancelEnd = true; client.cancelDecisionLimit = 1;
  client.ask('one'); client.ask('two'); await pause(550);
  assert.equal((await read()).state, 'waiting_permission');
  const otherStore = new TaskStore(config.stateDir), other = new TaskManager(config, client, otherStore);
  try {
    await other.cancel(input.conversationKey, task.taskId);
    assert.equal(client.pending.size, 1);
    await pause(450);
    assert.equal((await read()).state, 'cancel_requested');
    client.decide('two', 'cancelled');
    assert.equal((await read()).state, 'cancel_requested');
    client.running = false;
    client.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } });
    assert.equal((await read(1000)).state, 'cancelled');
  } finally { other.shutdown(); otherStore.close(); }
});
