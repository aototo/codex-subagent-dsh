import { matchesRequestedSelection, modelSelectionFromHeaderEvent } from './model-routing.js';
import type { ModelSelection, SessionSnapshot, TaskRecord, WireEvent } from './types.js';

export const RECOVERY_MAX_RESULT_CHARS = 64 * 1024;

export type RecoveryHistory =
  | { ok: true; turn: number; terminalSeq: number; reason: 'completed'; result: string; actualModel?: ModelSelection; actualModelSeq?: number }
  | { ok: true; turn: number; terminalSeq: number; reason: 'aborted'; actualModel?: ModelSelection; actualModelSeq?: number }
  | { ok: false; error: string };

const invalid = (error: string): RecoveryHistory => ({ ok: false, error });

function messageText(event: WireEvent): string | undefined {
  const content = event.data?.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block: unknown): block is { type: 'text'; text: string } => {
      if (block === null || typeof block !== 'object') return false;
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string';
    })
    .map(block => block.text)
    .join('\n');
  return text.length > 0 ? text : undefined;
}

/**
 * Proves only the durable history facts needed for terminal recovery. The
 * caller must separately prove the session is stopped and its queues are empty.
 */
export function inspectRecoveryHistory(task: TaskRecord, snapshot: SessionSnapshot): RecoveryHistory {
  if (snapshot.header?.id !== task.sessionId) return invalid('RECOVERY_SESSION_MISMATCH');
  if (snapshot.hasMore !== false) return invalid('RECOVERY_HISTORY_TRUNCATED');
  if (!Number.isSafeInteger(snapshot.cursor) || snapshot.cursor < 0 || !Array.isArray(snapshot.records)) {
    return invalid('RECOVERY_HISTORY_INVALID');
  }
  if (snapshot.records.length !== snapshot.cursor + 1) return invalid('RECOVERY_HISTORY_INCOMPLETE');
  if (snapshot.projections?.asOfSeq !== snapshot.cursor) return invalid('RECOVERY_SNAPSHOT_PROJECTION_STALE');

  let turn: number | undefined;
  let promptSeq: number | undefined;
  let result: string | undefined;
  let terminal: WireEvent | undefined;
  let actualModel: ModelSelection | undefined;
  let actualModelSeq: number | undefined;
  const requestedModel = task.input?.modelSelection;

  for (let index = 0; index < snapshot.records.length; index++) {
    const record = snapshot.records[index];
    const event = record?.event;
    if (record?.type !== 'event' || event?.seq !== index) return invalid('RECOVERY_HISTORY_GAPPED');

    if (event.type === 'turn/start') {
      if (turn !== undefined || terminal !== undefined || !Number.isSafeInteger(event.data?.turn)) {
        return invalid('RECOVERY_FOREIGN_TURN');
      }
      turn = event.data.turn;
      if (task.turn !== undefined && task.turn !== turn) return invalid('RECOVERY_FOREIGN_TURN');
      continue;
    }

    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (turn === undefined || promptSeq !== undefined || terminal !== undefined || event.data.source.rpcId !== task.taskId) {
        return invalid('RECOVERY_PROMPT_CORRELATION_FAILED');
      }
      promptSeq = event.seq;
      continue;
    }

    if (event.type === 'assistant/message') {
      if (turn === undefined || promptSeq === undefined || terminal !== undefined || event.data?.turn !== turn) {
        return invalid('RECOVERY_FOREIGN_MESSAGE');
      }
      const text = messageText(event);
      if (text !== undefined && text.length > RECOVERY_MAX_RESULT_CHARS) return invalid('RECOVERY_RESULT_TOO_LARGE');
      // Do not reuse an interim answer when the last assistant record is empty
      // or tool-only. A later final text message can establish the result again.
      result = text;
      continue;
    }

    if (event.type === 'request/header') {
      // Legacy tasks did not request a model pin and remain compatible with
      // older or provider-specific request/header shapes.
      if (requestedModel === undefined) continue;
      if (turn === undefined || promptSeq === undefined || terminal !== undefined) {
        return invalid('RECOVERY_MODEL_HEADER_UNCORRELATED');
      }
      const observed = modelSelectionFromHeaderEvent(event);
      if (observed === undefined) return invalid('RECOVERY_MODEL_HEADER_INVALID');
      if (!matchesRequestedSelection(observed, requestedModel)) {
        return invalid('RECOVERY_MODEL_ROUTE_MISMATCH');
      }
      actualModel = observed;
      actualModelSeq = event.seq;
      continue;
    }

    if (/^(?:tool|command|exec)(?:\/|\b)/.test(event.type)) {
      // An interim answer is not the final result if execution followed it.
      result = undefined;
      continue;
    }

    if (event.type === 'turn/end') {
      if (
        turn === undefined ||
        promptSeq === undefined ||
        terminal !== undefined ||
        event.data?.turn !== turn ||
        event.seq !== snapshot.cursor
      ) {
        return invalid('RECOVERY_TERMINAL_MISMATCH');
      }
      terminal = event;
    }
  }

  if (turn === undefined || promptSeq === undefined || terminal === undefined) {
    return invalid('RECOVERY_HISTORY_INCOMPLETE');
  }
  const reason = terminal.data?.reason?.kind;
  if (reason === 'completed') {
    if (requestedModel !== undefined && actualModel === undefined) {
      return invalid('RECOVERY_MODEL_ROUTE_NOT_OBSERVED');
    }
    if (result === undefined) return invalid('RECOVERY_NO_VERIFIABLE_RESULT');
    return {
      ok: true,
      turn,
      terminalSeq: terminal.seq,
      reason,
      result,
      ...(actualModel === undefined ? {} : { actualModel, actualModelSeq })
    };
  }
  if (reason === 'aborted') {
    return {
      ok: true,
      turn,
      terminalSeq: terminal.seq,
      reason,
      ...(actualModel === undefined ? {} : { actualModel, actualModelSeq })
    };
  }
  return invalid('RECOVERY_TERMINAL_NOT_RESTORABLE');
}
