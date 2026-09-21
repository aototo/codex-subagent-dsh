import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeLoopbackOrigin, type BridgeConfig } from './config.js';

const CREDENTIAL_VERSION = 1;
const CREDENTIAL_DIRECTORY = 'credentials';
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export interface DshCredential {
  version: 1;
  origin: string;
  cookie: string;
  connectedAt: number;
}

export class DshAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DshAuthError';
    this.code = code;
  }
}

function credentialPath(config: BridgeConfig): string {
  const digest = createHash('sha256').update(checkedOrigin(config)).digest('hex');
  return join(config.stateDir, CREDENTIAL_DIRECTORY, `${digest}.json`);
}

function checkedOrigin(config: BridgeConfig): string {
  try {
    const origin = normalizeLoopbackOrigin(config.origin);
    if (origin !== config.origin) throw new Error('non-canonical origin');
    return origin;
  } catch {
    throw new DshAuthError('ORIGIN_INVALID', 'The configured DSH origin must be a canonical loopback HTTP origin');
  }
}

async function ensurePrivateDirectories(config: BridgeConfig): Promise<string> {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(config.stateDir);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
    throw new DshAuthError('CREDENTIAL_DIRECTORY_INVALID', 'The DSH credential directory is not a private local directory');
  }
  await chmod(config.stateDir, 0o700);
  const directory = join(config.stateDir, CREDENTIAL_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentialInfo = await lstat(directory);
  if (!credentialInfo.isDirectory() || credentialInfo.isSymbolicLink()) {
    throw new DshAuthError('CREDENTIAL_DIRECTORY_INVALID', 'The DSH credential directory is not a private local directory');
  }
  await chmod(directory, 0o700);
  return directory;
}

function parseStoredCredential(value: unknown, config: BridgeConfig): DshCredential {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as Record<string, unknown>).version !== CREDENTIAL_VERSION ||
    (value as Record<string, unknown>).origin !== config.origin ||
    typeof (value as Record<string, unknown>).cookie !== 'string' ||
    !Number.isSafeInteger((value as Record<string, unknown>).connectedAt) ||
    ((value as Record<string, unknown>).connectedAt as number) < 0
  ) {
    throw new DshAuthError('CREDENTIAL_INVALID', 'Saved DSH credential is invalid; reconnect is required');
  }
  const credential = value as DshCredential;
  if (!isSafeCookieHeader(credential.cookie)) {
    throw new DshAuthError('CREDENTIAL_INVALID', 'Saved DSH credential is invalid; reconnect is required');
  }
  return credential;
}

export function isSafeCookieHeader(value: string): boolean {
  if (value.length === 0 || value.length > 16_384 || /[\r\n]/.test(value)) return false;
  return value.split('; ').every((pair) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]+$/.test(pair));
}

function cookiesFromResponse(headers: Headers): string {
  const values = headers.getSetCookie();
  const pairs: string[] = [];
  for (const value of values) {
    const pair = value.slice(0, value.indexOf(';') === -1 ? value.length : value.indexOf(';')).trim();
    if (!isSafeCookieHeader(pair)) {
      throw new DshAuthError('AUTH_RESPONSE_INVALID', 'DSH returned an invalid authentication response');
    }
    pairs.push(pair);
  }
  if (pairs.length === 0) {
    throw new DshAuthError('AUTH_RESPONSE_INVALID', 'DSH did not return an authentication cookie');
  }
  const cookie = pairs.join('; ');
  if (!isSafeCookieHeader(cookie)) {
    throw new DshAuthError('AUTH_RESPONSE_INVALID', 'DSH returned an invalid authentication response');
  }
  return cookie;
}

export async function saveCredential(config: BridgeConfig, credential: DshCredential): Promise<void> {
  parseStoredCredential(credential, config);
  const directory = await ensurePrivateDirectories(config);
  const target = credentialPath(config);
  const temporary = join(directory, `.credential-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(credential)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function loadCredential(config: BridgeConfig): Promise<DshCredential | undefined> {
  const path = credentialPath(config);
  try {
    const stateInfo = await lstat(config.stateDir);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink()) {
      throw new DshAuthError('CREDENTIAL_DIRECTORY_INVALID', 'The DSH credential directory is not a private local directory');
    }
    await chmod(config.stateDir, 0o700);
    const directory = join(config.stateDir, CREDENTIAL_DIRECTORY);
    const credentialInfo = await lstat(directory);
    if (!credentialInfo.isDirectory() || credentialInfo.isSymbolicLink()) {
      throw new DshAuthError('CREDENTIAL_DIRECTORY_INVALID', 'The DSH credential directory is not a private local directory');
    }
    await chmod(directory, 0o700);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new DshAuthError('CREDENTIAL_INVALID', 'Saved DSH credential is invalid; reconnect is required');
    }
    await chmod(path, 0o600);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size > MAX_CREDENTIAL_BYTES) {
        throw new DshAuthError('CREDENTIAL_INVALID', 'Saved DSH credential is invalid; reconnect is required');
      }
      const text = await handle.readFile('utf8');
      return parseStoredCredential(JSON.parse(text), config);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof DshAuthError) throw error;
    if (error instanceof SyntaxError) {
      throw new DshAuthError('CREDENTIAL_INVALID', 'Saved DSH credential is invalid; reconnect is required');
    }
    throw new DshAuthError('CREDENTIAL_READ_FAILED', 'Unable to read the saved DSH credential');
  }
}

function validatedLoginUrl(loginUrl: string, config: BridgeConfig): URL {
  const origin = checkedOrigin(config);
  if (loginUrl.length > 16_384) {
    throw new DshAuthError('LOGIN_URL_INVALID', 'The DSH login URL is invalid');
  }
  let url: URL;
  try {
    url = new URL(loginUrl.trim());
  } catch {
    throw new DshAuthError('LOGIN_URL_INVALID', 'The DSH login URL is invalid');
  }
  const tokens = url.searchParams.getAll('token');
  if (
    url.origin !== origin ||
    url.pathname !== '/' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    tokens.length !== 1 ||
    tokens[0] === '' ||
    [...url.searchParams.keys()].some((key) => key !== 'token')
  ) {
    throw new DshAuthError('LOGIN_URL_INVALID', 'The DSH login URL must be the exact loopback launch URL for the configured server');
  }
  return url;
}

export async function connect(loginUrl: string, config: BridgeConfig): Promise<DshCredential> {
  const url = validatedLoginUrl(loginUrl, config);
  const origin = checkedOrigin(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.rpcTimeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'cache-control': 'no-store' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new DshAuthError('AUTH_REJECTED', 'DSH rejected the login URL; use the current URL printed by dsh web');
    }
    if (response.status !== 303) {
      throw new DshAuthError('AUTH_RESPONSE_INVALID', 'DSH returned an unexpected authentication response');
    }
    const location = response.headers.get('location');
    if (location === null) {
      throw new DshAuthError('AUTH_RESPONSE_INVALID', 'DSH returned an invalid authentication redirect');
    }
    const redirect = new URL(location, origin);
    if (redirect.origin !== origin || redirect.username !== '' || redirect.password !== '') {
      throw new DshAuthError('AUTH_REDIRECT_BLOCKED', 'DSH attempted to redirect authentication outside the configured origin');
    }
    const credential: DshCredential = {
      version: CREDENTIAL_VERSION,
      origin,
      cookie: cookiesFromResponse(response.headers),
      connectedAt: Date.now(),
    };
    await saveCredential(config, credential);
    return credential;
  } catch (error) {
    if (error instanceof DshAuthError) throw error;
    if (controller.signal.aborted) {
      throw new DshAuthError('AUTH_TIMEOUT', 'Timed out while connecting to DSH');
    }
    throw new DshAuthError('AUTH_UNAVAILABLE', 'Unable to connect to DSH');
  } finally {
    clearTimeout(timeout);
    url.search = '';
  }
}

export async function disconnect(config: BridgeConfig): Promise<void> {
  try {
    const stateInfo = await lstat(config.stateDir);
    const directory = join(config.stateDir, CREDENTIAL_DIRECTORY);
    const credentialInfo = await lstat(directory);
    if (
      !stateInfo.isDirectory() ||
      stateInfo.isSymbolicLink() ||
      !credentialInfo.isDirectory() ||
      credentialInfo.isSymbolicLink()
    ) {
      throw new DshAuthError('CREDENTIAL_DIRECTORY_INVALID', 'The DSH credential directory is not a private local directory');
    }
    await rm(credentialPath(config), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof DshAuthError) throw error;
    throw new DshAuthError('CREDENTIAL_WRITE_FAILED', 'Unable to remove the saved DSH credential');
  }
}
