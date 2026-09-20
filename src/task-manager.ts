import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BridgeConfig } from './config.js';
import { inspectRecoveryHistory } from './reconcile.js';
import { discoverableModels, matchesRequestedSelection, modelSelectionFromHeaderEvent, parseModelSelection, validateCapabilities, validateSetResponse } from './model-routing.js';
import { TaskStore } from './task-store.js';
import { TERMINAL_STATES, type DshApi, type SessionSnapshot, type SubmitInput, type Subscription, type TaskRecord, type WireEvent } from './types.js';

const execute = promisify(execFile);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const RECOVERY_BUDGET_MS = 10_000;
const RECOVERY_LIST_MAX_PAGES = 20;
const RECOVERY_LIST_MAX_RETRIES = 4;
interface ActiveRun {
  task: TaskRecord;
  sub?: Subscription;
  timer?: NodeJS.Timeout;
  cancelTimer?: NodeJS.Timeout;
  submitted: boolean;
  seenPrompt: boolean;
  turn?: number;
  lastSeq: number;
  result: string;
  finishing: boolean;
}
const terminal = (task: TaskRecord) => TERMINAL_STATES.includes(task.state);
function stable(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function safeError(error: unknown): string {
  // Do not forward network bodies, prompts, cookies or arbitrary exception text.
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_/-]{1,80}$/.test(code) ? code : 'DSH_REQUEST_FAILED';
}

export class TaskManager {
  readonly ownerId = randomUUID();
  private active = new Map<string, ActiveRun>();
  private cancelChecks = new Set<NodeJS.Timeout>();
  private recoveries = new Map<string, Promise<TaskRecord>>();
  private closed = false;
  constructor(readonly config: BridgeConfig, readonly client: DshApi, readonly store: TaskStore) { store.markOrphans(); }

  async status(connectCommand: string, includeModels = false) {
    const base = { origin: this.client.origin, tools: ['dsh_status', 'dsh_submit', 'dsh_task', 'dsh_cancel'] };
    if (!await this.client.probe()) {
      return {
        ...base,
        connected: false,
        dshRunning: false,
        state: 'dsh_not_running',
        code: 'DSH_NOT_RUNNING',
        nextAction: 'start_dsh',
        guidance: `Start DSH at ${this.client.origin}, then call dsh_status again.`,
      };
    }
    try {
      await this.client.rpc('session/list', {});
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'AUTH_REQUIRED' || code === 'CREDENTIAL_UNAVAILABLE') {
        return {
          ...base,
          connected: false,
          dshRunning: true,
          state: 'authentication_required',
          code,
          nextAction: 'run_connect_command',
          connectCommand,
          guidance: 'Run connectCommand in a local terminal and paste the current DSH login URL there. Never paste the login URL or credentials into chat.',
        };
      }
      throw error;
    }
    const ready = { ...base, connected: true, dshRunning: true, state: 'ready', taskTimeoutMs: this.config.taskTimeoutMs, maxWaitMs: this.config.maxWaitMs, scope: 'conversationKey is logical grouping, not authentication', permissionHandling: 'Handle DSH approval/questions in DSH. This version does not automatically answer or reliably detect all waits.' };
    if (!includeModels) return ready;
    try {
      const capabilities = await this.client.companionRpc('capabilities.get', {});
      return {
        ...ready,
        modelRouting: {
          available: true,
          protocol: 1,
          persistence: 'session-log',
          catalog: discoverableModels(capabilities),
        },
      };
    } catch (error) {
      const remoteCode = safeError(error);
      const missing = remoteCode === 'HTTP_ERROR';
      return {
        ...ready,
        modelRouting: {
          available: false,
          code: missing ? 'MODEL_ROUTING_COMPANION_MISSING' : 'MODEL_ROUTING_CAPABILITY_UNSUPPORTED',
          guidance: missing
            ? 'Install and enable the bundled DSH companion in this DSH profile to use modelSelection.'
            : 'The enabled DSH companion did not return a supported, sanitized model catalog.',
        },
      };
    }
  }

  private async normalize(input: SubmitInput): Promise<SubmitInput> {
    const cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be an existing directory');
    for (const allowed of input.allowedPaths ?? []) {
      if (path.isAbsolute(allowed) || allowed.split(/[\\/]/).includes('..')) throw new Error('allowedPaths must be workspace-relative paths without ..');
    }
    if (input.mode === 'write') {
      if (!input.baselineCommit || !/^[a-f0-9]{40}$/i.test(input.baselineCommit)) throw new Error('write tasks require a full baselineCommit');
      if (!input.allowedPaths?.length) throw new Error('write tasks require allowedPaths');
    }
    if (input.modelSelection !== undefined && parseModelSelection(input.modelSelection) === undefined) {
      throw new Error('modelSelection requires non-empty provider/model and an optional non-empty reasoningEffort');
    }
    return { ...input, cwd };
  }

  private async validateWriteWorkspace(input: SubmitInput) {
    if (input.mode === 'write') {
      const cwd = input.cwd;
      const git = async (...args: string[]) => (await execute('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 256 * 1024 })).stdout.trim();
      const root = await realpath(await git('rev-parse', '--show-toplevel'));
      if (root !== cwd) throw new Error('write cwd must be the linked worktree root');
      const gitDir = await git('rev-parse', '--absolute-git-dir');
      const commonDir = await git('rev-parse', '--git-common-dir');
      if (await realpath(gitDir) === await realpath(path.resolve(cwd, commonDir))) throw new Error('write tasks require a separate Git linked worktree');
      if (await git('rev-parse', 'HEAD') !== input.baselineCommit!.toLowerCase()) throw new Error('baselineCommit does not match worktree HEAD');
      if (await git('status', '--porcelain')) throw new Error('write worktree must be clean before delegation');
    }
  }

  async submit(raw: SubmitInput): Promise<TaskRecord> {
    if (this.closed) throw new Error('Task manager is closing');
    const input = await this.normalize(raw);
    if (this.closed) throw new Error('Task manager is closing');
    const now = Date.now();
    const record: TaskRecord = { taskId: randomUUID(), requestId: input.requestId, conversationKey: input.conversationKey, origin: this.client.origin, inputHash: createHash('sha256').update(stable(input)).digest('hex'), input, cwd: input.cwd, sessionId: 'session-' + randomUUID(), state: 'queued', ownerId: this.ownerId, ownerPid: process.pid, createdAt: now, updatedAt: now, deadlineAt: now + this.config.taskTimeoutMs, attempt: 1 };
    const reserved = this.store.reserve(record);
    if (!reserved.created) return reserved.task;
    const run: ActiveRun = { task: reserved.task, submitted: false, seenPrompt: false, lastSeq: -1, result: '', finishing: false };
    this.active.set(record.taskId, run);
    run.timer = setTimeout(() => { void this.cancel(record.conversationKey, record.taskId).catch(() => this.uncertain(run, 'TIMEOUT_CANCEL_FAILED')); }, Math.max(1, record.deadlineAt - Date.now()));
    // Ownership is durable before this asynchronous dispatch can contact DSH.
    void this.dispatch(run);
    return reserved.task;
  }

  private current(run: ActiveRun) { return this.store.get(this.client.origin, run.task.conversationKey, run.task.taskId); }
  private update(run: ActiveRun, patch: Partial<TaskRecord>) { run.task = this.store.update(run.task.taskId, { ...patch, updatedAt: Date.now() }, ['queued', 'running', 'waiting_permission', 'waiting_input', 'cancel_requested']); return run.task; }
  private mayDispatch(run: ActiveRun) {
    if (!this.active.has(run.task.taskId)) return false;
    const state = this.current(run).state;
    if (state === 'queued') return true;
    if (state === 'cancel_requested') this.store.update(run.task.taskId, { state: 'cancelled', endReason: 'cancelled_before_prompt' }, ['cancel_requested']);
    this.cleanup(run);
    return false;
  }
  private cleanup(run: ActiveRun) {
    this.active.delete(run.task.taskId);
    clearTimeout(run.timer); clearTimeout(run.cancelTimer);
    run.sub?.close();
  }
  private uncertain(run: ActiveRun, error: string) {
    if (!this.active.has(run.task.taskId)) return;
    if (!terminal(this.current(run))) this.update(run, { state: 'unknown', error, guidance: 'Inspect this session in DSH before retrying. No automatic resubmission; workspace reservation is retained.' });
    this.cleanup(run);
  }

  private async dispatch(run: ActiveRun) {
    // Validate after idempotent reserve: retrying an existing task must still work
    // when the first execution has already made its worktree dirty.
    try { await this.validateWriteWorkspace(run.task.input); }
    catch {
      if (!this.active.has(run.task.taskId)) return;
      const current = this.store.update(run.task.taskId, { state: 'failed', error: 'WORKSPACE_BASELINE_INVALID', guidance: 'Write tasks require a clean separate Git linked worktree whose HEAD matches baselineCommit.' }, ['queued']);
      if (current.state === 'cancel_requested') this.mayDispatch(run);
      else this.cleanup(run);
      return;
    }
    if (!this.active.has(run.task.taskId)) return;
    if (!this.mayDispatch(run)) return;
    try {
      const created = await this.client.rpc<{sessionId: string}>('session/create', { sessionId: run.task.sessionId, cwd: run.task.cwd, agentPreset: 'standard' });
      if (!this.active.has(run.task.taskId)) return;
      if (created.sessionId !== run.task.sessionId) { this.uncertain(run, 'SESSION_ID_MISMATCH'); return; }
      if (!this.mayDispatch(run)) return;
      if (run.task.input.modelSelection !== undefined) {
        try {
          validateCapabilities(await this.client.companionRpc('capabilities.get', {}));
          if (!this.active.has(run.task.taskId) || !this.mayDispatch(run)) return;
          const receipt = await this.client.companionRpc('selection.set', {
            sessionId: run.task.sessionId,
            selection: run.task.input.modelSelection,
          });
          if (!this.active.has(run.task.taskId) || !this.mayDispatch(run)) return;
          const configuredModel = validateSetResponse(receipt, run.task.sessionId, run.task.input.modelSelection);
          this.update(run, { configuredModel });
        } catch (error) {
          if (!this.active.has(run.task.taskId)) return;
          const current = this.current(run);
          if (current.state !== 'queued') {
            this.mayDispatch(run);
            return;
          }
          const remoteCode = safeError(error);
          this.store.update(run.task.taskId, {
            state: 'failed',
            error: remoteCode === 'DSH_REQUEST_FAILED' ? 'MODEL_ROUTING_RESPONSE_INVALID' : remoteCode,
            guidance: remoteCode === 'HTTP_ERROR'
              ? 'Install and enable the bundled DSH companion in the addressed DSH profile. No prompt was submitted.'
              : 'The requested Session model was not durably confirmed. Check companion capabilities and the exact provider/model/effort. No prompt was submitted.',
          }, ['queued']);
          this.cleanup(run);
          return;
        }
      }
      if (!this.mayDispatch(run)) return;
      const sub = await this.client.follow(run.task.sessionId, {
        snapshot: snapshot => {
          if (snapshot.header.id !== run.task.sessionId || snapshot.records?.some(r => r.event?.type === 'turn/start')) { this.uncertain(run, 'SESSION_ALREADY_USED'); return; }
          run.lastSeq = snapshot.projections?.asOfSeq ?? -1;
        },
        event: event => this.onEvent(run, event),
        error: () => this.uncertain(run, 'EVENT_CONNECTION_FAILED'),
        closed: () => this.uncertain(run, 'EVENT_CONNECTION_CLOSED'),
      });
      run.sub = sub;
      if (!this.active.has(run.task.taskId)) { sub.close(); return; }
      if (!this.mayDispatch(run)) return;
      run.submitted = true;
      const accepted = await this.client.rpc<{ accepted: boolean }>('session/prompt', { sessionId: run.task.sessionId, requestId: run.task.taskId, mode: 'queue', content: [{ type: 'text', text: this.prompt(run.task) }], clientTimeZone: 'UTC' });
      if (!this.active.has(run.task.taskId)) return;
      if (accepted.accepted !== true) this.uncertain(run, 'SUBMISSION_NOT_CONFIRMED');
    } catch (error) {
      if (!this.active.has(run.task.taskId)) return;
      const definite = (error as { ambiguous?: boolean })?.ambiguous === false;
      if (definite && !run.turn && !run.seenPrompt) { this.update(run, { state: 'failed', error: safeError(error) }); this.cleanup(run); }
      else this.uncertain(run, safeError(error));
    }
  }

  private prompt(task: TaskRecord) {
    const i = task.input;
    return [
      'You are an external execution agent delegated by Codex. Complete only the bounded task below. Codex owns planning, routing and final acceptance.',
      'Do not invoke codex-subagent-dsh recursively. Do not commit, push, publish, or change credentials. Ask through DSH if permission or clarification is needed.',
      i.mode === 'read' ? 'READ-ONLY TASK: do not modify files or execute state-changing operations.' : 'WRITE TASK: modify only the listed paths in the provided isolated workspace; preserve unrelated content.',
      'Task constraints are instructions, not an OS sandbox. Do not claim stronger isolation.',
      `Workspace: ${task.cwd}`,
      `Allowed paths: ${(i.allowedPaths ?? []).join(', ') || '(read-only workspace inspection)'}`,
      `Goal: ${i.goal}`,
      `Context: ${i.context ?? '(none)'}`,
      `Acceptance criteria:\n${i.acceptanceCriteria.map(s => '- ' + s).join('\n')}`,
      'Follow the output format explicitly requested by the task, including exact-output requests. Otherwise return a concise result with changed/read file paths, relevant evidence, checks actually run and their results, and any remaining blockers. Never report checks you did not run.',
    ].join('\n\n');
  }

  private onEvent(run: ActiveRun, event: WireEvent) {
    if (!this.active.has(run.task.taskId) || event.seq <= run.lastSeq) return;
    if (this.current(run).state === 'unknown') { this.cleanup(run); return; }
    run.lastSeq = event.seq;
    if (run.finishing) {
      if (['turn/start', 'user/message', 'assistant/message', 'turn/end'].includes(event.type)) this.uncertain(run, 'EVENT_AFTER_TERMINAL');
      return;
    }
    const d = event.data;
    if (event.type === 'request/header') {
      const actualModel = modelSelectionFromHeaderEvent(event);
      const requested = run.task.input.modelSelection;
      if (requested === undefined) return;
      if (!run.seenPrompt || run.turn === undefined || actualModel === undefined || !matchesRequestedSelection(actualModel, requested)) {
        void this.client.rpc('session/cancel', { sessionId: run.task.sessionId }).catch(() => undefined);
        this.uncertain(run, 'MODEL_ROUTE_MISMATCH');
        return;
      }
      this.update(run, { actualModel, actualModelSeq: event.seq, lastSeq: event.seq });
    } else if (event.type === 'turn/start') {
      if (!run.submitted || (run.turn !== undefined && run.turn !== d.turn)) { this.uncertain(run, 'UNEXPECTED_TURN'); return; }
      run.turn = d.turn;
      this.update(run, { state: this.current(run).state === 'cancel_requested' ? 'cancel_requested' : 'running', turn: d.turn, lastSeq: event.seq, guidance: 'If DSH is awaiting approval or input, handle it in DSH; this client does not auto-answer.' });
    } else if (event.type === 'user/message' && d.source?.kind === 'user') {
      if (d.source.rpcId !== run.task.taskId) { this.uncertain(run, 'UNEXPECTED_USER_MESSAGE'); return; }
      run.seenPrompt = true;
    } else if (event.type === 'assistant/message' && d.turn === run.turn) {
      const text = d.message?.content?.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
      if (text) run.result = text.slice(0, 64 * 1024);
    } else if (event.type === 'turn/end') {
      if (run.turn === undefined || d.turn !== run.turn) { this.uncertain(run, 'TERMINAL_TURN_MISMATCH'); return; }
      run.finishing = true;
      void this.finish(run, d.reason?.kind, event.seq);
    }
  }

  private async quietSession(run: ActiveRun, terminalSeq: number): Promise<boolean> {
    for (let retry = 0; retry < 4; retry++) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const value: any = await this.client.rpc('session/list', cursor ? { cursor } : {});
        const session = value.items?.find((s: any) => s.sessionId === run.task.sessionId);
        if (session) {
          const inbox = session.projections?.values?.inbox;
          const asOfSeq = session.projections?.asOfSeq;
          if (Number.isSafeInteger(asOfSeq) && asOfSeq >= terminalSeq && run.lastSeq >= asOfSeq && session.running === false && Array.isArray(inbox?.['next-turn']) && inbox['next-turn'].length === 0 && Array.isArray(inbox?.['next-step']) && inbox['next-step'].length === 0) return true;
          break;
        }
        const next = value.nextCursor;
        if (typeof next !== 'string' || !next || seen.has(next)) break;
        seen.add(next); cursor = next;
      }
      if (retry < 3) await pause(100 * (retry + 1));
    }
    return false;
  }

  private async finish(run: ActiveRun, reason: string, seq: number) {
    try {
      if (!await this.quietSession(run, seq)) { this.uncertain(run, 'SESSION_NOT_CONFIRMED_IDLE'); return; }
      if (!this.active.has(run.task.taskId)) return;
      const latest = this.current(run);
      if (reason === 'completed' && latest.input.modelSelection !== undefined && latest.actualModel === undefined) {
        this.uncertain(run, 'MODEL_ROUTE_NOT_OBSERVED');
        return;
      }
      if (reason === 'completed' && run.seenPrompt && run.result) this.update(run, { state: 'completed', result: run.result, lastSeq: seq, endReason: reason, guidance: 'Execution ended. Codex must independently verify artifacts and acceptance criteria.' });
      else if (reason === 'aborted' && this.current(run).endReason === 'cancellation_requested') this.update(run, { state: 'cancelled', lastSeq: seq, endReason: reason, guidance: 'DSH termination and empty queue confirmed. Cancellation does not roll back file changes.' });
      else if (reason === 'completed') this.update(run, { state: 'failed', lastSeq: seq, endReason: reason, error: 'NO_VERIFIABLE_RESULT' });
      else if (['failure', 'aborted', 'interrupted'].includes(reason)) this.update(run, { state: 'failed', lastSeq: seq, endReason: reason, error: 'DSH_EXECUTION_STOPPED' });
      else { this.uncertain(run, 'UNRECOGNIZED_END_REASON'); return; }
      this.cleanup(run);
    } catch { this.uncertain(run, 'TERMINAL_STATE_CHECK_FAILED'); }
  }

  private recoveryVersion(task: TaskRecord) {
    return { state: task.state, updatedAt: task.updatedAt, endReason: task.endReason };
  }

  private sameRecoveryVersion(left: TaskRecord, right: TaskRecord) {
    return left.state === right.state && left.updatedAt === right.updatedAt && left.endReason === right.endReason;
  }

  private recoveryUnknown(task: TaskRecord, error: string, signal?: AbortSignal): TaskRecord {
    if (this.closed || signal?.aborted || task.state !== 'unknown') return task;
    return this.store.update(task.taskId, {
      state: 'unknown',
      error,
      guidance: 'Recovery could not prove a terminal DSH outcome. Inspect the original session; do not resubmit. The workspace reservation is retained.',
    }, ['unknown'], this.recoveryVersion(task));
  }

  private async recoverySessionState(
    task: TaskRecord,
    terminalSeq: number,
    active: () => boolean,
  ): Promise<{ confirmed: true } | { confirmed: false; error: string }> {
    let lastError = 'RECOVERY_SESSION_NOT_FOUND';
    for (let retry = 0; retry < RECOVERY_LIST_MAX_RETRIES && active(); retry++) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < RECOVERY_LIST_MAX_PAGES && active(); page++) {
        const value: any = await this.client.rpc('session/list', cursor ? { cursor } : {});
        if (!active()) return { confirmed: false, error: 'RECOVERY_BUDGET_EXCEEDED' };
        if (!Array.isArray(value?.items)) return { confirmed: false, error: 'RECOVERY_SESSION_LIST_INVALID' };
        const matches = value.items.filter((session: any) => session?.sessionId === task.sessionId);
        if (matches.length > 1) return { confirmed: false, error: 'RECOVERY_SESSION_LIST_INVALID' };
        if (matches.length === 1) {
          const session = matches[0];
          const inbox = session.projections?.values?.inbox;
          if (session.running !== false) lastError = 'RECOVERY_SESSION_NOT_IDLE';
          else if (
            !Array.isArray(inbox?.['next-turn']) ||
            inbox['next-turn'].length !== 0 ||
            !Array.isArray(inbox?.['next-step']) ||
            inbox['next-step'].length !== 0
          ) lastError = 'RECOVERY_SESSION_QUEUE_NOT_EMPTY';
          else if (session.projections?.asOfSeq !== terminalSeq) lastError = 'RECOVERY_SESSION_PROJECTION_STALE';
          else return { confirmed: true };
          break;
        }
        const next = value.nextCursor;
        if (typeof next !== 'string' || next.length === 0 || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      if (retry + 1 < RECOVERY_LIST_MAX_RETRIES && active()) await pause(100 * (retry + 1));
    }
    return { confirmed: false, error: lastError };
  }

  private async recover(task: TaskRecord, deadline: number, signal?: AbortSignal): Promise<TaskRecord> {
    const existing = this.recoveries.get(task.taskId);
    if (existing) return existing;
    if (Date.now() >= deadline) return task;

    let abandoned = false;
    let streamValid = true;
    let subscription: Subscription | undefined;
    const active = () => !abandoned && !this.closed && !signal?.aborted && Date.now() < deadline;
    const currentOr = (fallback: TaskRecord) => {
      if (this.closed) return fallback;
      try { return this.store.get(this.client.origin, fallback.conversationKey, fallback.taskId); }
      catch { return fallback; }
    };
    const work = (async (): Promise<TaskRecord> => {
      let snapshot: SessionSnapshot | undefined;
      try {
        const pendingSubscription = this.client.follow(task.sessionId, {
          snapshot: value => { snapshot = value; },
          event: () => { streamValid = false; },
          error: () => { streamValid = false; },
          closed: () => { streamValid = false; },
        });
        subscription = await pendingSubscription;
        if (!active() || !streamValid) return currentOr(task);
        if (snapshot === undefined) return this.recoveryUnknown(task, 'RECOVERY_SNAPSHOT_MISSING', signal);

        const history = inspectRecoveryHistory(task, snapshot);
        if (!history.ok) return this.recoveryUnknown(task, history.error, signal);
        const session = await this.recoverySessionState(task, history.terminalSeq, () => active() && streamValid);
        if (!active() || !streamValid) return currentOr(task);
        if (!session.confirmed) return this.recoveryUnknown(task, session.error, signal);

        const current = this.store.get(this.client.origin, task.conversationKey, task.taskId);
        if (!active() || !streamValid || terminal(current)) return current;
        // Bind remote proof to the exact local record that initiated it. A
        // concurrent cancellation or other state decision wins this attempt.
        if (!this.sameRecoveryVersion(current, task)) return current;
        const version = this.recoveryVersion(task);
        if (history.reason === 'completed') {
          if (current.state !== 'unknown') return current;
          return this.store.update(current.taskId, {
            state: 'completed',
            turn: history.turn,
            lastSeq: history.terminalSeq,
            result: history.result,
            ...(history.actualModel === undefined ? {} : { actualModel: history.actualModel, actualModelSeq: history.actualModelSeq }),
            error: null,
            endReason: history.reason,
            guidance: 'Recovered from the complete original DSH history. Codex must independently verify artifacts and acceptance criteria.',
          }, ['unknown'], version);
        }
        if (
          history.reason === 'aborted' &&
          task.endReason === 'cancellation_requested' &&
          current.state === 'unknown'
        ) {
          return this.store.update(current.taskId, {
            state: 'cancelled',
            turn: history.turn,
            lastSeq: history.terminalSeq,
            error: null,
            endReason: history.reason,
            guidance: 'Recovered a persisted cancellation intent plus an observed aborted DSH turn and empty queue. Cancellation does not roll back file changes.',
          }, ['unknown'], version);
        }
        return this.recoveryUnknown(current, 'RECOVERY_TERMINAL_CONFLICT', signal);
      } catch (error) {
        // Transport and protocol availability failures are not durable task
        // evidence. Keep the latest persisted state unchanged.
        void error;
        return currentOr(task);
      } finally {
        subscription?.close();
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<TaskRecord>(resolve => {
      timer = setTimeout(() => {
        abandoned = true;
        subscription?.close();
        resolve(currentOr(task));
      }, Math.max(1, deadline - Date.now()));
      timer.unref?.();
    });
    const recovery = Promise.race([work, timeout]).finally(() => {
      abandoned = true;
      clearTimeout(timer);
      subscription?.close();
      if (this.recoveries.get(task.taskId) === recovery) this.recoveries.delete(task.taskId);
    });
    this.recoveries.set(task.taskId, recovery);
    return recovery;
  }

  async task(conversationKey: string, taskId: string, waitMs = 0, signal?: AbortSignal): Promise<TaskRecord> {
    const startedAt = Date.now();
    const waitBudget = Math.min(Math.max(waitMs, 0), this.config.maxWaitMs);
    const until = startedAt + waitBudget;
    const inspectionAllowance = Math.min(this.config.rpcTimeoutMs, this.config.maxWaitMs);
    const operationDeadline = startedAt + Math.min(
      this.config.maxWaitMs,
      Math.max(waitBudget, inspectionAllowance),
    );
    do {
      this.store.markOrphans();
      const task = this.store.get(this.client.origin, conversationKey, taskId);
      if (terminal(task) || signal?.aborted) return task;
      if (task.state === 'unknown') {
        return await this.recover(task, Math.min(operationDeadline, Date.now() + RECOVERY_BUDGET_MS), signal);
      }
      if (Date.now() >= until) return task;
      await pause(Math.min(100, Math.max(1, until - Date.now())));
    } while (true);
  }

  async cancel(conversationKey: string, taskId: string): Promise<TaskRecord> {
    const task = this.store.get(this.client.origin, conversationKey, taskId);
    if (terminal(task) || task.state === 'cancel_requested') return task;
    const updated = this.store.update(taskId, { state: 'cancel_requested', endReason: 'cancellation_requested', updatedAt: Date.now(), guidance: 'Cancellation requested; termination is not yet confirmed.' }, ['queued', 'running', 'waiting_permission', 'waiting_input', 'unknown']);
    if (updated.state !== 'cancel_requested') return updated;
    const run = this.active.get(taskId);
    if (run && !run.submitted) return updated; // dispatch stops before prompt, even if create is in flight.
    try {
      const response = await this.client.rpc<{ accepted: boolean }>('session/cancel', { sessionId: task.sessionId });
      if (this.closed) return updated;
      if (response.accepted !== true) throw new Error('not accepted');
      if (run && this.active.has(taskId)) run.cancelTimer = setTimeout(() => this.uncertain(run, 'CANCEL_TERMINATION_UNCONFIRMED'), 5000);
      else {
        // Another live MCP instance may own the event subscription. Give its
        // terminal check time to settle; never treat the RPC receipt as stopped.
        const check = setTimeout(() => {
          this.cancelChecks.delete(check);
          const latest = this.store.get(this.client.origin, conversationKey, taskId);
          if (latest.state === 'cancel_requested') this.store.update(taskId, { state: 'unknown', error: 'CANCEL_TERMINATION_UNCONFIRMED', guidance: 'Cancellation was accepted but termination is unconfirmed. Check DSH; workspace remains reserved.' }, ['cancel_requested']);
        }, 5000);
        this.cancelChecks.add(check);
      }
    } catch {
      if (run) this.uncertain(run, 'CANCEL_REQUEST_UNCONFIRMED');
      else if (!this.closed) this.store.update(taskId, { state: 'unknown', error: 'CANCEL_REQUEST_UNCONFIRMED' }, ['cancel_requested']);
    }
    return this.closed ? updated : this.store.get(this.client.origin, conversationKey, taskId);
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.cancelChecks) clearTimeout(timer);
    this.cancelChecks.clear();
    for (const recovery of this.recoveries.values()) void recovery.catch(() => {});
    for (const run of [...this.active.values()]) this.uncertain(run, 'MCP_PROCESS_CLOSED');
  }
}
