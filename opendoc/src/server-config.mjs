// Original OpenDoc deployment configuration. MIT. Operator input, never document input.
import { open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';

export class ServerError extends Error {
  constructor(code, field) { super(field ? `${code}: ${field}` : code); this.code = code; }
}
const invalid = field => { throw new ServerError('INVALID_CONFIG', field); };
const loopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function shape(value, required, optional = [], field = 'configuration') {
  if (!plain(value) || required.some(k => !Object.hasOwn(value,k)) || Object.keys(value).some(k=>![...required,...optional].includes(k))) invalid(field);
}
function text(value, field, max = 256) { if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value)) invalid(field); return value; }
function number(value, min, max, field) { if(!Number.isSafeInteger(value)||value<min||value>max) invalid(field); }
function freeze(value) { if(value && typeof value==='object') { for(const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }

// @spec OD-SERVER-001
export function parseStrictJson(bytes) {
  try {
    if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536) invalid();
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes); let at=0,nodes=0;
    const space=()=>{while(/[\x20\t\r\n]/.test(source[at]??'!'))at++;};
    function string() {
      const start=at++; while(at<source.length){const c=source[at++];if(c==='"')return JSON.parse(source.slice(start,at));if(c==='\\')at++;}
      invalid();
    }
    function value(depth=0) {
      if(depth>32||++nodes>10000)invalid(); space(); const c=source[at];
      if(c==='"'){string();return;}
      if(c==='{') {at++;space();const keys=new Set();if(source[at]==='}'){at++;return;}
        for(;;){space();if(source[at]!=='"')invalid();const key=string();if(keys.has(key))invalid();keys.add(key);space();if(source[at++]!==':')invalid();value(depth+1);space();const end=source[at++];if(end==='}')return;if(end!==',')invalid();}}
      if(c==='['){at++;space();if(source[at]===']'){at++;return;}for(;;){value(depth+1);space();const end=source[at++];if(end===']')return;if(end!==',')invalid();}}
      const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
      if(!match)invalid();at+=match[0].length;
    }
    value();space();if(at!==source.length)invalid();return JSON.parse(source);
  } catch { invalid(); }
}

// @spec OD-SERVER-001 OD-SERVER-002
export function validateServerConfig(input) {
  let c; try { c=structuredClone(input); } catch { invalid(); }
  shape(c,['version','server','database','schemas','oidc','authKeyFile','activeTenantId'],['administration','live','limits']);
  if(c.version!==1)invalid('version');
  shape(c.server,['mode','publicOrigin','host','port'],['tlsCertificateFile','tlsKeyFile','tlsCaFile','privateIngress','shutdownTimeoutMs']);
  const s=c.server,dev=s.mode==='development';
  if(!['development','direct-tls','proxy'].includes(s.mode))invalid('server.mode');
  text(s.host,'server.host');if(!isIP(s.host))invalid('server.host');number(s.port,1,65535,'server.port');
  let origin;try{origin=new URL(s.publicOrigin);}catch{invalid('server.publicOrigin');}
  if(origin.origin!==s.publicOrigin||origin.username||origin.password||origin.protocol!==(dev?'http:':'https:'))invalid('server.publicOrigin');
  if(dev&&(!loopback(s.host)||!loopback(origin.hostname)))invalid('server.mode');
  if(dev&&(Number(origin.port||80)!==s.port||origin.hostname.replace(/^\[|\]$/g,'')!==s.host))invalid('server.publicOrigin');
  if(s.mode==='proxy'&&s.privateIngress!==true)invalid('server.privateIngress');
  if(s.mode!=='proxy'&&s.privateIngress!==undefined)invalid('server.privateIngress');
  if(s.mode==='direct-tls') {text(s.tlsCertificateFile,'server.tlsCertificateFile',4096);text(s.tlsKeyFile,'server.tlsKeyFile',4096);}
  else if(s.tlsCertificateFile!==undefined||s.tlsKeyFile!==undefined||s.tlsCaFile!==undefined)invalid('server.tls');
  if(s.tlsCaFile!==undefined)text(s.tlsCaFile,'server.tlsCaFile',4096);
  s.shutdownTimeoutMs??=10000;number(s.shutdownTimeoutMs,100,30000,'server.shutdownTimeoutMs');
  shape(c.database,['host','port','database','user','passwordFile','tls'],['caFile','max']);
  const db=c.database;text(db.host,'database.host');if(!isIP(db.host)&&!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(db.host))invalid('database.host');
  number(db.port,1,65535,'database.port');text(db.database,'database.database');text(db.user,'database.user');text(db.passwordFile,'database.passwordFile',4096);
  if(db.tls!=='verify-full'&&!(dev&&loopback(db.host)&&db.tls==='disable'))invalid('database.tls');
  if(db.caFile!==undefined){if(db.tls!=='verify-full')invalid('database.caFile');text(db.caFile,'database.caFile',4096);}
  db.max??=8;number(db.max,1,32,'database.max');
  shape(c.schemas,['accounts','documents','live','sessions']);
  for(const value of Object.values(c.schemas))if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(value)||/^(pg_|public$|information_schema$)/.test(value))invalid('schemas');
  if(new Set(Object.values(c.schemas)).size!==4)invalid('schemas');
  if(typeof c.activeTenantId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(c.activeTenantId))invalid('activeTenantId');
  text(c.authKeyFile,'authKeyFile',4096);
  shape(c.oidc,['issuer','clientId','clientSecretFile','authorizationEndpoint','tokenEndpoint','jwksUri'],['method']);
  text(c.oidc.clientId,'oidc.clientId');text(c.oidc.clientSecretFile,'oidc.clientSecretFile',4096);
  c.oidc.method??='client_secret_basic';if(!['client_secret_basic','client_secret_post'].includes(c.oidc.method))invalid('oidc.method');
  for(const key of ['issuer','authorizationEndpoint','tokenEndpoint','jwksUri']) {
    let u;try{u=new URL(c.oidc[key]);}catch{invalid(`oidc.${key}`);}
    if(u.username||u.password||u.hash||u.search||u.protocol!==(dev?'http:':'https:')||(dev&&!loopback(u.hostname)))invalid(`oidc.${key}`);
  }
  if(c.administration!==undefined){shape(c.administration,['user','passwordFile']);text(c.administration.user,'administration.user');text(c.administration.passwordFile,'administration.passwordFile',4096);}
  if(!dev&&c.administration?.user===db.user)invalid('administration.user');
  if(c.live!==undefined){shape(c.live,[],['authorityId','sharedSyncIntervalMs']);
    if(c.live.authorityId!==undefined&&(typeof c.live.authorityId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.live.authorityId)))invalid('live.authorityId');
    if(c.live.sharedSyncIntervalMs!==undefined)number(c.live.sharedSyncIntervalMs,50,30000,'live.sharedSyncIntervalMs');}
  if(c.limits!==undefined){shape(c.limits,[],['readinessTimeoutMs']);if(c.limits.readinessTimeoutMs!==undefined)number(c.limits.readinessTimeoutMs,50,10000,'limits.readinessTimeoutMs');}
  return freeze(c);
}

// Open first, then inspect/read the descriptor, including projected secret symlinks.
// Nonblocking open prevents a FIFO from stalling before regular-file validation.
async function file(path,max,field) {
  let handle;
  try {
    const { constants }=await import('node:fs');handle=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
    const stat=await handle.stat();if(!stat.isFile()||stat.size>max)invalid(field);
    const bytes=Buffer.alloc(max+1);let total=0;
    while(total<=max){const {bytesRead}=await handle.read(bytes,total,max+1-total,null);if(!bytesRead)break;total+=bytesRead;}
    if(total>max)invalid(field);return bytes.subarray(0,total);
  } catch {invalid(field);} finally{await handle?.close();}
}
function secret(bytes,field){let s;try{s=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{invalid(field);}s=s.replace(/\r?\n$/,'');if(!s||/[\x00\r\n]/.test(s))invalid(field);return s;}
export async function readServerJson(path) { return parseStrictJson(await file(path,65536,'configuration')); }

// @spec OD-SERVER-002 OD-SERVER-009
export async function loadServerConfig(path,{administrative=false}={}) {
  const absolute=resolve(path),base=dirname(absolute),config=validateServerConfig(await readServerJson(absolute));
  const read=(name,max,field)=>file(resolve(base,name),max,field);
  const key=await read(config.authKeyFile,32,'authKeyFile');if(key.length!==32)invalid('authKeyFile');
  const clientSecret=secret(await read(config.oidc.clientSecretFile,4096,'oidc.clientSecretFile'),'oidc.clientSecretFile');
  const selected=administrative?config.administration:config.database;if(!selected)invalid('administration');
  const password=secret(await read(selected.passwordFile,4096,'database.passwordFile'),'database.passwordFile');
  let ca;if(config.database.caFile)ca=await read(config.database.caFile,1048576,'database.caFile');
  let tls;
  if(config.server.mode==='direct-tls') {
    tls={cert:await read(config.server.tlsCertificateFile,1048576,'server.tlsCertificateFile'),key:await read(config.server.tlsKeyFile,1048576,'server.tlsKeyFile')};
    if(config.server.tlsCaFile)tls.ca=await read(config.server.tlsCaFile,1048576,'server.tlsCaFile');
    try{createSecureContext(tls);const cert=new X509Certificate(tls.cert),host=new URL(config.server.publicOrigin).hostname.replace(/^\[|\]$/g,'');
      if(!(isIP(host)?cert.checkIP(host):cert.checkHost(host))||Date.parse(cert.validFrom)>Date.now()||Date.parse(cert.validTo)<=Date.now())invalid('server.tls');
    }catch{invalid('server.tls');}
  }
  // Every pg option that has an ambient environment default is set explicitly.
  const database={host:config.database.host,port:config.database.port,database:config.database.database,user:selected.user,password,
    ssl:config.database.tls==='verify-full'?{rejectUnauthorized:true,...(ca?{ca:ca.toString('utf8')}:{})}:false,
    max:config.database.max,connectionTimeoutMillis:2000,query_timeout:3000,statement_timeout:2000,lock_timeout:2000,
    idle_in_transaction_session_timeout:5000,idleTimeoutMillis:10000,options:'-c search_path=pg_catalog',
    application_name:'opendoc-server',client_encoding:'UTF8',keepAlive:true};
  return {config,database,authKey:Buffer.from(key),clientSecret,tls,administrative};
}
