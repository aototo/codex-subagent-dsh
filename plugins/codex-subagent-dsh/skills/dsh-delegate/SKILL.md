---
name: dsh-delegate
description: Delegate a bounded local task to a running DeepSeek Harness instance through the codex-subagent-dsh MCP tools, then independently inspect and verify its result. Use when DSH is an appropriate execution worker; the main Codex agent still chooses between DSH and native Codex subagents and owns the final decision.
---

# DSH Delegate

Keep routing and acceptance with the main Codex agent. Decide whether the task fits DSH or a native Codex subagent before submitting it. DSH is useful for bounded local searches, edits, or checks with an explicit working directory, allowed paths, and observable acceptance criteria. Keep planning, ambiguous product decisions, and final verification in the main agent.

## Authentication

Call `dsh_status` before the first delegation and follow its structured state. For `dsh_not_running`, tell the user to start DSH at the returned origin, then check again; do not ask them to run the connection command yet. For `authentication_required`, show the returned `connectCommand` exactly and ask the user to run it in their own terminal, then paste the DSH startup login URL into that terminal. For `ready`, continue without setup instructions. Never ask the user to paste the login URL, its token, or stored credentials into the conversation. Do not put credentials in tool arguments, task context, logs, or files returned to the model.

## Optional model selection

When the user requests an exact DSH model, call `dsh_status` with `includeModels: true` after the connection is ready. Copy the exact `provider`, `model`, and optional `reasoningEffort` identifiers from the sanitized companion catalog into `dsh_submit.modelSelection`. Do not infer routes from task keywords, aliases, or model families. If capability discovery is missing or unsupported, tell the user to install or update the bundled DSH companion in the profile addressed by `DSH_SUBAGENT_URL`; do not change DSH's shared default as a workaround.

Omit `modelSelection` when no exact route was requested so DSH keeps its existing default behavior. A submitted selection is immutable for that Session and is part of the request's idempotency identity. If capability validation, exact selection, or durable persistence fails, the bridge must fail before sending the first prompt and must not silently choose another model.

## Task scope

Create one random `conversationKey` for the current conversation on its first DSH delegation and reuse it for every `dsh_submit`, `dsh_task`, and `dsh_cancel` call in that conversation. The key is a logical grouping label, not authentication. Use a stable `requestId` for retries of the same logical submission; do not invent a new ID to bypass an unknown result.

For `mode: read`, state exactly what DSH may inspect. This mode is a task constraint and does not create an operating-system sandbox. Check the workspace afterward when absence of edits matters.

For `mode: write`, submit only a Git linked worktree prepared by the main agent. Before submission, verify that its `HEAD` equals the intended `baselineCommit`, pass that commit explicitly, and list the allowed paths. The MVP does not support write tasks in non-Git directories or ordinary shared checkouts.

Give `dsh_submit` a concrete goal, necessary context, absolute `cwd`, mode, allowed paths where applicable, acceptance criteria, and expected response evidence. Do not ask DSH to call this plugin recursively.

## Four tools

- `dsh_status`: distinguish `ready`, `dsh_not_running`, and `authentication_required` without creating a task; use its next action and exact installed connection command. Pass `includeModels: true` only when model discovery is needed.
- `dsh_submit`: create one bounded task. Preserve its returned `taskId` and the conversation key. Include `modelSelection` only when the exact route came from companion discovery.
- `dsh_task`: query or wait for a bounded interval. For an unknown task, perform bounded read-only reconciliation of its original DSH session. Complete, correlated history plus an idle session and empty queues can recover a terminal state and result. A running session or incomplete/conflicting evidence remains unknown. A wait timeout does not cancel the task. Use moderate waits instead of rapid polling.
- `dsh_cancel`: request a stop. Treat `cancel_requested` as pending until task state confirms termination; cancellation does not roll back file changes.

A live, correlated approval request that remains undecided can report `waiting_permission`; `dsh_task` returns early in this state. Tell the user to open the returned sessionId in DSH and check the approval request, then resume querying the same task after they respond. Do not repeatedly poll while awaiting user action, automatically approve, change permissions, or resubmit. The task deadline continues during the wait. This state does not guarantee that a browser dialog is visible. Ordinary user-input waits are not detected; never infer `waiting_input` from silence. Disconnects and old audit records do not prove a current permission wait. After a restart, query with the original taskId and conversationKey; do not submit a replacement task. This is on-demand terminal-state recovery, not background monitoring, resumed execution, or automatic timeout restoration. History truncated by the DSH follow snapshot cannot be recovered in this version. If the terminal state cannot be proven, preserve `unknown` and do not resubmit automatically.

## Acceptance

DSH completion is execution evidence, not acceptance. Read the actual files, inspect the complete diff from `baselineCommit`, and run the checks needed for the stated acceptance criteria. Treat DSH's file list and test report as claims to verify. For an explicit model selection, distinguish `modelRouting.requested`, `configured`, and `actualRequest`; accept the route only when the actual request evidence exactly matches the requested provider/model/effort. Report execution state and main-agent acceptance separately, including any unverified limitation.
