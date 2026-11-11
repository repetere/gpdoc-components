import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import test from 'node:test';
import {
  DeploymentProfileError,
  validateDeploymentProfile,
  verifyDeploymentProfile,
} from '../src/profile.mjs';

const now = Date.parse('2026-11-11T12:00:00.000Z');
const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const header = { alg: 'EdDSA', typ: 'opendoc-profile+jws', kid: 'example-admin-1' };

function profile(patch = {}) {
  return {
    version: 1,
    deploymentId: 'example-deployment',
    tenantId: 'example-tenant',
    generation: 7,
    issuedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    endpoints: {
      api: 'https://docs.example.test/api',
      collaboration: 'wss://docs.example.test/collaboration',
    },
    identity: {
      issuer: 'https://identity.example.test/realms/example',
      audience: 'urn:example:opendoc:api',
      clientId: 'opendoc-public-client',
    },
    brand: { displayName: 'Example OpenDoc' },
    ...patch,
  };
}

function signed(payload = profile(), protectedHeader = header, privateKey = keys.privateKey) {
  const h = Buffer.from(typeof protectedHeader === 'string' ? protectedHeader : JSON.stringify(protectedHeader)).toString('base64url');
  const p = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  const input = `${h}.${p}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

function options(patch = {}) {
  return {
    trustedKeys: new Map([['example-admin-1', keys.publicKey]]),
    expectedDeploymentId: 'example-deployment',
    minGeneration: 7,
    now,
    ...patch,
  };
}

function rejects(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DeploymentProfileError);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

// @spec OD-PROFILE-SCHEMA: Closed, bounded, non-authorizing deployment metadata.
test('validation returns a detached frozen profile and defaults telemetry off', () => {
  const input = profile({ tenantHint: 'Example organization' });
  const result = validateDeploymentProfile(input, { now });
  assert.notEqual(input, result);
  assert.notEqual(input.identity, result.identity);
  assert.equal(result.telemetry, 'off');
  assert.equal(result.tenantHint, 'Example organization');
  assert.equal(result.identity.issuer, input.identity.issuer);
  assert.equal(result.identity.audience, 'urn:example:opendoc:api');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.endpoints));
  assert.ok(Object.isFrozen(result.identity));
  assert.ok(Object.isFrozen(result.brand));
  assert.equal(input.telemetry, undefined);
});

test('minimal profile needs no brand or tenant hint; explicit off is allowed', () => {
  const input = profile({ telemetry: 'off' });
  delete input.brand;
  const result = validateDeploymentProfile(input, { now: new Date(now) });
  assert.equal(result.brand, undefined);
  assert.equal(result.tenantHint, undefined);
});

test('the published example is valid only as unsigned illustrative data, not enrollment', () => {
  const text = fs.readFileSync(new URL('../examples/profile.json', import.meta.url), 'utf8');
  const example = validateDeploymentProfile(JSON.parse(text), { now });
  assert.match(example.tenantHint, /Unsigned example only; cannot enroll/);
  assert.equal(example.telemetry, 'off');
  rejects(() => verifyDeploymentProfile(text, options()), 'PROFILE_JWS_INVALID');
});

test('rejects unknown fields, credentials, and document or workspace authority', () => {
  for (const name of ['accessToken', 'clientSecret', 'password', 'documentId', 'workspaceId', 'permissions', 'signingKeys']) {
    rejects(() => validateDeploymentProfile(profile({ [name]: 'not-allowed' }), { now }));
  }
  for (const field of ['endpoints', 'identity', 'brand']) {
    const input = profile();
    input[field].secret = 'not-allowed';
    rejects(() => validateDeploymentProfile(input, { now }));
  }
});

test('rejects missing fields, unknown versions, and invalid identifiers', () => {
  for (const field of ['version', 'deploymentId', 'tenantId', 'generation', 'issuedAt', 'expiresAt', 'endpoints', 'identity']) {
    const input = profile();
    delete input[field];
    rejects(() => validateDeploymentProfile(input, { now }));
  }
  for (const version of [0, 2, '1', null]) {
    rejects(() => validateDeploymentProfile(profile({ version }), { now }));
  }
  for (const deploymentId of ['', '../escape', 'a'.repeat(129), 'with space', 7]) {
    rejects(() => validateDeploymentProfile(profile({ deploymentId }), { now }));
  }
  for (const generation of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, '7']) {
    rejects(() => validateDeploymentProfile(profile({ generation }), { now }));
  }
});

test('rejects unsupported endpoint schemes and URL credentials', () => {
  const badApi = [
    'http://docs.example.test/api', 'file:///api', 'javascript:alert(1)', '/api',
    'https://name:secret@docs.example.test/api', 'https://@docs.example.test/api',
    'https://docs.example.test/api?token=secret', 'https://docs.example.test/api?',
    'https://docs.example.test/api#secret', 'https://docs.example.test/api#',
    'https://docs.example.test\\@other.example.test/api',
    'https://docs.example.test/\napi', 'https://docs.example.test/a/../api',
    'https://docs.example.test/%', 'https://docs.example.test/%zz',
    'https://docs.example.test/%0aapi', 'https://docs.example.test/%5capi',
    'https://docs.example.test/' + 'x'.repeat(2048),
  ];
  for (const api of badApi) {
    const input = profile();
    input.endpoints.api = api;
    rejects(() => validateDeploymentProfile(input, { now }));
  }
  for (const collaboration of ['ws://docs.example.test/', 'https://docs.example.test/']) {
    const input = profile();
    input.endpoints.collaboration = collaboration;
    rejects(() => validateDeploymentProfile(input, { now }));
  }
});

test('identity supports issuer paths and opaque audience, but not secrets or URL credentials', () => {
  const input = profile();
  input.identity.issuer = 'https://identity.example.test/tenant/oauth2';
  input.identity.audience = 'opaque-api-audience';
  assert.equal(validateDeploymentProfile(input, { now }).identity.issuer, input.identity.issuer);
  for (const issuer of ['http://identity.example.test/tenant', 'https://user:password@identity.example.test/', 'https://identity.example.test/?secret=1']) {
    rejects(() => validateDeploymentProfile({ ...input, identity: { ...input.identity, issuer } }, { now }));
  }
  for (const audience of ['', 'with space', 'x'.repeat(257), ['api'], null]) {
    rejects(() => validateDeploymentProfile({ ...input, identity: { ...input.identity, audience } }, { now }));
  }
  for (const clientId of ['', '\n', 'x'.repeat(257), null]) {
    rejects(() => validateDeploymentProfile({ ...input, identity: { ...input.identity, clientId } }, { now }));
  }
});

test('brand is a plain display label; telemetry cannot be enabled in v1', () => {
  for (const brand of [{ html: '<b>Name</b>' }, { displayName: '<b>Name</b>' }, { displayName: '\u202EName' }, { displayName: '\uD800' }, { displayName: 'x'.repeat(81) }]) {
    rejects(() => validateDeploymentProfile(profile({ brand }), { now }));
  }
  for (const telemetry of ['on', true, { endpoint: 'https://collector.example.test' }]) {
    rejects(() => validateDeploymentProfile(profile({ telemetry }), { now }));
  }
});

test('rejects non-data objects, accessors, symbol fields and hostile prototypes without invoking getters', () => {
  for (const input of [null, [], new Date(), 'profile', 1]) {
    rejects(() => validateDeploymentProfile(input, { now }));
  }
  const withGetter = profile();
  let reads = 0;
  Object.defineProperty(withGetter, 'tenantId', { get() { reads += 1; return 'tenant'; }, enumerable: true });
  rejects(() => validateDeploymentProfile(withGetter, { now }));
  assert.equal(reads, 0);
  const nonEnumerable = profile();
  Object.defineProperty(nonEnumerable, 'secret', { value: 'hidden' });
  rejects(() => validateDeploymentProfile(nonEnumerable, { now }));
  const symbol = profile();
  symbol[Symbol('secret')] = 'hidden';
  rejects(() => validateDeploymentProfile(symbol, { now }));
  const inherited = Object.assign(Object.create({ secret: 'hidden' }), profile());
  rejects(() => validateDeploymentProfile(inherited, { now }));
  assert.equal(validateDeploymentProfile(Object.assign(Object.create(null), profile()), { now }).version, 1);
});

// @spec OD-PROFILE-TIME: No expiration or issue-time grace window.
test('time bounds reject expired and not-yet-valid profiles, including exact expiry', () => {
  rejects(() => validateDeploymentProfile(profile(), { now: Date.parse('2026-12-01T00:00:00.000Z') }), 'PROFILE_EXPIRED');
  rejects(() => validateDeploymentProfile(profile(), { now: Date.parse('2026-10-31T23:59:59.999Z') }), 'PROFILE_NOT_YET_VALID');
  assert.equal(validateDeploymentProfile(profile(), { now: Date.parse('2026-11-01T00:00:00.000Z') }).generation, 7);
});

test('dates must be real UTC instants and expiry must follow issue time', () => {
  for (const issuedAt of ['2026-02-30T00:00:00.000Z', '2026-11-01', '2026-11-01T00:00:00+00:00', '2026-11-01T24:00:00.000Z', '2026-11-01T00:00:60.000Z', 1]) {
    rejects(() => validateDeploymentProfile(profile({ issuedAt }), { now }));
  }
  for (const expiresAt of ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z']) {
    rejects(() => validateDeploymentProfile(profile({ expiresAt }), { now }));
  }
  assert.equal(validateDeploymentProfile(profile({ issuedAt: '2026-11-01T00:00:00Z' }), { now }).version, 1);
  for (const badNow of [NaN, Infinity, -1, 'today', new Date(NaN)]) {
    rejects(() => validateDeploymentProfile(profile(), { now: badNow }));
  }
});

// @spec OD-PROFILE-SIGNATURE: External trust anchors; EdDSA/Ed25519 only.
test('verifies a signed profile using an administrator-supplied public key', () => {
  const result = verifyDeploymentProfile(signed(), options());
  assert.equal(result.deploymentId, 'example-deployment');
  assert.equal(result.telemetry, 'off');
  assert.ok(Object.isFrozen(result));
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifyDeploymentProfile(signed(), options({ trustedKeys: { 'example-admin-1': pem } })).generation, 7);
});

test('rejects payload tampering and a different signer', () => {
  const token = signed().split('.');
  token[1] = Buffer.from(JSON.stringify(profile({ tenantId: 'other-tenant' }))).toString('base64url');
  rejects(() => verifyDeploymentProfile(token.join('.'), options()), 'PROFILE_SIGNATURE_INVALID');
  rejects(() => verifyDeploymentProfile(signed(profile(), header, otherKeys.privateKey), options()), 'PROFILE_SIGNATURE_INVALID');
});

test('rejects unsigned JSON, unsecured tokens and every non-allowlisted header', () => {
  rejects(() => verifyDeploymentProfile(JSON.stringify(profile()), options()));
  for (const badHeader of [
    { ...header, alg: 'none' }, { ...header, alg: 'HS256' }, { ...header, typ: 'JWT' },
    { ...header, jwk: {} }, { ...header, jku: 'https://example.test/key' },
    { ...header, x5u: 'https://example.test/cert' }, { ...header, crit: [] },
    { ...header, b64: false }, { ...header, kid: '../key' }, { alg: 'EdDSA', kid: header.kid },
  ]) {
    rejects(() => verifyDeploymentProfile(signed(profile(), badHeader), options()));
  }
});

test('rejects unknown keys, private keys, non-Ed25519 keys and malformed trust stores', () => {
  rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys: {} })), 'PROFILE_KEY_UNTRUSTED');
  rejects(() => verifyDeploymentProfile(signed(profile(), { ...header, kid: 'unknown' }), options()), 'PROFILE_KEY_UNTRUSTED');
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ed448 = generateKeyPairSync('ed448');
  for (const key of [keys.privateKey, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), ec.publicKey, ed448.publicKey, 'path/to/key.pem', '-----BEGIN PUBLIC KEY-----\nAA==\n-----END PUBLIC KEY-----\n', {}, null]) {
    rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys: { [header.kid]: key } })), 'PROFILE_TRUST_INVALID');
  }
  rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys: null })), 'PROFILE_TRUST_INVALID');
  const getters = {};
  Object.defineProperty(getters, header.kid, { get() { throw new Error('Must not run'); }, enumerable: true });
  rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys: getters })), 'PROFILE_TRUST_INVALID');
});

test('bounds trust-store size and rejects hidden or invalid trust entries', () => {
  const many = Array.from({ length: 33 }, (_, index) => [`key-${index}`, keys.publicKey]);
  for (const trustedKeys of [new Map(many), Object.fromEntries(many), { '../key': keys.publicKey }]) {
    rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys })), 'PROFILE_TRUST_INVALID');
  }
  const hidden = { [header.kid]: keys.publicKey, [Symbol('key')]: keys.publicKey };
  rejects(() => verifyDeploymentProfile(signed(), options({ trustedKeys: hidden })), 'PROFILE_TRUST_INVALID');
});

// @spec OD-PROFILE-BINDING: Deployment binding and caller-owned rollback floor.
test('requires deployment binding and rejects stale generations', () => {
  rejects(() => verifyDeploymentProfile(signed(), options({ expectedDeploymentId: 'other-deployment' })), 'PROFILE_DEPLOYMENT_MISMATCH');
  rejects(() => verifyDeploymentProfile(signed(), options({ expectedDeploymentId: undefined })));
  rejects(() => verifyDeploymentProfile(signed(), options({ minGeneration: 8 })), 'PROFILE_GENERATION_STALE');
  rejects(() => verifyDeploymentProfile(signed(), options({ minGeneration: -1 })));
  assert.equal(verifyDeploymentProfile(signed(), options({ minGeneration: 7 })).generation, 7);
  assert.equal(verifyDeploymentProfile(signed(), options({ minGeneration: undefined })).generation, 7);
});

test('a valid signature does not bypass schema or time validation', () => {
  rejects(() => verifyDeploymentProfile(signed(profile({ accessToken: 'secret' })), options()));
  rejects(() => verifyDeploymentProfile(signed(), options({ now: Date.parse('2027-01-01T00:00:00Z') })), 'PROFILE_EXPIRED');
  rejects(() => verifyDeploymentProfile(signed(), options({ now: Date.parse('2026-01-01T00:00:00Z') })), 'PROFILE_NOT_YET_VALID');
});

// @spec OD-PROFILE-ENCODING: Compact normalized JSON and strict base64url.
test('rejects duplicate keys, whitespace and non-normalized JSON in signed data', () => {
  const json = JSON.stringify(profile());
  for (const payload of [
    json.replace('"version":1', '"version":1,"version":1'),
    json.replace('"tenantId":"example-tenant"', '"tenantId":"example-tenant","tenantId":"other"'),
    json.replace('"displayName":"Example OpenDoc"', '"displayName":"Example OpenDoc","displayName":"Example OpenDoc"'),
    ` ${json}`, JSON.stringify(profile(), null, 2),
    json.replace('"version":1', '"version":1.0'),
    json.replace('"version"', '"ver\\u0073ion"'),
  ]) {
    rejects(() => verifyDeploymentProfile(signed(payload), options()), 'PROFILE_JWS_INVALID');
  }
  const duplicateHeader = '{"alg":"EdDSA","alg":"EdDSA","typ":"opendoc-profile+jws","kid":"example-admin-1"}';
  rejects(() => verifyDeploymentProfile(signed(profile(), duplicateHeader), options()), 'PROFILE_JWS_INVALID');
});

test('compact member order is flexible, while nested escaped duplicates are rejected', () => {
  const reordered = Object.fromEntries(Object.entries(profile()).reverse());
  const reorderedHeader = { kid: header.kid, typ: header.typ, alg: header.alg };
  assert.equal(verifyDeploymentProfile(signed(reordered, reorderedHeader), options()).version, 1);
  const json = JSON.stringify(profile()).replace('"clientId":"opendoc-public-client"', '"clientId":"opendoc-public-client","client\\u0049d":"other"');
  rejects(() => verifyDeploymentProfile(signed(json), options()), 'PROFILE_JWS_INVALID');
});

test('rejects malformed, oversized and noncanonical JWS segments', () => {
  for (const token of [null, '', '.', '..', 'a.b.c.d', 'a'.repeat(16385), `${signed()}\n`]) {
    rejects(() => verifyDeploymentProfile(token, options()));
  }
  const valid = signed().split('.');
  for (const replacement of ['', 'AA==', 'A', '+/8', 'a'.repeat(12000)]) {
    const parts = [...valid];
    parts[1] = replacement;
    rejects(() => verifyDeploymentProfile(parts.join('.'), options()));
  }
  const shortSignature = [...valid];
  shortSignature[2] = Buffer.alloc(63).toString('base64url');
  rejects(() => verifyDeploymentProfile(shortSignature.join('.'), options()));
  const badBits = [...valid];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = badBits[2].at(-1);
  badBits[2] = badBits[2].slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
  rejects(() => verifyDeploymentProfile(badBits.join('.'), options()));
});

test('rejects invalid UTF-8 and malformed JSON even when signed by a trusted key', () => {
  for (const payload of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('\uFEFF{}'), Buffer.from('null')]) {
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload.toString('base64url')}`;
    const token = `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`;
    rejects(() => verifyDeploymentProfile(token, options()));
  }
});

test('unknown options fail closed rather than silently omitting security checks', () => {
  rejects(() => verifyDeploymentProfile(signed(), { ...options(), minimumGeneration: 99 }));
  rejects(() => validateDeploymentProfile(profile(), { now, allowExpired: true }));
});

// @spec OD-PROFILE-LOCAL: Validation and verification do not read files or contact servers.
test('validation and verification have no filesystem or network side effects', (t) => {
  const token = signed();
  let calls = 0;
  const blocked = () => { calls += 1; throw new Error('Unexpected I/O'); };
  for (const method of ['readFileSync', 'writeFileSync', 'openSync', 'readFile', 'writeFile', 'open']) t.mock.method(fs, method, blocked);
  for (const method of ['readFile', 'writeFile', 'open']) t.mock.method(fsPromises, method, blocked);
  for (const module of [http, https]) {
    for (const method of ['request', 'get']) t.mock.method(module, method, blocked);
  }
  for (const method of ['connect', 'createConnection']) t.mock.method(net, method, blocked);
  t.mock.method(tls, 'connect', blocked);
  for (const method of ['lookup', 'resolve']) t.mock.method(dns, method, blocked);
  t.mock.method(globalThis, 'fetch', blocked);
  if (typeof globalThis.WebSocket === 'function') t.mock.method(globalThis, 'WebSocket', blocked);
  assert.equal(validateDeploymentProfile(profile(), { now }).version, 1);
  assert.equal(verifyDeploymentProfile(token, options()).version, 1);
  rejects(() => verifyDeploymentProfile(signed(profile(), { ...header, jku: 'https://example.test/keys' }), options()));
  assert.equal(calls, 0);
});
