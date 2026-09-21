import type { WireEvent } from './types.js';

const outcomes = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Bounded audit-pair tracking. Never retain reasons, commands, or tool arguments. */
export class ApprovalState {
  private requests = new Map<string, { toolName: string; callId?: string; outcome?: string }>();
  pending = 0;

  accept(event: WireEvent): boolean {
    const d = event.data;
    if (!d || typeof d !== 'object' || !token(d.id)) return false;
    const previous = this.requests.get(d.id);
    if (event.type === 'approval/asked') {
      if (!token(d.toolName) || (d.callId !== undefined && !token(d.callId))) return false;
      if (previous !== undefined) {
        return previous.outcome === undefined && previous.toolName === d.toolName && previous.callId === d.callId;
      }
      if (this.requests.size >= 1024) return false;
      this.requests.set(d.id, { toolName: d.toolName, callId: d.callId });
      this.pending++;
      return true;
    }
    if (event.type !== 'approval/decided' || !outcomes.has(d.outcome) || previous === undefined) return false;
    if (previous.outcome !== undefined) return previous.outcome === d.outcome;
    previous.outcome = d.outcome;
    this.pending--;
    return true;
  }

  clear() { this.requests.clear(); this.pending = 0; }
}
