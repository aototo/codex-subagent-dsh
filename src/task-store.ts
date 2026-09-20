import { chmodSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { TERMINAL_STATES, type TaskRecord, type TaskState } from './types.js';

const DATABASE_NAME = 'tasks.sqlite3';
const BUSY_TIMEOUT_MS = 5_000;
const TERMINAL_STATE_SET = new Set<string>(TERMINAL_STATES);

interface TaskRow {
  task_id: string;
  request_id: string;
  conversation_key: string;
  origin: string;
  input_hash: string;
  input_json: string;
  cwd: string;
  mode: 'read' | 'write';
  session_id: string;
  state: string;
  owner_id: string;
  owner_pid: number;
  created_at: number;
  updated_at: number;
  deadline_at: number;
  attempt: number;
  turn: number | null;
  last_seq: number | null;
  result: string | null;
  error: string | null;
  guidance: string | null;
  end_reason: string | null;
  configured_model_json: string | null;
  actual_model_json: string | null;
  actual_model_seq: number | null;
}

export interface ReserveResult {
  created: boolean;
  task: TaskRecord;
}

type StoredTaskPatch = Partial<
  Pick<
    TaskRecord,
    | 'sessionId'
    | 'state'
    | 'updatedAt'
    | 'deadlineAt'
    | 'attempt'
    | 'turn'
    | 'lastSeq'
    | 'result'
    | 'error'
    | 'guidance'
    | 'endReason'
    | 'configuredModel'
    | 'actualModel'
    | 'actualModelSeq'
  >
>;

export type TaskPatch = Omit<StoredTaskPatch, 'error'> & { error?: string | null };

export interface TaskVersion {
  state: TaskState;
  updatedAt: number;
  endReason?: string;
}

export class TaskStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(stateDir: string) {
    const privateDir = resolve(stateDir);
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);

    const databasePath = resolve(privateDir, DATABASE_NAME);
    this.#database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#database.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        origin TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        turn INTEGER,
        last_seq INTEGER,
        result TEXT,
        error TEXT,
        guidance TEXT,
        end_reason TEXT,
        configured_model_json TEXT,
        actual_model_json TEXT,
        actual_model_seq INTEGER,
        UNIQUE(origin, conversation_key, request_id)
      );
      CREATE INDEX IF NOT EXISTS tasks_owner_id_idx ON tasks(owner_id);
      CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);
    `);
    this.#transaction(() => {
      const columns = new Set((this.#database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(row => row.name));
      if (!columns.has('configured_model_json')) this.#database.exec('ALTER TABLE tasks ADD COLUMN configured_model_json TEXT');
      if (!columns.has('actual_model_json')) this.#database.exec('ALTER TABLE tasks ADD COLUMN actual_model_json TEXT');
      if (!columns.has('actual_model_seq')) this.#database.exec('ALTER TABLE tasks ADD COLUMN actual_model_seq INTEGER');
    });
  }

  reserve(record: TaskRecord): ReserveResult {
    this.#assertOpen();
    const normalizedRecord: TaskRecord = {
      ...record,
      cwd: normalizeDirectory(record.cwd),
    };

    return this.#transaction(() => {
      const duplicate = this.#database
        .prepare(
          `SELECT * FROM tasks
           WHERE origin = ? AND conversation_key = ? AND request_id = ?`,
        )
        .get(record.origin, record.conversationKey, record.requestId) as TaskRow | undefined;

      if (duplicate) {
        if (duplicate.input_hash !== record.inputHash) {
          throw new Error('request parameters conflict');
        }
        return { created: false, task: rowToTask(duplicate) };
      }

      const taskIdConflict = this.#database
        .prepare('SELECT 1 FROM tasks WHERE task_id = ?')
        .get(record.taskId);
      if (taskIdConflict) {
        throw new Error('task id conflict');
      }

      const occupyingRows = this.#database
        .prepare(
          `SELECT cwd, mode FROM tasks
           WHERE state NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .all() as Array<Pick<TaskRow, 'cwd' | 'mode'>>;

      for (const occupying of occupyingRows) {
        if (
          directoriesOverlap(normalizedRecord.cwd, occupying.cwd) &&
          (normalizedRecord.input.mode === 'write' || occupying.mode === 'write')
        ) {
          throw new Error('workspace is busy');
        }
      }

      this.#database
        .prepare(
          `INSERT INTO tasks (
            task_id, request_id, conversation_key, origin, input_hash, input_json,
            cwd, mode, session_id, state, owner_id, owner_pid, created_at,
            updated_at, deadline_at, attempt, turn, last_seq, result, error,
            guidance, end_reason, configured_model_json, actual_model_json,
            actual_model_seq
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalizedRecord.taskId,
          normalizedRecord.requestId,
          normalizedRecord.conversationKey,
          normalizedRecord.origin,
          normalizedRecord.inputHash,
          JSON.stringify(normalizedRecord.input),
          normalizedRecord.cwd,
          normalizedRecord.input.mode,
          normalizedRecord.sessionId,
          normalizedRecord.state,
          normalizedRecord.ownerId,
          normalizedRecord.ownerPid,
          normalizedRecord.createdAt,
          normalizedRecord.updatedAt,
          normalizedRecord.deadlineAt,
          normalizedRecord.attempt,
          optionalValue(normalizedRecord.turn),
          optionalValue(normalizedRecord.lastSeq),
          optionalValue(normalizedRecord.result),
          optionalValue(normalizedRecord.error),
          optionalValue(normalizedRecord.guidance),
          optionalValue(normalizedRecord.endReason),
          optionalValue(normalizedRecord.configuredModel === undefined ? undefined : JSON.stringify(normalizedRecord.configuredModel)),
          optionalValue(normalizedRecord.actualModel === undefined ? undefined : JSON.stringify(normalizedRecord.actualModel)),
          optionalValue(normalizedRecord.actualModelSeq),
        );

      return { created: true, task: normalizedRecord };
    });
  }

  get(origin: string, conversationKey: string, taskId: string): TaskRecord {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new Error('task not found');
    if (row.origin !== origin || row.conversation_key !== conversationKey) {
      throw new Error('task scope mismatch');
    }
    return rowToTask(row);
  }

  update(
    taskId: string,
    patch: TaskPatch,
    expectedStates?: readonly TaskState[],
    expectedVersion?: TaskVersion,
  ): TaskRecord {
    this.#assertOpen();
    return this.#transaction(() => {
      const currentRow = this.#database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
        | TaskRow
        | undefined;
      if (!currentRow) throw new Error('task not found');

      if (expectedStates !== undefined && !expectedStates.includes(currentRow.state as TaskState)) {
        return rowToTask(currentRow);
      }

      if (
        expectedVersion !== undefined &&
        (
          currentRow.state !== expectedVersion.state ||
          currentRow.updated_at !== expectedVersion.updatedAt ||
          (currentRow.end_reason ?? undefined) !== expectedVersion.endReason
        )
      ) {
        return rowToTask(currentRow);
      }

      if (
        TERMINAL_STATE_SET.has(currentRow.state) &&
        patch.state !== undefined &&
        patch.state !== currentRow.state
      ) {
        throw new Error('terminal task state is immutable');
      }

      const assignments: string[] = [];
      const values: SQLInputValue[] = [];
      const set = (column: string, value: SQLInputValue): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };

      if (patch.sessionId !== undefined) set('session_id', patch.sessionId);
      if (patch.state !== undefined) set('state', patch.state);
      if (patch.deadlineAt !== undefined) set('deadline_at', patch.deadlineAt);
      if (patch.attempt !== undefined) set('attempt', patch.attempt);
      if (patch.turn !== undefined) set('turn', patch.turn);
      if (patch.lastSeq !== undefined) set('last_seq', patch.lastSeq);
      if (patch.result !== undefined) set('result', patch.result);
      if (patch.error !== undefined) set('error', patch.error);
      if (patch.guidance !== undefined) set('guidance', patch.guidance);
      if (patch.endReason !== undefined) set('end_reason', patch.endReason);
      if (patch.configuredModel !== undefined) set('configured_model_json', JSON.stringify(patch.configuredModel));
      if (patch.actualModel !== undefined) set('actual_model_json', JSON.stringify(patch.actualModel));
      if (patch.actualModelSeq !== undefined) set('actual_model_seq', patch.actualModelSeq);
      set('updated_at', Math.max(patch.updatedAt ?? Date.now(), currentRow.updated_at + 1));

      values.push(taskId);
      this.#database
        .prepare(`UPDATE tasks SET ${assignments.join(', ')} WHERE task_id = ?`)
        .run(...values);

      const updated = this.#database
        .prepare('SELECT * FROM tasks WHERE task_id = ?')
        .get(taskId) as unknown as TaskRow;
      return rowToTask(updated);
    });
  }

  listOwned(ownerId: string): TaskRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at, task_id')
      .all(ownerId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  markOrphans(): number {
    this.#assertOpen();
    return this.#transaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT task_id, owner_pid, state FROM tasks
           WHERE state NOT IN ('completed', 'failed', 'cancelled', 'unknown')`,
        )
        .all() as Array<Pick<TaskRow, 'task_id' | 'owner_pid' | 'state'>>;
      const deadPids = new Map<number, boolean>();
      let changed = 0;
      const now = Date.now();

      for (const row of rows) {
        let dead = deadPids.get(row.owner_pid);
        if (dead === undefined) {
          dead = !pidExists(row.owner_pid);
          deadPids.set(row.owner_pid, dead);
        }
        if (!dead) continue;

        const result = this.#database
          .prepare(
            `UPDATE tasks SET state = 'unknown', updated_at = MAX(updated_at + 1, ?)
             WHERE task_id = ? AND state = ?`,
          )
          .run(now, row.task_id, row.state);
        changed += Number(result.changes);
      }
      return changed;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('task store is closed');
  }
}

function normalizeDirectory(directory: string): string {
  return resolve(directory);
}

function directoriesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeDirectory(left);
  const normalizedRight = normalizeDirectory(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftPrefix = normalizedLeft.endsWith(sep) ? normalizedLeft : `${normalizedLeft}${sep}`;
  const rightPrefix = normalizedRight.endsWith(sep) ? normalizedRight : `${normalizedRight}${sep}`;
  return normalizedLeft.startsWith(rightPrefix) || normalizedRight.startsWith(leftPrefix);
}

function optionalValue(value: SQLInputValue | undefined): SQLInputValue {
  return value === undefined ? null : value;
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    requestId: row.request_id,
    conversationKey: row.conversation_key,
    origin: row.origin,
    inputHash: row.input_hash,
    input: JSON.parse(row.input_json) as TaskRecord['input'],
    cwd: row.cwd,
    sessionId: row.session_id,
    state: row.state as TaskState,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    attempt: row.attempt,
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.last_seq === null ? {} : { lastSeq: row.last_seq }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.guidance === null ? {} : { guidance: row.guidance }),
    ...(row.end_reason === null ? {} : { endReason: row.end_reason }),
    ...(row.configured_model_json === null ? {} : { configuredModel: JSON.parse(row.configured_model_json) }),
    ...(row.actual_model_json === null ? {} : { actualModel: JSON.parse(row.actual_model_json) }),
    ...(row.actual_model_seq === null ? {} : { actualModelSeq: row.actual_model_seq }),
  };
}

function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ESRCH'
    );
  }
}
