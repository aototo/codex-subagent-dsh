import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { apply, hostMode } from '../src/dsh-plugin.js';

const unified = { options: { id: 'codex-subagent-dsh', name: '@aototo/codex-subagent-dsh' }, disabled: false };
function fixture(profile = 'desktop', entries: any[] = [unified]) {
  const listeners = new Map<string, Function[]>(), effects: Function[] = [], injections: string[][] = [];
  const ctx: any = {
    profileContext: { name: profile }, loader: { entries: () => entries }, registry: {},
    agents: { list: () => [] }, sessions: {}, sessionController: {},
    on(name: string, callback: Function) { listeners.set(name, [...listeners.get(name) ?? [], callback]); return () => {}; },
    effect(callback: Function) { effects.push(callback()); },
    inject(deps: string[]) { injections.push(deps); },
  };
  return { ctx, listeners, effects, injections };
}
test('unified host routing uses profile name, never the shared webServer service', () => {
  assert.equal(hostMode({ name: 'desktop' }), 'desktop');
  assert.equal(hostMode({ name: 'web' }), 'web');
  assert.equal(hostMode({ name: 'custom-web' }), 'web');
  for (const profile of [undefined, {}, { name: '' }, { name: 3 }]) assert.throws(() => hostMode(profile), /HOST_UNKNOWN/);
});
test('unified desktop enables only desktop authorization and shared model routing', () => {
  const { ctx, injections } = fixture(); apply(ctx);
  assert.deepEqual(injections, [['webServer', 'connection'], ['connection']]);
});
test('unified Web enables only browser pairing and shared model routing', () => {
  const { ctx, injections } = fixture('web'); apply(ctx);
  assert.equal(injections.length, 2);
  assert.deepEqual(injections.at(-1), ['connection']);
});
test('enabled legacy or duplicate unified entries fail before hooks or routes are installed', () => {
  for (const legacy of [
    { options: { name: '@aototo/codex-subagent-dsh-companion' }, disabled: false },
    { options: { id: 'codex-subagent-dsh-desktop-bridge' }, disabled: false },
    { ...unified },
  ]) {
    const f = fixture('desktop', [unified, legacy]);
    assert.throws(() => apply(f.ctx), /PLUGIN_CONFLICT/);
    assert.equal(f.injections.length, 0); assert.equal(f.listeners.size, 0);
  }
});
test('disabled legacy and independent aotu assistant entries do not block unified plugin', () => {
  const f = fixture('desktop', [unified,
    { options: { name: '@aototo/codex-subagent-dsh-companion' }, disabled: true },
    { options: { name: '@aotu/dsh-desktop-bridge', id: 'aotu-desktop-bridge' }, disabled: false },
  ]);
  apply(f.ctx); assert.equal(f.injections.length, 2);
});
test('future conflicting top-level fiber is rejected; own children, unload, assistant are untouched', () => {
  const f = fixture(); apply(f.ctx);
  const hook = f.listeners.get('internal/plugin')![0];
  const old = { options: { name: '@aototo/codex-subagent-dsh-companion' }, disabled: false };
  assert.throws(() => hook({ uid: 12, entry: old }), /PLUGIN_CONFLICT/);
  assert.throws(() => hook({ uid: 13, entry: unified }), /PLUGIN_CONFLICT/);
  assert.doesNotThrow(() => hook({ uid: null, entry: old }));
  assert.doesNotThrow(() => hook({ uid: 14, entry: unified, parent: { fiber: { entry: unified } } }));
  assert.doesNotThrow(() => hook({ uid: 15, entry: { options: { name: '@aotu/dsh-desktop-bridge' } } }));
});
test('distribution has exactly one installable DSH package with matching backend/client identity', async () => {
  const root = new URL('../plugins/codex-subagent-dsh/', import.meta.url);
  const dirs = await readdir(root);
  assert(!dirs.includes('dsh-companion')); assert(!dirs.includes('dsh-desktop-bridge'));
  const manifest = JSON.parse(await readFile(new URL('dsh-plugin/package.json', root), 'utf8'));
  assert.equal(manifest.name, '@aototo/codex-subagent-dsh');
  assert.equal(manifest.version, '0.6.0');
  for (const entry of manifest.files) await readFile(new URL('dsh-plugin/' + entry, root));
  assert.match(await readFile(new URL('dsh-plugin/client.js', root), 'utf8'), /id: '@aototo\/codex-subagent-dsh'/);
});
