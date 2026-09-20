#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const dshRoot = process.env.DSH_INSTALL_ROOT;
if (!dshRoot) {
  throw new Error('Set DSH_INSTALL_ROOT to the installed @deepseek-ai/dsh package directory');
}
const requireFromDsh = createRequire(`${dshRoot}/package.json`);
const { Context } = requireFromDsh('@deepseek-ai/cordis');
const { agentEvents, installModelSelection } = requireFromDsh('@deepseek-ai/dsh-agent');
const { createScope, scopeTarget } = requireFromDsh('@deepseek-ai/dsh-scope');

function installBuiltInSelection(agentCtx, route) {
  installModelSelection(agentCtx, { current: route, assembled: undefined });
}

function installSessionPin(agentCtx, selection) {
  let assembled;
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current;
    const downstream = await next();
    assembled = selected;
    if (selected === undefined) return downstream;
    return {
      ...downstream,
      variables: {
        ...downstream.variables,
        provider: selected.provider,
        model: selected.model,
      },
    };
  }, { prepend: true });
  agentCtx.on('agent/request', async (_payload, next) => {
    const downstream = await next();
    if (assembled === undefined) return downstream;
    const { reasoningEffort: _inherited, ...withoutInherited } = downstream;
    return {
      ...withoutInherited,
      provider: assembled.provider,
      model: assembled.model,
      ...(assembled.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: assembled.reasoningEffort }),
    };
  }, { prepend: true });
}

async function runAgent(root, sessionId, selection) {
  const agent = { id: sessionId };
  const scope = createScope(root, agent);
  const agentCtx = scope.ctx;
  installBuiltInSelection(agentCtx, {
    provider: 'shared-default',
    model: 'default-model',
    reasoningEffort: 'default-effort',
  });
  if (selection !== undefined) installSessionPin(agentCtx, { current: selection });

  const assembly = await root.waterfall(
    scopeTarget(agent, agent),
    'system-prompt/assemble',
    { variables: { marker: sessionId } },
    { scope: agent },
    async () => ({ variables: { marker: sessionId } }),
  );
  const request = await agentEvents(root, agent).waterfall(
    'agent/request',
    { turn: 1, step: 1, signal: AbortSignal.timeout(1_000) },
    async () => ({ provider: 'adapter', model: 'adapter-model', reasoningEffort: 'adapter-effort' }),
  );
  return { assembly, request };
}

const root = new Context();
const first = await runAgent(root, 'session-a', {
  provider: 'fixture-provider-a',
  model: 'fixture-model-a',
  reasoningEffort: 'high',
});
const second = await runAgent(root, 'session-b', {
  provider: 'fixture-provider-b',
  model: 'fixture-model-b',
});
const omitted = await runAgent(root, 'session-c', undefined);

assert.deepEqual(first.assembly.variables, {
  marker: 'session-a',
  provider: 'fixture-provider-a',
  model: 'fixture-model-a',
});
assert.deepEqual(first.request, {
  provider: 'fixture-provider-a',
  model: 'fixture-model-a',
  reasoningEffort: 'high',
});
assert.deepEqual(second.request, {
  provider: 'fixture-provider-b',
  model: 'fixture-model-b',
});
assert.deepEqual(omitted.request, {
  provider: 'shared-default',
  model: 'default-model',
  reasoningEffort: 'default-effort',
});
assert.notDeepEqual(first.request, second.request);

console.log(JSON.stringify({
  dsh: requireFromDsh('@deepseek-ai/dsh/package.json').version,
  agent: requireFromDsh('@deepseek-ai/dsh-agent/package.json').version,
  note: 'Routes are fabricated hook-order fixtures; this probe does not prove provider availability.',
  first,
  second,
  omitted,
}, null, 2));
