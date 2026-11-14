// Original OpenDoc operational CLI. MIT. Secret values never travel in argv.
import { pathToFileURL } from 'node:url';
import { loadServerConfig, readServerJson, ServerError } from './server-config.mjs';
import { startServer, createServerPool, createServerServices, initializeServerComponent, provisionServerAccount } from './server.mjs';
import { createWebClientHandler } from './web-client.mjs';

function argumentsFor(argv) {
  const [command,...args]=argv;
  if(!['start','check','init','account'].includes(command))throw new ServerError('INVALID_COMMAND');
  const options={};
  for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];
    if(!['--config','--component','--input'].includes(key)||!value||value.startsWith('--')||Object.hasOwn(options,key))throw new ServerError('INVALID_COMMAND');
    options[key]=value;}
  if(!options['--config']||(command==='init'?!options['--component']:options['--component']!==undefined)||(command==='account'?!options['--input']:options['--input']!==undefined))throw new ServerError('INVALID_COMMAND');
  return {command,options};
}

// @spec OD-SERVER-008 OD-SERVER-009
export async function runServerCli(argv,{out=message=>process.stdout.write(message+'\n'),err=message=>process.stderr.write(message+'\n')}={}) {
  try {
    const {command,options}=argumentsFor(argv),loaded=await loadServerConfig(options['--config'],{administrative:['init','account'].includes(command)});
    if(command==='check') {
      const pool=createServerPool(loaded);let services;
      try {services=createServerServices(loaded,pool);await createWebClientHandler({handle:services.auth.createHandler({store:services.store,liveStore:services.liveStore}),
        canonicalOrigin:loaded.config.server.publicOrigin,allowInsecureLoopback:loaded.config.server.mode==='development'});}
      finally {services?.auth.close();await pool.end();}
      out('OpenDoc configuration and local assets valid. No external services checked.');return 0;
    }
    if(command==='init'){await initializeServerComponent(loaded,options['--component']);out('OpenDoc component initialized.');return 0;}
    if(command==='account'){await provisionServerAccount(loaded,await readServerJson(options['--input']));out('OpenDoc account provisioned.');return 0;}
    const host=await startServer(loaded);out('OpenDoc server ready.');
    let stopped=false;
    const stop=async()=>{if(stopped)return;stopped=true;const {forced}=await host.close();
      process.exitCode=forced?1:0;out(forced?'OpenDoc shutdown deadline reached; outstanding outcomes may be uncertain.':'OpenDoc server stopped.');
      // Pending driver work may never settle. The process deadline is intentional.
      process.exit(process.exitCode);
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);return 0;
  }catch(error){err(error instanceof ServerError?error.message:'OPENDOC_COMMAND_FAILED');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runServerCli(process.argv.slice(2));
