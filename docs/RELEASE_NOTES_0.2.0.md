# Release notes 0.2.0 — per-session DSH model routing

Status: prepared for PR review. 0.2.0 has **not** been published to the GitHub
marketplace, merged, tagged, or released. Publishing and PR creation are phase 2
and happen only after maintainer acceptance.

## Highlights

- `dsh_submit` accepts an optional `modelSelection` that pins one exact
  `provider` / `model` / optional `reasoningEffort` to the newly created task
  Session before its first prompt.
- A new bundled DSH companion (`@aototo/codex-subagent-dsh-companion` 0.2.0)
  registers authenticated exact Fetch routes under
  `/api/codex-session-model/<operation>` on the existing `/api` carrier — same
  Host/Origin checks and browser-cookie authentication, no side-channel
  credentials.
- Pins persist through DSH's official `model/selection` Session event with a
  `codexSessionModelRouting` ownership marker and a persistence-flush barrier
  before the companion acknowledges them. Companion hooks override prompt
  assembly and the actual agent request for the pinned Session only.
- `dsh_status` with `includeModels: true` returns a sanitized
  provider/model/effort catalog so callers copy exact identifiers instead of
  guessing.
- `dsh_task` reports `modelRouting.requested`, `configured`, and the
  `actualRequest` observed from the real `request/header` separately, including
  during query-time recovery.

## Behavior guarantees

- Routing is optional: omitting `modelSelection` preserves the existing default
  routing behavior, and unpinned Sessions keep downstream results.
- A persisted pin is immutable for that Session and participates in the
  idempotency hash; capability, validation, or persistence failure blocks the
  first prompt.
- No silent fallback: an explicitly routed completed task must carry an
  exactly matching actual request header. Missing or mismatched evidence does
  not report success, and the bridge never calls `session/selectModel`, so the
  shared default model is never written.
- Companion calls reuse the existing authenticated `/api` envelope;
  unauthenticated requests return 401.

## Install

Users install the Codex plugin from the marketplace as before
(`codex plugin marketplace add aototo/codex-subagent-dsh --ref main`, then
`codex plugin add codex-subagent-dsh@codex-subagent-dsh`). The companion ships
inside the installed plugin root, so model routing additionally needs:

```bash
dsh plugin --profile web add -w <installed-plugin-root>/dsh-companion
```

Run against the same profile addressed by `DSH_SUBAGENT_URL`, then restart that
profile. No repository clone or npm build is needed for this step; building is
only for repo development. Compatibility gate: `@deepseek-ai/dsh` 0.1.5-rc.1
with resolved `dsh-agent` / Session Controller / Connection 0.1.5-rc.2 and
Cordis 4.0.2 — re-run the isolated host probe for other combinations.

## Validation

Independently run on the maintainer host:

- `npm run check`: typecheck, distributable build, and 74 automated tests pass.
- Hook probe (`probe-session-model-hooks.mjs`): real `installModelSelection`
  and Cordis waterfall confirm pin precedence over downstream selection.
- Isolated-host probe (`probe-dsh-companion.mjs`): temporary profile on a
  random port proves unauthenticated 401, authenticated capability discovery
  and set/get, concurrent A/B pins on different models, cold-restart recovery,
  unpinned Session C keeping the default, exact request headers, unchanged
  shared default, and one bundled-MCP `dsh_submit(modelSelection)` completing
  with matching requested/configured/actualRequest.
- Live real-provider acceptance: a `deepseek-official / deepseek-v4-flash /
  low` task completed via the built MCP runtime with all three route fields
  matching exactly (actual request/header seq 12); the shared default stayed
  `devin-proxy / devin/swe-2 / high` and the profile settings file hash was
  identical before and after.

User-reported, not yet independently reproduced by the maintainer:

- A new Codex desktop conversation discovered the installed 0.2.0 tools, read
  the README accurately, and completed an explicitly routed
  `deepseek-official / deepseek-v4-flash / low` task with all three route
  fields matching; 36 project files were unchanged.

## Known limits

- 0.2.0 is not yet published to the GitHub marketplace; marketplace install
  and lifecycle evidence belongs to 0.1.1. No fresh GitHub 0.2.0 install,
  update, or uninstall has been verified.
- Only the DeepSeek official provider above has live evidence; synthetic
  fixtures prove the mechanism, not other providers or models.
- The desktop new-conversation path is user-reported pending independent
  reproduction.
- Existing 0.1.x limits still apply: loopback-only DSH, no crash-recovery
  verification, no background task takeover, `running` may mask a pending
  permission/input request in DSH, and unprovable terminal states stay
  `unknown` without resubmission.

## PR material

Suggested title:

```text
feat: add per-session DSH model routing (0.2.0)
```

Suggested body:

```markdown
## Summary
Adds optional per-session model routing: `dsh_submit.modelSelection` pins one
exact provider/model/reasoningEffort to the new task Session via a bundled,
authenticated DSH companion. `dsh_status { includeModels: true }` exposes a
sanitized catalog; `dsh_task` reports requested/configured/actualRequest
separately with no silent fallback and no writes to the shared default.

## Key changes
- Optional `modelSelection` on `dsh_submit`; immutable per Session, part of
  the idempotency hash; first prompt gated on capability, validation, and
  durable persistence.
- New `dsh-companion` plugin: `/api/codex-session-model/*` routes,
  marker-owned `model/selection` persistence, agent-scoped assembly/request
  hooks.
- Model catalog discovery and separate actual request/header evidence,
  including recovery-time matching.
- Docs: bilingual quickstart, companion install from the installed plugin
  root, verification records, and these release notes.

## Validation
- `npm run check` (typecheck + build + 74 tests) passes.
- Isolated-host probes prove auth gating, concurrent pin isolation, cold
  restart, unpinned-session default, exact request headers, and unchanged
  shared default.
- Live acceptance on `deepseek-official/deepseek-v4-flash/low` completed with
  requested/configured/actual matching exactly; shared default unchanged.
- Desktop new-conversation 0.2.0 run is user-reported, pending independent
  reproduction.

## Known limits
- 0.2.0 not yet published to the marketplace; no fresh GitHub install/update/
  uninstall verification.
- Single real provider verified; no claim for other providers/models.
- Existing 0.1.x limits (loopback only, no crash-recovery test, no background
  takeover) unchanged.
```
