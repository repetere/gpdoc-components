// Synthetic integration-only database contract. No ambient pg configuration.
import assert from 'node:assert/strict';
import { isIP } from 'node:net';
export const TEST_DATABASE_URL = 'postgres://opendoc_test:synthetic-test-only@127.0.0.1:55432/opendoc_test';
export const TEST_CI_DATABASE_URL = 'postgres://opendoc_test:synthetic-test-only@127.0.0.1:5432/opendoc_test';
export const TEST_ISSUER = 'https://shared-live-sync.example.test';
export const TEST_ORIGIN = 'https://example.test';
export function testDatabaseConfig(raw) {
  if (raw !== TEST_DATABASE_URL && raw !== TEST_CI_DATABASE_URL) throw new Error('Only an exact synthetic loopback PostgreSQL test target is permitted');
  return { host: '127.0.0.1', port: raw === TEST_CI_DATABASE_URL ? 5432 : 55432, user: 'opendoc_test', password: 'synthetic-test-only', database: 'opendoc_test', ssl: false,
    options: '-c search_path=pg_catalog', application_name: 'opendoc-shared-live-synthetic-integration', max: 3,
    connectionTimeoutMillis: 3000, query_timeout: 10000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 };
}
export function expectedServerAddresses(raw) {
  if (raw === undefined) return ['127.0.0.1', '::1'];
  if (typeof raw !== 'string' || !isIP(raw) || raw.includes('%')) throw new Error('Expected PostgreSQL address must be one exact IP');
  return [raw];
}
export function testDatabaseChildEnvironment(raw, expectedAddress) {
  testDatabaseConfig(raw); expectedServerAddresses(expectedAddress);
  return { OPENDOC_PG_INTEGRATION: '1', DATABASE_URL: raw,
    ...(expectedAddress === undefined ? {} : { OPENDOC_PG_EXPECTED_SERVER_ADDRESS: expectedAddress }) };
}
export async function verifyTestDatabase(pool, expectedAddress) {
  const result = await pool.query('SELECT current_database() AS database, current_user AS username, host(inet_server_addr()) AS address, pg_backend_pid() AS pid');
  const identity = result.rows[0];
  assert.equal(identity.database, 'opendoc_test'); assert.equal(identity.username, 'opendoc_test');
  assert.ok(expectedServerAddresses(expectedAddress).includes(identity.address), 'Must connect to the expected synthetic PostgreSQL server');
  return identity;
}
