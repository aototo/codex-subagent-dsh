import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/task-store.js';
import { TaskManager } from '../src/task-manager.js';
import type { BridgeConfig } from '../src/config.js';
import type { DshApi, FollowHandlers, SubmitInput } from '../src/types.js';

const tick = () => new Promise<void>(r => setTimeout(r, 15));
class FakeDsh implements DshApi {
  origin = 'http://127.0.0.1:3080';
  handlers?: FollowHandlers;
  sid = '';
  submissionId = '';
  prompts = 0;
  cancels = 0;
  seq = 1;
  running = false;
  queued = false;
  promptError = false;
  foreignMessage = false;
  reachable = true;
  statusError?: string;
  companionMode: 'ok' | 'missing' | 'malformed' | 'unsupported' = 'ok';
  configuredModel?: { provider: string; model: string; reasoningEffort?: string };
  async probe() { return this.reachable; }
  async rpc<T = any>(method: string, request: any): Promise<T> {
    if (method === 'session/create') { this.sid = request.sessionId; this.configuredModel = undefined; return { sessionId: this.sid } as T; }
    if (method === 'session/prompt') {
      this.prompts++; this.submissionId = request.requestId;
      if (this.promptError) throw Object.assign(new Error('network failure'), { ambiguous: true });
      this.running = true;
      this.emit('turn/start', { turn: 1 });
      this.emit('user/message', { source: { kind: 'user', rpcId: this.foreignMessage ? 'wrong' : this.submissionId } });
      if (this.configuredModel !== undefined) {
        this.emit('request/header', { header: { config: { ...this.configuredModel, temperature: 0.2, maxTokens: 4096 } }, reason: 'initial' });
      }
      return { accepted: true } as T;
    }
    if (method === 'session/cancel') { this.cancels++; this.running = false; this.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } }); return { accepted: true } as T; }
    if (method === 'session/list') {
      if (this.statusError) throw Object.assign(new Error(this.statusError), { code: this.statusError });
      return { items: [{ sessionId: this.sid, running: this.running, projections: { asOfSeq: this.seq - 1, values: { inbox: { 'next-step': [], 'next-turn': this.queued ? ['pending'] : [] } } } }] } as T;
    }
    throw new Error('unexpected RPC');
  }
  async companionRpc<T = any>(method: string, request: any): Promise<T> {
    if (this.companionMode === 'missing') throw Object.assign(new Error('not found'), { code: 'HTTP_ERROR', ambiguous: false });
    if (this.companionMode === 'malformed') return { unexpected: true } as T;
    if (method === 'capabilities.get') return {
      protocol: this.companionMode === 'unsupported' ? 99 : 1,
      operations: ['capabilities.get', 'selection.set', 'selection.get'],
      persistence: 'session-log',
      catalog: {
        default: { provider: 'fixture-provider', model: 'fixture-model' },
        routableProviders: ['fixture-provider'],
        groups: [{ id: 'fixture-provider', name: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }],
      },
    } as T;
    if (method === 'selection.set') {
      this.configuredModel = request.selection;
      return { protocol: 1, sessionId: request.sessionId, persisted: true, selection: request.selection } as T;
    }
    throw new Error('unexpected companion RPC');
  }
  async follow(sessionId: string, handlers: FollowHandlers) {
    this.handlers = handlers;
    handlers.snapshot({ type: 'snapshot', header: { id: sessionId }, records: [], projections: { asOfSeq: 0 } });
    return { close: () => {} };
  }
  emit(type: string, data: any) { this.handlers?.event({ type, data, seq: this.seq++ }); }
  complete(text = 'done') {
    this.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text }] } });
    this.running = false;
    this.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  }
}
async function fixture(t: any, timeout = 10000) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-manager-'));
  const config: BridgeConfig = { origin: 'http://127.0.0.1:3080', stateDir: path.join(root, 'state'), taskTimeoutMs: timeout, rpcTimeoutMs: 100, maxWaitMs: 1000 };
  const client = new FakeDsh(), store = new TaskStore(config.stateDir), manager = new TaskManager(config, client, store);
  t.after(async () => { manager.shutdown(); store.close(); await rm(root, { recursive: true, force: true }); });
  const input: SubmitInput = { conversationKey: 'test', requestId: 'request', goal: 'inspect', cwd: root, mode: 'read', acceptanceCriteria: ['report evidence'] };
  return { root, config, client, store, manager, input };
}

test('status distinguishes stopped DSH, authentication setup, and ready state', async t => {
  const { manager, client } = await fixture(t);
  client.reachable = false;
  assert.deepEqual(await manager.status('node "/plugin/runtime/connect.mjs"'), {
    origin: client.origin,
    tools: ['dsh_status', 'dsh_connect', 'dsh_submit', 'dsh_task', 'dsh_cancel'],
    connected: false,
    dshRunning: false,
    state: 'dsh_not_running',
    code: 'DSH_NOT_RUNNING',
    nextAction: 'start_dsh',
    guidance: `Start DSH at ${client.origin}, then call dsh_status again.`,
  });
  client.reachable = true;
  client.statusError = 'AUTH_REQUIRED';
  const auth = await manager.status('node "/plugin/runtime/connect.mjs"');
  assert.equal(auth.state, 'authentication_required');
  assert.equal(auth.dshRunning, true);
  assert.equal((auth as any).connectCommand, 'node "/plugin/runtime/connect.mjs"');
  client.statusError = undefined;
  const ready = await manager.status('unused');
  assert.equal(ready.state, 'ready');
  assert.equal(ready.connected, true);
  const discovered: any = await manager.status('unused', true);
  assert.equal(discovered.modelRouting.available, true);
  assert.deepEqual(discovered.modelRouting.catalog.providers[0].models[0], {
    model: 'fixture-model',
    name: 'Fixture model',
    reasoningEfforts: ['high'],
  });
  client.companionMode = 'missing';
  assert.equal((await manager.status('unused', true) as any).modelRouting.code, 'MODEL_ROUTING_COMPANION_MISSING');
});

test('submit deduplicates and returns correlated final output, excluding a wrong-turn message', async t => {
  const { manager, input, client } = await fixture(t);
  const first = await manager.submit(input);
  const duplicate = await manager.submit(input);
  assert.equal(first.taskId, duplicate.taskId);
  await tick(); assert.equal(client.prompts, 1);
  client.emit('assistant/message', { turn: 99, message: { content: [{ type: 'text', text: 'wrong result' }] } });
  client.complete('verified output');
  const final = await manager.task('test', first.taskId, 1000);
  assert.equal(final.state, 'completed'); assert.equal(final.result, 'verified output');
  await assert.rejects(manager.task('another', first.taskId), /scope/);
});

test('explicit Session model is configured before prompt and confirmed from its request header', async t => {
  const { manager, input, client } = await fixture(t);
  const modelSelection = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' };
  const task = await manager.submit({ ...input, modelSelection });
  await tick();
  assert.equal(client.prompts, 1);
  client.complete('model routed');
  const final = await manager.task('test', task.taskId, 1000);
  assert.equal(final.state, 'completed');
  assert.deepEqual(final.configuredModel, modelSelection);
  assert.deepEqual(final.actualModel, modelSelection);
  assert.equal(typeof final.actualModelSeq, 'number');
});

test('missing, malformed, or unsupported model-routing capability prevents the first prompt', async t => {
  const { manager, input, client } = await fixture(t);
  const modelSelection = { provider: 'fixture-provider', model: 'fixture-model' };
  for (const [index, mode] of (['missing', 'malformed', 'unsupported'] as const).entries()) {
    client.companionMode = mode;
    const task = await manager.submit({ ...input, requestId: `model-failure-${index}`, modelSelection });
    const final = await manager.task('test', task.taskId, 1000);
    assert.equal(final.state, 'failed');
    assert.match(final.guidance ?? '', /No prompt was submitted/);
  }
  assert.equal(client.prompts, 0);
});

test('model selection participates in idempotency and a header mismatch cannot complete', async t => {
  const { manager, input, client } = await fixture(t);
  const first = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' };
  const task = await manager.submit({ ...input, modelSelection: first });
  await assert.rejects(
    manager.submit({ ...input, modelSelection: { ...first, reasoningEffort: 'low' } }),
    /parameters conflict/,
  );
  await tick();
  client.emit('request/header', { header: { config: { provider: 'other', model: 'wrong' } }, reason: 'change' });
  client.complete('must not pass');
  assert.equal((await manager.task('test', task.taskId, 1000)).state, 'unknown');
});

test('bounded wait and aborted wait do not cancel; explicit cancel settles while wait is active', async t => {
  const { manager, input, client } = await fixture(t);
  const task = await manager.submit(input); await tick();
  assert.equal((await manager.task('test', task.taskId, 10)).state, 'running');
  const abort = new AbortController(); abort.abort();
  await manager.task('test', task.taskId, 1000, abort.signal);
  assert.equal(client.cancels, 0);
  const waiting = manager.task('test', task.taskId, 1000);
  await manager.cancel('test', task.taskId);
  assert.equal((await waiting).state, 'cancelled'); assert.equal(client.cancels, 1);
});

test('unknown submission outcome is persisted and retry never dispatches a second prompt', async t => {
  const { manager, input, client } = await fixture(t); client.promptError = true;
  const task = await manager.submit(input); await tick();
  assert.equal((await manager.task('test', task.taskId)).state, 'unknown');
  await manager.submit(input); assert.equal(client.prompts, 1);
});

test('foreign prompt and socket disconnection never report success', async t => {
  const { manager, input, client } = await fixture(t); client.foreignMessage = true;
  const task = await manager.submit(input); await tick(); client.complete();
  assert.equal((await manager.task('test', task.taskId)).state, 'unknown');
});

test('cancel keeps unknown when pending inbox work remains', async t => {
  const { manager, input, client, store } = await fixture(t);
  const task = await manager.submit(input); await tick(); client.queued = true;
  await manager.cancel('test', task.taskId);
  const final = await manager.task('test', task.taskId, 1000);
  assert.equal(final.state, 'unknown'); assert.equal(store.get(client.origin, 'test', task.taskId).state, 'unknown');
});

test('no usable final result fails acceptance of execution; disconnect and shutdown preserve unknown', async t => {
  const { manager, input, client, store } = await fixture(t);
  const first = await manager.submit(input); await tick(); client.complete('');
  assert.equal((await manager.task('test', first.taskId, 1000)).state, 'failed');
  const second = await manager.submit({ ...input, requestId: 'second' }); await tick();
  client.handlers?.closed(); assert.equal((await manager.task('test', second.taskId)).state, 'unknown');
  const third = await manager.submit({ ...input, requestId: 'third' }); await tick(); manager.shutdown();
  assert.equal(store.get(client.origin, 'test', third.taskId).state, 'unknown');
});

test('task deadline requests cancellation without polling', async t => {
  const { manager, input, client } = await fixture(t, 100);
  const task = await manager.submit(input);
  const final = await manager.task('test', task.taskId, 1000);
  assert.equal(final.state, 'cancelled'); assert.equal(client.cancels, 1);
});

test('a different manager can cancel the live owner task without marking it failed', async t => {
  const { manager, input, client, config } = await fixture(t);
  const task = await manager.submit(input); await tick();
  const otherStore = new TaskStore(config.stateDir), other = new TaskManager(config, client, otherStore);
  try { await other.cancel('test', task.taskId); assert.equal((await manager.task('test', task.taskId, 1000)).state, 'cancelled'); }
  finally { other.shutdown(); otherStore.close(); }
});

test('write rejects primary checkout; linked clean baseline accepted and duplicate works after modification', async t => {
  const { manager, input, client, root } = await fixture(t);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'test base');
  const sha = git('rev-parse', 'HEAD');
  const rejected = await manager.submit({ ...input, mode: 'write', baselineCommit: sha, allowedPaths: ['note.txt'] });
  assert.equal((await manager.task('test', rejected.taskId, 1000)).state, 'failed'); assert.equal(client.prompts, 0);
  const worktree = path.join(root, 'isolated'); git('worktree', 'add', '-b', 'test-task', worktree);
  const write = { ...input, requestId: 'linked', mode: 'write' as const, cwd: worktree, baselineCommit: sha, allowedPaths: ['note.txt'] };
  const task = await manager.submit(write);
  for (let i = 0; i < 60 && !client.prompts; i++) await tick();
  assert.equal(client.prompts, 1);
  await writeFile(path.join(worktree, 'note.txt'), 'task output');
  assert.equal((await manager.submit(write)).taskId, task.taskId);
  client.complete('note written'); assert.equal((await manager.task('test', task.taskId, 1000)).state, 'completed');
});

test('shutdown during normalization prevents any reservation or remote dispatch', async t => {
  const { manager, input, client, store } = await fixture(t);
  let resume!: () => void;
  (manager as any).normalize = async (value: SubmitInput) => { await new Promise<void>(r => { resume = r; }); return value; };
  const submission = manager.submit(input);
  manager.shutdown(); resume();
  await assert.rejects(submission, /closing/);
  assert.equal(store.listOwned(manager.ownerId).length, 0); assert.equal(client.sid, '');
});

test('shutdown while model capabilities are pending prevents selection and prompt dispatch', async t => {
  const { manager, input, client, store } = await fixture(t);
  const modelSelection = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' };
  const original = client.companionRpc.bind(client);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  client.companionRpc = async (method, request) => {
    if (method === 'capabilities.get') {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
    return original(method, request);
  };
  const task = await manager.submit({ ...input, modelSelection });
  await started;
  manager.shutdown();
  release();
  await tick();
  assert.equal(client.prompts, 0);
  assert.equal(client.configuredModel, undefined);
  assert.equal(store.get(client.origin, input.conversationKey, task.taskId).state, 'unknown');
});

test('shutdown while model persistence is pending prevents a late prompt or terminal rewrite', async t => {
  const { manager, input, client, store } = await fixture(t);
  const modelSelection = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'high' };
  const original = client.companionRpc.bind(client);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  client.companionRpc = async (method, request) => {
    if (method === 'selection.set') {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
    return original(method, request);
  };
  const task = await manager.submit({ ...input, modelSelection });
  await started;
  manager.shutdown();
  release();
  await tick();
  assert.equal(client.prompts, 0);
  assert.equal(store.get(client.origin, input.conversationKey, task.taskId).state, 'unknown');
});

test('late workspace validation failure preserves shutdown uncertainty', async t => {
  const { manager, input, store, client } = await fixture(t);
  let reject!: (e: Error) => void;
  (manager as any).validateWriteWorkspace = () => new Promise<void>((_, r) => { reject = r; });
  const task = await manager.submit(input);
  manager.shutdown(); reject(new Error('late validation'));
  await tick();
  assert.equal(store.get(client.origin, 'test', task.taskId).state, 'unknown');
  assert.equal(client.prompts, 0);
});

test('cross-manager cancel before session creation prevents a later prompt even when cancel RPC fails', async t => {
  const { manager, input, client, config } = await fixture(t);
  let completeCreate!: () => void;
  const rpc = client.rpc.bind(client);
  client.rpc = async (method, request) => {
    if (method === 'session/create') await new Promise<void>(r => { completeCreate = r; });
    if (method === 'session/cancel') throw new Error('session does not exist yet');
    return rpc(method, request);
  };
  const task = await manager.submit(input); await tick();
  const otherStore = new TaskStore(config.stateDir), other = new TaskManager(config, client, otherStore);
  try {
    assert.equal((await other.cancel('test', task.taskId)).state, 'unknown');
    completeCreate(); await tick();
    assert.equal(client.prompts, 0);
    assert.equal((await manager.task('test', task.taskId)).state, 'unknown');
  } finally { other.shutdown(); otherStore.close(); }
});

test('another turn during terminal confirmation prevents false completion', async t => {
  const { manager, input, client } = await fixture(t);
  const task = await manager.submit(input); await tick();
  client.complete();
  client.emit('turn/start', { turn: 2 });
  client.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
  assert.equal((await manager.task('test', task.taskId, 1000)).state, 'unknown');
});

test('idle snapshot with an undelivered event watermark never confirms completion', async t => {
  const { manager, input, client } = await fixture(t);
  const rpc = client.rpc.bind(client);
  client.rpc = async (method, request) => {
    const response = await rpc<any>(method, request);
    if (method === 'session/list') response.items[0].projections.asOfSeq += 100;
    return response;
  };
  const task = await manager.submit(input); await tick(); client.complete();
  assert.equal((await manager.task('test', task.taskId, 1000)).state, 'unknown');
});
