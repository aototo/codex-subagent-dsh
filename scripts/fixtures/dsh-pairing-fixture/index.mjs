// Isolated feasibility fixture only; not a production pairing protocol.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const name = 'codex-pairing-fixture';
export const inject = ['webServer', 'connection'];
const secret = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function apply(ctx) {
  const pending = new Map();
  let total = 0;
  const ttl = 1200;
  const prune = () => { for (const [id, entry] of pending) if (entry.expires <= Date.now()) pending.delete(id); };
  const timer = setInterval(prune, 100).unref();
  ctx.effect(() => () => { clearInterval(timer); pending.clear(); });
  function headers(res) { res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/pairing-fixture', handler(req, res) {
    headers(res);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Pairing fixture</title><p>Backend feasibility probe. No browser approval UI implemented.</p>');
  }}));
  for (const op of ['start', 'poll']) ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `/pairing-fixture/${op}`, async handler(req, res) {
    headers(res);
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    // Client-only unauthenticated endpoints: reject browser-origin requests and DNS rebinding.
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || req.headers.origin || req.headers['sec-fetch-site']) { res.writeHead(403); res.end(); return; }
    let size = 0, chunks = '';
    for await (const chunk of req) { size += chunk.length; if (size > 1024) { res.writeHead(413); res.end(); return; } chunks += chunk; }
    let body; try { body = JSON.parse(chunks); } catch { res.writeHead(400); res.end(); return; }
    prune();
    if (op === 'start') {
      if (++total > 8 || pending.size >= 4) { res.writeHead(429); res.end(); return; }
      const id = secret(), pollSecret = secret();
      pending.set(id, { pollSecret, expires: Date.now() + ttl, state: 'pending', polls: 0 });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id, pollSecret })); return;
    }
    const entry = pending.get(body.id);
    if (!entry || !equal(body.pollSecret, entry.pollSecret)) { res.writeHead(403); res.end(); return; }
    if (++entry.polls > 10) { pending.delete(body.id); res.writeHead(429); res.end(); return; }
    if (entry.state === 'rejected') { pending.delete(body.id); res.writeHead(410); res.end(); return; }
    if (entry.state === 'approved') {
      pending.delete(body.id);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ cookie: entry.cookie })); return;
    }
    res.writeHead(202); res.end();
  }}));
  for (const op of ['approve', 'reject']) ctx.connection.fetch.register({ path: `/api/pairing-fixture/${op}`, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    // Native /api cookie, Host and browser-origin fence runs before this callback.
    const authority = request.headers.get('host');
    if (!/^127\.0\.0\.1:\d+$/.test(authority ?? '')) return new Response(null, { status: 403 });
    const origin = `http://${authority}`;
    if (request.headers.get('origin') !== origin) return new Response(null, { status: 403 });
    let body; try { const raw = await request.text(); if (raw.length > 1024) throw Error(); body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
    prune();
    const entry = pending.get(body.id);
    if (!entry || entry.state !== 'pending') return new Response(null, { status: 409 });
    entry.state = op === 'approve' ? 'approved' : 'rejected';
    if (op === 'approve') {
      const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
      if (cookies.length !== 1) { pending.delete(body.id); return new Response(null, { status: 403 }); }
      entry.cookie = cookies[0];
    }
    return Response.json({ state: entry.state }, { headers: { 'cache-control': 'no-store' } });
  }});
}
