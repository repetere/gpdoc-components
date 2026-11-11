import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompactSign, SignJWT, UnsecuredJWT, errors, exportJWK, exportSPKI, generateKeyPair } from 'jose';
import { createAccessTokenAuthenticator } from '../src/access-token-auth.mjs';
import { createOpenDocHandler } from '../src/api.mjs';
import { MemoryDocumentStore } from '../src/memory-store.mjs';

// Only synthetic, freshly generated keys and identities are used in these tests.
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const otherKey = await generateKeyPair('RS256', { extractable: true });
const key = { ...await exportJWK(publicKey), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
const otherPublicKey = { ...await exportJWK(otherKey.publicKey), kid: 'test-key-2', alg: 'RS256', use: 'sig' };
const issuer = 'https://issuer.example.test';
const audience = 'https://opendoc.example.test/api';
const subject = 'external-provider|synthetic-user';
const member = { principalId: 'internal-user', tenantId: 'tenant.example', role: 'editor' };
const seconds = () => Math.floor(Date.now() / 1000);
const payload = () => ({ iss: issuer, aud: audience, sub: subject, iat: seconds() - 10, exp: seconds() + 300 });
const header = () => ({ alg: 'RS256', typ: 'at+jwt', kid: key.kid });
const config = (overrides = {}) => ({
  issuer, audience, algorithms: ['RS256'], jwks: { keys: [key] }, activeTenantId: member.tenantId,
  resolveMembership: async () => ({ ...member }), ...overrides
});
const sign = (claims = payload(), protectedHeader = header(), signingKey = privateKey) => new SignJWT(claims).setProtectedHeader(protectedHeader).sign(signingKey);
const request = (token, url = 'https://opendoc.example.test/api/v1/session', otherHeaders = {}) => new Request(url, {
  headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...otherHeaders }
});

// @spec OD-AUTH-001, OD-AUTH-002
test('valid access tokens resolve only issuer/subject and the server-selected active tenant', async () => {
  const lookups = [];
  const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async identity => { lookups.push(identity); return { ...member, secret: 'never-return' }; } }));
  assert.deepEqual(await authenticate(request(await sign())), member);
  assert.deepEqual(lookups, [{ issuer, subject, activeTenantId: member.tenantId }]);
  assert.equal(Object.isFrozen(lookups[0]), true);
  const multiAudience = await sign({ ...payload(), aud: ['other-resource', audience] });
  assert.deepEqual(await authenticate(request(multiAudience)), member);
});

// @spec OD-AUTH-001
test('tampered claims, wrong signatures and unsigned tokens fail before membership lookup', async () => {
  let calls = 0;
  const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async () => { calls++; return member; } }));
  const original = await sign();
  const parts = original.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...payload(), sub: 'attacker' })).toString('base64url');
  const invalid = [parts.join('.'), await sign(payload(), header(), otherKey.privateKey), new UnsecuredJWT(payload()).encode()];
  for (const token of invalid) assert.equal(await authenticate(request(token)), null);
  assert.equal(calls, 0);
});

// @spec OD-AUTH-001
test('HS256 with the RSA public key as secret cannot cause algorithm confusion', async () => {
  const forged = await new SignJWT(payload()).setProtectedHeader({ ...header(), alg: 'HS256' }).sign(new TextEncoder().encode(await exportSPKI(publicKey)));
  assert.equal(await createAccessTokenAuthenticator(config())(request(forged)), null);
});

// @spec OD-AUTH-001, OD-AUTH-003
test('ID tokens, unknown or missing key IDs, and unsupported header extensions fail closed', async t => {
  const authenticate = createAccessTokenAuthenticator(config());
  for (const change of [
    { typ: 'JWT' }, { typ: undefined }, { typ: 'application/at+jwt' }, { typ: 'AT+JWT' },
    { kid: 'unknown' }, { kid: undefined }, { kid: 'https://keys.example.test/key' },
    { jku: 'https://keys.example.test/jwks' }, { x5u: 'https://keys.example.test/cert' },
    { jwk: key }, { x5c: ['ignored-certificate'] }, { extra: true }
  ]) {
    await t.test(JSON.stringify(change), async () => {
      assert.equal(await authenticate(request(await sign(payload(), { ...header(), ...change }))), null);
    });
  }
});

// @spec OD-AUTH-001
test('issuer, audience, expiry, not-before and future issued-at are validated', async t => {
  const now = seconds();
  const authenticate = createAccessTokenAuthenticator(config());
  for (const change of [
    { iss: 'https://other-issuer.example.test' }, { aud: 'other-resource' }, { aud: [] },
    { aud: [audience, 42] }, { exp: now - 1 }, { nbf: now + 60 }, { iat: now + 60 },
    { iat: now - 3601, exp: now + 60 }, { iat: now - 20, exp: now - 30 }
  ]) {
    await t.test(JSON.stringify(change), async () => {
      assert.equal(await authenticate(request(await sign({ ...payload(), ...change }))), null);
    });
  }
});

// @spec OD-AUTH-001
test('required claims and invalid subject/temporal claim types are rejected', async t => {
  const authenticate = createAccessTokenAuthenticator(config());
  for (const name of ['iss', 'aud', 'sub', 'iat', 'exp']) {
    await t.test(`missing ${name}`, async () => {
      const claims = payload(); delete claims[name];
      assert.equal(await authenticate(request(await sign(claims))), null);
    });
  }
  for (const change of [
    { sub: '' }, { sub: ' ' }, { sub: '\n' }, { sub: ['user'] }, { sub: 's'.repeat(513) },
    { iat: '123' }, { iat: seconds() - 0.5 }, { iat: -1 },
    { exp: '9999999999' }, { exp: null }, { exp: seconds() + 0.5 }, { exp: Number.MAX_SAFE_INTEGER },
    { exp: 1e200 }, { iat: 1e200 }, { nbf: 1e200 }, { nbf: seconds() - 0.5 }, { nbf: -1 }
  ]) {
    await t.test(JSON.stringify(change), async () => {
      assert.equal(await authenticate(request(await sign({ ...payload(), ...change }))), null);
    });
  }
});

// @spec OD-AUTH-001
test('signed JSON numeric overflow cannot create an immortal token', async () => {
  const authenticate = createAccessTokenAuthenticator(config());
  for (const claim of ['exp', 'iat', 'nbf']) {
    const claims = { ...payload(), [claim]: 'numeric-overflow-placeholder' };
    const raw = JSON.stringify(claims).replace('"numeric-overflow-placeholder"', '1e999');
    const token = await new CompactSign(new TextEncoder().encode(raw)).setProtectedHeader(header()).sign(privateKey);
    assert.equal(await authenticate(request(token)), null);
  }
});

// @spec OD-AUTH-001
test('malformed signed claim sets and invalid signature encodings are credentials failures', async () => {
  const authenticate = createAccessTokenAuthenticator(config());
  for (const raw of ['null', '[]', 'true', '"claims"', '{bad', new Uint8Array([0xff])]) {
    const token = await new CompactSign(typeof raw === 'string' ? new TextEncoder().encode(raw) : raw).setProtectedHeader(header()).sign(privateKey);
    assert.equal(await authenticate(request(token)), null);
  }
  const valid = await sign();
  const [protectedHeader, claims] = valid.split('.');
  assert.equal(await authenticate(request(`${protectedHeader}.${claims}.A`)), null);
  assert.equal(await authenticate(request(`${protectedHeader}.A.AA`)), null);
});

// @spec OD-AUTH-001
test('max token age also bounds issued lifetime and clock tolerance is explicit', async () => {
  const now = seconds();
  const authenticate = createAccessTokenAuthenticator(config({ maxTokenAgeSeconds: 60 }));
  assert.equal(await authenticate(request(await sign({ ...payload(), iat: now - 10, exp: now + 51 }))), null);
  assert.equal(await authenticate(request(await sign({ ...payload(), iat: now - 61, exp: now - 1 }))), null);
  assert.deepEqual(await authenticate(request(await sign({ ...payload(), iat: now - 10, exp: now + 40 }))), member);
  const tolerant = createAccessTokenAuthenticator(config({ maxTokenAgeSeconds: 60, clockToleranceSeconds: 10 }));
  assert.deepEqual(await tolerant(request(await sign({ ...payload(), iat: now + 5, nbf: now + 5, exp: now + 40 }))), member);
  assert.equal(await tolerant(request(await sign({ ...payload(), iat: now + 30, exp: now + 40 }))), null);
});

// @spec OD-AUTH-001, OD-AUTH-003
test('missing, malformed, multiple, URL-carried and oversized credentials never authenticate', async () => {
  const authenticate = createAccessTokenAuthenticator(config());
  const token = await sign();
  for (const authorization of ['', 'Basic abc', 'Bearer', 'Bearer bad', `Bearer ${token}, Bearer ${token}`, `Bearer  ${token}`, `Bearer ${'a'.repeat(8193)}`, 'Bearer e30.e30.@@@']) {
    assert.equal(await authenticate(request(undefined, undefined, { authorization })), null);
  }
  for (const malformed of ['a.b.c', 'e30.e30.AA', 'bnVsbA.e30.AA', 'W10.e30.AA']) assert.equal(await authenticate(request(malformed)), null);
  assert.equal(await authenticate(request()), null);
  for (const suffix of [`?access_token=${token}`, `?token=${token}`, '#access_token=hidden']) {
    assert.equal(await authenticate(request(token, `https://opendoc.example.test/api/v1/session${suffix}`)), null);
    assert.equal(await authenticate(request(undefined, `https://opendoc.example.test/api/v1/session${suffix}`)), null);
  }
  const large = await sign({ ...payload(), padding: 'x'.repeat(9000) });
  assert.equal(await authenticate(request(large)), null);
});

// @spec OD-AUTH-002
test('token roles and tenants never grant membership or become resolver inputs', async () => {
  const malicious = await sign({ ...payload(), role: 'owner', roles: ['owner'], tenantId: 'victim', tenant: 'victim', groups: ['admins'], principalId: 'admin', scope: 'all' });
  let received;
  const viewer = { ...member, role: 'viewer' };
  const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async input => { received = input; return viewer; } }));
  assert.deepEqual(await authenticate(request(malicious)), viewer);
  assert.deepEqual(received, { issuer, subject, activeTenantId: member.tenantId });
  const denied = createAccessTokenAuthenticator(config({ resolveMembership: async () => null }));
  assert.equal(await denied(request(malicious)), null);
  const handle = createOpenDocHandler({ authenticate, store: new MemoryDocumentStore() });
  const response = await handle(new Request('https://opendoc.example.test/api/v1/documents', {
    method: 'POST', headers: { authorization: `Bearer ${malicious}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'test', title: 'Test', content: 'Synthetic' })
  }));
  assert.equal(response.status, 403);
});

// @spec OD-AUTH-002
test('denied, malformed and wrong-tenant membership results fail closed', async () => {
  const token = await sign();
  for (const membership of [null, undefined, false, [], {}, { ...member, tenantId: 'other' }, { ...member, role: 'admin' }, { ...member, principalId: '' }, { ...member, principalId: subject }]) {
    const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async () => membership }));
    assert.equal(await authenticate(request(token)), null);
  }
  for (const role of ['owner', 'editor', 'viewer', 'commenter']) {
    const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async () => ({ ...member, role }) }));
    assert.deepEqual(await authenticate(request(token)), { ...member, role });
  }
});

// @spec OD-AUTH-004
test('membership outages propagate and the API returns a sanitized 503, not 401', async () => {
  const token = await sign();
  // Even a JOSE-shaped resolver error belongs to the dependency, not the token.
  for (const outage of [new Error('database-password-do-not-leak'), new errors.JWTExpired('dependency-secret-do-not-leak', {})]) {
    const authenticate = createAccessTokenAuthenticator(config({ resolveMembership: async () => { throw outage; } }));
    await assert.rejects(authenticate(request(token)), error => error === outage);
    const handle = createOpenDocHandler({ authenticate, store: new MemoryDocumentStore() });
    const response = await handle(request(token));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service dependency unavailable.' } });
  }
});

// @spec OD-AUTH-004
test('a key/runtime verification TypeError is not swallowed as a credential rejection', async () => {
  // This passes the bounded structural schema but jose rejects its zero-bit RSA
  // modulus. Operator key failures must remain distinct from bad credentials.
  const authenticate = createAccessTokenAuthenticator(config({ jwks: { keys: [{ ...key, n: 'A'.repeat(342) }] } }));
  const token = await sign();
  await assert.rejects(authenticate(request(token)), TypeError);
  const handle = createOpenDocHandler({ authenticate, store: new MemoryDocumentStore() });
  const response = await handle(request(token));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service dependency unavailable.' } });
});

// @spec OD-AUTH-001, OD-AUTH-004
test('invalid credentials receive a generic API 401 without token details', async () => {
  const authenticate = createAccessTokenAuthenticator(config());
  const handle = createOpenDocHandler({ authenticate, store: new MemoryDocumentStore() });
  const response = await handle(request(await sign({ ...payload(), iss: 'https://untrusted.example.test' })));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(await response.json(), { error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
});

// @spec OD-AUTH-003
test('local keys are snapshotted and administrator replacement controls rotation', async () => {
  const supplied = { keys: [{ ...key }] };
  const authenticate = createAccessTokenAuthenticator(config({ jwks: supplied }));
  supplied.keys[0].kid = 'modified';
  supplied.keys.push(otherPublicKey);
  assert.deepEqual(await authenticate(request(await sign())), member);
  const rotatedToken = await sign(payload(), { ...header(), kid: otherPublicKey.kid }, otherKey.privateKey);
  assert.equal(await authenticate(request(rotatedToken)), null);
  const overlap = createAccessTokenAuthenticator(config({ jwks: { keys: [key, otherPublicKey] } }));
  assert.deepEqual(await overlap(request(rotatedToken)), member);
  assert.deepEqual(await overlap(request(await sign())), member);
  const replacement = createAccessTokenAuthenticator(config({ jwks: { keys: [otherPublicKey] } }));
  assert.equal(await replacement(request(await sign())), null);
  assert.deepEqual(await replacement(request(rotatedToken)), member);
});

// @spec OD-AUTH-003
test('untrusted key URL headers are rejected without any fetch', async () => {
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('Network must not be used'); };
  try {
    const authenticate = createAccessTokenAuthenticator(config());
    assert.deepEqual(await authenticate(request(await sign())), member);
    assert.equal(await authenticate(request(await sign(payload(), { ...header(), jku: 'https://attacker.example.test/jwks' }))), null);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = savedFetch; }
});

// @spec OD-AUTH-003
test('unsafe, incomplete or remote trust configuration fails during construction', async () => {
  const privateJwk = await exportJWK(privateKey);
  const configurations = [
    { issuer: '' }, { audience: '' }, { algorithms: undefined }, { algorithms: ['HS256'] }, { algorithms: ['RS256', 'RS512'] },
    { activeTenantId: '../victim' }, { resolveMembership: null }, { jwks: 'https://keys.example.test/jwks' },
    { jwks: { keys: [] } }, { jwks: { keys: [key, key] } }, { jwks: { keys: Array(33).fill(key) } },
    { jwks: { keys: [key], url: 'https://keys.example.test/jwks' } },
    ...[{ kid: undefined }, { kty: 'oct' }, { alg: 'HS256' }, { use: 'enc' }, { key_ops: ['sign', 'verify'] }, { n: 'bad' }, { e: '=' }, { x5u: 'https://keys.example.test/cert' }, privateJwk].map(change => ({ jwks: { keys: [{ ...key, ...change }] } })),
    { maxTokenBytes: 1 }, { maxTokenBytes: 16385 }, { maxTokenAgeSeconds: 0 }, { maxTokenAgeSeconds: Infinity },
    { maxTokenAgeSeconds: 86401 }, { clockToleranceSeconds: -1 }, { clockToleranceSeconds: 61 }
  ];
  for (const change of configurations) assert.throws(() => createAccessTokenAuthenticator(config(change)), TypeError);
  assert.throws(() => createAccessTokenAuthenticator(), TypeError);
});
