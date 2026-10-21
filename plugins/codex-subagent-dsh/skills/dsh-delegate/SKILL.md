---
name: dsh-delegate
description: Delegate a bounded local task to a running DeepSeek Harness instance through the codex-subagent-dsh MCP tools, then independently inspect and verify its result. Use when DSH is an appropriate execution worker; the main Codex agent still chooses between DSH and native Codex subagents and owns the final decision.
---

# DSH Delegate

Keep routing and acceptance with the main Codex agent. Decide whether the task fits DSH or a native Codex subagent before submitting it. DSH is useful for bounded local searches, edits, or checks with an explicit working directory, allowed paths, and observable acceptance criteria. Keep planning, ambiguous product decisions, and final verification in the main agent.

## Authentication

On the first `dsh_status` or `dsh_connect`, pass `connectionMode: web` or `desktop` when the user names a host. Otherwise use the configured default or `auto` (Web first, Desktop only when Web is unreachable). Report the selected mode and origin. Once selected, this MCP process cannot switch backends; a different mode requires a new conversation. Authentication or task failure must never trigger fallback.

The bundled `dsh-plugin` is the only DSH-side package in Codex plugin 0.6.0: `@aototo/codex-subagent-dsh`. It provides Desktop authorization, Web pairing, and session model routing. Install a full copy in a stable versioned directory outside disposable Codex caches. Read its README before installation or migration. Desktop must use its plugin manager; never use `dsh plugin --profile desktop`.

For migration from 0.5.0, first finish running work and back up profile configuration. Disable only `@aototo/codex-subagent-dsh-desktop-bridge` and `@aototo/codex-subagent-dsh-companion` before enabling the unified plugin. Do not disable/uninstall `@aotu/dsh-desktop-bridge` (the Aotu assistant) or alter its service controls. Keep old stable directories for rollback and retain all connection files. Mixed old/new enabled components are a configuration error, not a reason to bypass duplicate protection. Check current readiness after migration; reuse still-valid grants, and ask the user to explicitly authorize only if needed.

Desktop grants remain under `<DSH_SUBAGENT_HOME>/codex-desktop`, with the same consumer marker. Never import a legacy root-level grant or scan ports/read Electron cookies. Only the user clicks Allow/Reject. After Desktop restarts, reauthorize and open a new Codex conversation. Origin-scoped old tasks are never resubmitted automatically. A normal same-host bundle migration should not itself require writing authorization files; verify, do not assume.

Call `dsh_status` before the first delegation. It is read-only and must not open the browser. For `dsh_not_running`, tell the user to start DSH at the returned origin and check again. For `ready`, continue without setup instructions.

For Web `authentication_required`, inspect the pairing capability. If available, use `dsh_connect` with `action: start` when the user asks to connect. Show the returned matching code and confirmation URL, and ask the user to compare the code and choose Allow or Reject in their logged-in DSH browser. Never approve on their behalf. Do not repeatedly poll while waiting for the user. After they respond, use `action: check`; only `ready` means the API check and private credential save succeeded. `action: cancel` cancels this pending pairing, not DSH tasks or existing credentials. On rejection or expiry, report the outcome without automatically starting again. A process restart loses pending pairing state.

For Web, if the companion is missing or outdated, check the verified compatibility matrix before helping install the bundled `dsh-plugin` in the actual DSH profile. Locate it from this Skill's plugin root; prefer copying the complete companion to a stable, versioned local data directory and retain the previous installation for rollback. Check for running tasks before restarting a shared profile and act within the user's authorization. Do not silently restart or replace their shared instance. A browser not signed into DSH must complete DSH's own login first; pairing does not bypass login.

The grant reuses the browser's existing DSH cookie and expiry. It is not an independently revocable or task-scoped token, and task execution still follows DSH permissions. A `confirmationUrl` is a non-credential link; the private claim secret must never appear in tool results, chat, logs, or URLs. When browser pairing is unavailable, `connectCommand` is the compatibility fallback: show it exactly for the user to run in their own terminal and paste the DSH login URL there. Never ask them to paste login links, tokens, cookies, or stored credentials into chat.

## Optional model selection

When the user requests an exact DSH model, call `dsh_status` with `includeModels: true` after the connection is ready. Copy the exact `provider`, `model`, and optional `reasoningEffort` identifiers from the sanitized companion catalog into `dsh_submit.modelSelection`. Do not infer routes from task keywords, aliases, or model families. If capability discovery is missing or unsupported, report that exact model routing is unavailable. For Web, consult the compatibility matrix before installing or updating its companion; for Desktop, use only the companion/Desktop combination recorded in the compatibility guide and install through Desktop plugin management, not the CLI desktop profile. Never change DSH's shared default or silently omit an explicitly requested model as a workaround.

Omit `modelSelection` when no exact route was requested so DSH keeps its existing default behavior. A submitted selection is immutable for that Session and is part of the request's idempotency identity. If capability validation, exact selection, or durable persistence fails, the bridge must fail before sending the first prompt and must not silently choose another model.

## Task scope

Create one random `conversationKey` for the current conversation on its first DSH delegation and reuse it for every `dsh_submit`, `dsh_task`, and `dsh_cancel` call in that conversation. The key is a logical grouping label, not authentication. Use a stable `requestId` for retries of the same logical submission; do not invent a new ID to bypass an unknown result.

For `mode: read`, state exactly what DSH may inspect. This mode is a task constraint and does not create an operating-system sandbox. Check the workspace afterward when absence of edits matters.

For `mode: write`, submit only a Git linked worktree prepared by the main agent. Before submission, verify that its `HEAD` equals the intended `baselineCommit`, pass that commit explicitly, and list the allowed paths. The MVP does not support write tasks in non-Git directories or ordinary shared checkouts.

Give `dsh_submit` a concrete goal, necessary context, absolute `cwd`, mode, allowed paths where applicable, acceptance criteria, and expected response evidence. Do not ask DSH to call this plugin recursively.

## Five tools

- `dsh_status`: distinguish `ready`, `dsh_not_running`, and `authentication_required` without creating a task; use its next action and exact installed connection command. Pass `includeModels: true` only when model discovery is needed.
- `dsh_connect`: select the initial connection mode and start/check/cancel Web pairing, or verify an existing Desktop grant; only the user confirms the authorization in DSH. `openBrowser: false` returns the link without opening it.
- `dsh_submit`: create one bounded task. Preserve its returned `taskId` and the conversation key. Include `modelSelection` only when the exact route came from companion discovery.
- `dsh_task`: query or wait for a bounded interval. For an unknown task, perform bounded read-only reconciliation of its original DSH session. Complete, correlated history plus an idle session and empty queues can recover a terminal state and result. A running session or incomplete/conflicting evidence remains unknown. A wait timeout does not cancel the task. Use moderate waits instead of rapid polling.
- `dsh_cancel`: request a stop. Treat `cancel_requested` as pending until task state confirms termination; cancellation does not roll back file changes.

A live, correlated approval request that remains undecided can report `waiting_permission`; `dsh_task` returns early in this state. Tell the user to open the returned sessionId in DSH and check the approval request, then resume querying the same task after they respond. Do not repeatedly poll while awaiting user action, automatically approve, change permissions, or resubmit. The task deadline continues during the wait. This state does not guarantee that a browser dialog is visible. Ordinary user-input waits are not detected; never infer `waiting_input` from silence. Disconnects and old audit records do not prove a current permission wait. After a restart, query with the original taskId and conversationKey; do not submit a replacement task. This is on-demand terminal-state recovery, not background monitoring, resumed execution, or automatic timeout restoration. History truncated by the DSH follow snapshot cannot be recovered in this version. If the terminal state cannot be proven, preserve `unknown` and do not resubmit automatically.

## Acceptance

DSH completion is execution evidence, not acceptance. Read the actual files, inspect the complete diff from `baselineCommit`, and run the checks needed for the stated acceptance criteria. Treat DSH's file list and test report as claims to verify. For an explicit model selection, distinguish `modelRouting.requested`, `configured`, and `actualRequest`; accept the route only when the actual request evidence exactly matches the requested provider/model/effort. Report execution state and main-agent acceptance separately, including any unverified limitation.
