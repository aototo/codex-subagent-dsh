import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isSafeCookieHeader, loadCredential, saveCredential, type DshCredential } from './auth.js';
import { normalizeLoopbackOrigin, type BridgeConfig } from './config.js';

const PREFIX = '/codex-pairing/v1/';
const MAX_BYTES = 64 * 1024;
type SafeResult = { state: string; available?: boolean; connected?: boolean; confirmationUrl?: string; matchingCode?: string; expiresAt?: number; browserOpened?: boolean; nextAction?: string };
interface Pending { pairingId: string; claimSecret: string; matchingCode: string; expiresAt: number; confirmationUrl: string; browserOpened: boolean }
export interface PairingDependencies {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => Promise<boolean>;
  now?: () => number;
  saveCredential?: (config: BridgeConfig, credential: DshCredential) => Promise<void>;
}
class Failure extends Error { constructor(readonly state: string) { super(state); } }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
async function openBrowser(url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// Bootstrap explicitly rejects browser fetch metadata. Node's global fetch adds
// sec-fetch-mode, so use the native HTTP transport without browser headers.
const nativeFetch: typeof fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
  return await new Promise<Response>((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: init.method, headers, signal: init.signal ?? undefined,
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const status = response.statusCode ?? 500;
      if ([204, 205, 304].includes(status)) {
        response.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
      } else {
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      }
    });
    request.once('error', reject);
    request.end(typeof init.body === 'string' ? init.body : undefined);
  });
};

/** Secrets live only in this process. Public results deliberately contain no raw errors or credentials. */
export class PairingClient {
  readonly #config: BridgeConfig;
  readonly #deps: Required<PairingDependencies>;
  #pending?: Pending;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(config: BridgeConfig, dependencies: PairingDependencies = {}) {
    this.#config = { ...config, origin: normalizeLoopbackOrigin(config.origin) };
    this.#deps = { fetch: dependencies.fetch ?? nativeFetch, openBrowser: dependencies.openBrowser ?? openBrowser, now: dependencies.now ?? Date.now, saveCredential: dependencies.saveCredential ?? saveCredential };
  }
  async #request(path: string, body?: unknown, cookie?: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.rpcTimeoutMs);
    try {
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (serialized && Buffer.byteLength(serialized) > MAX_BYTES) throw new Failure('invalid_response');
      const response = await this.#deps.fetch(new URL(path, this.#config.origin), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-store', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie === undefined ? {} : { cookie, origin: this.#config.origin }) },
        body: serialized,
      });
      if (!response.ok || response.status >= 300) await response.body?.cancel();
      if (response.status === 404) throw new Failure('pairing_unsupported');
      if (response.status === 401) throw new Failure('authentication_required');
      if (response.status === 403) throw new Failure('pairing_forbidden');
      if (response.status === 429) throw new Failure('rate_limited');
      if (!response.ok || response.status >= 300) throw new Failure('invalid_response');
      if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) {
        await response.body?.cancel();
        throw new Failure('invalid_response');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Failure('invalid_response'); }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof Failure) throw error;
      if (error instanceof SyntaxError) throw new Failure('invalid_response');
      throw new Failure(controller.signal.aborted ? 'connection_timeout' : 'dsh_not_running');
    } finally { clearTimeout(timer); }
  }
  async #authenticated(cookie: string): Promise<boolean> {
    const value = await this.#request(`${PREFIX}verify`, {}, cookie);
    return record(value) && value.protocol === 1 && value.authenticated === true;
  }
  async status(): Promise<SafeResult> {
    try {
      const value = await this.#request(`${PREFIX}capabilities`);
      if (!record(value) || value.protocol !== 1 || value.pairing !== true) return { state: 'pairing_unsupported', available: false, nextAction: 'Install or upgrade the DSH companion with browser pairing support.' };
      return { state: 'pairing_available', available: true, nextAction: 'Use dsh_connect with action=start to request browser confirmation.' };
    } catch (error) {
      // Older DSH can send its authenticated SPA fallback (401 or HTML) for
      // unknown routes. The anonymous capability protocol must not require login.
      if (error instanceof Failure && ['authentication_required', 'invalid_response'].includes(error.state)) {
        return { ...this.#failure(new Failure('pairing_unsupported')), available: false };
      }
      return { ...this.#failure(error), available: false };
    }
  }
  #failure(error: unknown): SafeResult {
    const state = error instanceof Failure ? error.state : 'connection_failed';
    return { state, connected: false, nextAction: state === 'pairing_forbidden' ? 'DSH rejected the request origin or access. Check the configured local address and DSH access settings before retrying.' : state === 'dsh_not_running' ? 'Start DSH at the configured address, then explicitly start a new connection.' : state === 'pairing_unsupported' ? 'Install or upgrade the DSH companion, then restart DSH when safe.' : 'The connection was not completed. Check DSH, then explicitly start a new pairing; do not paste credentials into chat.' };
  }
  #view(pending: Pending): SafeResult { return { state: 'pending', connected: false, confirmationUrl: pending.confirmationUrl, matchingCode: pending.matchingCode, expiresAt: pending.expiresAt, browserOpened: pending.browserOpened, nextAction: 'Open the confirmation page in your logged-in DSH browser, compare the matching code, and choose allow or reject. Then call dsh_connect with action=check.' }; }
  connect(action: 'start' | 'check' | 'cancel', shouldOpen = true): Promise<SafeResult> {
    const result = this.#queue.then(() => this.#connect(action, shouldOpen));
    this.#queue = result.catch(() => undefined);
    return result;
  }
  async #connect(action: 'start' | 'check' | 'cancel', shouldOpen: boolean): Promise<SafeResult> {
    try {
      if (this.#pending && this.#pending.expiresAt <= this.#deps.now()) { this.#pending = undefined; return { state: 'expired', connected: false, nextAction: 'Explicitly start a new pairing.' }; }
      if (action === 'start') {
        if (this.#pending) return this.#view(this.#pending);
        const credential = await loadCredential(this.#config).catch(() => undefined);
        if (credential) {
          try { if (await this.#authenticated(credential.cookie)) return { state: 'ready', connected: true }; }
          catch (error) { if (!(error instanceof Failure) || !['authentication_required', 'pairing_forbidden'].includes(error.state)) throw error; }
        }
        const capability = await this.status();
        if (capability.state !== 'pairing_available') return capability;
        const claimSecret = randomBytes(32).toString('hex');
        const value = await this.#request(`${PREFIX}begin`, { claimHash: createHash('sha256').update(claimSecret).digest('hex') });
        if (!record(value) || value.protocol !== 1 || typeof value.pairingId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.pairingId) || typeof value.matchingCode !== 'string' || !/^[A-Z0-9-]{4,32}$/.test(value.matchingCode) || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.#deps.now() || value.expiresAt > this.#deps.now() + 10 * 60_000 || typeof value.confirmationUrl !== 'string') throw new Failure('invalid_response');
        const expected = new URL(`${PREFIX}confirm`, this.#config.origin);
        expected.searchParams.set('id', value.pairingId);
        if (value.confirmationUrl !== expected.href) throw new Failure('invalid_response');
        this.#pending = { pairingId: value.pairingId, claimSecret, matchingCode: value.matchingCode, expiresAt: value.expiresAt, confirmationUrl: expected.href, browserOpened: false };
        if (shouldOpen) this.#pending.browserOpened = await this.#deps.openBrowser(expected.href).catch(() => false);
        return this.#view(this.#pending);
      }
      const pending = this.#pending;
      if (!pending) {
        if (action === 'cancel') return { state: 'no_pending_pairing', nextAction: 'There is no pending pairing to cancel. Saved connection credentials were not changed.' };
        const credential = await loadCredential(this.#config).catch(() => undefined);
        if (credential) {
          if (await this.#authenticated(credential.cookie)) return { state: 'ready', connected: true };
          throw new Failure('authentication_failed');
        }
        return { state: 'no_pending_pairing', connected: false, nextAction: 'Start a new pairing explicitly; pending connections cannot be restored after restart.' };
      }
      const value = await this.#request(`${PREFIX}${action === 'cancel' ? 'cancel' : 'claim'}`, { pairingId: pending.pairingId, claimSecret: pending.claimSecret });
      if (!record(value) || typeof value.state !== 'string' || !['pending', 'rejected', 'expired', 'cancelled', 'claimed'].includes(value.state)) throw new Failure('invalid_response');
      if (value.state === 'pending' && action === 'check') return this.#view(pending);
      this.#pending = undefined;
      if (value.state === 'claimed' && action === 'check') {
        if (typeof value.cookie !== 'string' || !isSafeCookieHeader(value.cookie)) throw new Failure('pairing_already_claimed');
        if (!await this.#authenticated(value.cookie)) throw new Failure('authentication_failed');
        try { await this.#deps.saveCredential(this.#config, { version: 1, origin: this.#config.origin, cookie: value.cookie, connectedAt: this.#deps.now() }); }
        catch { throw new Failure('credential_save_failed'); }
        return { state: 'ready', connected: true };
      }
      if (value.state === 'pending') throw new Failure('invalid_response');
      if (action === 'cancel') return { state: value.state, nextAction: 'Pairing ended. Saved connection credentials were not changed.' };
      return { state: value.state, connected: false, nextAction: 'No connection was saved. Start a new pairing explicitly if needed.' };
    } catch (error) {
      // Claim may already have consumed its one-shot credential. Never automatically retry it.
      this.#pending = undefined;
      return this.#failure(error);
    }
  }
  async shutdown(): Promise<void> { await this.connect('cancel', false); }
}
