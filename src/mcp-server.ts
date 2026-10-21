import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { desktopStateDir, loadConfig } from './config.js';
import { EndpointBinding } from './connection.js';
import { EndpointError, type DshConnectionMode } from './dsh-endpoint.js';
import { DshClient } from './dsh-client.js';
import { PairingClient } from './pairing-client.js';
import { TaskStore } from './task-store.js';
import { TaskManager } from './task-manager.js';
import type { TaskRecord } from './types.js';

const config = loadConfig();
const store = new TaskStore(config.stateDir);
const binding = new EndpointBinding(config);
let manager: TaskManager;
let pairing: PairingClient;
let selectedMode: 'web' | 'desktop';
async function ensureConnection(mode?: DshConnectionMode) {
  const endpoint = await binding.get(mode);
  if (!manager) {
    const boundConfig = { ...config, origin: endpoint.origin, stateDir: endpoint.mode === 'desktop' ? desktopStateDir(config.stateDir) : config.stateDir };
    manager = new TaskManager(boundConfig, new DshClient(boundConfig), store);
    pairing = new PairingClient(boundConfig);
    selectedMode = endpoint.mode;
  }
}
function desktopStatus(status: Awaited<ReturnType<TaskManager['status']>>) {
  const { connectCommand: _unused, ...result } = status as typeof status & { connectCommand?: string };
  return { ...result, connectionMode: 'desktop', ...('modelRouting' in status && status.modelRouting && !status.modelRouting.available ? { modelRouting: { ...status.modelRouting, guidance: 'Desktop model routing is unavailable in the selected instance. Check the compatibility guide and install or enable its verified model-routing companion through Desktop plugin management, then call dsh_status with includeModels=true. Do not change the shared default model or silently omit the requested selection.' } } : {}), ...(status.state === 'authentication_required' ? {
    nextAction: 'authorize_desktop_bridge',
    guidance: 'Open the DSH desktop connection bridge permission UI and explicitly authorize this connection. If the bridge is missing, install it with user authorization first. Never approve for the user. Then check again.',
  } : status.state === 'dsh_not_running' ? {
    nextAction: 'restart_conversation_after_desktop_ready',
    guidance: 'Start DSH desktop and authorize its connection bridge, then open a new Codex conversation. The selected backend will not change in this process.',
  } : {}) };
}
const server = new McpServer({ name: 'codex-subagent-dsh', version: '0.6.0' });
const connectCommand = `node ${JSON.stringify(fileURLToPath(new URL('./connect.mjs', import.meta.url)))}`;
const key = z.string().min(1).max(128);
const connectionMode = z.enum(['auto', 'web', 'desktop']).optional().describe('Select a backend on the first call. auto prefers reachable Web, then authorized Desktop. Once selected, changing backend requires a new Codex conversation.');
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
async function guarded(work: () => Promise<unknown>, mode?: DshConnectionMode) {
  try { await ensureConnection(mode); }
  catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : 'DSH endpoint discovery failed';
    return content({ message, connected: false, state: 'connection_unavailable',
      code: error instanceof EndpointError ? error.code : 'DSH_ENDPOINT_UNAVAILABLE',
      nextAction: error instanceof EndpointError ? error.nextAction : 'check_dsh_connection',
      requestedMode: mode ?? config.connectionMode, connectionMode: binding.current?.mode,
      origin: binding.current?.origin,
      guidance: 'No task was sent and no backend was switched. In auto mode Web is checked first; if unavailable, Desktop requires a valid user-authorized connection bridge. Never resubmit an unknown task just because a new connection succeeds.',
    });
  }
  try { return content(await work()); }
  catch (error) {
    const code = (error as any)?.code;
    // Error messages from our own modules are bounded; never reflect remote response bodies.
    const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[URL]').replace(/(?:token|cookie|authorization)\s*[=:]\s*\S+/gi, '[credential]') : 'Request failed';
    return { ...content({ error: typeof code === 'string' ? code : 'REQUEST_FAILED', message: message.slice(0, 400), guidance: 'Check dsh_status for connection guidance. Do not paste login links or credentials into chat.' }), isError: true };
  }
}
server.registerTool('dsh_status', { description: 'Select connectionMode=auto/web/desktop on the first call; the process then stays bound to that backend. Check whether local DSH is running and authenticated without creating a task. Set includeModels to discover sanitized provider/model/effort routes from the optional companion. Returns a precise next action and installed connect command when setup is required. DSH is one optional execution backend; the main agent decides whether to use DSH or native Codex subagents.', inputSchema: { includeModels: z.boolean().default(false), connectionMode }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, input => guarded(async () => {
  const rawStatus = await manager.status(connectCommand, input.includeModels);
  const status = { ...rawStatus, connectionMode: selectedMode, capabilities: { taskConnection: rawStatus.connected, authorization: selectedMode === 'desktop' ? 'desktop_bridge' : 'web_pairing_or_terminal', modelSelection: 'modelRouting' in rawStatus ? rawStatus.modelRouting?.available === true : 'not_checked' } };
  if (selectedMode === 'desktop') return desktopStatus(status);
  if (status.state !== 'authentication_required') return status;
  const capability = await pairing.status();
  if (!capability.available && capability.state !== 'pairing_unsupported') return { ...status, pairing: capability, nextAction: capability.state === 'dsh_not_running' ? 'start_dsh' : 'check_connection', guidance: capability.nextAction };
  return { ...status, pairing: capability, nextAction: capability.available ? 'connect_in_browser' : 'install_or_update_companion', guidance: capability.available
    ? 'Ask the user to start browser pairing with dsh_connect, compare the matching code, and confirm in their logged-in DSH browser. Never approve for them.'
    : 'Install or update the bundled DSH companion in this profile for browser pairing. The returned connectCommand remains a terminal fallback.' };
}, input.connectionMode));
server.registerTool('dsh_connect', {
  description: 'For desktop DSH, start/check verifies the existing explicitly authorized desktop bridge connection; if needed guide the user to its permission UI. Desktop cancel leaves credentials/tasks unchanged. For Web DSH, start, check, or cancel browser pairing with the running local DSH. Start opens a confirmation page once (openBrowser=false returns its URL). Show the matching code and wait for the user to allow or reject in their logged-in DSH browser; never click approval for them. Check after their response. Pairing credentials stay inside the runtime. Does not create an agent task, install a companion, or change execution permissions.',
  inputSchema: { action: z.enum(['start', 'check', 'cancel']).default('start'), openBrowser: z.boolean().default(true), connectionMode },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, input => guarded(async () => {
  if (selectedMode === 'desktop') {
    if (input.action === 'cancel') return { state: 'no_pending_pairing', connectionMode: 'desktop', guidance: 'No browser pairing is pending. Saved credentials and running tasks are unchanged.' };
    const status = desktopStatus(await manager.status(connectCommand));
    return { ...status, capabilities: { taskConnection: status.connected, authorization: 'desktop_bridge', modelSelection: 'not_checked' } };
  }
  return { ...await pairing.connect(input.action, input.openBrowser), connectionMode: selectedMode, origin: manager.client.origin };
}, input.connectionMode));
server.registerTool('dsh_submit', {
  description: 'Delegate one bounded task to a new local DSH session. Use a stable conversationKey and requestId; duplicates do not resubmit. Optional modelSelection pins one exact provider/model/effort to this Session before its first prompt and requires the DSH companion. Main agent retains final acceptance. Write mode requires a clean, separate Git linked worktree and its HEAD baseline. Read mode is a task instruction, not a sandbox.',
  inputSchema: { conversationKey: key, requestId: key, goal: z.string().min(1).max(16000), context: z.string().max(32000).optional(), cwd: z.string().min(1).max(4096), mode: z.enum(['read', 'write']), allowedPaths: z.array(z.string().min(1).max(4096)).max(100).optional(), acceptanceCriteria: z.array(z.string().min(1).max(2000)).min(1).max(30), baselineCommit: z.string().regex(/^[a-fA-F0-9]{40}$/).optional(), modelSelection: z.object({ provider: z.string().min(1).max(256), model: z.string().min(1).max(256), reasoningEffort: z.string().min(1).max(256).optional() }).strict().optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}, input => guarded(async () => view(await manager.submit(input))));
server.registerTool('dsh_task', { description: 'Read or boundedly wait for a scoped DSH task; waitMs is at most 20 seconds. Returns early for live waiting_permission: direct the user to this sessionId in DSH; do not approve or poll repeatedly while user action is pending. The task deadline continues. Unknown tasks receive a bounded read-only check of the original session for a provable terminal state/result. Running or incomplete evidence stays unknown and retains workspace reservations. Never auto-resubmit; verify results independently.', inputSchema: { ...scope, waitMs: z.number().int().min(0).max(config.maxWaitMs).default(0) }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, (input, extra) => guarded(async () => view(await manager.task(input.conversationKey, input.taskId, input.waitMs, extra.signal))));
server.registerTool('dsh_cancel', { description: 'Request cancellation of the matching scoped task. Acceptance of a cancel request is not proof of termination; inspect returned state. Cancellation does not roll back changes.', inputSchema: scope, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, input => guarded(async () => view(await manager.cancel(input.conversationKey, input.taskId))));

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  manager?.shutdown();
  await pairing?.shutdown();
  await server.close().catch(() => {});
  store.close();
}
process.stdin.on('end', () => { void close().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void close().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
