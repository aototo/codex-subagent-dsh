import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../src/dsh-companion.js';

type Selection = { provider: string; model: string; reasoningEffort?: string };

const selectionA: Selection = { provider: 'fixture', model: 'model-a', reasoningEffort: 'high' };
const selectionB: Selection = { provider: 'fixture', model: 'model-b', reasoningEffort: 'low' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeAgent {
  status = 'idle' as const;
  inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[] };
  events: Array<{ type: string; seq: number; data: any }> = [];
  listeners = new Map<string, Set<(...args: any[]) => unknown>>();
  ctx = {
    on: (name: string, listener: (...args: any[]) => unknown) => {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return () => listeners.delete(listener);
    },
  };
  session = {
    snapshotEvents: () => [...this.events],
    append: (type: string, data: unknown) => {
      const event = { type, seq: this.events.length, data: structuredClone(data) };
      this.events.push(event);
      return event;
    },
  };
  constructor(readonly id: string) {}
}

class CompanionHarness {
  agents = new Map<string, FakeAgent>();
  routes = new Map<string, { fetch(request: Request): Promise<Response> }>();
  listeners = new Map<string, Set<(...args: any[]) => unknown>>();
  disposers: Array<() => void | Promise<void>> = [];
  flush = true;
  catalog: any = {
    default: selectionA,
    routableProviders: ['fixture'],
    groups: [{
      id: 'fixture',
      name: 'Fixture',
      models: [
        { id: 'model-a', name: 'A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
        { id: 'model-b', name: 'B', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
      ],
    }],
  };
  catalogCall = async () => this.catalog;
  ctx: any = {
    agents: { list: () => [...this.agents.values()] },
    sessionController: {
      resolveAgent: async (sessionId: string) => {
        const agent = this.agents.get(sessionId);
        return agent === undefined ? { error: new Error('not found') } : { agent };
      },
      modelCatalog: () => this.catalogCall(),
    },
    sessions: { flush: async () => this.flush },
    on: (name: string, listener: (...args: any[]) => unknown) => {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
      return () => listeners.delete(listener);
    },
    effect: (callback: () => (() => void | Promise<void>)) => {
      const disposer = callback();
      this.disposers.push(disposer);
      return disposer;
    },
    inject: (dependencies: string[], callback: (ctx: any) => void) => {
      if (dependencies.every(name => name in this.ctx)) callback(this.ctx);
      return () => {};
    },
    connection: {
      fetch: {
        register: (route: any) => {
          this.routes.set(route.path, route);
          const disposer = () => { this.routes.delete(route.path); };
          this.disposers.push(disposer);
          return disposer;
        },
      },
    },
  };

  addAgent(id: string) {
    const agent = new FakeAgent(id);
    this.agents.set(id, agent);
    return agent;
  }

  start() {
    apply(this.ctx);
  }

  async dispose() {
    for (const disposer of [...this.disposers].reverse()) await disposer();
  }

  async rpc(operation: string, payload: unknown) {
    const path = `/api/codex-session-model/${operation}`;
    const route = this.routes.get(path);
    assert(route, `missing route ${path}`);
    const response = await route.fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: operation, payload }),
    }));
    assert.equal(response.status, 200);
    return (await response.json() as any).result;
  }
}

test('companion ignores ordinary UI selection events and persists one namespaced bridge pin', async t => {
  const harness = new CompanionHarness();
  const agent = harness.addAgent('session-ui');
  agent.session.append('model/selection', selectionB);
  harness.start();
  t.after(() => harness.dispose());

  assert.deepEqual(await harness.rpc('selection.get', { sessionId: agent.id }), {
    ok: true,
    value: { protocol: 1, pinned: false },
  });
  const result = await harness.rpc('selection.set', { sessionId: agent.id, selection: selectionA });
  assert.equal(result.ok, true);
  assert.equal(result.value.persisted, true);
  assert.equal(agent.events.filter(event => event.type === 'model/selection').length, 2);
  assert.deepEqual((await harness.rpc('selection.get', { sessionId: agent.id })).value.requested, selectionA);
});

test('companion serializes conflicting sets and rejects invalid provider or effort before append', async t => {
  const harness = new CompanionHarness();
  const agent = harness.addAgent('session-race');
  const catalog = deferred<any>();
  harness.catalogCall = () => catalog.promise;
  harness.start();
  t.after(() => harness.dispose());

  const first = harness.rpc('selection.set', { sessionId: agent.id, selection: selectionA });
  const second = harness.rpc('selection.set', { sessionId: agent.id, selection: selectionB });
  catalog.resolve(harness.catalog);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, false);
  assert.equal(right.error.code, 'session/model-conflict');
  assert.equal(agent.events.length, 1);

  const other = harness.addAgent('session-invalid');
  assert.equal((await harness.rpc('selection.set', {
    sessionId: other.id,
    selection: { provider: 'unknown', model: 'model-a' },
  })).error.code, 'session/model-unavailable');
  assert.equal((await harness.rpc('selection.set', {
    sessionId: other.id,
    selection: { provider: 'fixture', model: 'model-a', reasoningEffort: 'wrong' },
  })).error.code, 'session/model-unavailable');
  assert.equal(other.events.length, 0);
});

test('flush failure never claims durability; exact retry flushes again and becomes idempotent', async t => {
  const harness = new CompanionHarness();
  const agent = harness.addAgent('session-flush');
  harness.flush = false;
  harness.start();
  t.after(() => harness.dispose());

  const failed = await harness.rpc('selection.set', { sessionId: agent.id, selection: selectionA });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'session/persistence-unavailable');
  assert.equal(agent.events.length, 1);
  harness.flush = true;
  const retry = await harness.rpc('selection.set', { sessionId: agent.id, selection: selectionA });
  assert.equal(retry.ok, true);
  assert.equal(retry.value.persisted, true);
  assert.equal(retry.value.idempotent, true);
  assert.equal(agent.events.length, 1);
});

test('plugin disposal during catalog validation prevents append and hook installation', async () => {
  const harness = new CompanionHarness();
  const agent = harness.addAgent('session-dispose');
  const catalog = deferred<any>();
  harness.catalogCall = () => catalog.promise;
  harness.start();
  const pending = harness.rpc('selection.set', { sessionId: agent.id, selection: selectionA });
  await harness.dispose();
  catalog.resolve(harness.catalog);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'gateway/unavailable');
  assert.equal(agent.events.length, 0);
  assert.equal(agent.listeners.size, 0);
});

// Both Web and Desktop use these same session-scoped middleware contracts.
async function assembleRequest(agent: FakeAgent, defaults: Selection) {
  const assemblyListeners = [...(agent.listeners.get('system-prompt/assemble') ?? [])];
  let assembly = { variables: { ...defaults, sentinel: 'preserved' } };
  for (const listener of assemblyListeners.reverse()) {
    const downstream = assembly;
    assembly = await listener({}, {}, async () => downstream) as typeof assembly;
  }
  let request = { ...defaults, messages: ['unchanged'] };
  for (const listener of [...(agent.listeners.get('agent/request') ?? [])].reverse()) {
    const downstream = request;
    request = await listener({}, async () => downstream) as typeof request;
  }
  return { assembly, request };
}

test('session pins isolate both assembly and request from other sessions and shared defaults', async t => {
  const harness = new CompanionHarness();
  const a = harness.addAgent('session-a');
  const b = harness.addAgent('session-b');
  const unpinned = harness.addAgent('session-unpinned');
  harness.start();
  t.after(() => harness.dispose());
  const defaults = { provider: 'shared', model: 'shared-default', reasoningEffort: 'inherited' };
  const beforeCatalog = structuredClone(harness.catalog);
  for (const [agent, selection] of [[a, selectionA], [b, selectionB]] as const) {
    assert.equal((await harness.rpc('selection.set', { sessionId: agent.id, selection })).ok, true);
  }
  const [left, right, control] = await Promise.all([a, b, unpinned].map(agent => assembleRequest(agent, defaults)));
  for (const [actual, selection] of [[left, selectionA], [right, selectionB]] as const) {
    assert.equal(actual.assembly.variables.provider, selection.provider);
    assert.equal(actual.assembly.variables.model, selection.model);
    assert.equal(actual.assembly.variables.sentinel, 'preserved');
    assert.deepEqual(actual.request, { ...selection, messages: ['unchanged'] });
  }
  assert.deepEqual(control.request, { ...defaults, messages: ['unchanged'] });
  assert.equal(unpinned.listeners.size, 0);
  assert.deepEqual(harness.catalog, beforeCatalog);
});

test('omitting effort removes inherited request effort and reports actual headers separately', async t => {
  const harness = new CompanionHarness();
  const agent = harness.addAgent('session-default-effort');
  harness.start();
  t.after(() => harness.dispose());
  const selection = { provider: 'fixture', model: 'model-a' };
  assert.equal((await harness.rpc('selection.set', { sessionId: agent.id, selection })).ok, true);
  const result = await assembleRequest(agent, selectionB);
  assert.deepEqual(result.request, { ...selection, messages: ['unchanged'] });
  assert.equal(Object.hasOwn(result.request, 'reasoningEffort'), false);
  assert.equal((await harness.rpc('selection.get', { sessionId: agent.id })).value.actualRequest, undefined);
  // An adapter can materialize its own default; the verification API must report
  // this actual header, not simply echo the configured selection as proof.
  agent.session.append('request/header', { header: { config: selectionA } });
  const verified = (await harness.rpc('selection.get', { sessionId: agent.id })).value;
  assert.deepEqual(verified.requested, selection);
  assert.deepEqual(verified.actualRequest, selectionA);
  assert.equal(verified.actualRequestHeaderSeq, 1);
});

test('restored durable pin reinstalls scoped hooks while ordinary UI selection does not', async t => {
  const harness = new CompanionHarness();
  const pinned = harness.addAgent('session-restored');
  const ordinary = harness.addAgent('session-ordinary');
  pinned.session.append('model/selection', {
    ...selectionA, codexSessionModelRouting: { owner: 'codex-subagent-dsh', protocol: 1 },
  });
  ordinary.session.append('model/selection', selectionB);
  harness.start();
  t.after(() => harness.dispose());
  assert.deepEqual((await assembleRequest(pinned, selectionB)).request, { ...selectionA, messages: ['unchanged'] });
  assert.equal(ordinary.listeners.size, 0);
});
