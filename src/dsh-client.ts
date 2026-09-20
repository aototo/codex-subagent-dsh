import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { loadCredential } from './auth.js';
import { normalizeLoopbackOrigin, type BridgeConfig } from './config.js';
import type {
  DshApi,
  FollowHandlers,
  SessionSnapshot,
  Subscription,
  WireEvent,
} from './types.js';

const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_WEBSOCKET_FRAME_BYTES = 4 * 1024 * 1024;
const FOLLOW_HISTORY_MESSAGES = 50;

export class DshError extends Error {
  readonly code: string;
  readonly ambiguous: boolean;

  constructor(code: string, message: string, ambiguous: boolean) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_HTTP_RESPONSE_BYTES) {
    throw new DshError('RESPONSE_TOO_LARGE', 'DSH returned an oversized response', true);
  }
  if (response.body === null) {
    throw new DshError('INVALID_RESPONSE', 'DSH returned an empty response', true);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > MAX_HTTP_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DshError('RESPONSE_TOO_LARGE', 'DSH returned an oversized response', true);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DshError('INVALID_RESPONSE', 'DSH returned an invalid JSON response', true);
  }
}

function rpcFailure(error: Record<string, unknown>): DshError {
  const rawCode = error.code;
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(rawCode)
    ? rawCode
    : 'RPC_FAILED';
  const explicitRejections = new Set([
    'auth/forbidden',
    'auth/required',
    'bad-request',
    'forbidden',
    'gateway/bad-request',
    'invalid-argument',
    'not-found',
    'session/conflict',
    'session/model-unavailable',
    'session/not-found',
    'unauthorized',
  ]);
  const ambiguous = !explicitRejections.has(code);
  return new DshError(code, `DSH rejected the request (${code})`, ambiguous);
}

function websocketUrl(origin: string): URL {
  const url = new URL('/api/remote.mux', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function rawText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}

function parseWireEvent(value: unknown): WireEvent | undefined {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 0
  ) {
    return undefined;
  }
  return value as unknown as WireEvent;
}

function parseSnapshot(value: unknown, sessionId: string): SessionSnapshot | undefined {
  if (!isRecord(value) || value.type !== 'snapshot' || !isRecord(value.header) || value.header.id !== sessionId) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.cursor) || !Array.isArray(value.records) || typeof value.hasMore !== 'boolean') {
    return undefined;
  }
  for (const record of value.records) {
    if (!isRecord(record) || record.type !== 'event' || parseWireEvent(record.event) === undefined) return undefined;
  }
  return value as unknown as SessionSnapshot;
}

export class DshClient implements DshApi {
  readonly origin: string;
  readonly #config: BridgeConfig;

  constructor(config: BridgeConfig) {
    try {
      const origin = normalizeLoopbackOrigin(config.origin);
      this.#config = { ...config, origin };
      this.origin = origin;
    } catch {
      throw new DshError('INVALID_ORIGIN', 'The configured DSH origin must be a loopback HTTP origin', false);
    }
  }

  async probe(): Promise<boolean> {
    const url = new URL(this.origin);
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const timeoutMs = Math.min(this.#config.rpcTimeoutMs, 1500);
    return await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: hostname, port });
      let settled = false;
      const finish = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(reachable);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(timeoutMs, () => finish(false));
    });
  }

  async #credentialCookie(): Promise<string> {
    try {
      const credential = await loadCredential(this.#config);
      if (credential === undefined) {
        throw new DshError('AUTH_REQUIRED', 'DSH is not connected; run the local connection command first', false);
      }
      return credential.cookie;
    } catch (error) {
      if (error instanceof DshError) throw error;
      throw new DshError('CREDENTIAL_UNAVAILABLE', 'The saved DSH credential is unavailable; reconnect is required', false);
    }
  }

  async rpc<T = unknown>(method: string, request: unknown): Promise<T> {
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(method)) {
      throw new DshError('INVALID_METHOD', 'Invalid DSH RPC method', false);
    }
    const cookie = await this.#credentialCookie();

    const rpcId = randomUUID();
    const parameterName = method === 'session/list' ? '_request' : 'request';
    let body: string;
    try {
      body = JSON.stringify({
        type: 'client-request',
        rpcId,
        method,
        payload: { args: { [parameterName]: request } },
      });
    } catch {
      throw new DshError('INVALID_REQUEST', 'The DSH RPC request is not JSON serializable', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.rpcTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(new URL(`/api/${method}`, this.origin), {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          cookie,
          origin: this.origin,
        },
        body,
      });
      if (response.status === 401 || response.status === 403) {
        throw new DshError('AUTH_REQUIRED', 'DSH authentication expired; reconnect is required', false);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new DshError('REDIRECT_BLOCKED', 'DSH RPC attempted an unexpected redirect', false);
      }
      if (!response.ok) {
        const ambiguous = response.status >= 500;
        throw new DshError('HTTP_ERROR', `DSH RPC failed with HTTP ${response.status}`, ambiguous);
      }

      const envelope = await readLimitedJson(response);
      if (
        !isRecord(envelope) ||
        envelope.type !== 'server-response' ||
        envelope.rpcId !== rpcId ||
        !isRecord(envelope.result) ||
        typeof envelope.result.ok !== 'boolean'
      ) {
        throw new DshError('INVALID_RESPONSE', 'DSH returned an invalid RPC envelope', true);
      }
      if (envelope.result.ok === false) {
        if (!isRecord(envelope.result.error)) {
          throw new DshError('INVALID_RESPONSE', 'DSH returned an invalid RPC failure', true);
        }
        throw rpcFailure(envelope.result.error);
      }
      if (!Object.hasOwn(envelope.result, 'value')) {
        throw new DshError('INVALID_RESPONSE', 'DSH returned an RPC response without a value', true);
      }
      return envelope.result.value as T;
    } catch (error) {
      if (error instanceof DshError) throw error;
      if (controller.signal.aborted) {
        throw new DshError('RPC_TIMEOUT', 'DSH RPC timed out; the request outcome is unknown', true);
      }
      throw new DshError('RPC_UNAVAILABLE', 'DSH RPC transport failed; the request outcome is unknown', true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async follow(sessionId: string, handlers: FollowHandlers): Promise<Subscription> {
    if (sessionId === '' || sessionId.length > 512 || /[\r\n]/.test(sessionId)) {
      throw new DshError('INVALID_SESSION', 'Invalid DSH session id', false);
    }
    const cookie = await this.#credentialCookie();

    const streamId = randomUUID();
    const socket = new WebSocket(websocketUrl(this.origin), {
      headers: { cookie },
      origin: this.origin,
      maxPayload: MAX_WEBSOCKET_FRAME_BYTES,
      handshakeTimeout: this.#config.rpcTimeoutMs,
      followRedirects: false,
    });

    return await new Promise<Subscription>((resolve, reject) => {
      let snapshotReceived = false;
      let settled = false;
      let errorNotified = false;
      let closedNotified = false;
      let closing = false;
      const timer = setTimeout(() => {
        fail(new DshError('FOLLOW_TIMEOUT', 'Timed out waiting for the DSH session snapshot', true));
      }, this.#config.rpcTimeoutMs);
      timer.unref?.();

      const notifyError = (error: Error) => {
        if (errorNotified) return;
        errorNotified = true;
        try {
          handlers.error(error);
        } catch {
          // Handler failures must not reveal transport state or crash the process.
        }
      };
      const notifyClosed = () => {
        if (closedNotified) return;
        closedNotified = true;
        try {
          handlers.closed();
        } catch {
          // Handler failures are isolated from the transport.
        }
      };
      const fail = (error: DshError) => {
        clearTimeout(timer);
        notifyError(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          closing = true;
          socket.close(1008, 'invalid DSH stream');
        }
      };

      socket.on('open', () => {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId },
                maxMessages: FOLLOW_HISTORY_MESSAGES,
              },
            },
          },
        }));
      });

      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          fail(new DshError('INVALID_STREAM', 'DSH returned an invalid binary stream frame', true));
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(rawText(data));
        } catch {
          fail(new DshError('INVALID_STREAM', 'DSH returned an invalid stream frame', true));
          return;
        }
        if (!isRecord(frame) || frame.streamId !== streamId || typeof frame.type !== 'string') {
          fail(new DshError('INVALID_STREAM', 'DSH returned a frame for an unexpected stream', true));
          return;
        }
        if (frame.type === 'error') {
          const failure = isRecord(frame.error) ? rpcFailure(frame.error) : new DshError('STREAM_FAILED', 'DSH session stream failed', true);
          fail(failure);
          return;
        }
        if (frame.type === 'end') {
          if (!snapshotReceived) {
            fail(new DshError('STREAM_ENDED', 'DSH session stream ended before its snapshot', true));
          } else {
            closing = true;
            socket.close(1000, 'DSH stream ended');
          }
          return;
        }
        if (frame.type !== 'item' || !Object.hasOwn(frame, 'value')) {
          fail(new DshError('INVALID_STREAM', 'DSH returned an invalid stream envelope', true));
          return;
        }

        const value = frame.value;
        if (!snapshotReceived) {
          const snapshot = parseSnapshot(value, sessionId);
          if (snapshot === undefined) {
            fail(new DshError('INVALID_SNAPSHOT', 'DSH returned an invalid or mismatched session snapshot', true));
            return;
          }
          try {
            handlers.snapshot(snapshot);
          } catch {
            fail(new DshError('HANDLER_FAILED', 'The DSH snapshot handler failed', true));
            return;
          }
          snapshotReceived = true;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve({
              close: () => {
                if (closing) return;
                closing = true;
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: 'cancel', streamId }), () => socket.close(1000, 'subscription closed'));
                } else {
                  socket.close();
                }
              },
            });
          }
          return;
        }

        if (!isRecord(value) || value.type !== 'event') {
          // Assistant presentation frames are optional and are not durable task events.
          if (isRecord(value) && value.type === 'assistant-stream') return;
          fail(new DshError('INVALID_STREAM', 'DSH returned an invalid session event frame', true));
          return;
        }
        const event = parseWireEvent(value.event);
        if (event === undefined) {
          fail(new DshError('INVALID_STREAM', 'DSH returned an invalid session event', true));
          return;
        }
        try {
          handlers.event(event);
        } catch {
          fail(new DshError('HANDLER_FAILED', 'The DSH event handler failed', true));
        }
      });

      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        const error = statusCode === 401 || statusCode === 403
          ? new DshError('AUTH_REQUIRED', 'DSH authentication expired; reconnect is required', false)
          : new DshError('FOLLOW_REJECTED', 'DSH rejected the session stream', statusCode >= 500 || statusCode === 0);
        fail(error);
        notifyClosed();
      });

      socket.on('error', () => {
        fail(new DshError('FOLLOW_UNAVAILABLE', 'DSH session stream failed', true));
      });

      socket.on('close', () => {
        clearTimeout(timer);
        if (!snapshotReceived && !settled) {
          const error = new DshError('FOLLOW_CLOSED', 'DSH session stream closed before its snapshot', true);
          notifyError(error);
          settled = true;
          reject(error);
        } else if (snapshotReceived && !closing) {
          notifyError(new DshError('FOLLOW_DISCONNECTED', 'DSH session stream disconnected', true));
        }
        notifyClosed();
      });
    });
  }
}
