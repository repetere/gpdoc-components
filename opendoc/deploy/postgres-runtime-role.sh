#!/bin/sh
set -eu
# Fresh database initialization only. The generated password is hex, never argv.
runtime_password="$(cat /run/secrets/runtime-password)"
case "$runtime_password" in ''|*[!0-9a-f]*) exit 1;; esac
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE opendoc_runtime LOGIN PASSWORD '$runtime_password';
GRANT CONNECT ON DATABASE opendoc TO opendoc_runtime;
SQL
unset runtime_password
