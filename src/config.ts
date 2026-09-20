import { homedir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_ORIGIN = 'http://127.0.0.1:3080';
const DEFAULT_STATE_DIR = resolve(homedir(), '.codex-subagent-dsh');

export interface BridgeConfig {
  origin: string;
  stateDir: string;
  rpcTimeoutMs: number;
  taskTimeoutMs: number;
  maxWaitMs: number;
}

export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export function normalizeLoopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DSH_SUBAGENT_URL must be a valid loopback HTTP URL');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('DSH_SUBAGENT_URL must be a loopback HTTP origin without credentials, path, query, or fragment');
  }

  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const configuredHome = env.DSH_SUBAGENT_HOME?.trim();
  return {
    origin: normalizeLoopbackOrigin(env.DSH_SUBAGENT_URL?.trim() || DEFAULT_ORIGIN),
    stateDir: resolve(configuredHome || DEFAULT_STATE_DIR),
    rpcTimeoutMs: 10_000,
    taskTimeoutMs: 15 * 60_000,
    maxWaitMs: 20_000,
  };
}
