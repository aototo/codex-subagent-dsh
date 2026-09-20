// Explicit opt-in integration check against the user's already connected local DSH.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const mode = process.argv[2] ?? 'text';
if (!['text', 'read'].includes(mode)) throw new Error('Usage: npm run smoke -- text|read');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'dsh-opt-in-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, 'plugins/codex-subagent-dsh/runtime/server.mjs')],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  stderr: 'pipe',
});
transport.stderr?.on('data', () => {});
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  const value = JSON.parse(response.content[0].text);
  if (response.isError) throw new Error(`${value.error}: ${value.message}`);
  return value;
};
let task;
let workspace;
try {
  await client.connect(transport);
  await call('dsh_status'); // Stop before submitting anything if connection is missing.
  workspace = await mkdtemp(path.join(tmpdir(), 'dsh-live-smoke-'));
  const marker = `DSH_SMOKE_${randomUUID()}`;
  await writeFile(path.join(workspace, 'evidence.txt'), marker + '\n');
  task = await call('dsh_submit', {
    conversationKey: 'smoke-' + randomUUID(), requestId: randomUUID(), cwd: workspace,
    mode: 'read',
    goal: mode === 'read' ? 'Read evidence.txt in the workspace and include its contents on a standalone line in your report. Do not modify any files.' : `Include ${marker} on a standalone line in your report. Do not use any tools or modify files.`,
    acceptanceCriteria: ['Include the correct marker on a standalone line and leave evidence.txt unchanged; a brief report is allowed'],
  });
  console.log(JSON.stringify({ taskId: task.taskId, sessionId: task.sessionId, workspace }));
  const until = Date.now() + 120000;
  do {
    task = await call('dsh_task', { conversationKey: task.conversationKey, taskId: task.taskId, waitMs: 20000 });
    console.log(JSON.stringify({ taskId: task.taskId, state: task.state }));
  } while (['queued', 'running', 'waiting_permission', 'waiting_input', 'cancel_requested'].includes(task.state) && Date.now() < until);
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(task.state)) {
    task = await call('dsh_cancel', { conversationKey: task.conversationKey, taskId: task.taskId });
    task = await call('dsh_task', { conversationKey: task.conversationKey, taskId: task.taskId, waitMs: 10000 });
  }
  assert.equal(task.state, 'completed', `DSH did not complete: ${task.state}; inspect ${task.sessionId}`);
  assert.deepEqual([...new Set(task.result?.match(/^DSH_SMOKE_[0-9a-f-]+$/gm) ?? [])], [marker]);
  assert.equal(await readFile(path.join(workspace, 'evidence.txt'), 'utf8'), marker + '\n');
  console.log(`PASS: ${mode}; correlated DSH result and unchanged fixture independently verified.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  // Preserve fixture on disk: a DSH session may still reference it after client exit.
  await client.close().catch(() => {});
  if (workspace) console.log(`Retained test workspace: ${workspace}`);
}
