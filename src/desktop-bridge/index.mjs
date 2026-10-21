import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DesktopGrant } from './grant.mjs';

const ROOT = '/codex-desktop-bridge/v1';
async function body(req) {
  if (Number(req.headers['content-length'] ?? 0) > 1024) throw new Error('Too large');
  const timeout = setTimeout(() => req.destroy(), 5000);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 1024) throw new Error('Too large');
      chunks.push(bytes);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Object.keys(value).length !== 1 || typeof value.csrf !== 'string' || !/^[0-9a-f]{64}$/.test(value.csrf)) throw new Error('Invalid request');
    return value;
  } finally { clearTimeout(timeout); }
}

export function apply(ctx) {
  ctx.inject(['webServer', 'connection'], scope => {
    let grant;
    for (const operation of ['status', 'approve', 'deny']) {
      scope.effect(() => scope.webServer.register({ kind: 'exact', path: `${ROOT}/${operation}`, async handler(req, res) {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', 'application/json');
        res.setHeader('x-content-type-options', 'nosniff');
        const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
        try {
          const rejection = scope.connection.requestRejection(req);
          if (rejection !== undefined) return send(rejection, { error: 'authentication_required' });
          const port = scope.webServer.port;
          if (!Number.isInteger(port) || port < 1 || port > 65535) return send(503, { error: 'host_not_ready' });
          const origin = `http://127.0.0.1:${port}`;
          if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'origin_rejected' });
          const remote = req.socket.remoteAddress;
          if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return send(403, { error: 'loopback_required' });
          // DesktopGrant owns the codex-desktop namespace; never publish legacy root grants.
          grant ??= new DesktopGrant({ origin,
            stateDir: resolve(process.env.DSH_SUBAGENT_HOME?.trim() || resolve(homedir(), '.codex-subagent-dsh')),
            dshHome: resolve(process.env.DSH_HOME?.trim() || resolve(homedir(), '.dsh')) });
          if (operation === 'status' && req.method === 'GET') return send(200, grant.issue(req.headers.cookie));
          if (!['approve', 'deny'].includes(operation) || req.method !== 'POST') return send(405, { error: 'method_rejected' });
          if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'json_required' });
          if (operation === 'deny') return send(200, grant.deny((await body(req)).csrf, req.headers.cookie));
          await grant.approve((await body(req)).csrf, req.headers.cookie);
          send(200, { granted: true, origin });
        } catch { send(400, { error: 'approval_failed_refresh_and_retry' }); }
      } }));
    }
    scope.effect(() => () => { return grant?.close(); });
  });
}
