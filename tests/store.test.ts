import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { TaskStore, type ReserveResult } from '../src/task-store.js';
import type { TaskRecord } from '../src/types.js';

const ORIGIN = 'http://127.0.0.1:3080';

function testDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-task-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const number = task.next++;
  const cwd = overrides.cwd ?? join(tmpdir(), `workspace-${number}`);
  const requestId = overrides.requestId ?? `request-${number}`;
  const conversationKey = overrides.conversationKey ?? 'conversation-a';
  return {
    taskId: `task-${number}`,
    requestId,
    conversationKey,
    origin: ORIGIN,
    inputHash: `hash-${number}`,
    input: {
      conversationKey,
      requestId,
      goal: 'inspect files',
      cwd,
      mode: 'read',
      acceptanceCriteria: ['report findings'],
    },
    cwd,
    sessionId: '',
    state: 'queued',
    ownerId: 'owner-a',
    ownerPid: process.pid,
    createdAt: 1_000 + number,
    updatedAt: 1_000 + number,
    deadlineAt: 10_000 + number,
    attempt: 1,
    ...overrides,
  };
}
task.next = 1;

test('persists tasks in a private state directory and scopes reads', (t) => {
  const stateDir = join(testDirectory(t), 'state');
  const first = task();
  let store = new TaskStore(stateDir);
  assert.equal(store.reserve(first).created, true);
  store.close();

  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(stateDir, 'tasks.sqlite3')).mode & 0o777, 0o600);

  store = new TaskStore(stateDir);
  assert.deepEqual(store.get(first.origin, first.conversationKey, first.taskId), {
    ...first,
    cwd: first.cwd,
  });
  assert.throws(() => store.get(first.origin, first.conversationKey, 'missing'), /task not found/);
  assert.throws(
    () => store.get(first.origin, 'another-conversation', first.taskId),
    /task scope mismatch/,
  );
  assert.throws(() => store.get('http://127.0.0.1:9999', first.conversationKey, first.taskId), /task scope mismatch/);
  store.close();
});

test('deduplicates by origin, conversation, and request and rejects changed parameters', (t) => {
  const store = new TaskStore(testDirectory(t));
  t.after(() => store.close());
  const first = task();
  assert.equal(store.reserve(first).created, true);

  const retry = task({
    taskId: 'retry-task-id',
    requestId: first.requestId,
    conversationKey: first.conversationKey,
    origin: first.origin,
    inputHash: first.inputHash,
    cwd: first.cwd,
  });
  const duplicate = store.reserve(retry);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.taskId, first.taskId);

  assert.throws(
    () => store.reserve({ ...retry, inputHash: 'different-hash' }),
    /request parameters conflict/,
  );

  const otherConversation = task({
    requestId: first.requestId,
    conversationKey: 'conversation-b',
    inputHash: first.inputHash,
    cwd: first.cwd,
  });
  assert.equal(store.reserve(otherConversation).created, true);
});

test('serializes independent processes reserving the same request', async (t) => {
  const stateDir = testDirectory(t);
  const base = task();
  const workers = Array.from({ length: 8 }, (_, index) =>
    startWorker({ ...base, taskId: `concurrent-${index}`, ownerPid: process.pid + index + 1 }, stateDir),
  );
  t.after(() => workers.forEach(({ child }) => child.kill()));

  await Promise.all(workers.map(({ ready }) => ready));
  workers.forEach(({ child }) => child.send('reserve'));
  const results = await Promise.all(workers.map(({ result }) => result));

  assert.equal(results.filter((entry) => entry.created).length, 1);
  assert.equal(new Set(results.map((entry) => entry.task.taskId)).size, 1);

  const store = new TaskStore(stateDir);
  t.after(() => store.close());
  assert.equal(store.get(base.origin, base.conversationKey, results[0].task.taskId)?.requestId, base.requestId);
});

test('blocks overlapping active directories whenever either task writes', (t) => {
  const root = testDirectory(t);
  const store = new TaskStore(join(root, 'state'));
  t.after(() => store.close());
  const workspace = join(root, 'workspace');
  const child = join(workspace, 'nested');
  const sibling = join(root, 'workspace-other');
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling, { recursive: true });

  const read = task({ cwd: workspace });
  store.reserve(read);
  assert.equal(store.reserve(task({ cwd: child })).created, true);

  const overlappingWrite = task({ cwd: child });
  overlappingWrite.origin = 'http://127.0.0.1:9999';
  overlappingWrite.conversationKey = 'conversation-b';
  overlappingWrite.input = {
    ...overlappingWrite.input,
    conversationKey: overlappingWrite.conversationKey,
    cwd: child,
    mode: 'write',
  };
  assert.throws(() => store.reserve(overlappingWrite), /workspace is busy/);

  const siblingWrite = task({ cwd: sibling });
  siblingWrite.input = { ...siblingWrite.input, cwd: sibling, mode: 'write' };
  assert.equal(store.reserve(siblingWrite).created, true);

  store.update(siblingWrite.taskId, { state: 'completed' });
  const released = task({ cwd: sibling });
  released.input = { ...released.input, cwd: sibling, mode: 'write' };
  assert.equal(store.reserve(released).created, true);
});

test('unknown keeps workspace occupied and terminal states cannot regress', (t) => {
  const root = testDirectory(t);
  let store = new TaskStore(join(root, 'state'));
  t.after(() => store.close());
  const workspace = join(root, 'workspace');
  const active = task({ cwd: workspace });
  active.input = { ...active.input, cwd: workspace, mode: 'write' };
  store.reserve(active);
  store.update(active.taskId, { state: 'unknown' });
  store.close();
  store = new TaskStore(join(root, 'state'));
  assert.equal(store.get(active.origin, active.conversationKey, active.taskId).state, 'unknown');

  const next = task({ cwd: join(workspace, 'child') });
  assert.throws(() => store.reserve(next), /workspace is busy/);
  assert.equal(store.update(active.taskId, { state: 'cancel_requested' }).state, 'cancel_requested');
  assert.equal(store.update(active.taskId, { state: 'cancelled' }).state, 'cancelled');
  assert.throws(() => store.update(active.taskId, { state: 'running' }), /terminal task state is immutable/);
});

test('conditional updates do not overwrite unknown or terminal states', (t) => {
  const store = new TaskStore(testDirectory(t));
  t.after(() => store.close());

  const unknown = task();
  store.reserve(unknown);
  const persistedUnknown = store.update(unknown.taskId, { state: 'unknown', updatedAt: 2_000 });
  const skippedUnknown = store.update(
    unknown.taskId,
    { state: 'failed', updatedAt: 3_000 },
    ['queued', 'running'],
  );
  assert.deepEqual(skippedUnknown, persistedUnknown);
  assert.equal(store.get(unknown.origin, unknown.conversationKey, unknown.taskId).state, 'unknown');

  const completed = task();
  store.reserve(completed);
  const persistedCompleted = store.update(completed.taskId, { state: 'completed', updatedAt: 4_000 });
  const skippedCompleted = store.update(
    completed.taskId,
    { state: 'cancel_requested', updatedAt: 5_000 },
    ['queued', 'running', 'unknown'],
  );
  assert.deepEqual(skippedCompleted, persistedCompleted);
  assert.equal(store.get(completed.origin, completed.conversationKey, completed.taskId).state, 'completed');
});

test('marks only tasks whose owner process no longer exists as unknown', (t) => {
  const store = new TaskStore(testDirectory(t));
  t.after(() => store.close());
  const living = task({ ownerId: 'living', ownerPid: process.pid });
  const orphan = task({ ownerId: 'dead', ownerPid: 2_147_483_647 });
  store.reserve(living);
  store.reserve(orphan);

  assert.equal(store.markOrphans(), 1);
  assert.equal(store.get(living.origin, living.conversationKey, living.taskId)?.state, 'queued');
  assert.equal(store.get(orphan.origin, orphan.conversationKey, orphan.taskId)?.state, 'unknown');
  assert.deepEqual(store.listOwned('living').map((entry) => entry.taskId), [living.taskId]);
  assert.equal(store.markOrphans(), 0);
});

interface WorkerHandle {
  child: ChildProcess;
  ready: Promise<void>;
  result: Promise<ReserveResult>;
}

function startWorker(record: TaskRecord, stateDir: string): WorkerHandle {
  const workerPath = fileURLToPath(new URL('./helpers/store-worker.ts', import.meta.url));
  const child = fork(workerPath, [stateDir, JSON.stringify(record)], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  let readyResolve!: () => void;
  let resultResolve!: (result: ReserveResult) => void;
  let resultReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const result = new Promise<ReserveResult>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    if (message.type === 'ready') readyResolve();
    if (message.type === 'result' && 'result' in message) resultResolve(message.result as ReserveResult);
    if (message.type === 'error' && 'error' in message) resultReject(new Error(String(message.error)));
  });
  child.on('error', resultReject);
  child.on('exit', (code) => {
    if (code && code !== 0) resultReject(new Error(`worker exited ${code}: ${stderr}`));
  });
  return { child, ready, result };
}
