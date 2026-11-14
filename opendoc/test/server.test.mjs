import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startServerHost, createOperationTracker } from '../src/server.mjs';
import { MemoryLiveDocumentStore } from '../src/live-document-store.mjs';

async function fixture(t, options={}) {
  const net=await import('node:net');const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin=`http://127.0.0.1:${port}`;
  const host=await startServerHost({config:{server:{mode:'development',publicOrigin:origin,host:'127.0.0.1',port,shutdownTimeoutMs:300},limits:{readinessTimeoutMs:60}},
    handle:async()=>new Response('ok'),liveStore:new MemoryLiveDocumentStore(),authenticate:async()=>null,
    checkReadiness:async()=>{},closeResources:async()=>{},...options});
  t.after(()=>host.close());return {host,origin,port};
}
// @spec OD-SERVER-005 OD-SERVER-006
test('health routes retain strict Host/forwarded-header policy and no-store responses',async t=>{
  const {origin}=await fixture(t);
  for(const path of ['/healthz','/readyz']) {const r=await fetch(origin+path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');}
  assert.equal(await new Promise((resolve,reject)=>{const r=request(origin+'/readyz',{headers:{host:'wrong.example.test'}},s=>{s.resume();resolve(s.statusCode);});r.on('error',reject);r.end();}),400);
  assert.equal((await fetch(origin+'/healthz',{headers:{'x-forwarded-for':'127.0.0.1'}})).status,400);
  assert.equal((await fetch(origin+'/readyz',{method:'POST'})).status,405);
});
// @spec OD-SERVER-005
test('WebSocket upgrades reject wrong/duplicate Host and forwarded headers before authentication',async t=>{
  let auth=0;const {port,origin}=await fixture(t,{authenticate:async()=>{auth++;return null;}});
  for(const headers of ['Host: wrong.example.test',`Host: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}`,`Host: 127.0.0.1:${port}\r\nForwarded: host=other`]) {
    const socket=connect(port,'127.0.0.1');await once(socket,'connect');let response='';socket.on('data',chunk=>response+=chunk);
    socket.write(`GET /api/v1/live-documents/example/collaboration HTTP/1.1\r\n${headers}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await once(socket,'close');assert.ok(!response.includes('101 Switching Protocols'));
  }assert.equal(auth,0);
});
// @spec OD-SERVER-006
test('readiness times out without releasing the occupied dependency slot or accumulating work',async t=>{
  let calls=0,finish;const gate=new Promise(r=>finish=r);const {origin}=await fixture(t,{checkReadiness:async()=>{if(++calls>1)await gate;}});
  const results=await Promise.all(Array.from({length:5},()=>fetch(origin+'/readyz')));assert.ok(results.every(r=>r.status===503));assert.equal(calls,2);
  assert.equal((await fetch(origin+'/readyz')).status,503);assert.equal(calls,2);
  finish();await delay(5);assert.equal((await fetch(origin+'/readyz')).status,200);
});
// @spec OD-SERVER-007
test('shutdown waits for tracked store settlement and closes resources exactly once',async t=>{
  const tracker=createOperationTracker();let resolve,closed=0;
  const {host}=await fixture(t,{operations:tracker,closeResources:async()=>{closed++;}});
  const running=tracker.run(()=>new Promise(r=>resolve=r));const stopped=host.close();await delay(25);assert.equal(closed,0);
  resolve();await running;assert.deepEqual(await stopped,{forced:false});await host.close();assert.equal(closed,1);
});
// @spec OD-SERVER-007
test('shutdown deadline reports forced state for unsettled work',async t=>{
  const operations=createOperationTracker();let resolve;const {host}=await fixture(t,{operations});
  const pending=operations.run(()=>new Promise(r=>resolve=r));assert.deepEqual(await host.close(),{forced:true});resolve();await pending;
});
// @spec OD-SERVER-004 OD-SERVER-007
test('failed initial readiness never opens a listener and releases owned resources',async()=>{
  let closed=0;await assert.rejects(startServerHost({config:{server:{mode:'development',publicOrigin:'http://127.0.0.1:8787',host:'127.0.0.1',port:8787,shutdownTimeoutMs:100},limits:{readinessTimeoutMs:50}},
    handle:async()=>new Response(),liveStore:new MemoryLiveDocumentStore(),authenticate:async()=>null,
    checkReadiness:async()=>{throw new Error('private driver secret');},closeResources:async()=>{closed++;}}),/STARTUP_FAILED/);
  assert.equal(closed,1);
});
