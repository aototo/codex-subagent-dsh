import type { Context } from '@deepseek-ai/cordis';
import { applyPairing } from './pairing-server.js';

export const name = 'codex-session-model-routing';
export const inject = ['agents', 'sessionController', 'sessions'];

const PROTOCOL = 1;
const CHANNEL = '/codex-session-model';
const OPERATIONS = ['capabilities.get', 'selection.set', 'selection.get'] as const;

interface Selection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

interface AgentLike {
  id: string;
  status: 'idle' | 'running';
  inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] };
  ctx: Context;
  session: {
    snapshotEvents(): Array<{ type: string; seq: number; data: any }>;
    append(type: string, value: unknown): unknown;
  };
}

interface Installation {
  selection: Selection;
  dispose(): void;
}

const PIN_MARKER = 'codexSessionModelRouting';
const PIN_OWNER = 'codex-subagent-dsh';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

function parseSelection(value: unknown): Selection | undefined {
  if (!record(value) || !identifier(value.provider) || !identifier(value.model)) return undefined;
  if (value.reasoningEffort !== undefined && !identifier(value.reasoningEffort)) return undefined;
  if (Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  };
}

function sameSelection(left: Selection, right: Selection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

function failure(code: string, message: string, details: object = {}) {
  return { ok: false as const, error: { code, message, details } };
}

function success<T>(value: T) {
  return { ok: true as const, value };
}

function durableSelection(agent: AgentLike): Selection | undefined {
  let selection: Selection | undefined;
  let count = 0;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'model/selection' || !record(event.data) || !Object.hasOwn(event.data, PIN_MARKER)) continue;
    count += 1;
    if (count > 1) throw new Error('multiple stored model pins');
    const marker = event.data[PIN_MARKER];
    if (
      !record(marker)
      || marker.owner !== PIN_OWNER
      || marker.protocol !== PROTOCOL
      || Object.keys(marker).some(key => !['owner', 'protocol'].includes(key))
      || Object.keys(event.data).some(key => !['provider', 'model', 'reasoningEffort', PIN_MARKER].includes(key))
    ) {
      throw new Error('stored model pin marker is invalid');
    }
    const parsed = parseSelection({
      provider: event.data.provider,
      model: event.data.model,
      ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort }),
    });
    if (parsed === undefined) throw new Error('stored model selection is invalid');
    selection = parsed;
  }
  return selection;
}

function actualSelection(agent: AgentLike): { selection: Selection; seq: number } | undefined {
  let actual: { selection: Selection; seq: number } | undefined;
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'request/header') continue;
    const config = event.data?.header?.config;
    const selection = parseSelection(record(config) ? {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    } : undefined);
    if (selection === undefined) throw new Error('stored request header is invalid');
    actual = { selection, seq: event.seq };
  }
  return actual;
}

function hasPromptHistory(agent: AgentLike): boolean {
  return agent.session.snapshotEvents().some(event => [
    'turn/start',
    'user/message',
    'request/header',
    'assistant/message',
    'assistant/attempt',
  ].includes(event.type));
}

function isAdmissionIdle(agent: AgentLike): boolean {
  return agent.status === 'idle' && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0;
}

function validateCatalog(catalog: any, selection: Selection): boolean {
  if (!record(catalog) || !Array.isArray(catalog.routableProviders) || !catalog.routableProviders.includes(selection.provider)) return false;
  if (!Array.isArray(catalog.groups)) return false;
  const provider = catalog.groups.find((group: any) => record(group) && group.id === selection.provider);
  if (!record(provider) || !Array.isArray(provider.models)) return false;
  const model = provider.models.find((entry: any) => record(entry) && entry.id === selection.model);
  if (!record(model)) return false;
  if (selection.reasoningEffort === undefined) return true;
  const reasoning = model.reasoning;
  return record(reasoning)
    && Array.isArray(reasoning.efforts)
    && reasoning.efforts.some((effort: any) => record(effort) && effort.id === selection.reasoningEffort);
}

function installPin(installations: Map<AgentLike, Installation>, agent: AgentLike, selection: Selection): void {
  const existing = installations.get(agent);
  if (existing !== undefined) {
    if (!sameSelection(existing.selection, selection)) throw new Error('agent model pin conflict');
    return;
  }

  let assembled: Selection | undefined;
  const disposeAssembly = agent.ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<any>) => {
    const downstream = await next();
    assembled = selection;
    return {
      ...downstream,
      variables: {
        ...downstream.variables,
        provider: selection.provider,
        model: selection.model,
      },
    };
  }, { prepend: true });
  const disposeRequest = agent.ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
    const downstream = await next();
    const selected = assembled;
    if (selected === undefined) throw new Error('model pin was not assembled for this request');
    const { reasoningEffort: _inherited, ...withoutInherited } = downstream;
    return {
      ...withoutInherited,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  }, { prepend: true });
  installations.set(agent, {
    selection,
    dispose() {
      disposeAssembly();
      disposeRequest();
    },
  });
}

function installDurablePin(installations: Map<AgentLike, Installation>, agent: AgentLike): void {
  const selection = durableSelection(agent);
  if (selection !== undefined) installPin(installations, agent, selection);
}

async function resolveAgent(ctx: Context, sessionId: unknown): Promise<AgentLike> {
  if (!identifier(sessionId) || sessionId.length > 512) throw new Error('invalid session id');
  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  if (record(resolved) && 'error' in resolved) throw new Error('session resolution failed');
  const agent = (record(resolved) && 'agent' in resolved ? resolved.agent : resolved) as AgentLike;
  if (!record(agent)) throw new Error('session resolution returned no agent');
  if (agent.id !== sessionId) throw new Error('resolved session scope mismatch');
  return agent;
}

export function apply(ctx: Context): void {
  applyPairing(ctx);
  const installations = new Map<AgentLike, Installation>();
  const locks = new Map<string, Promise<unknown>>();
  let closed = false;
  const serialized = async <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    locks.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (locks.get(sessionId) === current) locks.delete(sessionId);
    }
  };

  for (const agent of ctx.agents.list() as AgentLike[]) installDurablePin(installations, agent);
  ctx.on('agent/created', ({ agent }: { agent: AgentLike }) => {
    if (closed) return;
    installDurablePin(installations, agent);
  });
  ctx.on('agent/disposed', ({ agent }: { agent: AgentLike }) => {
    installations.get(agent)?.dispose();
    installations.delete(agent);
  });
  ctx.effect(() => () => {
    closed = true;
    for (const installation of installations.values()) installation.dispose();
    installations.clear();
  });

  const handleRpc = async (endpoint: string, payload: unknown) => {
    try {
      if (closed) return failure('gateway/unavailable', 'model-routing companion is stopping');
      if (endpoint === 'capabilities.get') {
        if (!record(payload) || Object.keys(payload).length !== 0) return failure('gateway/bad-request', 'capabilities payload must be empty');
        const catalog = await ctx.sessionController.modelCatalog();
        if (closed) return failure('gateway/unavailable', 'model-routing companion is stopping');
        return success({
          protocol: PROTOCOL,
          operations: [...OPERATIONS],
          persistence: 'session-log',
          immutableBeforeFirstPrompt: true,
          catalog,
        });
      }

      if (endpoint === 'selection.set') {
        if (!record(payload) || Object.keys(payload).some(key => !['sessionId', 'selection'].includes(key))) {
          return failure('gateway/bad-request', 'invalid selection request');
        }
        const requested = parseSelection(payload.selection);
        if (requested === undefined) return failure('gateway/bad-request', 'invalid model selection');
        const agent = await resolveAgent(ctx, payload.sessionId);
        return await serialized(agent.id, async () => {
          if (closed) return failure('gateway/unavailable', 'model-routing companion is stopping');
          const existing = durableSelection(agent);
          if (existing !== undefined) {
            if (!sameSelection(existing, requested)) return failure('session/model-conflict', 'Session already has another model pin');
            if (await ctx.sessions.flush(agent.session) !== true || closed) {
              return failure('session/persistence-unavailable', 'Session model pin durability could not be confirmed');
            }
            installPin(installations, agent, existing);
            return success({ protocol: PROTOCOL, sessionId: agent.id, persisted: true, selection: existing, idempotent: true });
          }
          if (hasPromptHistory(agent) || !isAdmissionIdle(agent)) {
            return failure('session/nonempty', 'Session model must be pinned before its first prompt');
          }
          const catalog = await ctx.sessionController.modelCatalog();
          if (closed) return failure('gateway/unavailable', 'model-routing companion is stopping');
          if (!validateCatalog(catalog, requested)) {
            return failure('session/model-unavailable', 'Requested provider, model, or reasoning effort is unavailable');
          }
          // Recheck after the asynchronous catalog read. From this point through
          // both appends there is no await, so prompt admission cannot interleave.
          if (hasPromptHistory(agent) || !isAdmissionIdle(agent) || durableSelection(agent) !== undefined) {
            return failure('session/nonempty', 'Session changed while its model pin was being validated');
          }
          // The namespaced marker distinguishes bridge ownership from ordinary
          // UI selections while retaining DSH's known, durable event type. DSH's
          // built-in projection reads only the model selection fields.
          agent.session.append('model/selection', {
            ...requested,
            [PIN_MARKER]: { owner: PIN_OWNER, protocol: PROTOCOL },
          });
          installPin(installations, agent, requested);
          if (await ctx.sessions.flush(agent.session) !== true) {
            return failure('session/persistence-unavailable', 'No Session durability provider acknowledged the model pin');
          }
          if (closed) return failure('gateway/unavailable', 'model-routing companion stopped before confirmation');
          return success({ protocol: PROTOCOL, sessionId: agent.id, persisted: true, selection: requested, idempotent: false });
        });
      }

      if (endpoint === 'selection.get') {
        if (!record(payload) || Object.keys(payload).some(key => key !== 'sessionId')) {
          return failure('gateway/bad-request', 'invalid selection query');
        }
        const agent = await resolveAgent(ctx, payload.sessionId);
        if (closed) return failure('gateway/unavailable', 'model-routing companion is stopping');
        const requested = durableSelection(agent);
        if (requested !== undefined) installPin(installations, agent, requested);
        const actual = actualSelection(agent);
        return success({
          protocol: PROTOCOL,
          pinned: requested !== undefined,
          requested,
          actualRequest: actual?.selection,
          actualRequestHeaderSeq: actual?.seq,
        });
      }

      return failure('gateway/not-found', 'unknown model-routing operation');
    } catch {
      return failure('gateway/internal', 'model-routing operation failed');
    }
  };
  // Exact Fetch routes live under Connection's shared `/api` carrier, after
  // its Host/Origin and browser-cookie authentication fence.
  ctx.inject(['connection'], (gatewayCtx: Context) => {
    for (const operation of OPERATIONS) {
      gatewayCtx.connection.fetch.register({
        path: `/api${CHANNEL}/${operation}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request: Request): Promise<Response> {
          let envelope: unknown;
          try {
            envelope = await request.json();
          } catch {
            return new Response('body is not JSON', { status: 400 });
          }
          if (
            !record(envelope)
            || envelope.type !== 'client-request'
            || !identifier(envelope.rpcId)
            || envelope.method !== operation
          ) {
            return new Response('invalid RPC envelope', { status: 400 });
          }
          const result = await handleRpc(operation, envelope.payload);
          return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
        },
      });
    }
  });
}
