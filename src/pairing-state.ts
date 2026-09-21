import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type PairingStatus = 'pending' | 'approved' | 'claimed' | 'rejected' | 'expired' | 'cancelled';
export class PairingError extends Error {
  constructor(readonly status: number) { super('Pairing request could not be completed'); }
}
interface Entry {
  pairingId: string; claimHash: string; origin: string; matchingCode: string; csrf: string;
  expiresAt: number; state: PairingStatus; cookie?: string; removeAt: number;
}
export interface PairingView {
  pairingId: string; matchingCode: string; expiresAt: number; state: PairingStatus; origin: string; csrf: string;
}
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const claimDigest = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Process-local, bounded state. No raw claim secret is retained. */
export class PairingState {
  private entries = new Map<string, Entry>();
  private closed = false;
  constructor(private now = Date.now, private ttlMs = 300_000, private capacity = 64, private pendingLimit = 16) {}
  sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (now >= entry.expiresAt && (entry.state === 'pending' || entry.state === 'approved')) this.finish(entry, 'expired');
      if (now >= entry.removeAt) this.entries.delete(id);
    }
  }
  begin(claimHash: string, origin: string) {
    this.sweep();
    if (this.closed) throw new PairingError(503);
    if (!/^[a-f0-9]{64}$/.test(claimHash)) throw new PairingError(400);
    if (this.entries.size >= this.capacity || [...this.entries.values()].filter(e => e.state === 'pending' || e.state === 'approved').length >= this.pendingLimit) throw new PairingError(429);
    const expiresAt = this.now() + this.ttlMs;
    const entry: Entry = { pairingId: token(), claimHash, origin, matchingCode: randomBytes(4).toString('hex').toUpperCase(), csrf: token(), expiresAt, removeAt: expiresAt + this.ttlMs, state: 'pending' };
    this.entries.set(entry.pairingId, entry);
    return { protocol: 1, pairingId: entry.pairingId, matchingCode: entry.matchingCode, expiresAt, confirmationUrl: `${origin}/codex-pairing/v1/confirm?id=${entry.pairingId}` };
  }
  private get(id: string, origin: string): Entry {
    this.sweep();
    if (this.closed) throw new PairingError(503);
    const entry = this.entries.get(id);
    if (!entry) throw new PairingError(404);
    if (entry.origin !== origin) throw new PairingError(403);
    return entry;
  }
  view(id: string, origin: string): PairingView {
    const { pairingId, matchingCode, expiresAt, state, csrf } = this.get(id, origin);
    return { pairingId, matchingCode, expiresAt, state, origin, csrf };
  }
  decide(id: string, origin: string, csrf: string, allow: boolean, cookie?: string): PairingStatus {
    const entry = this.get(id, origin);
    if (!equal(csrf, entry.csrf)) throw new PairingError(403);
    if (entry.state !== 'pending') throw new PairingError(409);
    if (allow) {
      if (!cookie || cookie.length > 4096 || /[\r\n]/.test(cookie)) throw new PairingError(403);
      entry.cookie = cookie;
      entry.state = 'approved';
      entry.csrf = '';
    } else this.finish(entry, 'rejected');
    return entry.state;
  }
  private authorize(id: string, origin: string, secret: string): Entry {
    const entry = this.get(id, origin);
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || !equal(claimDigest(secret), entry.claimHash)) throw new PairingError(403);
    return entry;
  }
  claim(id: string, origin: string, secret: string): { state: Exclude<PairingStatus, 'approved'>; cookie?: string } {
    const entry = this.authorize(id, origin, secret);
    if (entry.state === 'approved') {
      const cookie = entry.cookie!;
      this.finish(entry, 'claimed');
      return { state: 'claimed', cookie };
    }
    return { state: entry.state };
  }
  cancel(id: string, origin: string, secret: string) {
    const entry = this.authorize(id, origin, secret);
    if (entry.state === 'pending' || entry.state === 'approved') this.finish(entry, 'cancelled');
    return { state: entry.state };
  }
  private finish(entry: Entry, state: PairingStatus) {
    entry.state = state;
    delete entry.cookie;
    entry.csrf = '';
  }
  close(): void { for (const entry of this.entries.values()) this.finish(entry, 'cancelled'); this.entries.clear(); this.closed = true; }
}
