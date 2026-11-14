#!/bin/sh
set -eu
mkdir -p /tmp/opendoc-pg-tls
cp /run/tls/postgres.crt /tmp/opendoc-pg-tls/server.crt
cp /run/tls/postgres.key /tmp/opendoc-pg-tls/server.key
chown -R postgres:postgres /tmp/opendoc-pg-tls
chmod 600 /tmp/opendoc-pg-tls/server.key
exec /usr/local/bin/docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/opendoc-pg-tls/server.crt -c ssl_key_file=/tmp/opendoc-pg-tls/server.key
