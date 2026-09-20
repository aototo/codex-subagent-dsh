# Per-session DSH model routing plan

## Goal

Let `dsh_submit` optionally pin one exact DSH provider, model, and reasoning
effort to the newly created task Session. The pin applies only to that Session,
is installed before the first prompt, survives bridge and DSH restarts, and is
verified separately from the eventual request/header evidence. Omitting the
selection preserves current behavior.

## Compatibility gate

Before wiring the bridge, prove these contracts against the installed DSH
packages used by the target host:

1. `@deepseek-ai/dsh-client-connection` exposes exact Fetch route registration
   under the shared `/api` carrier; the carrier performs its existing
   Host/Origin and browser-cookie checks before dispatch.
2. A target Agent exposes an Agent-scoped Cordis context. A prepended
   `system-prompt/assemble` listener can snapshot one immutable Session pin and
   override `assembly.variables.provider/model` after downstream selection.
3. A prepended `agent/request` listener can await downstream routing and then
   replace `provider/model/reasoningEffort`, so the Session pin wins over the
   built-in default/model-selection listener without changing shared defaults.
4. Two Agents with different pins remain isolated, and an Agent without a pin
   receives the original downstream assembly and request unchanged.
5. The companion can resolve an exact Session, reject a Session that already
   has prompt/request history, validate provider/model/effort from the live
   catalog, and persist the pin before returning success.

The installed versions under test are the top-level
`@deepseek-ai/dsh@0.1.5-rc.1`, its resolved `@deepseek-ai/dsh-agent`,
`@deepseek-ai/dsh-api-session-controller`, and
`@deepseek-ai/dsh-client-connection` packages at `0.1.5-rc.2`, and Cordis
`4.0.2`.

## Proposed authenticated companion API

The DSH companion registers exact
`/api/codex-session-model/<operation>` Fetch routes. Calls use the same
`client-request` envelope, Host/Origin checks, and cookie authentication as the
bridge's other `/api` requests.

- `capabilities.get` with `{}` returns protocol version, supported operations,
  persistence status, package compatibility, and the live model catalog.
- `selection.set` with
  `{ sessionId, selection: { provider, model, reasoningEffort? } }` validates
  the exact route and effort, proves the Session is still empty, persists the
  pin, installs its Agent-scoped hooks, and returns the normalized persisted
  selection. Repeating the exact value is idempotent; changing it or addressing
  a nonempty Session fails closed.
- `selection.get` with `{ sessionId }` returns the persisted requested pin and,
  when present in this Session's durable log, the latest actual request-header
  route as a separate field. It never infers execution from the setter receipt.

The bridge dispatch order for an explicit selection is:

1. create Session;
2. call companion capability discovery;
3. call `selection.set` and require an exact echoed selection;
4. subscribe to Session events;
5. submit the first prompt.

Any missing capability, malformed/unsupported response, validation failure,
persistence failure, or exact-selection mismatch fails the task before prompt
submission. The bridge never calls `session/selectModel`, because that method
also saves the shared default.

## Implementation

1. Add the optional model-selection object to `SubmitInput`, MCP schema, task
   records, output, and documentation. Stable input hashing already hashes the
   complete normalized input, so the selection participates in idempotency.
2. Add a small companion client with strict response validation and safe error
   mapping. Keep requested selection and observed request/header evidence as
   distinct task fields.
3. Add the DSH companion package in this repository. Persist each pin as an
   official `model/selection` Session event with a namespaced
   `codexSessionModelRouting` ownership marker, then await the Session
   persistence flush barrier before acknowledging it. On activation or resume,
   recover only marker-owned pins, reject conflicting marker records, and
   install hooks on existing/new matching Agents. Ordinary UI model selections
   remain outside bridge ownership.
4. During live execution, capture the Session's durable request header only for
   that task. Do not treat unrelated HTTP headers, setter receipts, or recovery
   results as proof of the actual model.
5. Update reconciliation so an explicit-model task can recover completion only
   when its own durable request header exactly matches the persisted pin.

## Acceptance

- Exact provider/model/effort is validated; unsupported values fail closed.
- An explicit selection is immutable after the first prompt and never updates
  the shared default.
- Selection persistence failure prevents prompt submission.
- Restart reloads a valid pin; a missing or corrupt pin for a pinned task cannot
  fall through to a default model.
- Concurrent Sessions can use different selections without cross-talk.
- Omitted selection preserves current request behavior.
- Requested selection and actual request/header evidence are reported
  separately, including during recovery.
- Unit/integration tests cover missing capability, malformed responses,
  unsupported selections, nonempty/cross-Session requests, persistence/reload,
  precedence, isolation, and prompt gating.
- Typecheck, full tests, distributable build, plugin manifest validation, Skill
  validation, and package-content inspection pass.

## Executable gate

The implementation is gated by two repository scripts. Both require an
explicit `DSH_INSTALL_ROOT`; checked-in code contains no developer-specific DSH
path.

```bash
DSH_INSTALL_ROOT=/path/to/lib/node_modules/@deepseek-ai/dsh \
  node scripts/probe-session-model-hooks.mjs

DSH_INSTALL_ROOT=/path/to/lib/node_modules/@deepseek-ai/dsh \
  node scripts/probe-dsh-companion.mjs
```

The hook probe exercises DSH's exported `installModelSelection` with the real
Cordis waterfall. The isolated-host probe creates a temporary profile on a
random port, proves unauthenticated rejection, authenticated set/get, concurrent
A/B pins, cold restore, unpinned Session C behavior, unchanged shared defaults,
actual request headers through a synthetic adapter, and one bundled MCP
`dsh_submit` completion with matching requested/configured/actual fields. The
synthetic models are fixtures; this gate does not establish availability of any
external provider or production model.
