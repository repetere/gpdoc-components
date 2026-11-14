// Generate LOCAL reference credentials and CA. Never a public TLS issuance tool.
import { mkdir, writeFile, readFile, access, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('./.reference/',import.meta.url));
try {await access(root);throw new Error('Reference directory already exists; refusing to replace credentials.');}
catch(error){if(error.code!=='ENOENT')throw error;}
if(process.argv.slice(2).some(x=>x!=='--synthetic-client'))throw new Error('Unknown argument');
await mkdir(join(root,'tls'),{recursive:true});await mkdir(join(root,'secrets'));
for(const name of ['admin-password','runtime-password'])await writeFile(join(root,'secrets',name),randomBytes(32).toString('hex'),{mode:0o600});
await writeFile(join(root,'secrets/auth-key'),randomBytes(32),{mode:0o600});
if(process.argv.includes('--synthetic-client'))await writeFile(join(root,'secrets/client-secret'),randomBytes(32).toString('hex'),{mode:0o600});
const tls=join(root,'tls');const openssl=args=>execFileSync('openssl',args,{cwd:tls,stdio:['ignore','ignore','pipe']});
openssl(['req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca.key','-out','ca.crt','-days','30','-subj','/CN=OpenDoc local reference CA']);
for(const [name,host] of [['app','localhost'],['postgres','postgres']]){
  openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',`${name}.key`,'-out',`${name}.csr`,'-subj',`/CN=${host}`]);
  await writeFile(join(tls,`${name}.ext`),`subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
  openssl(['x509','-req','-in',`${name}.csr`,'-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out',`${name}.crt`,'-days','30','-extfile',`${name}.ext`]);
}
await writeFile(join(root,'server.json'),await readFile(new URL('./server.example.json',import.meta.url)));
// Local bind mounts may not preserve UID mapping. Only this isolated reference
// directory is made readable to the non-root container; protect its parent.
await chmod(root,0o700);
for(const name of ['secrets/admin-password','secrets/runtime-password','secrets/auth-key','secrets/client-secret','tls/app.key']){
  try{await chmod(join(root,name),0o644);}catch(e){if(e.code!=='ENOENT')throw e;}
}
console.log('Local reference files created. Configure real OIDC endpoints and mount its client secret before sign-in.');
