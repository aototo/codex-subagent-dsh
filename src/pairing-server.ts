import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { PairingError, PairingState } from './pairing-state.js';

const ROOT = '/codex-pairing/v1';
const STYLE = 'body{margin:0;padding:32px 18px;background:#f3f5f7;color:#18212d;font:16px/1.7 system-ui,sans-serif}main{max-width:640px;margin:24px auto;padding:32px;border:1px solid #dce2e9;border-radius:16px;background:white}h1{font-size:26px;margin-top:0}strong{font-family:ui-monospace,monospace;color:#1648a0}button{font:inherit;border:1px solid #bfc9d6;border-radius:8px;padding:10px 22px;cursor:pointer;background:#fff}button[value=allow]{background:#1959b8;border-color:#1959b8;color:white}button:focus-visible{outline:3px solid #80adff;outline-offset:3px}form{margin-top:28px}';
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const loopback = (ip?: string) => ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
function secureHeaders(res: ServerResponse) {
  res.setHeader('cache-control', 'no-store');
  // A no-referrer policy makes browser form POST Origin become null.
  // same-origin preserves the approval Origin while withholding cross-origin referrers.
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
}
function json(res: ServerResponse, value: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); }
function html(res: ServerResponse, body: string) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 Codex 与 DSH</title><style>${STYLE}</style><body><main><h1>连接 Codex 与 DSH</h1>${body}</main></body></html>`);
}
async function readBody(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > 2048) throw new PairingError(413);
  const chunks: Buffer[] = []; let length = 0;
  // Bound slow clients as well as the buffered body; destroy after response on timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 2048) throw new PairingError(413); chunks.push(bytes); } return Buffer.concat(chunks).toString('utf8'); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new PairingError(408)); req.destroy(); }, 5000); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
}
function parseJson(raw: string, fields: string[]): Record<string, string> {
  // This wire format contains ASCII opaque tokens only. Disallow escaped key spellings,
  // duplicate fields and nested values, including ambiguity hidden by JSON.parse.
  if (raw.includes('\\')) throw new PairingError(400);
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new PairingError(400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PairingError(400);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== fields.length || fields.some(key => typeof object[key] !== 'string' || (raw.match(new RegExp(`"${key}"\\s*:`, 'g')) ?? []).length !== 1) || Object.keys(object).some(key => !fields.includes(key))) throw new PairingError(400);
  return object as Record<string, string>;
}
/** Register native HTTP routes so unauthenticated bootstrap can be narrowly fenced. */
export function registerPairing(ctx: Pick<Context, 'connection' | 'webServer' | 'effect'>, state = new PairingState()): void {
  let closed = false;
  let windowStart = Date.now(), requests = 0, begins = 0;
  const timer = setInterval(() => state.sweep(), 10_000).unref();
  ctx.effect(() => () => { closed = true; clearInterval(timer); state.close(); });
  for (const operation of ['capabilities', 'begin', 'claim', 'cancel', 'confirm', 'decide', 'verify']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${ROOT}/${operation}`, async handler(req, res) {
      secureHeaders(res);
      try {
        if (closed) throw new PairingError(503);
        const port = ctx.webServer.port;
        const host = req.headers.host;
        if (!Number.isInteger(port) || port < 1 || !loopback(req.socket.remoteAddress) || !host || !['127.0.0.1', 'localhost', '[::1]'].some(h => host === `${h}:${port}` || (port === 80 && host === h))) throw new PairingError(403);
        // Duplicate Host / Origin headers must not be hidden by Node's header normalization.
        const names = req.rawHeaders.filter((_, index) => index % 2 === 0).map(n => n.toLowerCase());
        if (names.filter(n => n === 'host').length !== 1 || names.filter(n => n === 'origin').length > 1 || names.filter(n => n === 'content-type').length > 1) throw new PairingError(403);
        const origin = new URL(`http://${host}`).origin;
        const browserRoute = operation === 'confirm' || operation === 'decide' || operation === 'verify';
        if (!browserRoute && (req.headers.origin !== undefined || Object.keys(req.headers).some(k => k.startsWith('sec-fetch-')))) throw new PairingError(403);
        if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = begins = 0; }
        if (++requests > 1200 || (operation === 'begin' && ++begins > 16)) throw new PairingError(429);
        const method = operation === 'capabilities' || operation === 'confirm' ? 'GET' : 'POST';
        if (req.method !== method) { res.setHeader('allow', method); throw new PairingError(405); }
        const url = new URL(req.url ?? '', origin);
        if (operation !== 'confirm' && url.search) throw new PairingError(400);
        if (operation === 'capabilities') { json(res, { protocol: 1, pairing: true }); return; }
        if (browserRoute) {
          if ((operation === 'decide' || operation === 'verify') && req.headers.origin !== origin) throw new PairingError(403);
          const rejected = ctx.connection.requestRejection(req);
          if (rejected !== undefined) {
            res.statusCode = rejected;
            html(res, '<p>请先在此浏览器登录当前 DSH，再重新打开 Codex 提供的确认页面。此页面不会自动登录或授权。</p>'); return;
          }
          if (operation === 'verify') {
            if (req.headers['content-type'] !== 'application/json') throw new PairingError(415);
            parseJson(await readBody(req), []);
            json(res, { protocol: 1, authenticated: true }); return;
          }
          if (operation === 'confirm') {
            if (url.searchParams.getAll('id').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'id')) throw new PairingError(400);
            const view = state.view(url.searchParams.get('id')!, origin);
            if (view.state !== 'pending') { html(res, `<p>此请求已处理或过期（${escape(view.state)}）。请返回 Codex 查看结果。</p>`); return; }
            html(res, `<p>一个本机客户端请求连接 DSH。请求来源标签为 Codex 插件，但这不是可信身份认证。</p><p>DSH 地址：<strong>${escape(origin)}</strong></p><p>请核对 Codex 中显示的匹配码：<strong>${escape(view.matchingCode)}</strong></p><p>到期时间：${escape(new Date(view.expiresAt).toISOString())}（5 分钟内有效）。只有你刚刚主动发起连接且匹配码一致时才允许。</p><p>允许后，将当前 DSH 登录凭证交给该客户端保存，使其可以调用当前 DSH 接口、读取会话和派发任务。执行仍受 DSH 权限策略限制。这不是按任务限权或可单独撤销的令牌；删除插件凭证不会使已复制凭证在 DSH 失效。</p><form method="post" action="${ROOT}/decide"><input type="hidden" name="pairingId" value="${escape(view.pairingId)}"><input type="hidden" name="csrf" value="${escape(view.csrf)}"><button type="submit" name="decision" value="allow">允许连接</button> <button type="submit" name="decision" value="reject">拒绝</button></form>`); return;
          }
          if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') throw new PairingError(415);
          const form = new URLSearchParams(await readBody(req));
          if (['pairingId', 'csrf', 'decision'].some(key => form.getAll(key).length !== 1) || [...form.keys()].some(k => !['pairingId', 'csrf', 'decision'].includes(k)) || !['allow', 'reject'].includes(form.get('decision')!)) throw new PairingError(400);
          const name = 'dsh-auth-' + createHash('sha256').update(new URL(origin).host).digest('base64url');
          const cookies = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.slice(0, v.indexOf('=')) === name);
          if (cookies.length !== 1 || cookies[0]!.length > 4096 || !new RegExp(`^${name}=[A-Za-z0-9_.-]+$`).test(cookies[0]!)) throw new PairingError(403);
          const result = state.decide(form.get('pairingId')!, origin, form.get('csrf')!, form.get('decision') === 'allow', cookies[0]);
          html(res, `<p>${result === 'approved' ? '已允许连接，请返回 Codex 等待连接验证。' : '已拒绝连接。'}你可以关闭此页面。</p>`); return;
        }
        if (req.headers['content-type'] !== 'application/json') throw new PairingError(415);
        const fields = operation === 'begin' ? ['claimHash'] : ['pairingId', 'claimSecret'];
        const body = parseJson(await readBody(req), fields);
        if (operation === 'begin') json(res, state.begin(body.claimHash!, origin));
        else json(res, operation === 'claim' ? state.claim(body.pairingId!, origin, body.claimSecret!) : state.cancel(body.pairingId!, origin, body.claimSecret!));
      } catch (error) {
        res.statusCode = error instanceof PairingError ? error.status : 500;
        if (operation === 'confirm' || operation === 'decide') html(res, '<p>连接请求未完成。请返回 Codex 检查状态，并从当前确认链接重新打开页面；如请求已过期，请重新发起连接。</p>');
        else json(res, { error: 'pairing_request_failed' });
      }
    } }));
  }
}
export function applyPairing(ctx: Context): void {
  ctx.inject(['webServer', 'connection'], pairingCtx => registerPairing(pairingCtx));
}
