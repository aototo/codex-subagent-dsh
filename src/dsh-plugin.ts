import type { Context } from '@deepseek-ai/cordis';
import { applyModelRouting } from './dsh-companion.js';
import { applyPairing } from './pairing-server.js';
// The desktop authorization implementation remains internal to the single bundle.
// @ts-expect-error Internal JavaScript module is bundled by esbuild.
import { apply as applyDesktop } from './desktop-bridge/index.mjs';

export const name = 'codex-subagent-dsh';
export const inject = ['profileContext', 'loader', 'agents', 'sessionController', 'sessions'];

const LEGACY_NAMES = new Set(['@aototo/codex-subagent-dsh-companion', '@aototo/codex-subagent-dsh-desktop-bridge']);
const LEGACY_IDS = new Set(['codex-session-model-routing', 'codex-subagent-dsh-desktop-bridge']);
const UNIFIED_PACKAGE = '@aototo/codex-subagent-dsh';
const owners = new WeakSet<object>();
type Entry = { options: { id?: string; name?: string }; disabled: boolean };
interface Host extends Context {
  profileContext: { name: string };
  loader: { entries(): Iterable<Entry> };
  registry: object;
}
function legacy(entry: Entry): boolean {
  return LEGACY_NAMES.has(entry.options.name ?? '') || LEGACY_IDS.has(entry.options.id ?? '');
}
function conflict(): Error {
  return new Error('CODEX_DSH_PLUGIN_CONFLICT: disable the old Codex companion/desktop bridge or duplicate unified plugin, then enable codex-subagent-dsh. Do not disable the aotu assistant.');
}
export function hostMode(profile: unknown): 'desktop' | 'web' {
  if (!profile || typeof profile !== 'object' || !('name' in profile) || typeof profile.name !== 'string' || !profile.name.trim()) {
    throw new Error('CODEX_DSH_HOST_UNKNOWN: profileContext.name is required; cannot choose an authorization surface safely.');
  }
  // Both hosts provide webServer. The application-owned profile is authoritative.
  return profile.name === 'desktop' ? 'desktop' : 'web';
}
export function apply(context: Context): void {
  const ctx = context as Host;
  const mode = hostMode(ctx.profileContext);
  const entries = [...ctx.loader.entries()].filter(entry => !entry.disabled);
  if (entries.some(legacy) || entries.filter(entry => entry.options.name === UNIFIED_PACKAGE || entry.options.id === name).length > 1 || owners.has(ctx.registry)) throw conflict();
  owners.add(ctx.registry);
  ctx.effect(() => () => { owners.delete(ctx.registry); });
  // Cordis emits this synchronously before running a new fiber. Throwing rejects
  // only the conflicting component. The host may persist its disabled status.
  ctx.on('internal/plugin', (fiber: { uid?: number | null; entry?: Entry; parent?: { fiber?: { entry?: Entry } }; ctx?: { fiber?: { entry?: Entry } } }) => {
    if (fiber.uid === null) return;
    const entry = fiber.entry ?? fiber.ctx?.fiber?.entry;
    if (entry && fiber.parent?.fiber?.entry === entry) return;
    if (entry && (legacy(entry) || entry.options.name === UNIFIED_PACKAGE || entry.options.id === name)) throw conflict();
  });
  if (mode === 'desktop') applyDesktop(ctx);
  else applyPairing(ctx);
  applyModelRouting(ctx);
}
