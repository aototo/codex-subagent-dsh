# codex-subagent-dsh

[简体中文](README.md) | [English](README_EN.md)

`codex-subagent-dsh` is a community Codex plugin that delegates clearly bounded tasks to a running DeepSeek Harness (DSH) through a local STDIO MCP server. The Codex main agent still decides whether to use DSH or native Codex subagents, and remains responsible for inspecting files and diffs, running tests, and giving final approval.

The repository provides both a Codex marketplace entry and ready-to-run plugin artifacts. Real DSH text tasks, file reads, and changes in isolated worktrees have passed validation. A read-only task invoked directly from a new Codex desktop conversation has also passed. Closing a window and quitting the entire app normally have been tested: DSH can continue running while the plugin initially preserves the task as `unknown`. After reopening Codex, the original `taskId` and `conversationKey` can be passed to `dsh_task` to recover the terminal state and result when complete evidence is available. Crash recovery has not yet been tested.

## Quick start

1. Install the plugin from the GitHub marketplace. The repository ships ready-to-run artifacts, so no clone or npm build is needed:

   ```bash
   codex plugin marketplace add aototo/codex-subagent-dsh --ref main
   codex plugin add codex-subagent-dsh@codex-subagent-dsh
   ```

2. Make sure DSH is running on a loopback address; the default is `http://127.0.0.1:3080`. Multiple Codex conversations share this one instance.
3. Open a new Codex conversation and say "check the DSH connection status". Follow the `dsh_status` guidance: start DSH if it is not running; if authentication is required, run the returned connect command in your own terminal and paste the DSH startup login URL only into that terminal. Once the state is `ready`, tasks can be delegated.
4. (Optional) For per-Session model pinning, install the bundled `dsh-companion` directory into the same DSH profile addressed by `DSH_SUBAGENT_URL`, then restart that profile. The companion ships inside the installed plugin root, so point the command at the installed path — no repository clone or build is needed:

   ```bash
   dsh plugin --profile web add -w <installed-plugin-root>/dsh-companion
   ```

   Derive the installed plugin root from the connect command in a `dsh_status` authentication-required response by removing the trailing `/runtime/connect.mjs`.
5. To pick a model, ask Codex to call `dsh_status` with `includeModels: true`, copy the exact `provider`, `model`, and optional `reasoningEffort` from the returned catalog, then delegate in natural language, for example:

   > Delegate this clearly bounded task to DSH using deepseek-official/deepseek-v4-flash (effort low); inspect the full diff and accept the result yourself.

6. Route acceptance: `dsh_task` reports `modelRouting.requested`, `configured`, and `actualRequest` observed from the real request/header separately. An explicitly routed task may only complete successfully with an exactly matching actual header; a missing or mismatched header never silently falls back or reports success.

## Requirements

- Node.js 22.13+ (Node 22 LTS and 24+ are supported)
- npm
- DSH running on a local loopback address; the default is `http://127.0.0.1:3080`
- The login URL generated when DSH starts, required for the first local connection

Optional per-Session model pinning requires the bundled DSH companion in the same DSH profile that Codex addresses. The companion ships inside the plugin root installed from the marketplace, so regular users can point at `<installed-plugin-root>/dsh-companion` directly — no repository clone or npm build is needed. Repository developers may use the in-repo path instead:

```bash
dsh plugin --profile web add -w <installed-plugin-root>/dsh-companion
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

After installing from the marketplace, tell Codex:

> Check the DSH connection status.

Codex calls `dsh_status`:

- If DSH is not running, it tells you to start DSH and shows the local address it checked.
- If DSH is running but not authenticated, it returns a complete connection command containing the actual installed plugin path.
- If the state is `ready`, tasks can be delegated immediately.

For the first authentication, copy the complete command returned by Codex and run it in a local terminal, for example:

```bash
node <actual-plugin-root>/runtime/connect.mjs
```

The plugin resolves the actual directory automatically, so you do not need to run `codex plugin list` and find it manually. When prompted in the terminal, paste the login URL generated by DSH. Do not paste the login URL or token into a Codex conversation, MCP parameters, or project files. The connection entry point handles and stores credentials only on the local machine. When the credentials expire, `dsh_status` returns the connection command again. The plugin does not install, upgrade, or restart DSH.

## Usage

The plugin exposes four tools:

| Tool | Purpose |
| --- | --- |
| `dsh_status` | Distinguishes between DSH not running, authentication required, and ready. With `includeModels: true`, it returns a sanitized provider/model/effort catalog from the companion. |
| `dsh_submit` | Submits one clearly bounded task and returns a `taskId`. Optional `modelSelection` pins an exact route before the Session's first prompt. Repeating the same request does not submit it again. |
| `dsh_task` | Reads a specific task's state and result, or waits for a bounded period. A wait timeout does not cancel the task. |
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
- DSH is disconnected or authentication has expired: `dsh_status` returns `authentication_required` and a complete `connectCommand`. Run that command in a local terminal; do not send the login URL to the model.
- `runtime/server.mjs` is missing: run `npm ci && npm run build`.
- A task remains `running` for a long time: the current version cannot reliably detect whether DSH is waiting for permission or user input, so the state may remain `running`. Open DSH and handle the pending request there. The plugin does not grant permission or answer questions on the user's behalf.
- A task is `unknown`: call `dsh_task` again with the original `taskId` and `conversationKey`. The plugin performs a bounded read of the original session to look for a provable terminal state. It does not create or resubmit the task. If evidence remains insufficient, inspect DSH and the workspace; a write-task reservation is not released early.
- A cancelled task remains `cancel_requested`: this only proves that the cancellation request was sent. Wait for a confirmed terminal state. Existing file changes are not reverted automatically.
- Codex cannot find the tools: confirm that the plugin is installed and enabled, and open a new conversation after an update. Then verify the built artifacts and manifest; see `docs/COMPATIBILITY.md`.
- `MODEL_ROUTING_COMPANION_MISSING`: install the bundled companion into the profile addressed by `DSH_SUBAGENT_URL`, then restart it. Do not substitute `session/selectModel`, which writes the shared default.
- `MODEL_ROUTING_CAPABILITY_UNSUPPORTED` or a model configuration failure: refresh `dsh_status` with `includeModels: true` and verify the exact provider/model/effort. The bridge does not choose a fallback model.

## Current limitations

- Installation from the GitHub marketplace has been validated with an isolated Codex configuration, but Git-source update and uninstall regression tests are not yet complete. Tool discovery and a read-only task from a new conversation using a local marketplace have been validated. Closing the test window, quitting the entire app normally, and reopening it have been validated. Crash behavior has not been tested.
- Each task uses a separate DSH session. Continuing the original session for rework and listing tasks are not supported. Query-time recovery of a proven terminal state and result is supported; background automatic recovery and takeover of running tasks are not.
- After the Codex or MCP process exits, the plugin does not guarantee continued timeout tracking, automatic cancellation, or waking the conversation.
- The plugin cannot reliably distinguish normal execution from DSH waiting for permission or user input. The task may remain `running` while waiting.
- When the terminal state cannot be proven, the plugin returns `unknown` and does not automatically resubmit. Query-time recovery requires a complete, continuous history, the original task association, and consistent idle and empty-queue evidence. If DSH returns a truncated history snapshot, this version does not fetch additional pages. Results larger than the 65,536-character limit or snapshots larger than the transport limit also remain `unknown`.
- Only loopback addresses are allowed. DSH running on another machine is not supported.
- This is a community MCP plugin that lets Codex call an external DSH instance. It is not a native Codex subagent backend.

See the [compatibility notes](docs/COMPATIBILITY.md) for versions and reference sources.

## Development verification

`npm run check` performs type checking, builds the distributable artifacts, and runs 74 automated tests. The isolated probe below also boots a temporary DSH profile, installs the companion and a synthetic adapter, and proves authentication, two concurrently pinned Sessions, an unaffected default Session, cold-restart recovery, real request headers, and the bundled MCP `dsh_submit`→`dsh_task` path:

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-companion.mjs
```

The synthetic adapter proves the routing mechanism. It does not prove availability of any external provider or commercial model in the user's configuration.

After the first connection, the following commands submit one constrained task to a real DSH instance:

```bash
npm run smoke -- text
npm run smoke -- read
```

The script prints the `taskId` and `sessionId`. Verify the exact marker in the returned report and the actual file contents. DSH may add explanations, so the plugin does not guarantee strictly formatted plain-text output. After two minutes, the script requests cancellation. A task whose state cannot be confirmed remains `unknown` and is not retried automatically. Temporary test directories are retained for inspection so that a workspace still referenced by a DSH session is not deleted.

See the public [verification notes](docs/VERIFICATION.md) for a summary.
