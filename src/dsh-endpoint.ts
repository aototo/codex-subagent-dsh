// Desktop discovery is namespaced separately from the legacy Feishu bridge.
import { desktopStateDir, normalizeLoopbackOrigin } from './config.js';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { connect, isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

export type DshConnectionMode = 'web' | 'desktop' | 'auto';

export type DshEndpointOptions = {
  mode: DshConnectionMode;
  webUrl: string;
  stateDir: string;
  timeoutMs?: number;
  expectedDshHome?: string;
};

export type DshEndpointDependencies = {
  probe?: (origin: string, timeoutMs: number) => Promise<boolean>;
  isAlive?: (pid: number) => boolean | Promise<boolean>;
  uid?: number;
};

export class EndpointError extends Error {
  constructor(readonly code: string, readonly nextAction: string, message: string) { super(message); }
}

const MAX_METADATA_BYTES = 16 * 1024;

function localOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('DSH 地址必须是本机 HTTP origin');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DSH 地址必须是本机 HTTP origin');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1'
    || (isIP(hostname) === 4 && hostname.startsWith('127.'));
  if (
    url.protocol !== 'http:' || !loopback || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    // Reject even empty query/fragment markers and paths normalized away by URL.
    || !/^http:\/\/[^/?#]+\/?$/.test(value)
  ) {
    throw new Error('DSH 地址必须是无路径、参数或凭据的本机 HTTP origin');
  }
  return url.origin;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function probeTcp(origin: string, timeoutMs: number): Promise<boolean> {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function readDesktopMetadata(
  options: DshEndpointOptions,
  deps: DshEndpointDependencies,
): Promise<{ origin: string; instanceId: string; pid: number }> {
  const directoryPath = desktopStateDir(options.stateDir);
  const metadataPath = path.join(directoryPath, 'desktop-connection.json');
  const uid = deps.uid ?? process.getuid?.();
  let content: string;
  try {
    for (const entry of [options.stateDir, directoryPath]) {
      const directory = await lstat(entry);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o022) !== 0) {
        throw new Error('桌面连接目录必须归当前用户所有，不能为符号链接或允许其他用户写入');
      }
    }
    const before = await lstat(metadataPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('桌面发现文件必须是普通文件，不能使用符号链接');
    }
    const file = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
        throw new Error('桌面发现文件在读取期间发生变化');
      }
      if (uid === undefined || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) {
        throw new Error('桌面发现文件必须归当前用户所有且权限为 0600');
      }
      if (stat.size > MAX_METADATA_BYTES) throw new Error('桌面发现文件超过 16 KiB');
      const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_METADATA_BYTES) throw new Error('桌面发现文件超过 16 KiB');
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new EndpointError('DESKTOP_DISCOVERY_MISSING', 'install_or_authorize_desktop_bridge', '未找到 DSH 桌面连接信息：启动桌面端，在其连接组件中授权；若未安装组件，先按插件安装说明安装。');
    }
    if (code) throw new Error('无法安全读取 DSH 桌面连接信息，请检查文件权限');
    throw error;
  }

  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    metadata = parsed as Record<string, unknown>;
  } catch {
    throw new Error('DSH 桌面连接信息格式无效');
  }
  if (
    metadata.consumer !== 'codex-subagent-dsh' || metadata.version !== 1 || typeof metadata.instanceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(metadata.instanceId) || !Number.isSafeInteger(metadata.pid)
    || (metadata.pid as number) <= 0 || typeof metadata.approvedAt !== 'string'
    || !Number.isFinite(Date.parse(metadata.approvedAt))
  ) throw new Error('DSH 桌面连接信息版本、进程或授权时间无效');

  const expectedHome = options.expectedDshHome ?? path.join(homedir(), '.dsh');
  if (
    typeof metadata.dshHome !== 'string' || !path.isAbsolute(metadata.dshHome)
    || !path.isAbsolute(expectedHome) || path.resolve(metadata.dshHome) !== path.resolve(expectedHome)
  ) throw new Error('DSH 桌面数据目录不匹配，拒绝连接到不同存储');

  const origin = localOrigin(metadata.origin);
  if (!await (deps.isAlive ?? processIsAlive)(metadata.pid as number)) {
    throw new EndpointError('DESKTOP_DISCOVERY_STALE', 'reauthorize_desktop_bridge', 'DSH 桌面连接信息已失效：客户端进程不存在。启动桌面端并重新授权连接组件。');
  }
  return { origin, instanceId: metadata.instanceId as string, pid: metadata.pid as number };
}

export async function readDesktopOrigin(options: DshEndpointOptions, deps: DshEndpointDependencies = {}) {
  try { return await readDesktopMetadata(options, deps); }
  catch (error) {
    if (error instanceof EndpointError) throw error;
    // Only our own fixed validation messages are exposed, never file contents.
    throw new EndpointError('DESKTOP_DISCOVERY_INVALID', 'repair_desktop_bridge_discovery', error instanceof Error ? error.message : 'DSH 桌面连接信息无效');
  }
}

/** Resolve once at startup. Authentication or task failures must not trigger fallback. */
export async function resolveDshEndpoint(
  options: DshEndpointOptions,
  deps: DshEndpointDependencies = {},
): Promise<{ origin: string; mode: 'web' | 'desktop'; instanceId?: string; pid?: number }> {
  if (!['web', 'desktop', 'auto'].includes(options.mode)) {
    throw new Error('DSH 连接模式必须为 web、desktop 或 auto');
  }
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('DSH 连接探测超时必须为正整数');
  }
  const probe = deps.probe ?? probeTcp;
  if (options.mode === 'web') return { origin: normalizeLoopbackOrigin(options.webUrl), mode: 'web' };
  if (options.mode !== 'desktop') {
    const origin = normalizeLoopbackOrigin(options.webUrl);
    if (await probe(origin, timeoutMs)) return { origin, mode: 'web' };
  }
  const desktop = await readDesktopOrigin(options, deps);
  const { origin } = desktop;
  if (!await probe(origin, timeoutMs)) {
    throw new EndpointError('DESKTOP_UNREACHABLE', 'start_desktop_and_authorize_bridge', 'DSH 桌面端口不可达，请启动客户端并检查连接组件；不会自动重启客户端。');
  }
  return { ...desktop, mode: 'desktop' };
}
