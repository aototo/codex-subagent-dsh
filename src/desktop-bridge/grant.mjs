import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Private bridge directory required');
}
async function atomicPrivateJson(path, value) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}

/** Export only the Host-issued cookie, only after an authenticated user approves. */
export class DesktopGrant {
  pending = new Map();
  granted = false;
  closed = false;
  writes = Promise.resolve();
  instanceId = randomBytes(16).toString('hex');
  constructor({ origin, stateDir, dshHome, pid = process.pid, now = Date.now }) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin) throw new Error('Loopback origin required');
    Object.assign(this, { origin, baseStateDir: stateDir, stateDir: join(stateDir, 'codex-desktop'), dshHome, pid, now });
    this.cookieName = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url');
  }
  cookie(header) {
    const cookies = (header ?? '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(this.cookieName + '='));
    if (cookies.length !== 1 || cookies[0].length > 4096
      || !new RegExp(`^${this.cookieName}=[A-Za-z0-9_.-]+$`).test(cookies[0])) throw new Error('Host authentication required');
    return cookies[0];
  }
  issue(header, operation = 'approve') {
    if (this.closed) throw new Error('Bridge stopped');
    const cookie = this.cookie(header);
    for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(key);
    if (this.pending.size >= 8) this.pending.delete(this.pending.keys().next().value);
    const csrf = randomBytes(32).toString('hex');
    this.pending.set(csrf, { cookieHash: hash(cookie), expiresAt: this.now() + 300_000, operation });
    return { csrf, origin: this.origin, granted: this.granted };
  }
  consume(csrf, header, operation) {
    if (this.closed) throw new Error('Bridge stopped');
    const cookie = this.cookie(header);
    const pending = this.pending.get(csrf);
    if (!pending || pending.operation !== operation || pending.expiresAt <= this.now() || pending.cookieHash !== hash(cookie)) throw new Error('Approval expired or invalid');
    this.pending.delete(csrf);
    return cookie;
  }
  deny(csrf, header) {
    this.consume(csrf, header, 'approve');
    return { denied: true, granted: this.granted };
  }
  approve(csrf, header) {
    const work = this.writes.then(() => this.publish(csrf, header));
    this.writes = work.catch(() => {});
    return work;
  }
  async publish(csrf, header) {
    const cookie = this.consume(csrf, header, 'approve');
    await privateDirectory(this.baseStateDir);
    await privateDirectory(this.stateDir);
    const credentials = join(this.stateDir, 'credentials');
    await privateDirectory(credentials);
    await atomicPrivateJson(join(credentials, `${hash(this.origin)}.json`), {
      version: 1, origin: this.origin, cookie, connectedAt: this.now(),
    });
    if (this.closed) throw new Error('Bridge stopped');
    await atomicPrivateJson(join(this.stateDir, 'desktop-connection.json'), {
      version: 1, consumer: 'codex-subagent-dsh', origin: this.origin, pid: this.pid, approvedAt: new Date(this.now()).toISOString(), dshHome: this.dshHome, instanceId: this.instanceId,
    });
    if (this.closed) throw new Error('Bridge stopped');
    this.granted = true;
  }
  async close() {
    this.closed = true;
    this.pending.clear();
    await this.writes;
  }
}
