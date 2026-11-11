// Original OpenDoc renewal security and data-integrity regressions. MIT.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { createLiveDocument } from '../web/live-document.mjs';
import { connectLiveCollaboration } from '../src/live-collaboration-client.mjs';
const URL = 'wss://documents.example.test/api/v1/live-documents/one/collaboration';
const flush = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function frame(doc, revision = 1) { const update=Y.encodeStateAsUpdate(doc), data=new Uint8Array(update.length+9); data[0]=2; new DataView(data.buffer).setBigUint64(1,BigInt(revision)); data.set(update,9); return data; }
class Socket extends EventTarget {
  static instances = [];
  constructor() { super(); this.readyState = 0; this.bufferedAmount = 0; this.sent = []; Socket.instances.push(this); }
  send(data) { this.sent.push(data); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; }
  receive(data) { this.dispatchEvent(new MessageEvent('message',{data})); }
  drop(code = 1011) { const e=new Event('close'); Object.defineProperty(e,'code',{value:code}); this.dispatchEvent(e); }
}
function ready(ws, server, role = 'editor') { ws.open(); ws.receive(JSON.stringify({type:'ready',protocol:'opendoc-yjs-2',role})); ws.receive(frame(server)); }
const credential = () => ({url:URL,token:'synthetic',expiresAt:Date.now()+60000});
async function initialized(t) {
  const server=new Y.Doc(); server.getText('content').insert(0,'abc');
  const binding=createLiveDocument({WebSocketImpl:Socket}); t.after(()=>{binding.destroy();server.destroy();});
  const promise=binding.reconnect({authorize:async()=>credential()}); await flush(); ready(Socket.instances.at(-1),server); assert.equal(await promise,true); return {binding,server};
}
test('edits during renewal retain last known role until handshake', async t => {
  const {binding,server}=await initialized(t);
  const reconnect=binding.reconnect({authorize:async()=>credential()}); await flush();
  assert.equal(binding.edit({content:'first'}),true);
  assert.equal(binding.getState().role,'editor','pre-handshake transport role null must not erase initialized role');
  assert.equal(binding.edit({content:'second'}),true);
  ready(Socket.instances.at(-1),server); await reconnect;
  assert.equal(binding.getState().content,'second'); assert.equal(binding.getState().pending,true);
});
test('IME text survives a handshake downgrade racing composition', async t => {
  const {binding,server}=await initialized(t); assert.equal(binding.beginComposition('content'),true);
  const reconnect=binding.reconnect({authorize:async()=>credential()}); await flush();
  ready(Socket.instances.at(-1),server,'viewer'); await reconnect;
  binding.endComposition('a漢bc');
  assert.equal(binding.getState().content,'a漢bc','composed text must remain exportable after permission change');
  assert.equal(binding.getState().pending,true);
  assert.equal(Socket.instances.at(-1).sent.filter(v=>v instanceof Uint8Array).length,0);
});
test('destroy fences a late authorization result before socket creation', async t => {
  const waiting=deferred(),binding=createLiveDocument({WebSocketImpl:Socket});
  const before=Socket.instances.length,pending=binding.reconnect({authorize:()=>waiting.promise});
  binding.destroy(); waiting.resolve(credential()); assert.equal(await pending,false); assert.equal(Socket.instances.length,before);
});
test('old authorization failure cannot stop a newer connection', async t => {
  const {binding,server}=await initialized(t); const waiting=deferred();
  const old=binding.reconnect({authorize:()=>waiting.promise});
  const current=binding.reconnect({authorize:async()=>credential()}); await flush(); ready(Socket.instances.at(-1),server); await current;
  waiting.resolve(Promise.reject(Object.assign(new Error('late denial'),{status:403}))); assert.equal(await old,false);
  assert.equal(binding.getState().status,'connected');
});
test('forward clock jump rejects remote state and preserves unacknowledged edits', async t => {
  const now=Date.now(); t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const server=new Y.Doc(),doc=new Y.Doc(),errors=[]; t.after(()=>{doc.destroy();server.destroy();}); server.getText('content').insert(0,'abc');
  const pending=connectLiveCollaboration({...credential(),doc,WebSocketImpl:Socket,onError:e=>errors.push(e)}); const ws=Socket.instances.at(-1); ready(ws,server); const connection=await pending;
  doc.getText('content').insert(3,' local'); t.mock.timers.setTime(now+60001);
  server.getText('content').insert(0,'should not merge '); ws.receive(frame(server,2));
  assert.equal(connection.connected,false); assert.equal(connection.pending,true); assert.equal(doc.getText('content').toString(),'abc local'); assert.equal(errors.at(-1).code,'ticket-expired'); connection.close();
});
test('brief successful handshakes cannot reset exhausted retry budget', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
  const {binding,server}=await initialized(t); const initial=Socket.instances.length;
 for (const wait of [500, 1500, 3000]) { Socket.instances.at(-1).drop(); assert.equal(binding.getState().status,'retrying'); t.mock.timers.tick(wait); await flush(); ready(Socket.instances.at(-1),server); await flush(); }
  Socket.instances.at(-1).drop(); assert.equal(binding.getState().status,'disconnected'); t.mock.timers.tick(120000); await flush(); assert.equal(Socket.instances.length,initial+3);
});

test('invalid short expiry is terminal, not a renewal storm', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let count=0;const binding=createLiveDocument({WebSocketImpl:Socket});t.after(()=>binding.destroy());
  assert.equal(await binding.reconnect({authorize:async()=>{count++;return {...credential(),expiresAt:Date.now()+100};}}),false);
  assert.equal(binding.getState().status,'stopped');t.mock.timers.tick(120000);await flush();assert.equal(count,1);
});
test('reentrant stop during renewal emission prevents authorization and future sockets', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let binding,count=0;
  const server=new Y.Doc();server.getText('content').insert(0,'abc');t.after(()=>{binding.destroy();server.destroy();});
 binding=createLiveDocument({WebSocketImpl:Socket,onChange:state=>{if(state.status==='renewing')binding.disconnect('stopped');}});
  const pending=binding.reconnect({authorize:async()=>{count++;return credential();}});await flush();ready(Socket.instances.at(-1),server);await pending;
  const sockets=Socket.instances.length;t.mock.timers.tick(55000);await flush();assert.equal(binding.getState().status,'stopped');assert.equal(count,1);assert.equal(Socket.instances.length,sockets);
  t.mock.timers.tick(120000);await flush();assert.equal(count,1);
});
test('reentrant destroy on successful connection emits no renewal or retries', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let binding,count=0,armed=false;
  const server=new Y.Doc();t.after(()=>server.destroy());
 binding=createLiveDocument({WebSocketImpl:Socket,onChange:state=>{if(armed&&state.status==='connected')binding.destroy();}});
  const pending=binding.reconnect({authorize:async()=>{count++;return credential();}});await flush();armed=true;ready(Socket.instances.at(-1),server);assert.equal(await pending,false);
  t.mock.timers.tick(120000);await flush();assert.equal(count,1);assert.equal(Socket.instances.at(-1).readyState,3);
});
test('lost ACK rollover keeps delete-only pending until fresh matching acknowledgement', async t => {
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});const {binding,server}=await initialized(t);const old=Socket.instances.at(-1);
  t.mock.timers.tick(54999);binding.edit({content:'ac'});const submitted=old.sent.find(v=>v instanceof Uint8Array);Y.applyUpdate(server,submitted.subarray(5));
  t.mock.timers.tick(1);await flush();const current=Socket.instances.at(-1);assert.notEqual(current,old);ready(current,server);await flush();assert.equal(binding.getState().pending,true);
  old.receive(JSON.stringify({type:'ack',sequence:1,revision:1}));assert.equal(binding.getState().pending,true);
  const replay=current.sent.find(v=>v instanceof Uint8Array);assert.ok(replay);Y.applyUpdate(server,replay.subarray(5));current.receive(frame(server,2));assert.equal(binding.getState().pending,true);
  current.receive(JSON.stringify({type:'ack',sequence:1,revision:2}));assert.equal(binding.getState().pending,false);assert.equal(binding.getState().content,'ac');
});
test('backward wall-clock changes cannot bypass the monotonic send deadline', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  let monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  const server = new Y.Doc(), doc = new Y.Doc(), errors = [];
  t.after(() => { doc.destroy(); server.destroy(); });
  const promise = connectLiveCollaboration({ url: URL, token: 'synthetic', expiresAt: now + 1000,
    doc, WebSocketImpl: Socket, onError: error => errors.push(error) });
  const ws = Socket.instances.at(-1); ready(ws, server); const connection = await promise;
  // Do not run timeout callbacks: exercise the synchronous check before a send.
  t.mock.timers.setTime(now - 600000); monotonic = 1001;
  doc.getText('content').insert(0, 'Retain this edit');
  assert.equal(connection.connected, false);
  assert.equal(connection.pending, true);
  assert.equal(ws.sent.filter(value => value instanceof Uint8Array).length, 0);
  assert.equal(errors.at(-1).code, 'ticket-expired');
  connection.close();
});

test('reentrant destroy during reconnect reset prevents authorization work', async t => {
  let binding, armed = false, calls = 0;
  binding = createLiveDocument({ WebSocketImpl: Socket, onChange: state => {
    if (armed && state.status === 'disconnected') { armed = false; binding.destroy(); }
  } });
  t.after(() => binding.destroy());
  const before = Socket.instances.length;
  armed = true;
  assert.equal(await binding.reconnect({ authorize: async () => { calls++; return credential(); } }), false);
  assert.equal(calls, 0);
  assert.equal(Socket.instances.length, before);
});

test('reentrant reconnect does not invoke the newer authorizer twice', async t => {
  let binding, armed = false, oldCalls = 0, newCalls = 0, newer;
  const server = new Y.Doc();
  binding = createLiveDocument({ WebSocketImpl: Socket, onChange: state => {
    if (armed && state.status === 'connecting') {
      armed = false;
      newer = binding.reconnect({ authorize: async () => { newCalls++; return credential(); } });
    }
  } });
  t.after(() => { binding.destroy(); server.destroy(); });
  armed = true;
  const older = binding.reconnect({ authorize: async () => { oldCalls++; return credential(); } });
  await flush(); ready(Socket.instances.at(-1), server);
  assert.equal(await newer, true);
  assert.equal(await older, false);
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
});
