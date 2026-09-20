// src/dsh-companion.ts
var name = "codex-session-model-routing";
var inject = ["agents", "sessionController", "sessions"];
var PROTOCOL = 1;
var CHANNEL = "/codex-session-model";
var OPERATIONS = ["capabilities.get", "selection.set", "selection.get"];
var PIN_MARKER = "codexSessionModelRouting";
var PIN_OWNER = "codex-subagent-dsh";
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}
function parseSelection(value) {
  if (!record(value) || !identifier(value.provider) || !identifier(value.model)) return void 0;
  if (value.reasoningEffort !== void 0 && !identifier(value.reasoningEffort)) return void 0;
  if (Object.keys(value).some((key) => !["provider", "model", "reasoningEffort"].includes(key))) return void 0;
  return {
    provider: value.provider,
    model: value.model,
    ...value.reasoningEffort === void 0 ? {} : { reasoningEffort: value.reasoningEffort }
  };
}
function sameSelection(left, right) {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}
function success(value) {
  return { ok: true, value };
}
function durableSelection(agent) {
  let selection;
  let count = 0;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== "model/selection" || !record(event.data) || !Object.hasOwn(event.data, PIN_MARKER)) continue;
    count += 1;
    if (count > 1) throw new Error("multiple stored model pins");
    const marker = event.data[PIN_MARKER];
    if (!record(marker) || marker.owner !== PIN_OWNER || marker.protocol !== PROTOCOL || Object.keys(marker).some((key) => !["owner", "protocol"].includes(key)) || Object.keys(event.data).some((key) => !["provider", "model", "reasoningEffort", PIN_MARKER].includes(key))) {
      throw new Error("stored model pin marker is invalid");
    }
    const parsed = parseSelection({
      provider: event.data.provider,
      model: event.data.model,
      ...event.data.reasoningEffort === void 0 ? {} : { reasoningEffort: event.data.reasoningEffort }
    });
    if (parsed === void 0) throw new Error("stored model selection is invalid");
    selection = parsed;
  }
  return selection;
}
function actualSelection(agent) {
  let actual;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== "request/header") continue;
    const config = event.data?.header?.config;
    const selection = parseSelection(record(config) ? {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === void 0 ? {} : { reasoningEffort: config.reasoningEffort }
    } : void 0);
    if (selection === void 0) throw new Error("stored request header is invalid");
    actual = { selection, seq: event.seq };
  }
  return actual;
}
function hasPromptHistory(agent) {
  return agent.session.snapshotEvents().some((event) => [
    "turn/start",
    "user/message",
    "request/header",
    "assistant/message",
    "assistant/attempt"
  ].includes(event.type));
}
function isAdmissionIdle(agent) {
  return agent.status === "idle" && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0;
}
function validateCatalog(catalog, selection) {
  if (!record(catalog) || !Array.isArray(catalog.routableProviders) || !catalog.routableProviders.includes(selection.provider)) return false;
  if (!Array.isArray(catalog.groups)) return false;
  const provider = catalog.groups.find((group) => record(group) && group.id === selection.provider);
  if (!record(provider) || !Array.isArray(provider.models)) return false;
  const model = provider.models.find((entry) => record(entry) && entry.id === selection.model);
  if (!record(model)) return false;
  if (selection.reasoningEffort === void 0) return true;
  const reasoning = model.reasoning;
  return record(reasoning) && Array.isArray(reasoning.efforts) && reasoning.efforts.some((effort) => record(effort) && effort.id === selection.reasoningEffort);
}
function installPin(installations, agent, selection) {
  const existing = installations.get(agent);
  if (existing !== void 0) {
    if (!sameSelection(existing.selection, selection)) throw new Error("agent model pin conflict");
    return;
  }
  let assembled;
  const disposeAssembly = agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const downstream = await next();
    assembled = selection;
    return {
      ...downstream,
      variables: {
        ...downstream.variables,
        provider: selection.provider,
        model: selection.model
      }
    };
  }, { prepend: true });
  const disposeRequest = agent.ctx.on("agent/request", async (_payload, next) => {
    const downstream = await next();
    const selected = assembled;
    if (selected === void 0) throw new Error("model pin was not assembled for this request");
    const { reasoningEffort: _inherited, ...withoutInherited } = downstream;
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === void 0 ? {} : { reasoningEffort: selected.reasoningEffort }
    };
  }, { prepend: true });
  installations.set(agent, {
    selection,
    dispose() {
      disposeAssembly();
      disposeRequest();
    }
  });
}
function installDurablePin(installations, agent) {
  const selection = durableSelection(agent);
  if (selection !== void 0) installPin(installations, agent, selection);
}
async function resolveAgent(ctx, sessionId) {
  if (!identifier(sessionId) || sessionId.length > 512) throw new Error("invalid session id");
  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  if (record(resolved) && "error" in resolved) throw new Error("session resolution failed");
  const agent = record(resolved) && "agent" in resolved ? resolved.agent : resolved;
  if (!record(agent)) throw new Error("session resolution returned no agent");
  if (agent.id !== sessionId) throw new Error("resolved session scope mismatch");
  return agent;
}
function apply(ctx) {
  const installations = /* @__PURE__ */ new Map();
  const locks = /* @__PURE__ */ new Map();
  let closed = false;
  const serialized = async (sessionId, operation) => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    locks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (locks.get(sessionId) === current) locks.delete(sessionId);
    }
  };
  for (const agent of ctx.agents.list()) installDurablePin(installations, agent);
  ctx.on("agent/created", ({ agent }) => {
    if (closed) return;
    installDurablePin(installations, agent);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    installations.get(agent)?.dispose();
    installations.delete(agent);
  });
  ctx.effect(() => () => {
    closed = true;
    for (const installation of installations.values()) installation.dispose();
    installations.clear();
  });
  const handleRpc = async (endpoint, payload) => {
    try {
      if (closed) return failure("gateway/unavailable", "model-routing companion is stopping");
      if (endpoint === "capabilities.get") {
        if (!record(payload) || Object.keys(payload).length !== 0) return failure("gateway/bad-request", "capabilities payload must be empty");
        const catalog = await ctx.sessionController.modelCatalog();
        if (closed) return failure("gateway/unavailable", "model-routing companion is stopping");
        return success({
          protocol: PROTOCOL,
          operations: [...OPERATIONS],
          persistence: "session-log",
          immutableBeforeFirstPrompt: true,
          catalog
        });
      }
      if (endpoint === "selection.set") {
        if (!record(payload) || Object.keys(payload).some((key) => !["sessionId", "selection"].includes(key))) {
          return failure("gateway/bad-request", "invalid selection request");
        }
        const requested = parseSelection(payload.selection);
        if (requested === void 0) return failure("gateway/bad-request", "invalid model selection");
        const agent = await resolveAgent(ctx, payload.sessionId);
        return await serialized(agent.id, async () => {
          if (closed) return failure("gateway/unavailable", "model-routing companion is stopping");
          const existing = durableSelection(agent);
          if (existing !== void 0) {
            if (!sameSelection(existing, requested)) return failure("session/model-conflict", "Session already has another model pin");
            if (await ctx.sessions.flush(agent.session) !== true || closed) {
              return failure("session/persistence-unavailable", "Session model pin durability could not be confirmed");
            }
            installPin(installations, agent, existing);
            return success({ protocol: PROTOCOL, sessionId: agent.id, persisted: true, selection: existing, idempotent: true });
          }
          if (hasPromptHistory(agent) || !isAdmissionIdle(agent)) {
            return failure("session/nonempty", "Session model must be pinned before its first prompt");
          }
          const catalog = await ctx.sessionController.modelCatalog();
          if (closed) return failure("gateway/unavailable", "model-routing companion is stopping");
          if (!validateCatalog(catalog, requested)) {
            return failure("session/model-unavailable", "Requested provider, model, or reasoning effort is unavailable");
          }
          if (hasPromptHistory(agent) || !isAdmissionIdle(agent) || durableSelection(agent) !== void 0) {
            return failure("session/nonempty", "Session changed while its model pin was being validated");
          }
          agent.session.append("model/selection", {
            ...requested,
            [PIN_MARKER]: { owner: PIN_OWNER, protocol: PROTOCOL }
          });
          installPin(installations, agent, requested);
          if (await ctx.sessions.flush(agent.session) !== true) {
            return failure("session/persistence-unavailable", "No Session durability provider acknowledged the model pin");
          }
          if (closed) return failure("gateway/unavailable", "model-routing companion stopped before confirmation");
          return success({ protocol: PROTOCOL, sessionId: agent.id, persisted: true, selection: requested, idempotent: false });
        });
      }
      if (endpoint === "selection.get") {
        if (!record(payload) || Object.keys(payload).some((key) => key !== "sessionId")) {
          return failure("gateway/bad-request", "invalid selection query");
        }
        const agent = await resolveAgent(ctx, payload.sessionId);
        if (closed) return failure("gateway/unavailable", "model-routing companion is stopping");
        const requested = durableSelection(agent);
        if (requested !== void 0) installPin(installations, agent, requested);
        const actual = actualSelection(agent);
        return success({
          protocol: PROTOCOL,
          pinned: requested !== void 0,
          requested,
          actualRequest: actual?.selection,
          actualRequestHeaderSeq: actual?.seq
        });
      }
      return failure("gateway/not-found", "unknown model-routing operation");
    } catch {
      return failure("gateway/internal", "model-routing operation failed");
    }
  };
  ctx.inject(["connection"], (gatewayCtx) => {
    for (const operation of OPERATIONS) {
      gatewayCtx.connection.fetch.register({
        path: `/api${CHANNEL}/${operation}`,
        methods: ["POST"],
        requestBody: "buffered",
        async fetch(request) {
          let envelope;
          try {
            envelope = await request.json();
          } catch {
            return new Response("body is not JSON", { status: 400 });
          }
          if (!record(envelope) || envelope.type !== "client-request" || !identifier(envelope.rpcId) || envelope.method !== operation) {
            return new Response("invalid RPC envelope", { status: 400 });
          }
          const result = await handleRpc(operation, envelope.payload);
          return Response.json({ type: "server-response", rpcId: envelope.rpcId, result });
        }
      });
    }
  });
}
export {
  apply,
  inject,
  name
};
