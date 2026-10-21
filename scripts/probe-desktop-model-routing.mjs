#!/usr/bin/env node
// Backend-only isolated probe of the runtime shipped in a Desktop app. No user credentials.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = process.env.DSH_DESKTOP_APP;
if (!app) throw Error('Set DSH_DESKTOP_APP to the installed .app directory. This probe never launches its UI.');
const resource = path.join(app, 'Contents/Resources');
const archive = path.join(resource, 'app.asar');
const node = path.join(resource, 'runtime/primary-runtime/dependencies/node/bin/node');
const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/codex-subagent-dsh/dsh-plugin');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let temporary, child;
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill('SIGTERM');
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(1)); });
const timeout = setTimeout(() => { void stop().finally(() => process.exit(1)); }, 120_000).unref();
// Extract only the bundled dsh runtime; reject path traversal and unsupported archive links.
async function extractRuntime(target) {
  const handle = await open(archive, 'r');
  try {
    const head = Buffer.alloc(16); await handle.read(head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12), dataStart = 8 + head.readUInt32LE(4);
    assert(headerSize > 0 && headerSize < 32 * 1024 * 1024, 'Invalid ASAR header size');
    const header = Buffer.alloc(headerSize); await handle.read(header, 0, headerSize, 16);
    const root = JSON.parse(header.toString());
    async function extract(entry, relative) {
      const output = path.resolve(target, relative);
      assert(output === target || output.startsWith(target + path.sep), 'Unsafe ASAR path');
      assert(!entry.link, 'ASAR links are unsupported by this probe');
      if (entry.files) {
        await mkdir(output, { recursive: true });
        for (const [name, nested] of Object.entries(entry.files)) {
          assert(!['.', '..'].includes(name) && !/[\\/]/.test(name), 'Unsafe ASAR segment');
          await extract(nested, path.join(relative, name));
        }
      } else {
        assert(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 256 * 1024 * 1024, 'Invalid ASAR entry size');
        if (entry.unpacked) {
          const source = path.join(archive + '.unpacked', 'dsh', relative);
          assert((await lstat(source)).isFile(), 'Unpacked entry must be a regular file');
          await copyFile(source, output);
        } else {
          const offset = Number(entry.offset); assert(Number.isSafeInteger(offset) && offset >= 0, 'Invalid ASAR offset');
          const data = Buffer.alloc(entry.size);
          let read = 0;
          while (read < data.length) { const value = await handle.read(data, read, data.length - read, dataStart + offset + read); assert(value.bytesRead, 'Truncated ASAR entry'); read += value.bytesRead; }
          await writeFile(output, data);
        }
        if (entry.executable) await chmod(output, 0o755);
      }
    }
    assert(root.files?.dsh?.files, 'Desktop app has no bundled dsh runtime');
    await extract(root.files.dsh, '');
  } finally { await handle.close(); }
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companion = path.join(repoRoot, 'plugins/codex-subagent-dsh/dsh-plugin');
const adapter = path.join(repoRoot, 'scripts/fixtures/dsh-fake-adapter');
const migration = process.argv.includes('--migration');
const duplicates = process.argv.includes('--duplicates');
// Freeze legacy fixture bytes at the released main baseline, never copy live installations.
async function legacyFixture(directory) {
  const prefix = 'plugins/codex-subagent-dsh/' + directory;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'b5cab81', '--', prefix], { cwd: repoRoot, encoding: 'utf8' }).trim().split('\n');
  const output = join(temporary, 'legacy', directory);
  for (const file of files) {
    assert(file.startsWith(prefix + '/'));
    const target = join(output, file.slice(prefix.length + 1));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, execFileSync('git', ['show', 'b5cab81:' + file], { cwd: repoRoot }));
  }
  return output;
}

const join = path.join;
const selectionA = { provider: 'codex-fixture', model: 'fixture-model-a', reasoningEffort: 'fixture-high' };
const selectionB = { provider: 'codex-fixture', model: 'fixture-model-b', reasoningEffort: 'fixture-low' };
const selectionC = { provider: 'codex-fixture', model: 'fixture-model-c', reasoningEffort: 'fixture-medium' };
async function waitForCompleted(auth, sessionId, model) {
  const url = new URL('/api/remote.mux', auth.origin); url.protocol = 'ws:';
  const socket = new WebSocket(url, {headers:{cookie:auth.cookie},origin:auth.origin,maxPayload:4*1024*1024});
  const streamId=randomUUID();
  try {
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('fixture terminal timeout')),10000);
      let text='',completed=false;
      const settle=error=>{clearTimeout(timer);error?reject(error):resolve({completed:true,text})};
      socket.on('error',settle);
      socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},maxMessages:50}}}})));
      socket.on('message',data=>{try{
        const frame=JSON.parse(String(data));assert.equal(frame.streamId,streamId);
        if(frame.type==='error')throw Error('fixture follow failed');
        if(frame.type!=='item')return;
        const value=frame.value;
        const events=value.type==='snapshot'?value.records.map(record=>record.event):value.type==='event'?[value.event]:[];
        for(const event of events){
          if(event.type==='assistant/message')text=event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('');
          if(event.type==='turn/end'){assert.equal(event.data.reason.kind,'completed');completed=true}
        }
        if(completed){assert.equal(text,`isolated fixture response from ${model}`);settle()}
      }catch(error){settle(error)}});
    });
  } finally {socket.close();}
}

let runtime, profile, home, host, mcpClient;
async function stopHost() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.send({type:'shutdown'});
  for (let i=0; i<100 && child.exitCode===null && child.signalCode===null; i++) await sleep(50);
  if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await new Promise(resolve=>child.once('exit',resolve)); }
}
async function startHost(env) {
  child=spawn(node,['--expose-internals',join(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),runtime,profile,join(resource,'runtime/primary-runtime')],{cwd:profile,env,stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.resume(); child.stderr.on('data', data => { if(process.env.DSH_PROBE_DIAGNOSTICS==='1') console.error(String(data).replace(/https?:\/\/[^\s]+/g, '[URL suppressed]')); });
  let ready,fatal;
  child.on('message',m=>{if(m?.type==='ready')ready=m;if(m?.type==='fatal')fatal=true});
  child.on('error',()=>{fatal=true});
  for(let i=0;i<600&&!ready;i++){assert(!fatal && child.exitCode===null,'isolated host startup failed');await sleep(50)}
  assert(ready,'isolated host startup timed out');return {child,loginUrl:ready.url};
}
async function authenticate(loginUrl) {
  const response = await fetch(loginUrl, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert(cookie, 'isolated login did not issue a cookie');
  return { origin: new URL(loginUrl).origin, cookie };
}

async function rawRpc(auth, path, method, payload, authenticated = true) {
  return await fetch(`${auth.origin}${path}`, {
    method: 'POST',
    headers: {
      origin: auth.origin,
      'content-type': 'application/json',
      ...(authenticated ? { cookie: auth.cookie } : {}),
    },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
  });
}

async function rpc(auth, path, method, payload) {
  const response = await rawRpc(auth, path, method, payload);
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.type, 'server-response');
  assert.equal(envelope.result?.ok, true, `${method} failed: ${envelope.result?.error?.code ?? 'invalid response'}`);
  return envelope.result.value;
}

const companionRpc = (auth, operation, payload) => rpc(
  auth,
  `/api/codex-session-model/${operation}`,
  operation,
  payload,
);

const apiRpc = (auth, method, request) => rpc(
  auth,
  `/api/${method}`,
  method,
  { args: { request } },
);

function sameSelection(left, right) {
  return left?.provider === right.provider
    && left?.model === right.model
    && left?.reasoningEffort === right.reasoningEffort;
}

async function waitForActual(auth, sessionId, selection) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await companionRpc(auth, 'selection.get', { sessionId });
    if (sameSelection(observed.actualRequest, selection)) return observed;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`request/header was not observed for ${selection.model}`);
}

try {
  temporary=await mkdtemp(join(tmpdir(),'codex-desktop-model-probe-'));
  home=join(temporary,'dsh-home');runtime=join(temporary,'runtime');profile=join(home,'profiles/desktop');
  await extractRuntime(runtime);
  await mkdir(join(profile,'node_modules/@aototo'),{recursive:true});
  const baseBundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
  const unifiedName = JSON.parse(await readFile(join(companion,'package.json'),'utf8')).name;
  const legacyNames = ['@aototo/codex-subagent-dsh-companion','@aototo/codex-subagent-dsh-desktop-bridge'];
  const adapterName = JSON.parse(await readFile(join(adapter,'package.json'),'utf8')).name;
  const legacyDirs = migration || duplicates ? await Promise.all(['dsh-companion','dsh-desktop-bridge'].map(legacyFixture)) : [];
  for(const directory of [companion,adapter,...legacyDirs]){
    const manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
    await symlink(directory,join(profile,'node_modules',manifest.name));
  }
  const useBundles = async names => writeFile(join(profile,'package.json'),JSON.stringify({name:'isolated-desktop-model-probe',private:true,dsh:{profile:{bundles:[...baseBundles,...names,adapterName]}}}));
  await useBundles(migration ? legacyNames : [unifiedName]);
  await writeFile(join(profile,'cordis.patch.yml'),'- id: agent-default-model\n  config:\n    provider: codex-fixture\n    model: fixture-model-c\n');
  const env={...process.env,DSH_HOME:home,DSH_SUBAGENT_HOME:join(temporary,'state')};
  await mkdir(join(home, 'workspaces', 'a'), { recursive: true });
  await mkdir(join(home, 'workspaces', 'b'), { recursive: true });
  await mkdir(join(home, 'workspaces', 'c'), { recursive: true });
  host = await startHost(env);
  let auth = await authenticate(host.loginUrl);
  const grantPath=join(env.DSH_SUBAGENT_HOME,'codex-desktop','desktop-connection.json');
  const grantCredential=join(env.DSH_SUBAGENT_HOME,'codex-desktop','credentials',createHash('sha256').update(auth.origin).digest('hex')+'.json');
  const grantStatus=await fetch(auth.origin+'/codex-desktop-bridge/v1/status',{headers:{cookie:auth.cookie,origin:auth.origin}});
  assert.equal(grantStatus.status,200);
  const csrf=(await grantStatus.json()).csrf;
  const allowed=await fetch(auth.origin+'/codex-desktop-bridge/v1/approve',{method:'POST',headers:{cookie:auth.cookie,origin:auth.origin,'content-type':'application/json'},body:JSON.stringify({csrf})});
  assert.equal(allowed.status,200);
  const originalGrant=await readFile(grantPath,'utf8'),originalCredential=await readFile(grantCredential,'utf8');
  const assistantDiscovery=join(env.DSH_SUBAGENT_HOME,'desktop-connection.json'),assistantCredential=join(env.DSH_SUBAGENT_HOME,'credentials','assistant-fixture.json');
  await mkdir(path.dirname(assistantCredential),{recursive:true});
  await writeFile(assistantDiscovery,'isolated assistant discovery');await writeFile(assistantCredential,'isolated assistant credential');
  const unchangedGrants=async()=>{
    assert.equal(await readFile(grantPath,'utf8'),originalGrant);assert.equal(await readFile(grantCredential,'utf8'),originalCredential);
    assert.equal(await readFile(assistantDiscovery,'utf8'),'isolated assistant discovery');assert.equal(await readFile(assistantCredential,'utf8'),'isolated assistant credential');
  };
  const unauthenticated = await rawRpc(auth, '/api/codex-session-model/capabilities.get', 'capabilities.get', {}, false);
  assert.equal(unauthenticated.status, 401);
  const before = await companionRpc(auth, 'capabilities.get', {});
  assert.equal(before.protocol, 1);
  assert.deepEqual(before.operations, ['capabilities.get', 'selection.set', 'selection.get']);
  assert(before.catalog.routableProviders.includes('codex-fixture'));

  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const sessionC = randomUUID();
  await Promise.all([
    apiRpc(auth, 'session/create', { sessionId: sessionA, cwd: join(home, 'workspaces', 'a'), agentPreset: 'standard' }),
    apiRpc(auth, 'session/create', { sessionId: sessionB, cwd: join(home, 'workspaces', 'b'), agentPreset: 'standard' }),
    apiRpc(auth, 'session/create', { sessionId: sessionC, cwd: join(home, 'workspaces', 'c'), agentPreset: 'standard' }),
  ]);
  const invalid = await rawRpc(auth, '/api/codex-session-model/selection.set', 'selection.set', {sessionId:sessionA,selection:{...selectionA,reasoningEffort:'unsupported-effort'}});
  assert.equal((await invalid.json()).result.error.code,'session/model-unavailable');
  assert.equal((await companionRpc(auth,'selection.get',{sessionId:sessionA})).pinned,false);
  const [receiptA, receiptB] = await Promise.all([
    companionRpc(auth, 'selection.set', { sessionId: sessionA, selection: selectionA }),
    companionRpc(auth, 'selection.set', { sessionId: sessionB, selection: selectionB }),
  ]);
  assert.equal(receiptA.sessionId, sessionA);
  assert.equal(receiptB.sessionId, sessionB);
  assert.equal(receiptA.persisted, true);
  assert.equal(receiptB.persisted, true);
  assert.equal((await companionRpc(auth, 'selection.get', { sessionId: sessionC })).pinned, false);

  await stopHost(host);
  if(migration) await useBundles([unifiedName]);
  host = await startHost(env);
  await unchangedGrants();
  auth = await authenticate(host.loginUrl);
  const after = await companionRpc(auth, 'capabilities.get', {});
  assert.deepEqual(after.catalog.default, before.catalog.default, 'companion changed the shared default model');
  const [restoredA, restoredB, restoredC] = await Promise.all([
    companionRpc(auth, 'selection.get', { sessionId: sessionA }),
    companionRpc(auth, 'selection.get', { sessionId: sessionB }),
    companionRpc(auth, 'selection.get', { sessionId: sessionC }),
  ]);
  assert.equal(restoredA.pinned, true);
  assert.equal(restoredB.pinned, true);
  assert.equal(restoredC.pinned, false);
  assert(sameSelection(restoredA.requested, selectionA));
  assert(sameSelection(restoredB.requested, selectionB));

  await Promise.all([
    apiRpc(auth, 'session/prompt', {
      sessionId: sessionA,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Return the isolated fixture response.' }],
      clientTimeZone: 'UTC',
    }),
    apiRpc(auth, 'session/prompt', {
      sessionId: sessionB,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Return the isolated fixture response.' }],
      clientTimeZone: 'UTC',
    }),
  ]);
  const [actualA, actualB] = await Promise.all([
    waitForActual(auth, sessionA, selectionA),
    waitForActual(auth, sessionB, selectionB),
  ]);
  await apiRpc(auth, 'session/prompt', {
    sessionId: sessionC,
    requestId: randomUUID(),
    mode: 'queue',
    content: [{ type: 'text', text: 'Return the isolated default fixture response.' }],
    clientTimeZone: 'UTC',
  });
  const actualC = await waitForActual(auth, sessionC, selectionC);
  assert.equal((await companionRpc(auth, 'selection.get', { sessionId: sessionC })).pinned, false);
  const terminals=await Promise.all([[sessionA,selectionA],[sessionB,selectionB],[sessionC,selectionC]].map(([id,selection])=>waitForCompleted(auth,id,selection.model)));
  const afterRequests = await companionRpc(auth, 'capabilities.get', {});
  assert.deepEqual(afterRequests.catalog.default, before.catalog.default, 'requests changed the shared default model');



  // Use only isolated host credentials; no existing user connection is read or written.
  const state=join(temporary,'mcp-state'), namespace=join(state,'codex-desktop');
  await mkdir(join(namespace,'credentials'),{recursive:true,mode:0o700});
  await writeFile(join(namespace,'desktop-connection.json'),JSON.stringify({version:1,consumer:'codex-subagent-dsh',origin:auth.origin,pid:child.pid,dshHome:home,instanceId:'isolated-model-probe',approvedAt:new Date().toISOString()}),{mode:0o600});
  await writeFile(join(namespace,'credentials',createHash('sha256').update(auth.origin).digest('hex')+'.json'),JSON.stringify({version:1,origin:auth.origin,cookie:auth.cookie,connectedAt:Date.now()}),{mode:0o600});
  const bridgeWorkspace=join(home,'workspaces','bridge');await mkdir(bridgeWorkspace,{recursive:true});
  const mcpEnv={...process.env,DSH_HOME:home,DSH_SUBAGENT_HOME:state,DSH_CONNECTION_MODE:'desktop'};
  delete mcpEnv.DSH_SUBAGENT_URL;
  const transport=new StdioClientTransport({command:process.execPath,args:[join(repoRoot,'plugins/codex-subagent-dsh/runtime/server.mjs')],cwd:bridgeWorkspace,env:mcpEnv,stderr:'pipe'});
  transport.stderr?.on('data',()=>{});
  mcpClient=new Client({name:'desktop-model-host-gate',version:'1'});await mcpClient.connect(transport);
  const callTool=async(name,args)=>{const result=await mcpClient.callTool({name,arguments:args});assert.notEqual(result.isError,true,`${name} failed`);return JSON.parse(result.content[0].text)};
  const status=await callTool('dsh_status',{includeModels:true});
  assert.equal(status.connectionMode,'desktop');assert.equal(status.capabilities.modelSelection,true);
  const submitted=await callTool('dsh_submit',{conversationKey:'desktop-host-gate',requestId:'model-routing',goal:'Return the isolated fixture response.',cwd:bridgeWorkspace,mode:'read',acceptanceCriteria:['return one fixture response'],modelSelection:selectionA});
  const completed=await callTool('dsh_task',{conversationKey:'desktop-host-gate',taskId:submitted.taskId,waitMs:10000});
  assert.equal(completed.state,'completed');
  for(const key of ['requested','configured','actualRequest'])assert(sameSelection(completed.modelRouting[key],selectionA),key+' mismatch');
  await mcpClient.close();mcpClient=undefined;
  assert.deepEqual((await companionRpc(auth,'capabilities.get',{})).catalog.default,before.catalog.default);

  await unchangedGrants();
  if(migration){
    await stopHost(host);await useBundles(legacyNames);host=await startHost(env);auth=await authenticate(host.loginUrl);await unchangedGrants();
    for(const [sessionId,selection] of [[sessionA,selectionA],[sessionB,selectionB]]) assert(sameSelection((await companionRpc(auth,'selection.get',{sessionId})).requested,selection));
    assert.deepEqual((await companionRpc(auth,'capabilities.get',{})).catalog.default,before.catalog.default);
  }
  const duplicateResults=[];
  if(duplicates){
    const manager=(operation,args={})=>rpc(auth,'/api/pluginManager/'+operation,'pluginManager/'+operation,{args});
    const getRows=()=>manager('listPlugins');
    for(const names of [[...legacyNames,unifiedName],[unifiedName,...legacyNames]]){
      await stopHost(host);await useBundles(names);host=await startHost(env);auth=await authenticate(host.loginUrl);
      const rows=await getRows();
      const unified=rows.find(row=>row.moduleName===unifiedName);
      assert(unified && unified.fiberPhase!=='active','mixed startup activated unified plugin');
      for(const name of legacyNames) assert.equal(rows.find(row=>row.moduleName===name)?.fiberPhase,'active','mixed startup damaged legacy plugin');
      await unchangedGrants();duplicateResults.push({order:names,unifiedRejected:true,legacyActive:true});
    }
    await stopHost(host);
    await writeFile(join(profile,'cordis.patch.yml'),'- id: agent-default-model\n  config:\n    provider: codex-fixture\n    model: fixture-model-c\n- id: codex-session-model-routing\n  disabled: true\n- id: codex-subagent-dsh-desktop-bridge\n  disabled: true\n');
    await useBundles([unifiedName,...legacyNames]);host=await startHost(env);auth=await authenticate(host.loginUrl);
    assert.equal((await getRows()).find(row=>row.moduleName===unifiedName)?.fiberPhase,'active');
    for(const name of legacyNames){
      const beforeRows=await getRows(),legacy=beforeRows.find(row=>row.moduleName===name);assert(legacy&&!legacy.enabled);
      const outcome=await manager('setPluginEnabled',{id:legacy.entryId,enabled:true});
      assert.notEqual(outcome.application,'restart-required','dynamic test must exercise live HMR');
      const rows=await getRows();
      assert.notEqual(rows.find(row=>row.moduleName===name)?.fiberPhase,'active','dynamic legacy activation bypassed guard');
      assert.equal(rows.find(row=>row.moduleName===unifiedName)?.fiberPhase,'active','dynamic conflict disabled unified plugin');
      await unchangedGrants();await companionRpc(auth,'capabilities.get',{});
      duplicateResults.push({dynamic:name,legacyRejected:true,unifiedActive:true});
    }
  }
  const version=JSON.parse(await readFile(join(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/package.json'),'utf8')).version;
  console.log(JSON.stringify({ok:true,duplicateResults,migration:{legacyToUnified:migration,rollback:migration,grantFilesUnchanged:true,assistantFilesUnchanged:true,oldGrantNotAssumedValidAfterHostRestart:true},desktopHostVersion:version,authentication:{unauthenticatedStatus:401,authenticated:true},persistence:{restarted:true,sessionA:restoredA.pinned,sessionB:restoredB.pinned},isolation:{sessionA:actualA.actualRequest,sessionB:actualB.actualRequest,sessionC:actualC.actualRequest,sessionCUnpinned:restoredC.pinned===false},sharedDefaultUnchanged:true,terminals,bundledMcp:{state:completed.state,modelRouting:completed.modelRouting}},null,2));
} finally {
  await mcpClient?.close().catch(()=>{});
  clearTimeout(timeout);
  await stop();
}
