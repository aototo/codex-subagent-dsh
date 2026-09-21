import test from 'node:test';
import assert from 'node:assert/strict';
import { PairingState, PairingError, claimDigest } from '../src/pairing-state.js';
const secret = 'a'.repeat(64), origin = 'http://127.0.0.1:3080';
const fails = (code: number) => (e: unknown) => e instanceof PairingError && e.status === code;

test('pairing requires explicit decision and only one claimant receives credential', async () => {
  const state = new PairingState(); const pair = state.begin(claimDigest(secret), origin);
  assert.deepEqual(state.claim(pair.pairingId, origin, secret), { state: 'pending' });
  const view = state.view(pair.pairingId, origin);
  assert.throws(() => state.decide(pair.pairingId, origin, 'wrong', true, 'test-cookie'), fails(403));
  state.decide(pair.pairingId, origin, view.csrf, true, 'test-cookie');
  const results = await Promise.all(Array.from({ length: 8 }, async () => state.claim(pair.pairingId, origin, secret)));
  assert.equal(results.filter(r => r.cookie).length, 1);
  assert(results.every(r => r.state === 'claimed'));
  assert.throws(() => state.decide(pair.pairingId, origin, view.csrf, true, 'test-cookie'), fails(403));
});

test('claim binding rejects wrong secret, origin and unknown id', () => {
  const state = new PairingState(); const p = state.begin(claimDigest(secret), origin);
  assert.throws(() => state.claim(p.pairingId, origin, 'b'.repeat(64)), fails(403));
  assert.throws(() => state.claim(p.pairingId, 'http://localhost:3080', secret), fails(403));
  assert.throws(() => state.claim('missing', origin, secret), fails(404));
  assert.throws(() => state.cancel(p.pairingId, origin, 'b'.repeat(64)), fails(403));
  assert.deepEqual(state.claim(p.pairingId, origin, secret), { state: 'pending' });
});

for (const terminal of ['rejected', 'cancelled', 'expired'] as const) {
  test(`pairing ${terminal} cannot release credentials or be reapproved`, () => {
    let now = 0; const state = new PairingState(() => now, 100);
    const p = state.begin(claimDigest(secret), origin), view = state.view(p.pairingId, origin);
    if (terminal === 'rejected') state.decide(p.pairingId, origin, view.csrf, false);
    else { state.decide(p.pairingId, origin, view.csrf, true, 'test-cookie'); if (terminal === 'cancelled') state.cancel(p.pairingId, origin, secret); else now = 100; }
    assert.deepEqual(state.claim(p.pairingId, origin, secret), { state: terminal });
    assert.throws(() => state.decide(p.pairingId, origin, view.csrf, true, 'test-cookie'), fails(403));
    assert.deepEqual(state.cancel(p.pairingId, origin, secret), { state: terminal });
  });
}

test('pairing limits pending records, retains bounded tombstones then clears them', () => {
  let now = 0; const state = new PairingState(() => now, 100, 2, 1);
  const p = state.begin(claimDigest(secret), origin);
  assert.throws(() => state.begin(claimDigest(secret), origin), fails(429));
  state.cancel(p.pairingId, origin, secret);
  const p2 = state.begin(claimDigest(secret), origin); state.cancel(p2.pairingId, origin, secret);
  assert.throws(() => state.begin(claimDigest(secret), origin), fails(429));
  now = 201; assert(state.begin(claimDigest(secret), origin));
  assert.throws(() => state.claim(p.pairingId, origin, secret), fails(404));
});

test('closing erases pending approved entries and prevents new records', () => {
  const state = new PairingState(); const p = state.begin(claimDigest(secret), origin);
  state.decide(p.pairingId, origin, state.view(p.pairingId, origin).csrf, true, 'test-cookie');
  state.close();
  assert.throws(() => state.claim(p.pairingId, origin, secret), fails(503));
  assert.throws(() => state.begin(claimDigest(secret), origin), fails(503));
});
