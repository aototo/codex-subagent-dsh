export const name = 'codex-approval-fixture';
export const inject = ['llm', 'agents', 'approval'];

const pendingBySignal = new WeakMap();
const provider = 'codex-fixture';
const models = [
  { id: 'fixture-model-a', effort: 'fixture-high' },
  { id: 'fixture-model-b', effort: 'fixture-low' },
  { id: 'fixture-model-c', effort: 'fixture-medium' },
];

function modelInfo(model) {
  return {
    provider,
    id: model.id,
    name: `Codex approval fixture ${model.id}`,
    inputModalities: ['text'],
    context: { contextWindow: 16_384 },
    defaultMaxTokens: 1_024,
    reasoning: {
      efforts: [{ id: model.effort, name: model.effort }],
      defaultEffort: model.effort,
    },
  };
}

const adapter = {
  providerInfo(route) {
    return { id: route, name: 'Codex fixture provider' };
  },
  providerRetryPolicy() {},
  imageRequestPricing() {},
  async listModels() {
    return models.map(modelInfo);
  },
  async resolveModel(route, requestedModel) {
    const selected = models.find(candidate => candidate.id === requestedModel);
    if (route !== provider || selected === undefined) throw new Error('fixture route mismatch');
    return modelInfo(selected);
  },
  async prepareCall(route, requestedModel) {
    return {
      model: await this.resolveModel(route, requestedModel),
      stream: options => this.stream(options),
    };
  },
  async *stream(options) {
    await pendingBySignal.get(options.signal)?.();
    const selected = models.find(candidate => candidate.id === options.model);
    if (options.provider !== provider || selected === undefined || options.reasoningEffort !== selected.effort) {
      throw new Error('fixture request config mismatch');
    }
    const text = `isolated fixture response from ${selected.id}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

// This fixture invokes the real approval service inside a real agent turn.
// Only the LLM and answerer are deterministic; audit events are never fabricated.
export function apply(ctx) {
  ctx.llm.registerAdapter([provider], adapter);
  ctx.on('agent/created', ({ agent }) => {
    let used = false;
    const scenario = agent.session.header.cwd.split('/').at(-1);
    agent.ctx.on('approval/request', async (_req, next) => {
      if (scenario === 'native') return next();
      if (scenario === 'unavailable') throw new Error('fixture answerer unavailable');
      await new Promise(resolve => setTimeout(resolve, 1800));
      return scenario === 'reject' ? 'rejected' : 'allowed-once';
    }, { prepend: true });
    agent.ctx.on('agent/request', async ({ signal }, next) => {
      // User messages are committed after request preparation. Start approval
      // from stream() so the bridge can correlate the originating prompt first.
      pendingBySignal.set(signal, async () => {
        if (used) return;
        used = true;
        if (scenario === 'never') ctx.approval.setPolicy(agent, 'never');
        const abort = new AbortController();
        const timer = scenario === 'cancel' ? setTimeout(() => abort.abort(), 500) : undefined;
        try {
          await ctx.approval.request({
            agent,
            toolName: 'approval-fixture',
            callId: 'fixture-call',
            reason: 'Isolated approval transport verification. No file changes or shell commands.',
            signal: AbortSignal.any([signal, abort.signal]),
          });
        } finally {
          clearTimeout(timer);
        }
      });
      return next();
    }, { prepend: true });
  });
}
