// Synthetic configuration for server tests only.
export function configuration() {
  return { version: 1, server: { mode: 'development', publicOrigin: 'http://127.0.0.1:8787', host: '127.0.0.1', port: 8787 },
    database: { host: '127.0.0.1', port: 55432, database: 'opendoc_test', user: 'opendoc_test', passwordFile: 'db-secret', tls: 'disable' },
    schemas: { accounts: 'server_accounts', documents: 'server_documents', live: 'server_live', sessions: 'server_sessions' },
    activeTenantId: 'test-team', authKeyFile: 'auth-key',
    oidc: { issuer: 'http://127.0.0.1:9999', clientId: 'synthetic-client', clientSecretFile: 'client-secret',
      authorizationEndpoint: 'http://127.0.0.1:9999/auth', tokenEndpoint: 'http://127.0.0.1:9999/token', jwksUri: 'http://127.0.0.1:9999/jwks' } };
}
