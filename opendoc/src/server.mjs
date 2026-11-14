// Original OpenDoc deployable host. MIT. No implicit provisioning or demo identity.
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { createBrowserOidc } from './browser-oidc.mjs';
import { PostgresDocumentStore, initializePostgresSchema } from './postgres-store.mjs';
import { PostgresAccountStore, initializePostgresAccountSchema } from './account-store.mjs';
import { PostgresLiveDocumentStore, initializePostgresLiveDocumentSchema } from './live-document-store.mjs';
import { PostgresBrowserAuthState } from './postgres-browser-auth-state.mjs';
import { createWebClientHandler, createWebClientNodeListener, validWebClientIngress } from './web-client.mjs';
import { attachCollaborationServer } from './collaboration-server.mjs';
import { ServerError } from './server-config.mjs';

const deadline = async (promise,ms) => {
  let timer;try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ServerError('DEPENDENCY_UNAVAILABLE')),ms);})]);}
  finally {clearTimeout(timer);}
};

// @spec OD-SERVER-007: retain admission until the actual operation settles.
export function createOperationTracker() {
  const active=new Set();let sealed=false;
  return {
    run(work) {
      if(sealed)return Promise.reject(new ServerError('DRAINING'));
      const promise=Promise.resolve().then(work);active.add(promise);
      promise.then(()=>active.delete(promise),()=>active.delete(promise));return promise;
    },
    seal(){sealed=true;},
    async drain(){while(active.size)await Promise.allSettled([...active]);},
    get size(){return active.size;}
  };
}
function tracked(port,operations) {
  return new Proxy(port,{get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?(...args)=>operations.run(()=>value.apply(target,args)):value;}});
}
export function createServerPool(loaded) {
  const pool=new Pool(loaded.database);pool.on('error',()=>{});return pool;
}

// @spec OD-SERVER-003
export function createServerServices(loaded,pool,operations=createOperationTracker()) {
  const {config:c}=loaded;
  const accountStore=new PostgresAccountStore({pool,schema:c.schemas.accounts});
  const accounts=tracked(accountStore,operations);
  const store=tracked(new PostgresDocumentStore({pool,schema:c.schemas.documents}),operations);
  const liveStore=tracked(new PostgresLiveDocumentStore({pool,schema:c.schemas.live,accountSchema:c.schemas.accounts,
    ...(c.live?.authorityId?{historyGuard:{authorityId:c.live.authorityId}}:{})}),operations);
  const state=new PostgresBrowserAuthState({pool,schema:c.schemas.sessions,encryptionKey:loaded.authKey});
  const authState=tracked(state,operations);
  // configure() is synchronous and must remain so; only run/checkReadiness perform IO.
  const authStatePort={configure:options=>state.configure(options),run:(...args)=>authState.run(...args)};
  const auth=createBrowserOidc({issuer:c.oidc.issuer,clientId:c.oidc.clientId,
    clientAuthentication:{method:c.oidc.method,clientSecret:loaded.clientSecret},
    authorizationEndpoint:c.oidc.authorizationEndpoint,tokenEndpoint:c.oidc.tokenEndpoint,jwksUri:c.oidc.jwksUri,
    redirectUri:`${c.server.publicOrigin}/auth/callback`,activeTenantId:c.activeTenantId,
    resolveMembership:input=>accounts.resolveMembership(input),authState:authStatePort,allowInsecureLoopback:c.server.mode==='development'});
  return {accounts,store,liveStore,authState,state,auth,operations,
    checkReadiness:async()=>{for(const port of [accounts,store,liveStore,authState])await port.checkReadiness();}};
}

// @spec OD-SERVER-005 OD-SERVER-006 OD-SERVER-007
export async function startServerHost({config:c,tls,handle,liveStore,authenticate,checkReadiness,
  closeResources=async()=>{},stopAuthentication=()=>{},operations=createOperationTracker()}={}) {
  const origin=c.server.publicOrigin,dev=c.server.mode==='development',timeout=c.limits?.readinessTimeoutMs??3000;
  const sockets=new Set();let draining=false,server,transport,closing,pendingProbe;
  function probe() {
    if(draining)return Promise.reject(new ServerError('DRAINING'));
    if(!pendingProbe) {
      pendingProbe=operations.run(checkReadiness);
      const current=pendingProbe;current.then(()=>{if(pendingProbe===current)pendingProbe=undefined;},()=>{if(pendingProbe===current)pendingProbe=undefined;});
    }
    return deadline(pendingProbe,timeout);
  }
  const health=(status,ready)=>new Response(JSON.stringify({status:ready?'ok':'unavailable'}),{status,headers:{'cache-control':'no-store','content-type':'application/json','x-content-type-options':'nosniff'}});
  const routes=async request=>{
    if(draining)return health(503,false);
    const url=new URL(request.url);
    if(url.pathname==='/healthz'||url.pathname==='/readyz') {
      if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD','cache-control':'no-store'}});
      if(url.pathname==='/readyz')try{await probe();}catch{return health(503,false);}
      const result=health(200,true);return request.method==='HEAD'?new Response(null,{status:200,headers:result.headers}):result;
    }
    return operations.run(()=>handle(request));
  };
  const close=()=>{
    if(closing)return closing;draining=true;operations.seal();
    closing=(async()=>{
      let forced=false;
      const work=(async()=>{
        // Synchronously fence late authentication before closing the database pool.
        stopAuthentication();
        const stopped=server?.listening?new Promise(resolve=>server.close(()=>resolve())):Promise.resolve();
        await transport?.close();server?.closeIdleConnections();
        await operations.drain();await stopped;await closeResources();
      })();
      try{await deadline(work,c.server.shutdownTimeoutMs);}catch{forced=true;for(const socket of sockets)socket.destroy();server?.closeAllConnections();}
      return {forced};
    })();return closing;
  };
  try {
    await probe();
    const listener=createWebClientNodeListener({handle:routes,canonicalOrigin:origin,allowInsecureLoopback:dev});
    const options={maxHeaderSize:16384,headersTimeout:10000,requestTimeout:30000};
    server=c.server.mode==='direct-tls'?httpsServer({...options,...tls},listener):httpServer(options,listener);
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    server.setTimeout(30000,socket=>socket.destroy());
    const upgrades=new EventEmitter();
    transport=attachCollaborationServer({server:upgrades,liveStore,authenticate,allowedOrigins:[origin],
      ...(c.live?.sharedSyncIntervalMs?{sharedLiveSync:{intervalMs:c.live.sharedSyncIntervalMs}}:{})});
    server.on('upgrade',(request,socket,head)=>{
      if(draining||!validWebClientIngress(request,origin)||!upgrades.emit('upgrade',request,socket,head))socket.destroy();
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.server.port,c.server.host,()=>{server.off('error',reject);resolve();});});
    server.on('error',()=>{});
    return {origin,server,operations,close,stats:()=>({draining,operations:operations.size,...transport.stats()})};
  }catch{await close();throw new ServerError('STARTUP_FAILED');}
}

// @spec OD-SERVER-003 OD-SERVER-007
export async function startServer(loaded) {
  const pool=createServerPool(loaded),operations=createOperationTracker();let services;
  try {
    services=createServerServices(loaded,pool,operations);
    const handle=await createWebClientHandler({handle:services.auth.createHandler({store:services.store,liveStore:services.liveStore}),
      canonicalOrigin:loaded.config.server.publicOrigin,allowInsecureLoopback:loaded.config.server.mode==='development'});
    // startServerHost owns cleanup once entered.
    return await startServerHost({config:loaded.config,tls:loaded.tls,handle,liveStore:services.liveStore,
      authenticate:services.auth.authenticateCollaboration,checkReadiness:services.checkReadiness,
      stopAuthentication:()=>services.auth.close(),operations,closeResources:()=>pool.end()});
  }catch(error){services?.auth.close();if(!pool.ending)await deadline(pool.end(),loaded.config.server.shutdownTimeoutMs).catch(()=>{});throw new ServerError('STARTUP_FAILED');}
}

// @spec OD-SERVER-008
export async function initializeServerComponent(loaded,component) {
  if(loaded.administrative!==true)throw new ServerError('ADMINISTRATION_REQUIRED');
  if(!['accounts','documents','live','sessions'].includes(component))throw new ServerError('INVALID_COMMAND');
  const pool=createServerPool(loaded);let services;
  try {
    const schema=loaded.config.schemas[component];
    if(component==='accounts')await initializePostgresAccountSchema({pool,schema});
    if(component==='documents')await initializePostgresSchema({pool,schema});
    if(component==='live')await initializePostgresLiveDocumentSchema({pool,schema,...(loaded.config.live?.authorityId?{historyGuard:{authorityId:loaded.config.live.authorityId}}:{})});
    if(component==='sessions'){services=createServerServices(loaded,pool);await services.state.initialize();}
  }catch{throw new ServerError('INITIALIZATION_FAILED');}
  finally{services?.auth.close();await pool.end();}
}
// @spec OD-SERVER-008
export async function provisionServerAccount(loaded,input) {
  if(loaded.administrative!==true)throw new ServerError('ADMINISTRATION_REQUIRED');
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||input.issuer!==loaded.config.oidc.issuer||input.tenantId!==loaded.config.activeTenantId)throw new ServerError('INVALID_ACCOUNT');
  const pool=createServerPool(loaded);
  try{await new PostgresAccountStore({pool,schema:loaded.config.schemas.accounts}).provisionAccount(input);}
  catch{throw new ServerError('PROVISIONING_FAILED');}finally{await pool.end();}
}
