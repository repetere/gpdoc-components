// Actual deployable CLI + real isolated PostgreSQL + real synthetic OIDC HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { configuration } from '../test/fixtures/server-config.mjs';
import { startSyntheticProvider, NetworkCookieJar, authorizeAtProvider, SYNTHETIC_SECRET } from '../test/fixtures/oidc-provider.mjs';
import { testDatabaseConfig, verifyTestDatabase, TEST_DATABASE_URL } from './fixtures/shared-live-sync-common.mjs';
import { createOperationTracker, createServerServices } from '../src/server.mjs';
import { loadServerConfig } from '../src/server-config.mjs';
import { connectLiveCollaboration } from '../src/live-collaboration-client.mjs';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { setTimeout as delay } from 'node:timers/promises';

const enabled=process.env.OPENDOC_PG_INTEGRATION==='1';
const cli=fileURLToPath(new URL('../src/server-cli.mjs',import.meta.url));
async function run(args) {
  const child=spawn(process.execPath,[cli,...args],{env:{...process.env,PGOPTIONS:'-c search_path=untrusted_ambient'},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const [code]=await once(child,'exit');return {code,out,err};
}
async function boot(file) {
  const child=spawn(process.execPath,[cli,'start','--config',file],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  let timer;
  try{await Promise.race([new Promise((resolve,reject)=>{
    child.stdout.on('data',()=>{if(out.includes('OpenDoc server ready.'))resolve();});child.once('exit',code=>reject(new Error(`Server exited ${code}: ${err}`)));
  }),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000))]);}
  catch(e){child.kill('SIGKILL');throw e;}finally{clearTimeout(timer);}
  return {child,async close(){if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');child.kill('SIGTERM');let timeout;
    try{const result=await Promise.race([exit,new Promise((_,reject)=>timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Shutdown timeout'));},12000))]);assert.equal(result[0],0,err);}finally{clearTimeout(timeout);}}};
}
async function login(origin,provider,subject) {
  const jar=new NetworkCookieJar();const r=await jar.fetch(origin+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json','x-opendoc-login':'1'},body:'{}'});
  assert.equal(r.status,200,await r.clone().text());const {authorizationUrl}=await r.json();
  const callback=await authorizeAtProvider({provider,jar,authorizationUrl,subject});assert.equal((await jar.fetch(callback)).status,303);
  const session=await (await jar.fetch(origin+'/auth/session')).json();return {jar,session};
}

// @spec OD-SERVER-003 OD-SERVER-004 OD-SERVER-007 OD-SERVER-008 OD-SERVER-009 OD-SERVER-011
test('deployable CLI provisions explicitly, signs in, persists edits/sessions and fails closed across restart', {skip:!enabled,timeout:120000},async t=>{
  const raw=process.env.DATABASE_URL??TEST_DATABASE_URL,pgConfig=testDatabaseConfig(raw),pool=new Pool(pgConfig);
  await verifyTestDatabase(pool,process.env.OPENDOC_PG_EXPECTED_SERVER_ADDRESS);
  const dir=await mkdtemp(join(tmpdir(),'opendoc-host-')),prefix='host_'+randomBytes(6).toString('hex');
  const c=configuration();for(const key of Object.keys(c.schemas))c.schemas[key]=`${prefix}_${key}`;
  let app,provider;
  t.after(async()=>{await app?.close();await provider?.close();for(const schema of Object.values(c.schemas))await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();await rm(dir,{recursive:true,force:true});});
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');c.server.port=reservation.address().port;
  await new Promise(r=>reservation.close(r));const origin=c.server.publicOrigin=`http://127.0.0.1:${c.server.port}`;
  provider=await startSyntheticProvider({redirectUri:origin+'/auth/callback'});
  for(const key of ['issuer','clientId','authorizationEndpoint','tokenEndpoint','jwksUri'])c.oidc[key]=provider[key];
  c.database.port=pgConfig.port;c.administration={user:'opendoc_test',passwordFile:'db-secret'};
  c.live={sharedSyncIntervalMs:100,authorityId:'4d70654e-646f-4367-8000-000000000001'};
  await writeFile(join(dir,'db-secret'),'synthetic-test-only');await writeFile(join(dir,'client-secret'),SYNTHETIC_SECRET);await writeFile(join(dir,'auth-key'),randomBytes(32));
  const file=join(dir,'server.json');await writeFile(file,JSON.stringify(c));
  assert.equal((await run(['check','--config',file])).code,0);
  assert.equal((await run(['start','--config',file])).code,1,'No automatic schema creation');
  for(const component of ['accounts','documents','live','sessions'])assert.equal((await run(['init','--config',file,'--component',component])).code,0,component);
  assert.equal((await run(['init','--config',file,'--component','accounts'])).code,1,'Existing schema refused');
  for(const role of ['editor','viewer']){
    const account={issuer:provider.issuer,subject:`synthetic-${role}`,principalId:role,tenantId:c.activeTenantId,role};
    const input=join(dir,role+'.json');await writeFile(input,JSON.stringify(account));assert.equal((await run(['account','--config',file,'--input',input])).code,0);
  }
  app=await boot(file);assert.equal((await fetch(origin+'/readyz')).status,200);
  const editor=await login(origin,provider,'synthetic-editor'),viewer=await login(origin,provider,'synthetic-viewer');
  const mutation=(person,path,body)=>person.jar.fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json','x-opendoc-csrf':person.session.csrfToken},body:JSON.stringify(body)});
  const document={id:'persisted',title:'Server test',content:'Persist across process restart'};
  assert.equal((await mutation(editor,'/api/v1/documents',document)).status,201);
  assert.equal((await mutation(viewer,'/api/v1/documents',{...document,id:'denied'})).status,403);
  assert.equal((await mutation(editor,'/api/v1/live-documents',{id:'shared',title:'Live server',content:'initial'})).status,201);
  const peers=[];
  try {
    for(let i=0;i<2;i++) {
      const r=await mutation(editor,'/auth/collaboration-ticket',{documentId:'shared'});assert.equal(r.status,200);const ticket=await r.json();
      const doc=new Y.Doc();
      class Socket extends WebSocket {constructor(url){super(url,{origin});}}
      const connection=await connectLiveCollaboration({url:origin.replace('http:','ws:')+'/api/v1/live-documents/shared/collaboration',token:ticket.ticket,doc,WebSocketImpl:Socket});
      peers.push({doc,connection});
    }
    peers[0].doc.getText('content').insert(0,'A ');peers[1].doc.getText('content').insert(0,'B ');
    let converged=false;
    for(let n=0;n<100;n++){await delay(30);if(peers.every(p=>!p.connection.pending)&&peers[0].doc.getText('content').toString()===peers[1].doc.getText('content').toString()){converged=true;break;}}
    assert.ok(converged,'Two clients must converge and receive persistence acknowledgements');
  } finally {for(const p of peers){p.connection.close();p.doc.destroy();}}
  // Metadata checks must not rewrite shared session records.
  const before=await pool.query(`SELECT kind,record_key,payload,expires_at FROM "${c.schemas.sessions}".browser_auth_records ORDER BY kind,record_key`);
  const loaded=await loadServerConfig(file),services=createServerServices(loaded,pool,createOperationTracker());
  await services.checkReadiness();services.auth.close();
  assert.deepEqual((await pool.query(`SELECT kind,record_key,payload,expires_at FROM "${c.schemas.sessions}".browser_auth_records ORDER BY kind,record_key`)).rows,before.rows);
  await app.close();app=await boot(file);
  assert.equal((await editor.jar.fetch(origin+'/auth/session')).status,200,'Encrypted shared session survives process restart');
  assert.equal((await (await editor.jar.fetch(origin+'/api/v1/documents/persisted')).json()).content,document.content);
  const liveContent=(await (await editor.jar.fetch(origin+'/api/v1/live-documents/shared')).json()).content;
  assert.ok(liveContent.includes('A ')&&liveContent.includes('B ')&&liveContent.includes('initial'));
  await app.close();app=undefined;
  await writeFile(join(dir,'auth-key'),randomBytes(32));assert.equal((await run(['start','--config',file])).code,1,'Wrong shared-session key denies startup');
});
