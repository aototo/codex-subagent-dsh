import type { BridgeConfig } from './config.js';
import { EndpointError, readDesktopOrigin, resolveDshEndpoint, type DshConnectionMode, type DshEndpointDependencies, type DshEndpointOptions } from './dsh-endpoint.js';

/** Select before any task is created and never switch an established backend. */
export class EndpointBinding {
  private selected?: Awaited<ReturnType<typeof resolveDshEndpoint>>;
  private pending?: Promise<Awaited<ReturnType<typeof resolveDshEndpoint>>>;
  private pendingMode?: DshConnectionMode;
  private readonly options: DshEndpointOptions;
  constructor(config: BridgeConfig, private readonly deps: DshEndpointDependencies = {}) {
    this.options = { mode: config.connectionMode ?? 'web', webUrl: config.origin, stateDir: config.stateDir, expectedDshHome: config.expectedDshHome };
  }
  get current() { return this.selected; }
  private conflict() {
    return new EndpointError('DSH_BACKEND_BOUND', 'open_new_conversation', 'This MCP process already selected a DSH backend. Open a new Codex conversation and select the desired mode first; existing tasks will not move or be resubmitted.');
  }
  async get(mode?: DshConnectionMode) {
    if (this.selected && mode && mode !== 'auto' && mode !== this.selected.mode) throw this.conflict();
    if (!this.selected) {
      // Serialize first selection. A conflicting concurrent request must not reuse the wrong backend.
      if (this.pending && mode && mode !== 'auto' && this.pendingMode !== mode) throw this.conflict();
      if (!this.pending) {
        this.pendingMode = mode ?? this.options.mode;
        this.pending = resolveDshEndpoint({ ...this.options, mode: this.pendingMode }, this.deps);
      }
      const pending = this.pending;
      try { this.selected = await pending; }
      finally { if (this.pending === pending) { this.pending = undefined; this.pendingMode = undefined; } }
    }
    if (mode && mode !== 'auto' && mode !== this.selected.mode) throw this.conflict();
    if (this.selected.mode === 'desktop') {
      const current = await readDesktopOrigin(this.options, this.deps);
      if (current.origin !== this.selected.origin || current.pid !== this.selected.pid || current.instanceId !== this.selected.instanceId) {
        throw new EndpointError('DESKTOP_INSTANCE_CHANGED', 'open_new_conversation', 'DSH desktop instance changed. Open a new Codex conversation; this process will not switch task backends. Inspect unknown tasks in their original DSH session before resubmitting anything.');
      }
    }
    return this.selected;
  }
}
