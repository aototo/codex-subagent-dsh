export type TaskState = 'queued' | 'running' | 'waiting_permission' | 'waiting_input' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
export interface SubmitInput {
  conversationKey: string;
  requestId: string;
  goal: string;
  context?: string;
  cwd: string;
  mode: 'read' | 'write';
  allowedPaths?: string[];
  acceptanceCriteria: string[];
  baselineCommit?: string;
}
export interface TaskRecord {
  taskId: string;
  requestId: string;
  conversationKey: string;
  origin: string;
  inputHash: string;
  input: SubmitInput;
  cwd: string;
  sessionId: string;
  state: TaskState;
  ownerId: string;
  ownerPid: number;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  attempt: number;
  turn?: number;
  lastSeq?: number;
  result?: string;
  error?: string;
  guidance?: string;
  endReason?: string;
}
export const TERMINAL_STATES: TaskState[] = ['completed', 'failed', 'cancelled'];
export interface WireEvent { type: string; seq: number; time?: number; data: any }
export interface SessionSnapshot { type: 'snapshot'; header: { id: string }; records?: { type: string; event: WireEvent }[]; projections?: { asOfSeq?: number; values?: Record<string, any> }; [key: string]: any }
export interface FollowHandlers {
  snapshot(snapshot: SessionSnapshot): void;
  event(event: WireEvent): void;
  error(error: Error): void;
  closed(): void;
}
export interface Subscription { close(): void }
export interface DshApi {
  origin: string;
  probe(): Promise<boolean>;
  rpc<T = any>(method: string, request: any): Promise<T>;
  follow(sessionId: string, handlers: FollowHandlers): Promise<Subscription>;
}
