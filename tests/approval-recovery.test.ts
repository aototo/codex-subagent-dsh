import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRecoveryHistory } from '../src/reconcile.js';
import type { SessionSnapshot, TaskRecord } from '../src/types.js';

const task = { sessionId: 'session-approval', taskId: 'approval-task', turn: 1 } as TaskRecord;
const ask = { type: 'approval/asked', data: { id: 'approval-1', toolName: 'test' } };
const decide = (outcome: string) => ({ type: 'approval/decided', data: { id: 'approval-1', outcome } });
function snapshot(approvals: { type: string; data: unknown }[], completed = true): SessionSnapshot {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: task.taskId } } },
    ...approvals,
    ...(completed ? [
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'verified final' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] : []),
  ];
  return { type: 'snapshot', header: { id: task.sessionId }, cursor: events.length - 1,
    hasMore: false, projections: { asOfSeq: events.length - 1 },
    records: events.map((event, seq) => ({ type: 'event', event: { ...event, seq } })) };
}

test('terminal recovery requires paired valid approval history, regardless of decision outcome', () => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    const result = inspectRecoveryHistory(task, snapshot([ask, decide(outcome)]));
    assert.equal(result.ok, true, outcome);
  }
  for (const approvals of [[ask], [decide('allowed-once')], [ask, decide('invented')],
    [ask, decide('allowed-once'), decide('rejected')], [ask, decide('allowed-once'), ask]]) {
    assert.equal(inspectRecoveryHistory(task, snapshot(approvals)).ok, false);
  }
});

test('historical pending request never establishes a live waiting state', () => {
  assert.equal(inspectRecoveryHistory(task, snapshot([ask], false)).ok, false);
  const truncated = snapshot([ask, decide('allowed-once')]);
  truncated.hasMore = true;
  assert.equal(inspectRecoveryHistory(task, truncated).ok, false);
});

test('approval outside correlated prompt/turn cannot restore a terminal state', () => {
  const value = snapshot([ask, decide('allowed-once')]);
  const records = value.records!;
  records.unshift(...records.splice(2, 1));
  records.forEach((record, seq) => { record.event.seq = seq; });
  assert.equal(inspectRecoveryHistory(task, value).ok, false);
});
