import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { DshClient } from './dsh-client.js';
import { TaskStore } from './task-store.js';
import { TaskManager } from './task-manager.js';
import type { TaskRecord } from './types.js';

const config = loadConfig();
const store = new TaskStore(config.stateDir);
const manager = new TaskManager(config, new DshClient(config), store);
const server = new McpServer({ name: 'codex-subagent-dsh', version: '0.2.0' });
const connectCommand = `node ${JSON.stringify(fileURLToPath(new URL('./connect.mjs', import.meta.url)))}`;
const key = z.string().min(1).max(128);
const scope = { conversationKey: key, taskId: z.string().uuid() };
const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
function view(task: TaskRecord) {
  const { inputHash, ownerId, ownerPid, input, configuredModel, actualModel, actualModelSeq, ...publicTask } = task;
  return {
    ...publicTask,
    mode: input.mode,
    baselineCommit: input.baselineCommit,
    modelRouting: input.modelSelection === undefined ? undefined : {
      requested: input.modelSelection,
      configured: configuredModel,
      actualRequest: actualModel,
      actualRequestHeaderSeq: actualModelSeq,
    },
    acceptance: 'not_assessed_by_plugin',
  };
}
async function guarded(work: () => Promise<unknown>) {
  try { return content(await work()); }
  catch (error) {
    const code = (error as any)?.code;
    // Error messages from our own modules are bounded; never reflect remote response bodies.
    const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[URL]').replace(/(?:token|cookie|authorization)\s*[=:]\s*\S+/gi, '[credential]') : 'Request failed';
    return { ...content({ error: typeof code === 'string' ? code : 'REQUEST_FAILED', message: message.slice(0, 400), guidance: 'For authentication errors run the local connect command. Do not paste login links or credentials into chat.' }), isError: true };
  }
}
server.registerTool('dsh_status', { description: 'Check whether local DSH is running and authenticated without creating a task. Set includeModels to discover sanitized provider/model/effort routes from the optional companion. Returns a precise next action and installed connect command when setup is required. DSH is one optional execution backend; the main agent decides whether to use DSH or native Codex subagents.', inputSchema: { includeModels: z.boolean().default(false) }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, input => guarded(() => manager.status(connectCommand, input.includeModels)));
server.registerTool('dsh_submit', {
  description: 'Delegate one bounded task to a new local DSH session. Use a stable conversationKey and requestId; duplicates do not resubmit. Optional modelSelection pins one exact provider/model/effort to this Session before its first prompt and requires the DSH companion. Main agent retains final acceptance. Write mode requires a clean, separate Git linked worktree and its HEAD baseline. Read mode is a task instruction, not a sandbox.',
  inputSchema: { conversationKey: key, requestId: key, goal: z.string().min(1).max(16000), context: z.string().max(32000).optional(), cwd: z.string().min(1).max(4096), mode: z.enum(['read', 'write']), allowedPaths: z.array(z.string().min(1).max(4096)).max(100).optional(), acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(30), baselineCommit: z.string().regex(/^[a-fA-F0-9]{40}$/).optional(), modelSelection: z.object({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256), reasoningEffort: z.string().min(1).max(256).optional() }).strict().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, input => guarded(async () => view(await manager.submit(input))));
server.registerTool('dsh_task', { description: 'Read or boundedly wait for a scoped DSH task; waitMs is at most 20 seconds. Unknown tasks receive a bounded read-only check of the original session for a provable terminal state/result. Running or incomplete evidence stays unknown and retains workspace reservations. Never auto-resubmit; verify results independently.', inputSchema: { ...scope, waitMs: z.number().int().min(0).max(config.maxWaitMs).default(0) }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (input, extra) => guarded(async () => view(await manager.task(input.conversationKey, input.taskId, input.waitMs, extra.signal))));
server.registerTool('dsh_cancel', { description: 'Request cancellation of the matching scoped task. Acceptance of a cancel request is not proof of termination; inspect returned state. Cancellation does not roll back changes.', inputSchema: scope, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, input => guarded(async () => view(await manager.cancel(input.conversationKey, input.taskId))));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  manager.shutdown();
  await server.close().catch(() => {});
  store.close();
}
process.stdin.on('end', () => { void close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
