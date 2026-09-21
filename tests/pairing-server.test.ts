import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { registerPairing } from '../src/pairing-server.js';
import { claimDigest, PairingState } from '../src/pairing-state.js';
const secret = 'c'.repeat(64);
const root = '/codex-pairing/v1';
async function fixture() {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  const disposers: Array<() => void | Promise<void>> = [];
  const server = createServer((req, res) => { const route = routes.get(new URL(req.url!, 'http://localhost').pathname); if (route) void route(req, res); else { res.statusCode = 404; res.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, origin = `http://127.0.0.1:${port}`;
  const cookie = `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}=v1.test.signature`;
  let authCalls = 0;
  registerPairing({ webServer: { port, register: route => { routes.set(route.path, route.handler); return () => { routes.delete(route.path); }; } }, connection: { requestRejection: (req: IncomingMessage) => { authCalls++; return req.headers.cookie?.split(';').map(v => v.trim()).includes(cookie) ? undefined : 401; } } as any, effect: callback => { const disposer = callback(); disposers.push(disposer); return () => {}; } }, new PairingState());
  const send = (operation: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> => new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = httpRequest(origin + root + '/' + operation, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: res.headers as Record<string, string> })));
    }); req.on('error', reject); req.end(raw);
  });
  const begin = async () => { const response = await send('begin', { claimHash: claimDigest(secret) }); assert.equal(response.status, 200); return response.json() as Promise<{pairingId: string; matchingCode: string; confirmationUrl: string}>; };
  const form = async (id: string) => { const response = await send(`confirm?id=${id}`, undefined, { cookie }); assert.equal(response.status, 200); const page = await response.text(); return { page, csrf: page.match(/name="csrf" value="([a-f0-9]+)"/)![1]! }; };
  const decide = (id: string, csrf: string, decision = 'allow', headers: Record<string, string> = {}) => send('decide', new URLSearchParams({ pairingId: id, csrf, decision }).toString(), { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', ...headers });
  const claim = (id: string) => send('claim', { pairingId: id, claimSecret: secret });
  return { origin, port, cookie, send, begin, form, decide, claim, authCalls: () => authCalls, close: async () => { for (const dispose of disposers.reverse()) await dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('HTTP authenticated confirmation permits one exact cookie transfer, no unrelated cookie', async () => {
  const f = await fixture(); try {
    const capability = await f.send('capabilities'); assert.deepEqual(await capability.json(), { protocol: 1, pairing: true });
    const p = await f.begin(); assert.equal(new URL(p.confirmationUrl).origin, f.origin);
    assert.deepEqual(await (await f.claim(p.pairingId)).json(), { state: 'pending' });
    const { csrf, page } = await f.form(p.pairingId); assert(page.includes(p.matchingCode)); assert(!page.includes(f.cookie));
    const approved = await f.decide(p.pairingId, csrf, 'allow', { cookie: 'unrelated=must-not-transfer; ' + f.cookie });
    assert.equal(approved.status, 200); assert(!((await approved.text()).includes(f.cookie)));
    assert.deepEqual(await (await f.claim(p.pairingId)).json(), { state: 'claimed', cookie: f.cookie });
    assert.deepEqual(await (await f.claim(p.pairingId)).json(), { state: 'claimed' });
    assert(f.authCalls() >= 2);
  } finally { await f.close(); }
});

test('HTTP approval rejects unauthenticated, wrong/missing origin, wrong CSRF and duplicate form', async () => {
  const f = await fixture(); try {
    const p = await f.begin(), { csrf } = await f.form(p.pairingId);
    assert.equal((await f.send(`confirm?id=${p.pairingId}`)).status, 401);
    assert.equal((await f.decide(p.pairingId, csrf, 'allow', { cookie: '' })).status, 401);
    for (const origin of ['', 'null', 'https://evil.example', f.origin.replace('http:', 'https:')]) assert.equal((await f.decide(p.pairingId, csrf, 'allow', { origin })).status, 403);
    assert.equal((await f.decide(p.pairingId, 'wrong')).status, 403);
    assert.equal((await f.decide(p.pairingId, '中'.repeat(64))).status, 403);
    assert.equal((await f.send('decide', `pairingId=${p.pairingId}&csrf=${csrf}&decision=allow&decision=reject`, { cookie: f.cookie, origin: f.origin, 'content-type': 'application/x-www-form-urlencoded' })).status, 400);
    assert.equal((await f.decide(p.pairingId, csrf, 'allow', { cookie: `${f.cookie}; ${f.cookie}` })).status, 403);
    assert.deepEqual(await (await f.claim(p.pairingId)).json(), { state: 'pending' });
  } finally { await f.close(); }
});

test('HTTP bootstrap rejects browser requests, invalid Host, duplicate JSON, wrong content type and oversized body', async () => {
  const f = await fixture(); try {
    for (const headers of [{ origin: f.origin }, { 'sec-fetch-site': 'none' }, { 'sec-fetch-mode': 'cors' }] as Array<Record<string, string>>) assert.equal((await f.send('begin', { claimHash: claimDigest(secret) }, headers)).status, 403);
    for (const host of ['evil.example', `127.0.0.1:${f.port + 1}`, `127.0.0.1:${f.port}.evil.example`]) {
      const status = await new Promise<number | undefined>((resolve, reject) => { const req = httpRequest(f.origin + root + '/capabilities', { headers: { host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
      assert.equal(status, 403);
    }
    assert.equal((await f.send('begin', `{"claimHash":"${claimDigest(secret)}","claimHash":"${claimDigest(secret)}"}`)).status, 400);
    assert.equal((await f.send('begin', { claimHash: claimDigest(secret) }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await f.send('begin', 'x'.repeat(3000))).status, 413);
    assert.equal((await f.send('begin')).status, 405);
  } finally { await f.close(); }
});

test('HTTP rejects wrong secret, cancellation or rejection never releases credential', async () => {
  const f = await fixture(); try {
    const p = await f.begin(), { csrf } = await f.form(p.pairingId);
    assert.equal((await f.send('claim', { pairingId: p.pairingId, claimSecret: 'x'.repeat(64) })).status, 403);
    assert.equal((await f.decide(p.pairingId, csrf, 'reject')).status, 200);
    assert.deepEqual(await (await f.claim(p.pairingId)).json(), { state: 'rejected' });
    const other = await f.begin(); const form = await f.form(other.pairingId); await f.decide(other.pairingId, form.csrf);
    assert.deepEqual(await (await f.send('cancel', { pairingId: other.pairingId, claimSecret: secret })).json(), { state: 'cancelled' });
    assert.deepEqual(await (await f.claim(other.pairingId)).json(), { state: 'cancelled' });
  } finally { await f.close(); }
});

test('confirmation security headers prevent framing, caching and resource leakage; begin is rate bounded', async () => {
  const f = await fixture(); try {
    const p = await f.begin(); const page = await f.send(`confirm?id=${p.pairingId}`, undefined, { cookie: f.cookie });
    assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.equal(page.headers.get('x-frame-options'), 'DENY'); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert(!((await page.text()).includes('<script')));
    for (let i = 1; i < 16; i++) await f.begin();
    assert.equal((await f.send('begin', { claimHash: claimDigest(secret) })).status, 429);
  } finally { await f.close(); }
});


test('fixed-size verification requires native authentication and exact Origin, never exposes session data', async () => {
  const f = await fixture(); try {
    const headers = { cookie: f.cookie, origin: f.origin };
    const verified = await f.send('verify', {}, headers);
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), { protocol: 1, authenticated: true });
    assert.equal((await f.send('verify', {}, { origin: f.origin })).status, 401);
    assert.equal((await f.send('verify', {}, { cookie: f.cookie })).status, 403);
    assert.equal((await f.send('verify', {}, { cookie: f.cookie, origin: f.origin.replace('http:', 'https:') })).status, 403);
    assert.equal((await f.send('verify', { unexpected: 'value' }, headers)).status, 400);
    assert.equal((await f.send('verify', {}, { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await f.send('verify', 'x'.repeat(3000), headers)).status, 413);
    assert(f.authCalls() >= 4);
  } finally { await f.close(); }
});
