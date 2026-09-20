import type { ModelSelection, WireEvent } from './types.js';

export const MODEL_ROUTING_PROTOCOL = 1;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

export function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (!record(value) || !identifier(value.provider) || !identifier(value.model)) return undefined;
  if (value.reasoningEffort !== undefined && !identifier(value.reasoningEffort)) return undefined;
  if (Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) return undefined;
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  };
}

export function sameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort;
}

export function matchesRequestedSelection(actual: ModelSelection, requested: ModelSelection): boolean {
  return actual.provider === requested.provider
    && actual.model === requested.model
    && (requested.reasoningEffort === undefined || actual.reasoningEffort === requested.reasoningEffort);
}

export function modelSelectionFromHeaderEvent(event: WireEvent): ModelSelection | undefined {
  if (event.type !== 'request/header') return undefined;
  const config = event.data?.header?.config;
  if (!record(config)) return undefined;
  return parseModelSelection({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  });
}

export function validateCapabilities(value: unknown): { protocol: 1; persistence: 'session-log' } {
  const operations = record(value) && Array.isArray(value.operations) ? value.operations : undefined;
  if (
    !record(value)
    || value.protocol !== MODEL_ROUTING_PROTOCOL
    || value.persistence !== 'session-log'
    || operations === undefined
    || !['capabilities.get', 'selection.set', 'selection.get'].every(operation => operations.includes(operation))
  ) {
    throw new Error('DSH model-routing companion returned unsupported capabilities');
  }
  return { protocol: MODEL_ROUTING_PROTOCOL, persistence: 'session-log' };
}

export function discoverableModels(value: unknown): {
  default: ModelSelection;
  providers: Array<{
    provider: string;
    name: string;
    models: Array<{ model: string; name: string; reasoningEfforts: string[] }>;
  }>;
} {
  validateCapabilities(value);
  const catalog = record(value) ? value.catalog : undefined;
  if (!record(catalog)) throw new Error('DSH model-routing companion returned an invalid model catalog');
  const selectedDefault = parseModelSelection(catalog.default);
  const routable = Array.isArray(catalog.routableProviders)
    ? catalog.routableProviders.filter(identifier)
    : undefined;
  if (selectedDefault === undefined || routable === undefined || routable.length > 100 || !Array.isArray(catalog.groups)) {
    throw new Error('DSH model-routing companion returned an invalid model catalog');
  }
  const providers = catalog.groups.flatMap((group): Array<{
    provider: string;
    name: string;
    models: Array<{ model: string; name: string; reasoningEfforts: string[] }>;
  }> => {
    if (!record(group) || !identifier(group.id) || !routable.includes(group.id) || !Array.isArray(group.models)) return [];
    const name = identifier(group.name) ? group.name : group.id;
    const models = group.models.slice(0, 500).flatMap((model): Array<{ model: string; name: string; reasoningEfforts: string[] }> => {
      if (!record(model) || !identifier(model.id)) return [];
      const reasoning = record(model.reasoning) && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
      return [{
        model: model.id,
        name: identifier(model.name) ? model.name : model.id,
        reasoningEfforts: reasoning.flatMap(effort => record(effort) && identifier(effort.id) ? [effort.id] : []).slice(0, 100),
      }];
    });
    return [{ provider: group.id, name, models }];
  }).slice(0, 100);
  if (providers.length === 0) throw new Error('DSH model-routing companion returned an empty model catalog');
  return { default: selectedDefault, providers };
}

export function validateSetResponse(value: unknown, expectedSessionId: string, expected: ModelSelection): ModelSelection {
  if (
    !record(value)
    || value.protocol !== MODEL_ROUTING_PROTOCOL
    || value.sessionId !== expectedSessionId
    || value.persisted !== true
  ) {
    throw new Error('DSH model-routing companion returned an invalid selection receipt');
  }
  const selected = parseModelSelection(value.selection);
  if (selected === undefined || !sameModelSelection(selected, expected)) {
    throw new Error('DSH model-routing companion did not confirm the exact selection');
  }
  return selected;
}
