import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverableModels,
  modelSelectionFromHeaderEvent,
  validateCapabilities,
  validateSetResponse,
} from '../src/model-routing.js';

const selection = { provider: 'fixture', model: 'model-a', reasoningEffort: 'high' };

test('request header selection extracts only route fields from realistic config', () => {
  assert.deepEqual(modelSelectionFromHeaderEvent({
    type: 'request/header',
    seq: 4,
    data: {
      reason: 'initial',
      header: { config: { ...selection, temperature: 0.2, maxTokens: 4096, topP: 0.9 } },
    },
  }), selection);
});

test('capability and receipt validation rejects malformed, unsupported, and wrong-session responses', () => {
  const capabilities = {
    protocol: 1,
    persistence: 'session-log',
    operations: ['capabilities.get', 'selection.set', 'selection.get'],
    catalog: {
      default: selection,
      routableProviders: ['fixture'],
      groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] }, privateConfig: 'omitted' }] }],
      failures: [{ secret: 'omitted' }],
    },
  };
  assert.deepEqual(validateCapabilities(capabilities), { protocol: 1, persistence: 'session-log' });
  assert.deepEqual(discoverableModels(capabilities), {
    default: selection,
    providers: [{ provider: 'fixture', name: 'Fixture', models: [{ model: 'model-a', name: 'Model A', reasoningEfforts: ['high'] }] }],
  });
  assert.throws(() => validateCapabilities({ protocol: 2, operations: [] }), /unsupported/);
  assert.deepEqual(validateSetResponse({
    protocol: 1,
    sessionId: 'session-a',
    persisted: true,
    selection,
  }, 'session-a', selection), selection);
  assert.throws(() => validateSetResponse({
    protocol: 1,
    sessionId: 'session-b',
    persisted: true,
    selection,
  }, 'session-a', selection), /invalid selection receipt/);
});
