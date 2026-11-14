#!/usr/bin/env python3
"""Prepare one fresh, private single-host POC. Never provisions AWS resources."""
# @spec OD-SERVER-010
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--hostname', required=True)
p.add_argument('--directory', required=True, type=Path)
a = p.parse_args()
if not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)+', a.hostname):
    p.error('A lowercase DNS hostname is required')
root = a.directory.resolve()
try:
    root.mkdir(mode=0o700)
except FileExistsError:
    p.error('Refusing an existing deployment directory; credentials were not replaced')
os.umask(0o077)
source = Path(__file__).resolve().parents[3]
deploy = source / 'opendoc/deploy'
for name in ('tls', 'secrets', 'realm'):
    (root/name).mkdir()

def write(name, value):
    path = root/name
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(0o644)  # Individual read-only mounts; private parent stays 0700.

def dump(name, value):
    write(name, json.dumps(value, indent=2)+'\n')

def openssl(*args):
    subprocess.run(['openssl', *args], cwd=root/'tls', check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

passwords = {n: secrets.token_hex(32) for n in
             ('admin-password', 'runtime-password', 'keycloak-password', 'client-secret', 'owner-password')}
for name, value in passwords.items():
    write('secrets/'+name, value)
write('secrets/auth-key', secrets.token_bytes(32))
openssl('req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca.key','-out','ca.crt',
        '-days','3650','-subj','/CN=OpenDoc POC private database CA')
openssl('req','-new','-newkey','rsa:2048','-nodes','-keyout','postgres.key','-out','postgres.csr',
        '-subj','/CN=postgres')
write('tls/postgres.ext','subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\n')
openssl('x509','-req','-in','postgres.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
        '-out','postgres.crt','-days','365','-extfile','postgres.ext')
(root/'tls/ca.crt').chmod(0o644)
(root/'tls/postgres.crt').chmod(0o644)
origin = 'https://'+a.hostname
issuer = origin+'/identity/realms/opendoc'
owner = str(uuid.uuid4())
config = json.loads((deploy/'server.example.json').read_text())
config['server'] = {'mode':'proxy','publicOrigin':origin,'host':'0.0.0.0','port':8787,
                    'privateIngress':True,'shutdownTimeoutMs':10000}
config['database']['max'] = 4
config['activeTenantId'] = 'poc'
config['oidc'] = {'issuer':issuer,'clientId':'opendoc-web','clientSecretFile':'secrets/client-secret',
                  'authorizationEndpoint':issuer+'/protocol/openid-connect/auth',
                  'tokenEndpoint':issuer+'/protocol/openid-connect/token',
                  'jwksUri':issuer+'/protocol/openid-connect/certs'}
dump('server.json',config)
dump('owner-account.json',{'issuer':issuer,'subject':owner,'principalId':'poc-owner','tenantId':'poc','role':'editor'})
dump('realm/opendoc.json',{'realm':'opendoc','enabled':True,'sslRequired':'external',
     'registrationAllowed':False,'resetPasswordAllowed':False,'bruteForceProtected':True,
     'accessTokenLifespan':300,'ssoSessionIdleTimeout':1800,
     'clients':[{'clientId':'opendoc-web','enabled':True,'protocol':'openid-connect',
       'publicClient':False,'secret':passwords['client-secret'],'standardFlowEnabled':True,
       'directAccessGrantsEnabled':False,'serviceAccountsEnabled':False,
       'redirectUris':[origin+'/auth/callback'],'webOrigins':[origin],
       'attributes':{'pkce.code.challenge.method':'S256'}}],
     'users':[{'id':owner,'username':'poc-owner','enabled':True,
       'email':'poc-owner@example.invalid','firstName':'POC','lastName':'Owner',
       'credentials':[{'type':'password','value':passwords['owner-password'],'temporary':False}]}]})
write('keycloak.env', '\n'.join([
    'KC_DB=postgres', 'KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak?sslmode=verify-full&sslrootcert=/run/tls/ca.crt',
    'KC_DB_USERNAME=keycloak', 'KC_DB_PASSWORD='+passwords['keycloak-password'],
    'KC_HOSTNAME='+origin+'/identity', 'KC_HTTP_RELATIVE_PATH=/identity',
    'KC_HTTP_ENABLED=true','KC_PROXY_HEADERS=xforwarded', 'KC_HEALTH_ENABLED=true',
    'KC_DB_POOL_INITIAL_SIZE=1','KC_DB_POOL_MIN_SIZE=1','KC_DB_POOL_MAX_SIZE=5',
    'JAVA_OPTS_KC_HEAP=-Xms128m -Xmx384m','KC_CACHE=local','KC_LOG_LEVEL=warn'])+'\n')
write('keycloak-init.sh', '''#!/bin/sh
set -eu
password="$(cat /run/secrets/keycloak-password)"
case "$password" in ''|*[!0-9a-f]*) exit 1;; esac
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE keycloak LOGIN PASSWORD '$password';
CREATE DATABASE keycloak OWNER keycloak;
SQL
''')
def mount(src, dst):
    return str(root/src)+':'+dst+':ro'
appmounts = [mount('server.json','/run/opendoc/server.json'),mount('tls/ca.crt','/run/opendoc/tls/ca.crt')]
appmounts += [mount('secrets/'+n, '/run/opendoc/secrets/'+n) for n in ('runtime-password','auth-key','client-secret')]
app = {'image':'opendoc-poc:local','build':{'context':str(source),'dockerfile':'opendoc/Dockerfile'},
       'read_only':True,'tmpfs':['/tmp:size=32m'],'cap_drop':['ALL'],
       'security_opt':['no-new-privileges:true'],'mem_limit':'256m','pids_limit':128,
       'environment':{'NODE_OPTIONS':'--max-old-space-size=160'},
       'volumes':appmounts,'networks':['app','database'],
       'depends_on':{'postgres':{'condition':'service_healthy'}},
       'restart':'unless-stopped','stop_grace_period':'15s'}
admin = dict(app)
admin.update({'profiles':['admin'],'restart':'no','healthcheck':{'disable':True},
              'volumes':appmounts+[mount('secrets/admin-password','/run/opendoc/secrets/admin-password'),
                                    mount('owner-account.json','/run/opendoc/owner-account.json')]})
compose = {'name':'opendoc-poc','services':{
 'postgres':{'image':'postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536',
   'entrypoint':['/bin/sh','/reference/postgres-tls.sh'],
   'environment':{'POSTGRES_DB':'opendoc','POSTGRES_USER':'opendoc_admin',
                  'POSTGRES_PASSWORD_FILE':'/run/secrets/admin-password'},
   'volumes':['database:/var/lib/postgresql/data',
     mount('tls/postgres.crt','/run/tls/postgres.crt'),mount('tls/postgres.key','/run/tls/postgres.key'),
     mount('secrets/admin-password','/run/secrets/admin-password'),
     mount('secrets/runtime-password','/run/secrets/runtime-password'),
     mount('secrets/keycloak-password','/run/secrets/keycloak-password'),
     str(deploy/'postgres-tls.sh')+':/reference/postgres-tls.sh:ro',
     str(deploy/'postgres-runtime-role.sh')+':/docker-entrypoint-initdb.d/010-runtime-role.sh:ro',
     mount('keycloak-init.sh','/docker-entrypoint-initdb.d/020-keycloak.sh')],
   'mem_limit':'256m','shm_size':'64m','networks':['database'],'restart':'unless-stopped',
   'healthcheck':{'test':['CMD-SHELL','pg_isready -U opendoc_admin -d opendoc'],
                  'interval':'5s','timeout':'3s','retries':30}},
 'keycloak':{'image':'opendoc-keycloak:poc',
   'build':{'context':str(deploy/'lightsail'),'dockerfile':'Keycloak.Dockerfile'},
   'command':['start','--optimized','--import-realm'],
   'env_file':[str(root/'keycloak.env')],
   'volumes':[mount('realm/opendoc.json','/opt/keycloak/data/import/opendoc.json'),mount('tls/ca.crt','/run/tls/ca.crt')],
   'mem_limit':'768m','pids_limit':256,'networks':['identity','database'],'restart':'unless-stopped',
   'healthcheck':{'test':['CMD','bash','-ec',
       'exec 3<>/dev/tcp/127.0.0.1/9000; printf "GET /identity/health/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n" >&3; head -1 <&3 | grep -q " 200 "'],
       'interval':'10s','timeout':'5s','start_period':'90s','retries':12},
   'depends_on':{'postgres':{'condition':'service_healthy'}}},
 'app':app,'admin':admin,
 'caddy':{'image':'caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0','environment':{'OPENDOC_HOSTNAME':a.hostname},
   'ports':['80:80','443:443'],
   'volumes':[str(deploy/'lightsail/Caddyfile')+':/etc/caddy/Caddyfile:ro','caddy_data:/data','caddy_config:/config'],
   'depends_on':{'app':{'condition':'service_healthy'},'keycloak':{'condition':'service_healthy'}},
   'networks':['app','identity'],'mem_limit':'128m','pids_limit':128,'restart':'unless-stopped'}},
 'networks':{'app':{},'identity':{},'database':{'internal':True}},
 'volumes':{'database':{},'caddy_data':{},'caddy_config':{}}}
for service in compose['services'].values():
    service['logging']={'driver':'json-file','options':{'max-size':'5m','max-file':'2'}}
dump('compose.json',compose)
write('credentials.txt','URL: '+origin+'\nUsername: poc-owner\nPassword: '+passwords['owner-password']+'\n')
(root/'credentials.txt').chmod(0o600)
print('Prepared fresh private POC configuration. Credentials were written to credentials.txt, never stdout.')
