import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStrictJson, validateServerConfig, loadServerConfig } from '../src/server-config.mjs';

import { configuration } from './fixtures/server-config.mjs';

// @spec OD-SERVER-001
test('strict JSON rejects duplicate escaped keys, trailing data, invalid UTF-8 and nesting abuse', () => {
  assert.deepEqual(parseStrictJson(Buffer.from('{"a":1,"b":[true,null]}')), { a: 1, b: [true, null] });
  for (const text of ['{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}', '{}{}', '{"a":NaN}', '['.repeat(34)+'0'+']'.repeat(34)]) {
    assert.throws(() => parseStrictJson(Buffer.from(text)), /INVALID_CONFIG/);
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xff])), /INVALID_CONFIG/);
});
// @spec OD-SERVER-001 OD-SERVER-002
test('configuration is detached and rejects unsafe public, database and schema combinations', () => {
  const input = configuration(), output = validateServerConfig(input);
  input.server.port = 9000; assert.equal(output.server.port, 8787); assert.ok(Object.isFrozen(output.server));
  const mutations = [c=>c.extra=true,c=>c.server.extra=true,c=>c.server.host='0.0.0.0',c=>c.server.port=0,c=>c.server.publicOrigin='http://127.0.0.1:9999',
    c=>c.schemas.live=c.schemas.accounts,c=>c.schemas.accounts='public',c=>c.database.host='remote.example.test',
    c=>c.oidc.issuer='https://remote.example.test',c=>c.server.publicOrigin+='/',c=>c.database.ssl=false,
    c=>c.administration={user:'admin',passwordFile:'secret',host:'other'},c=>c.live={authorityId:'invalid'}];
  for (const mutate of mutations) { const config=configuration(); mutate(config); assert.throws(()=>validateServerConfig(config), /INVALID_CONFIG/); }
  const remote=configuration(); remote.server={mode:'proxy',publicOrigin:'https://docs.example.test',host:'0.0.0.0',port:8787,privateIngress:true};
  remote.database.tls='verify-full'; remote.database.host='postgres';
  for(const key of ['issuer','authorizationEndpoint','tokenEndpoint','jwksUri']) remote.oidc[key]=remote.oidc[key].replace('http://127.0.0.1:9999','https://id.example.test');
  assert.equal(validateServerConfig(remote).server.mode,'proxy'); delete remote.server.privateIngress;
  assert.throws(()=>validateServerConfig(remote),/INVALID_CONFIG/);
  remote.server.privateIngress=true;remote.administration={user:remote.database.user,passwordFile:'other-secret'};
  assert.throws(()=>validateServerConfig(remote),/INVALID_CONFIG: administration.user/);
});
// @spec OD-SERVER-002 OD-SERVER-009
test('mounted files are bounded, relative to configuration, regular and never echoed on failure', async t => {
  const dir=await mkdtemp(join(tmpdir(),'opendoc-config-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'db-secret'),'synthetic-db-secret\n'); await writeFile(join(dir,'client-secret'),'synthetic-client-secret\r\n');
  await writeFile(join(dir,'auth-key'),Buffer.alloc(32,3)); const file=join(dir,'server.json'); await writeFile(file,JSON.stringify(configuration()));
  const loaded=await loadServerConfig(file); assert.equal(loaded.database.password,'synthetic-db-secret');
  assert.equal(loaded.clientSecret,'synthetic-client-secret'); assert.equal(loaded.authKey.byteLength,32);
  await writeFile(join(dir,'auth-key'),Buffer.alloc(33)); await assert.rejects(loadServerConfig(file),e=>e.message==='INVALID_CONFIG: authKeyFile');
  await writeFile(join(dir,'auth-key'),Buffer.alloc(32)); await mkdir(join(dir,'not-file')); const c=configuration(); c.database.passwordFile='not-file';
  await writeFile(file,JSON.stringify(c)); await assert.rejects(loadServerConfig(file),e=>!e.message.includes(dir)&&!e.message.includes('synthetic-db-secret'));
});
