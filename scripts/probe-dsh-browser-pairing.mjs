#!/usr/bin/env node
// Production companion + bundled MCP integration. All state is temporary; no model calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dshRoot = process.env.DSH_INSTALL_ROOT;
if (!dshRoot) throw Error('DSH_INSTALL_ROOT must identify an installed @deepseek-ai/dsh');
const manualTimeout = process.argv.includes('--manual-timeout');
const manualReject = process.argv.includes('--manual-reject');
const manual = process.argv.includes('--manual') || manualReject || manualTimeout;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(dshRoot, 'lib/bin.js');
const profile = 'codex-browser-pairing-gate';
const clients = [];
const checks = [];
const secrets = [];
let home, host;
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const bounded = (url, options = {}) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(5000) });
async function cleanup() {
  await Promise.allSettled(clients.map(client => client.close()));
  if (host && host.exitCode === null && host.signalCode === null) {
    host.kill('SIGINT');
    for (let n = 0; n < 40 && host.exitCode === null && host.signalCode === null; n++) await sleep(50);
    if (host.exitCode === null && host.signalCode === null) {
      host.kill('SIGKILL');
      await new Promise(resolveExit => host.once('exit', resolveExit));
    }
  }
  if (home) await rm(home, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error('Isolated browser pairing probe timed out'); void cleanup().finally(() => process.exit(1)); }, manual ? 660_000 : 100_000).unref();
function assertSanitized(value) {
  const output = JSON.stringify(value);
  for (const secret of secrets) assert(!output.includes(secret), 'secret leaked in MCP result');
  assert(!/"(?:cookie|claimSecret|csrfToken|token)"\s*:/i.test(output), 'secret-shaped field in MCP result');
}
function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const result = spawnSync(command, [url], { stdio: 'ignore', timeout: 5000 });
  assert.equal(result.status, 0, 'opening isolated browser failed');
}
try {
  home = await mkdtemp(join(tmpdir(), 'codex-browser-pairing-'));
  await chmod(home, 0o700);
  const env = { ...process.env, DSH_HOME: home };
  for (const args of [
    ['--profile', profile, '--from-default-profile', 'web', '--dump-config'],
    ['plugin', '--profile', profile, 'add', '-w', join(repo, 'plugins/codex-subagent-dsh/dsh-companion')],
  ]) {
    const result = spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, 'isolated DSH setup failed; output withheld');
  }
  host = spawn(process.execPath, [bin, '--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [host.stdout, host.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-200_000); });
  let loginUrl;
  for (let n = 0; n < 400; n++) {
    loginUrl = /^dsh web: (http:\/\/[^\s]+)$/m.exec(output)?.[1];
    if (loginUrl) break;
    assert.equal(host.exitCode, null, 'isolated DSH exited during startup');
    await sleep(50);
  }
  assert(loginUrl, 'isolated DSH startup timed out');
  secrets.push(loginUrl);
  const origin = new URL(loginUrl).origin;
  const login = await bounded(loginUrl);
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie, 'isolated login failed');
  secrets.push(cookie);

  async function newClient(name) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(repo, 'plugins/codex-subagent-dsh/runtime/server.mjs')],
      env: { ...process.env, DSH_SUBAGENT_HOME: join(home, name), DSH_SUBAGENT_URL: origin },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: `browser-pairing-${name}`, version: '1' });
    clients.push(client);
    await client.connect(transport);
    return async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
      assertSanitized(result);
      assert.notEqual(result.isError, true, `${name} failed (response withheld)`);
      const value = JSON.parse(result.content[0].text);
      assertSanitized(value);
      return value;
    };
  }
  const callA = await newClient('client-a');
  const status = await callA('dsh_status');
  assert.equal(status.connected, false);
  assert.equal(status.state, 'authentication_required');
  assert.equal(status.pairing.available, true);
  checks.push('empty bridge state detects authentication required and production companion');
  const a = await callA('dsh_connect', { action: 'start', openBrowser: false });
  assert.equal(new URL(a.confirmationUrl).origin, origin);
  assert(a.matchingCode);
  checks.push('bundled MCP returns safe confirmation URL and matching code');

  // Form extraction deliberately follows actual production HTML, including CSRF.
  const unescape = value => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
  async function getForm(pair) {
    const response = await bounded(pair.confirmationUrl, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const html = await response.text();
    assert(html.includes(pair.matchingCode), 'confirmation page lacks matching code');
    const form = /<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
    assert(form, 'production form not found');
    const body = new URLSearchParams();
    for (const input of form[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = /\bname="([^"]+)"/.exec(input[0])?.[1];
      const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1];
      if (name && value !== undefined) body.set(unescape(name), unescape(value));
    }
    return { url: new URL(unescape(form[1]), pair.confirmationUrl).href, body };
  }
  async function decide(form, decision, authenticated = true, invalidCsrf = false) {
    const body = new URLSearchParams(form.body);
    body.set('decision', decision);
    if (invalidCsrf) {
      const name = [...body.keys()].find(key => /csrf/i.test(key));
      assert(name, 'CSRF input missing');
      body.set(name, 'wrong-csrf');
    }
    return bounded(form.url, { method: 'POST', headers: { origin, ...(authenticated ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body });
  }
  assert.equal((await bounded(a.confirmationUrl)).status, 401);
  checks.push('logged-out browser receives login guidance without authorization');
  const formA = await getForm(a);
  const pending = await callA('dsh_connect', { action: 'check' });
  assert.equal(pending.state, 'pending');
  assert.equal((await callA('dsh_status')).connected, false);
  checks.push('opening page and checking pending do not authorize');

  if (manualTimeout) {
    openUrl(loginUrl);
    openUrl(a.confirmationUrl);
    const waitStarted = Date.now();
    console.log(JSON.stringify({ manualTimeout: true, confirmationUrl: a.confirmationUrl, matchingCode: a.matchingCode, expiresAt: a.expiresAt, instruction: 'Do not click any button; waiting for the real five-minute expiry.' }));
    while (Date.now() <= a.expiresAt + 1000) {
      await sleep(Math.min(45000, Math.max(1, a.expiresAt + 1000 - Date.now())));
      console.log(JSON.stringify({ secondsRemaining: Math.max(0, Math.ceil((a.expiresAt - Date.now()) / 1000)) }));
    }
    const result = await callA('dsh_connect', { action: 'check' });
    assert.equal(result.state, 'expired');
    const response = await bounded(a.confirmationUrl, { headers: { cookie } });
    assert.equal(response.status, 200);
    const expiredPage = await response.text();
    assert(expiredPage.includes('expired') && !expiredPage.includes('<form'), 'expired page must not offer approval');
    assert([403, 409].includes((await decide(formA, 'allow')).status), 'old approval form remained usable after expiry');
    checks.push('real five-minute expiry returns expired without user decision');
    checks.push('expired page has no approval form and stale approval is rejected');
    console.log(JSON.stringify({ expiryVerified: true, state: result.state, waitedMs: Date.now() - waitStarted }));
    openUrl(a.confirmationUrl);
    console.log('Expired page opened; send Enter after inspecting the browser message.');
    process.stdin.resume();
    await new Promise(resolveInput => process.stdin.once('data', resolveInput));
    process.stdin.pause();
  } else if (manual) {
    // No programmatic decisions in manual mode. OS receives login URL; output never does.
    openUrl(loginUrl);
    openUrl(a.confirmationUrl);
    console.log(JSON.stringify({ manual: true, instruction: manualReject ? 'Compare matching code, then click Reject in the isolated DSH browser.' : 'Compare matching code, then click Allow connection in the isolated DSH browser.', confirmationUrl: a.confirmationUrl, matchingCode: a.matchingCode }));
    console.log('Waiting for user response; send Enter after the browser decision.');
    process.stdin.resume();
    await new Promise(resolveInput => process.stdin.once('data', resolveInput));
    process.stdin.pause();
    const result = await callA('dsh_connect', { action: 'check' });
    assert.equal(result?.state, manualReject ? 'rejected' : 'ready', 'manual decision not completed');
    checks.push(manualReject ? 'real user browser rejection' : 'real user browser approval');
  } else {
    assert.equal((await decide(formA, 'allow', false)).status, 401);
    assert.equal((await decide(formA, 'allow', true, true)).status, 403);
    assert.equal((await callA('dsh_connect', { action: 'check' })).state, 'pending');
    checks.push('unauthenticated and incorrect CSRF decisions denied');
    const callB = await newClient('client-b');
    const b = await callB('dsh_connect', { action: 'start', openBrowser: false });
    assert.notEqual(a.confirmationUrl, b.confirmationUrl);
    const formB = await getForm(b);
    const rejected = await decide(formB, 'reject');
    assert([200, 303].includes(rejected.status), 'rejection did not succeed');
    assert.equal((await callB('dsh_connect', { action: 'check' })).state, 'rejected');
    assert.equal((await callB('dsh_status')).connected, false);
    assert.equal((await callA('dsh_connect', { action: 'check' })).state, 'pending');
    checks.push('second client rejection cannot authorize first client');
    const c = await callB('dsh_connect', { action: 'start', openBrowser: false });
    const formC = await getForm(c);
    assert.equal((await callB('dsh_connect', { action: 'cancel' })).state, 'cancelled');
    assert([403, 409].includes((await decide(formC, 'allow')).status), 'cancelled pairing was not denied');
    checks.push('cancelled pairing cannot later be approved');
    const approved = await decide(formA, 'allow');
    assert([200, 303].includes(approved.status), 'approval did not succeed');
    assert.equal((await callA('dsh_connect', { action: 'check' })).state, 'ready');
    checks.push('explicit isolated approval through production HTML reaches MCP ready');
  }
  if (manualReject || manualTimeout) {
    assert.equal((await callA('dsh_status')).connected, false);
    assert.equal((await callA('dsh_connect', { action: 'check' })).state, 'no_pending_pairing');
    const credentialPath = join(home, 'client-a', 'credentials', `${createHash('sha256').update(origin).digest('hex')}.json`);
    await assert.rejects(readFile(credentialPath), { code: 'ENOENT' });
    checks.push('rejection or expiry leaves no saved credential and does not automatically restart pairing');
  } else {
  assert.equal((await callA('dsh_status')).connected, true);
  assert.equal((await callA('dsh_connect', { action: 'start', openBrowser: false })).state, 'ready');
  checks.push('saved credential authenticates native DSH without new pairing');
  const storedPath = join(home, 'client-a', 'credentials', `${createHash('sha256').update(origin).digest('hex')}.json`);
  const stored = JSON.parse(await readFile(storedPath, 'utf8'));
  if (!manual) assert(stored.cookie === cookie, 'stored credential differs from explicitly approved cookie');
  secrets.push(stored.cookie);
  const native = await bounded(origin + '/api/session/list', {
    method: 'POST', headers: { cookie: stored.cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'pairing-gate', method: 'session/list', payload: { args: { _request: {} } } }),
  });
  assert.equal(native.status, 200);
  assert.equal((await native.json()).result?.ok, true, 'saved credential failed native session/list');
  checks.push('on-disk credential independently authenticates native session/list');
  }
  console.log(JSON.stringify({ ok: true, manual, manualReject, manualTimeout, isolatedHome: true, productionCompanion: true, bundledMcp: true, noPaidModel: true, dsh: JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8')).version, checks }, null, 2));
} catch (error) {
  // Do not serialize assertion actual/expected values, request bodies, host logs, or credentials.
  console.error(`Browser pairing probe failed: ${error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 200) : 'unknown failure'}`);
  process.exitCode = 1;
} finally { clearTimeout(deadline); await cleanup(); }
