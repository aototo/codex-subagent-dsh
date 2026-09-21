# codex-subagent-dsh

[简体中文](README.md) | [English](README_EN.md)

`codex-subagent-dsh` is a community Codex plugin that delegates clearly bounded tasks to a running DeepSeek Harness (DSH) through a local STDIO MCP server. The Codex main agent still decides whether to use DSH or native Codex subagents, and remains responsible for inspecting files and diffs, running tests, and giving final approval.

The repository provides both a Codex marketplace entry and ready-to-run plugin artifacts. Real DSH text tasks, file reads, and changes in isolated worktrees have passed validation. A read-only task invoked directly from a new Codex desktop conversation has also passed. Closing a window and quitting the entire app normally have been tested: DSH can continue running while the plugin initially preserves the task as `unknown`. After reopening Codex, the original `taskId` and `conversationKey` can be passed to `dsh_task` to recover the terminal state and result when complete evidence is available. Crash recovery has not yet been tested.

0.4.0 adds browser-confirmed connection without a terminal command or login-link copy. See the [release notes](docs/RELEASE_NOTES_0.4.0.md). GitHub `main` provides this version after this PR is merged.

## Quick start

1. Install the plugin from the GitHub marketplace. The repository ships ready-to-run artifacts, so no clone or npm build is needed:

   ```bash
   codex plugin marketplace add aototo/codex-subagent-dsh --ref main
   codex plugin add codex-subagent-dsh@codex-subagent-dsh
   ```

2. Start the existing local DSH instance (default `http://127.0.0.1:3080`) and sign into its browser UI. Codex conversations share this instance.
3. Ask Codex to install the bundled `dsh-companion` into that DSH profile. Browser pairing and per-session model selection require the companion; no repository clone or build is needed:

   ```bash
   dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
   ```

   Replace `web` with the actual profile. Check for running tasks before restarting the shared instance. Codex can locate the installed directory from its Skill path. Prefer copying the complete companion into a stable, versioned local data directory before installation, retaining the previous version for rollback. If installing directly from the Codex cache, rebind it after cache upgrades or removal.
4. Open a new Codex conversation and say **“Connect my DSH.”** Compare the matching code in Codex and the confirmation page, click **Allow connection**, then tell Codex to check. A successful API check and credential save returns `ready`. The browser must already be signed into DSH; DSH's own initial login remains necessary, but no login-link copy into Codex is needed.
5. To pick a model, ask Codex to call `dsh_status` with `includeModels: true`, copy the exact `provider`, `model`, and optional `reasoningEffort` from the returned catalog, then delegate in natural language, for example:

   > Delegate this clearly bounded task to DSH using deepseek-official/deepseek-v4-flash (effort low); inspect the full diff and accept the result yourself.

6. Route acceptance: `dsh_task` reports `modelRouting.requested`, `configured`, and `actualRequest` observed from the real request/header separately. An explicitly routed task may only complete successfully with an exactly matching actual header; a missing or mismatched header never silently falls back or reports success.

## Requirements

- Node.js 22.13+ (Node 22 LTS and 24+ are supported)
- npm
- DSH running on a local loopback address; the default is `http://127.0.0.1:3080`
- The login URL generated when DSH starts, required for the first local connection

Browser pairing and optional per-Session model pinning require the bundled DSH companion in the same DSH profile that Codex addresses. The companion ships inside the plugin root installed from the marketplace, so regular users can point at `<installed-plugin-root>/dsh-companion` directly — no repository clone or npm build is needed. Repository developers may use the in-repo path instead:

```bash
dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
```

Restart that profile after installation. The companion never changes DSH's shared default model. The current compatibility gate covers `@deepseek-ai/dsh` 0.1.5-rc.1, its resolved `dsh-agent`/Session Controller/Connection 0.1.5-rc.2 packages, and Cordis 4.0.2. Re-run the isolated host probe for other combinations.

## Build

```bash
npm ci
npm run build
```

The build bundles the MCP server, connection entry point, and npm runtime dependencies into:

```text
plugins/codex-subagent-dsh/runtime/server.mjs
plugins/codex-subagent-dsh/runtime/connect.mjs
```

Run the complete development checks with Node.js 22.13+:

```bash
npm run check
```

The plugin manifest is located at `plugins/codex-subagent-dsh/.codex-plugin/plugin.json`. Its MCP configuration starts `runtime/server.mjs` through a path relative to the plugin root. A local marketplace installation snapshot, direct invocation from a new desktop conversation, and installation from the GitHub source in an isolated Codex configuration have all been validated.

## Install from GitHub

The repository includes committed, ready-to-run `runtime/*.mjs` artifacts. Regular users do not need to install npm dependencies or build the plugin locally:

```bash
codex plugin marketplace add aototo/codex-subagent-dsh --ref main
codex plugin add codex-subagent-dsh@codex-subagent-dsh
```

Open a new Codex conversation after installation so Codex can load the plugin. Current validation uses the CLI bundled with the Codex desktop app. The exact minimum Codex version has not yet been established; see the [compatibility notes](docs/COMPATIBILITY.md).

To update the GitHub marketplace and plugin, run:

```bash
codex plugin marketplace upgrade codex-subagent-dsh
codex plugin add codex-subagent-dsh@codex-subagent-dsh
```

To uninstall the plugin and marketplace, run:

```bash
codex plugin remove codex-subagent-dsh@codex-subagent-dsh
codex plugin marketplace remove codex-subagent-dsh
```

For local development, run `npm ci && npm run build`, then install the repository directory with `codex plugin marketplace add /absolute/path/to/codex-subagent-dsh`. After modifying the plugin, update the manifest cachebuster and reinstall it. Do not assume that editing the source alone refreshes the installed cache.

## First connection

Say **“Connect my DSH”** in Codex. `dsh_status` only inspects state; it never opens a browser.

- DSH stopped: start the instance at the returned address.
- Companion missing or outdated: install/update the bundled companion in that profile, then safely restart it.
- Authentication required: `dsh_connect` with `action: start` opens a confirmation page once. If opening fails, use its returned confirmation URL. Compare the matching code with Codex.
- After the user confirms: `action: check` claims the credential, verifies it against DSH, and saves it before returning `ready`.
- Rejected or expired: no automatic retry. `action: cancel` cancels the pending pairing.

Browser pairing supports HTTP on `127.0.0.1`, `localhost`, and `[::1]`, defaulting to `http://127.0.0.1:3080`. HTTPS and reverse-proxy pairing are not supported.

The user must approve in a browser already signed into DSH. Pairing neither signs in automatically nor approves task permissions. The grant permits access to this DSH instance under its existing execution permission policy. This version reuses the existing browser cookie and its expiry; it is not an independently revocable or task-scoped token. Deleting the local credential does not revoke copies on the server.

Claim secrets stay in runtime memory and never appear in model output, URLs, or browser pages. Pairings expire after five minutes. Unfinished pairings must be restarted after Codex or its MCP process restarts. Saved credentials remain usable while valid. Never paste login links, tokens, or cookies into chat.

Compatibility fallback: without the pairing companion, run the exact `connectCommand` returned by `dsh_status` in your own terminal and paste the DSH login URL there. This command is unnecessary for normal browser pairing. The plugin does not install or restart DSH automatically.

## Usage

The plugin exposes five tools:

| Tool | Purpose |
| --- | --- |
| `dsh_status` | Distinguishes between DSH not running, authentication required, and ready. With `includeModels: true`, it returns a sanitized provider/model/effort catalog from the companion. |
| `dsh_connect` | Start, check, or cancel browser pairing; the user confirms in DSH and the runtime handles credentials. |
| `dsh_submit` | Submits one clearly bounded task and returns a `taskId`. Optional `modelSelection` pins an exact route before the Session's first prompt. Repeating the same request does not submit it again. |
| `dsh_task` | Reads task state/results or waits for a bounded period. Live permission waits return early; a wait timeout does not cancel the task. |
| `dsh_cancel` | Requests cancellation of a specific task. An accepted request is not proof that execution stopped, and existing file changes are not rolled back. |

In normal use, tell Codex:

> Delegate this clearly bounded task to DSH. Inspect the full diff and run the key tests yourself.

Multiple Codex conversations share one running DSH instance, while each delegated task gets its own DSH session. After the first connection, separate MCP processes reuse the stored credentials. The main agent creates a `conversationKey` on the first delegation in a conversation and reuses it for later calls. This key is only a logical grouping label, not a security identity. Read mode is also a task-level instruction, not operating-system-level read-only isolation.

Write tasks are supported only in a Git linked worktree whose baseline commit has already been prepared and verified by the main agent. After DSH reports completion, the main agent must still inspect the actual artifacts independently. A cancellation request does not undo changes that have already been made.

To select a model, first call `dsh_status` with `includeModels: true`, then copy the exact `provider`, `model`, and optional `reasoningEffort` identifiers. Do not infer a route from task keywords. A persisted `modelSelection` is immutable for that Session and participates in the idempotency hash. Capability, validation, or durability failure blocks the first prompt. Omitting `modelSelection` preserves the existing default-routing behavior.

`dsh_task` reports `requested`, `configured`, and the `actualRequest` observed from the real `request/header` separately. An explicitly routed task cannot complete successfully without an exact matching header; the bridge never silently falls back.

## Troubleshooting

- `node` is missing or too old: make sure `node --version` is at least 22.13, then rebuild.
- DSH is not running: `dsh_status` returns `dsh_not_running`. Start DSH at the returned address, then check the status again.
- DSH is disconnected or authentication has expired: follow `dsh_status`, check the companion, and use `dsh_connect` for browser pairing. `connectCommand` is a compatibility fallback.
- `runtime/server.mjs` is missing: run `npm ci && npm run build`.
- A task reports `waiting_permission`: a correlated live approval request remains undecided. Open the returned sessionId in DSH and check it, then query the original task again. Rejection alone does not fail the task. The plugin never approves for you, and the task deadline continues.
- A task remains `running`: ordinary user questions and waits without recognizable approval events may still report running. Inspect the session in DSH.
- A task is `unknown`: call `dsh_task` again with the original `taskId` and `conversationKey`. The plugin performs a bounded read of the original session to look for a provable terminal state. It does not create or resubmit the task. If evidence remains insufficient, inspect DSH and the workspace; a write-task reservation is not released early.
- A cancelled task remains `cancel_requested`: this only proves that the cancellation request was sent. Wait for a confirmed terminal state. Existing file changes are not reverted automatically.
- Codex cannot find the tools: confirm that the plugin is installed and enabled, and open a new conversation after an update. Then verify the built artifacts and manifest; see `docs/COMPATIBILITY.md`.
- `MODEL_ROUTING_COMPANION_MISSING`: install the bundled companion into the profile addressed by `DSH_SUBAGENT_URL`, then restart it. Do not substitute `session/selectModel`, which writes the shared default.
- `MODEL_ROUTING_CAPABILITY_UNSUPPORTED` or a model configuration failure: refresh `dsh_status` with `includeModels: true` and verify the exact provider/model/effort. The bridge does not choose a fallback model.

## Current limitations

- Installation from the GitHub marketplace has been validated with an isolated Codex configuration, but Git-source update and uninstall regression tests are not yet complete. Tool discovery and a read-only task from a new conversation using a local marketplace have been validated. Closing the test window, quitting the entire app normally, and reopening it have been validated. Crash behavior has not been tested.
- Each task uses a separate DSH session. Continuing the original session for rework and listing tasks are not supported. Query-time recovery of a proven terminal state and result is supported; background automatic recovery and takeover of running tasks are not.
- After the Codex or MCP process exits, the plugin does not guarantee continued timeout tracking, automatic cancellation, or waking the conversation.
- Permission-wait detection requires a live, continuous event stream correlated to this task. A 400ms settling window suppresses immediate decisions; it does not prove a browser approval dialog is visible. Ordinary user-input waits are not detected. Old requests after disconnect/restart do not establish a live wait, and closing Codex does not guarantee notifications.
- See the [approval verification record](docs/APPROVAL_WAIT_VERIFICATION.md) for isolated checks and the browser acceptance status.
- When the terminal state cannot be proven, the plugin returns `unknown` and does not automatically resubmit. Query-time recovery requires a complete, continuous history, the original task association, and consistent idle and empty-queue evidence. If DSH returns a truncated history snapshot, this version does not fetch additional pages. Results larger than the 65,536-character limit or snapshots larger than the transport limit also remain `unknown`.
- Only loopback addresses are allowed. DSH running on another machine is not supported.
- This is a community MCP plugin that lets Codex call an external DSH instance. It is not a native Codex subagent backend.

See the [compatibility notes](docs/COMPATIBILITY.md) for versions and reference sources.

## Development verification

`npm run check` performs type checking, builds the distributable artifacts, and runs automated tests. The isolated probe below also boots a temporary DSH profile, installs the companion and a synthetic adapter, and proves authentication, two concurrently pinned Sessions, an unaffected default Session, cold-restart recovery, real request headers, and the bundled MCP `dsh_submit`→`dsh_task` path:

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-companion.mjs
```

Approval events and the bundled MCP wait state have a separate isolated probe:

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-approval.mjs
```

The synthetic adapter proves the routing mechanism. It does not prove availability of any external provider or commercial model in the user's configuration.

After the first connection, the following commands submit one constrained task to a real DSH instance:

```bash
npm run smoke -- text
npm run smoke -- read
```

The script prints the `taskId` and `sessionId`. Verify the exact marker in the returned report and the actual file contents. DSH may add explanations, so the plugin does not guarantee strictly formatted plain-text output. After two minutes, the script requests cancellation. A task whose state cannot be confirmed remains `unknown` and is not retried automatically. Temporary test directories are retained for inspection so that a workspace still referenced by a DSH session is not deleted.

See the public [verification notes](docs/VERIFICATION.md) for a summary.
