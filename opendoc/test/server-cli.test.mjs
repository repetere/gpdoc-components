import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runServerCli } from '../src/server-cli.mjs';
import { probeServer } from '../src/server-health.mjs';
import { configuration } from './fixtures/server-config.mjs';

// @spec OD-SERVER-008 OD-SERVER-009
test('configuration-only CLI works with unreachable services; invalid commands and secret failures stay sanitized',async t=>{
  const root=await mkdtemp(join(tmpdir(),'opendoc-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const c=configuration(),file=join(root,'server.json');
  await writeFile(file,JSON.stringify(c));await writeFile(join(root,'db-secret'),'private-synthetic-password');await writeFile(join(root,'client-secret'),'private-provider-secret');await writeFile(join(root,'auth-key'),Buffer.alloc(32));
  const output=[],io={out:x=>output.push(x),err:x=>output.push(x)};
  assert.equal(await runServerCli(['check','--config',file],io),0);
  assert.equal(await runServerCli(['init','--config',file,'--component','accounts'],io),1,'Explicit admin credentials required');
  for(const argv of [[],['start'],['check','--config',file,'--config',file],['check','--config',file,'--input','bad']])assert.equal(await runServerCli(argv,io),1);
  assert.ok(!output.join(' ').includes('private-synthetic-password'));assert.ok(!output.join(' ').includes('private-provider-secret'));
});
// @spec OD-SERVER-010
test('container probe has an absolute deadline even while a response trickles',async t=>{
  const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');const timer=setInterval(()=>res.write(' '),10);res.once('close',()=>clearInterval(timer));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const port=server.address().port;const before=performance.now();
  await assert.rejects(probeServer({config:{server:{mode:'development',publicOrigin:`http://127.0.0.1:${port}`,host:'127.0.0.1',port}}},{timeoutMs:80}));
  assert.ok(performance.now()-before<1000);
});
