// Host/TLS-correct container health probe. MIT. No credentials are transmitted.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';
import { loadServerConfig } from './server-config.mjs';

// @spec OD-SERVER-010
export async function probeServer(loaded,{timeoutMs=5000}={}) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new Error('invalid timeout');
  const {config:c,tls}=loaded,s=c.server,origin=new URL(s.publicOrigin),secure=s.mode==='direct-tls';
  const host=['0.0.0.0','::'].includes(s.host)?(s.host==='::'?'::1':'127.0.0.1'):s.host;
  await new Promise((resolve,reject)=>{
    let response,settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);response?.destroy();request.destroy();error?reject(error):resolve();};
    const request=(secure?httpsRequest:httpRequest)({host,port:s.port,path:'/readyz',method:'GET',headers:{host:origin.host},
      ...(secure?{servername:origin.hostname.replace(/^\[|\]$/g,''),rejectUnauthorized:true,...(tls.ca?{ca:tls.ca}:{})}:{}),timeout:timeoutMs},incoming=>{
      response=incoming;let body='';
      incoming.on('data',chunk=>{body+=chunk;if(body.length>256)finish(new Error('oversized'));});
      incoming.on('error',finish);incoming.on('end',()=>{
        try{if(incoming.statusCode!==200||JSON.parse(body).status!=='ok')throw new Error('unavailable');finish();}catch(e){finish(e);}
      });
    });
    const timer=setTimeout(()=>finish(new Error('deadline')),timeoutMs);
    request.on('timeout',()=>finish(new Error('timeout')));request.on('error',finish);request.end();
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==3)throw new Error();await probeServer(await loadServerConfig(process.argv[2]));}
  catch{process.stderr.write('OpenDoc readiness unavailable.\n');process.exitCode=1;}
}
