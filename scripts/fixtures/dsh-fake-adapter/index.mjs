export const name = 'codex-session-model-fake-adapter';
export const inject = ['llm'];

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
  name: `Codex model-routing fixture ${model.id}`,
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

export function apply(ctx) {
  ctx.llm.registerAdapter([provider], adapter);
}
