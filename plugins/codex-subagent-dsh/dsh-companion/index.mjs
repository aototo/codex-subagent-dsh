// src/pairing-server.ts
import { createHash as createHash2 } from "node:crypto";

// src/pairing-state.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
var PairingError = class extends Error {
  constructor(status) {
    super("Pairing request could not be completed");
    this.status = status;
  }
  status;
};
var token = () => randomBytes(32).toString("hex");
var equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
var claimDigest = (secret) => createHash("sha256").update(secret).digest("hex");
var PairingState = class {
  constructor(now = Date.now, ttlMs = 3e5, capacity = 64, pendingLimit = 16) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.capacity = capacity;
    this.pendingLimit = pendingLimit;
  }
  now;
  ttlMs;
  capacity;
  pendingLimit;
  entries = /* @__PURE__ */ new Map();
  closed = false;
  sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt && (entry.state === "pending" || entry.state === "approved")) this.finish(entry, "expired");
      if (now >= entry.removeAt) this.entries.delete(id);
    }
  }
  begin(claimHash, origin) {
    this.sweep();
    if (this.closed) throw new PairingError(503);
    if (!/^[a-f0-9]{64}$/.test(claimHash)) throw new PairingError(400);
    if (this.entries.size >= this.capacity || [...this.entries.values()].filter((e) => e.state === "pending" || e.state === "approved").length >= this.pendingLimit) throw new PairingError(429);
    const expiresAt = this.now() + this.ttlMs;
    const entry = { pairingId: token(), claimHash, origin, matchingCode: randomBytes(4).toString("hex").toUpperCase(), csrf: token(), expiresAt, removeAt: expiresAt + this.ttlMs, state: "pending" };
    this.entries.set(entry.pairingId, entry);
    return { protocol: 1, pairingId: entry.pairingId, matchingCode: entry.matchingCode, expiresAt, confirmationUrl: `${origin}/codex-pairing/v1/confirm?id=${entry.pairingId}` };
  }
  get(id, origin) {
    this.sweep();
    if (this.closed) throw new PairingError(503);
    const entry = this.entries.get(id);
    if (!entry) throw new PairingError(404);
    if (entry.origin !== origin) throw new PairingError(403);
    return entry;
  }
  view(id, origin) {
    const { pairingId, matchingCode, expiresAt, state, csrf } = this.get(id, origin);
    return { pairingId, matchingCode, expiresAt, state, origin, csrf };
  }
  decide(id, origin, csrf, allow, cookie) {
    const entry = this.get(id, origin);
    if (!equal(csrf, entry.csrf)) throw new PairingError(403);
    if (entry.state !== "pending") throw new PairingError(409);
    if (allow) {
      if (!cookie || cookie.length > 4096 || /[\r\n]/.test(cookie)) throw new PairingError(403);
      entry.cookie = cookie;
      entry.state = "approved";
      entry.csrf = "";
    } else this.finish(entry, "rejected");
    return entry.state;
  }
  authorize(id, origin, secret) {
    const entry = this.get(id, origin);
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || !equal(claimDigest(secret), entry.claimHash)) throw new PairingError(403);
    return entry;
  }
  claim(id, origin, secret) {
    const entry = this.authorize(id, origin, secret);
    if (entry.state === "approved") {
      const cookie = entry.cookie;
      this.finish(entry, "claimed");
      return { state: "claimed", cookie };
    }
    return { state: entry.state };
  }
  cancel(id, origin, secret) {
    const entry = this.authorize(id, origin, secret);
    if (entry.state === "pending" || entry.state === "approved") this.finish(entry, "cancelled");
    return { state: entry.state };
  }
  finish(entry, state) {
    entry.state = state;
    delete entry.cookie;
    entry.csrf = "";
  }
  close() {
    for (const entry of this.entries.values()) this.finish(entry, "cancelled");
    this.entries.clear();
    this.closed = true;
  }
};

// src/pairing-server.ts
var ROOT = "/codex-pairing/v1";
var STYLE = "body{margin:0;padding:32px 18px;background:#f3f5f7;color:#18212d;font:16px/1.7 system-ui,sans-serif}main{max-width:640px;margin:24px auto;padding:32px;border:1px solid #dce2e9;border-radius:16px;background:white}h1{font-size:26px;margin-top:0}strong{font-family:ui-monospace,monospace;color:#1648a0}button{font:inherit;border:1px solid #bfc9d6;border-radius:8px;padding:10px 22px;cursor:pointer;background:#fff}button[value=allow]{background:#1959b8;border-color:#1959b8;color:white}button:focus-visible{outline:3px solid #80adff;outline-offset:3px}form{margin-top:28px}";
var STYLE_HASH = createHash2("sha256").update(STYLE).digest("base64");
var escape = (value) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var loopback = (ip) => ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
function secureHeaders(res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
}
function json(res, value) {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
function html(res, body) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>\u8FDE\u63A5 Codex \u4E0E DSH</title><style>${STYLE}</style><body><main><h1>\u8FDE\u63A5 Codex \u4E0E DSH</h1>${body}</main></body></html>`);
}
async function readBody(req) {
  if (Number(req.headers["content-length"] ?? 0) > 2048) throw new PairingError(413);
  const chunks = [];
  let length = 0;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > 2048) throw new PairingError(413);
          chunks.push(bytes);
        }
        return Buffer.concat(chunks).toString("utf8");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new PairingError(408));
          req.destroy();
        }, 5e3);
        timer.unref();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function parseJson(raw, fields) {
  if (raw.includes("\\")) throw new PairingError(400);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PairingError(400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PairingError(400);
  const object = value;
  if (Object.keys(object).length !== fields.length || fields.some((key) => typeof object[key] !== "string" || (raw.match(new RegExp(`"${key}"\\s*:`, "g")) ?? []).length !== 1) || Object.keys(object).some((key) => !fields.includes(key))) throw new PairingError(400);
  return object;
}
function registerPairing(ctx, state = new PairingState()) {
  let closed = false;
  let windowStart = Date.now(), requests = 0, begins = 0;
  const timer = setInterval(() => state.sweep(), 1e4).unref();
  ctx.effect(() => () => {
    closed = true;
    clearInterval(timer);
    state.close();
  });
  for (const operation of ["capabilities", "begin", "claim", "cancel", "confirm", "decide", "verify"]) {
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path: `${ROOT}/${operation}`, async handler(req, res) {
      secureHeaders(res);
      try {
        if (closed) throw new PairingError(503);
        const port = ctx.webServer.port;
        const host = req.headers.host;
        if (!Number.isInteger(port) || port < 1 || !loopback(req.socket.remoteAddress) || !host || !["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}` || port === 80 && host === h)) throw new PairingError(403);
        const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map((n) => n.toLowerCase());
        if (names.filter((n) => n === "host").length !== 1 || names.filter((n) => n === "origin").length > 1 || names.filter((n) => n === "content-type").length > 1) throw new PairingError(403);
        const origin = new URL(`http://${host}`).origin;
        const browserRoute = operation === "confirm" || operation === "decide" || operation === "verify";
        if (!browserRoute && (req.headers.origin !== void 0 || Object.keys(req.headers).some((k) => k.startsWith("sec-fetch-")))) throw new PairingError(403);
        if (Date.now() - windowStart >= 6e4) {
          windowStart = Date.now();
          requests = begins = 0;
        }
        if (++requests > 1200 || operation === "begin" && ++begins > 16) throw new PairingError(429);
        const method = operation === "capabilities" || operation === "confirm" ? "GET" : "POST";
        if (req.method !== method) {
          res.setHeader("allow", method);
          throw new PairingError(405);
        }
        const url = new URL(req.url ?? "", origin);
        if (operation !== "confirm" && url.search) throw new PairingError(400);
        if (operation === "capabilities") {
          json(res, { protocol: 1, pairing: true });
          return;
        }
        if (browserRoute) {
          if ((operation === "decide" || operation === "verify") && req.headers.origin !== origin) throw new PairingError(403);
          const rejected = ctx.connection.requestRejection(req);
          if (rejected !== void 0) {
            res.statusCode = rejected;
            html(res, "<p>\u8BF7\u5148\u5728\u6B64\u6D4F\u89C8\u5668\u767B\u5F55\u5F53\u524D DSH\uFF0C\u518D\u91CD\u65B0\u6253\u5F00 Codex \u63D0\u4F9B\u7684\u786E\u8BA4\u9875\u9762\u3002\u6B64\u9875\u9762\u4E0D\u4F1A\u81EA\u52A8\u767B\u5F55\u6216\u6388\u6743\u3002</p>");
            return;
          }
          if (operation === "verify") {
            if (req.headers["content-type"] !== "application/json") throw new PairingError(415);
            parseJson(await readBody(req), []);
            json(res, { protocol: 1, authenticated: true });
            return;
          }
          if (operation === "confirm") {
            if (url.searchParams.getAll("id").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "id")) throw new PairingError(400);
            const view = state.view(url.searchParams.get("id"), origin);
            if (view.state !== "pending") {
              html(res, `<p>\u6B64\u8BF7\u6C42\u5DF2\u5904\u7406\u6216\u8FC7\u671F\uFF08${escape(view.state)}\uFF09\u3002\u8BF7\u8FD4\u56DE Codex \u67E5\u770B\u7ED3\u679C\u3002</p>`);
              return;
            }
            html(res, `<p>\u4E00\u4E2A\u672C\u673A\u5BA2\u6237\u7AEF\u8BF7\u6C42\u8FDE\u63A5 DSH\u3002\u8BF7\u6C42\u6765\u6E90\u6807\u7B7E\u4E3A Codex \u63D2\u4EF6\uFF0C\u4F46\u8FD9\u4E0D\u662F\u53EF\u4FE1\u8EAB\u4EFD\u8BA4\u8BC1\u3002</p><p>DSH \u5730\u5740\uFF1A<strong>${escape(origin)}</strong></p><p>\u8BF7\u6838\u5BF9 Codex \u4E2D\u663E\u793A\u7684\u5339\u914D\u7801\uFF1A<strong>${escape(view.matchingCode)}</strong></p><p>\u5230\u671F\u65F6\u95F4\uFF1A${escape(new Date(view.expiresAt).toISOString())}\uFF085 \u5206\u949F\u5185\u6709\u6548\uFF09\u3002\u53EA\u6709\u4F60\u521A\u521A\u4E3B\u52A8\u53D1\u8D77\u8FDE\u63A5\u4E14\u5339\u914D\u7801\u4E00\u81F4\u65F6\u624D\u5141\u8BB8\u3002</p><p>\u5141\u8BB8\u540E\uFF0C\u5C06\u5F53\u524D DSH \u767B\u5F55\u51ED\u8BC1\u4EA4\u7ED9\u8BE5\u5BA2\u6237\u7AEF\u4FDD\u5B58\uFF0C\u4F7F\u5176\u53EF\u4EE5\u8C03\u7528\u5F53\u524D DSH \u63A5\u53E3\u3001\u8BFB\u53D6\u4F1A\u8BDD\u548C\u6D3E\u53D1\u4EFB\u52A1\u3002\u6267\u884C\u4ECD\u53D7 DSH \u6743\u9650\u7B56\u7565\u9650\u5236\u3002\u8FD9\u4E0D\u662F\u6309\u4EFB\u52A1\u9650\u6743\u6216\u53EF\u5355\u72EC\u64A4\u9500\u7684\u4EE4\u724C\uFF1B\u5220\u9664\u63D2\u4EF6\u51ED\u8BC1\u4E0D\u4F1A\u4F7F\u5DF2\u590D\u5236\u51ED\u8BC1\u5728 DSH \u5931\u6548\u3002</p><form method="post" action="${ROOT}/decide"><input type="hidden" name="pairingId" value="${escape(view.pairingId)}"><input type="hidden" name="csrf" value="${escape(view.csrf)}"><button type="submit" name="decision" value="allow">\u5141\u8BB8\u8FDE\u63A5</button> <button type="submit" name="decision" value="reject">\u62D2\u7EDD</button></form>`);
            return;
          }
          if (req.headers["content-type"] !== "application/x-www-form-urlencoded") throw new PairingError(415);
          const form = new URLSearchParams(await readBody(req));
          if (["pairingId", "csrf", "decision"].some((key) => form.getAll(key).length !== 1) || [...form.keys()].some((k) => !["pairingId", "csrf", "decision"].includes(k)) || !["allow", "reject"].includes(form.get("decision"))) throw new PairingError(400);
          const name2 = "dsh-auth-" + createHash2("sha256").update(new URL(origin).host).digest("base64url");
          const cookies = (req.headers.cookie ?? "").split(";").map((v) => v.trim()).filter((v) => v.slice(0, v.indexOf("=")) === name2);
          if (cookies.length !== 1 || cookies[0].length > 4096 || !new RegExp(`^${name2}=[A-Za-z0-9_.-]+$`).test(cookies[0])) throw new PairingError(403);
          const result = state.decide(form.get("pairingId"), origin, form.get("csrf"), form.get("decision") === "allow", cookies[0]);
          html(res, `<p>${result === "approved" ? "\u5DF2\u5141\u8BB8\u8FDE\u63A5\uFF0C\u8BF7\u8FD4\u56DE Codex \u7B49\u5F85\u8FDE\u63A5\u9A8C\u8BC1\u3002" : "\u5DF2\u62D2\u7EDD\u8FDE\u63A5\u3002"}\u4F60\u53EF\u4EE5\u5173\u95ED\u6B64\u9875\u9762\u3002</p>`);
          return;
        }
        if (req.headers["content-type"] !== "application/json") throw new PairingError(415);
        const fields = operation === "begin" ? ["claimHash"] : ["pairingId", "claimSecret"];
        const body = parseJson(await readBody(req), fields);
        if (operation === "begin") json(res, state.begin(body.claimHash, origin));
        else json(res, operation === "claim" ? state.claim(body.pairingId, origin, body.claimSecret) : state.cancel(body.pairingId, origin, body.claimSecret));
      } catch (error) {
        res.statusCode = error instanceof PairingError ? error.status : 500;
        if (operation === "confirm" || operation === "decide") html(res, "<p>\u8FDE\u63A5\u8BF7\u6C42\u672A\u5B8C\u6210\u3002\u8BF7\u8FD4\u56DE Codex \u68C0\u67E5\u72B6\u6001\uFF0C\u5E76\u4ECE\u5F53\u524D\u786E\u8BA4\u94FE\u63A5\u91CD\u65B0\u6253\u5F00\u9875\u9762\uFF1B\u5982\u8BF7\u6C42\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u8FDE\u63A5\u3002</p>");
        else json(res, { error: "pairing_request_failed" });
      }
    } }));
  }
}
function applyPairing(ctx) {
  ctx.inject(["webServer", "connection"], (pairingCtx) => registerPairing(pairingCtx));
}

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
  applyPairing(ctx);
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
