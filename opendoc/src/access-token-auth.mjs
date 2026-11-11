// Original OpenDoc authentication adapter. Cryptography is delegated to jose.
// This module performs no network or filesystem access.
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const BASE64URL = /^[a-zA-Z0-9_-]+$/;
const COMPACT_JWT = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;
const ROLES = new Set(['owner', 'editor', 'viewer', 'commenter']);
const HEADER_FIELDS = new Set(['alg', 'typ', 'kid']);
const KEY_FIELDS = new Set(['kty', 'kid', 'n', 'e', 'alg', 'use', 'key_ops', 'ext']);
const INVALID_TOKEN_ERRORS = [
  errors.JWTExpired, errors.JWTClaimValidationFailed, errors.JWTInvalid,
  errors.JWSInvalid, errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed, errors.JWKSNoMatchingKey
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function boundedString(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function integerOption(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
}
function localKeys(jwks) {
  if (!plainObject(jwks) || Object.keys(jwks).some(k => k !== 'keys') || !Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 32) {
    throw new TypeError('A bounded administrator-pinned local JWKS is required');
  }
  const seen = new Set();
  return { keys: jwks.keys.map(key => {
    if (!plainObject(key) || Object.keys(key).some(k => !KEY_FIELDS.has(k)) || key.kty !== 'RSA' ||
      typeof key.kid !== 'string' || !KEY_ID.test(key.kid) || seen.has(key.kid) ||
      typeof key.n !== 'string' || !BASE64URL.test(key.n) || key.n.length < 342 || key.n.length > 1366 ||
      typeof key.e !== 'string' || !BASE64URL.test(key.e) || key.e.length > 16 ||
      (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig') ||
      (key.ext !== undefined && typeof key.ext !== 'boolean') ||
      (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) {
      throw new TypeError('Local JWKS requires distinct public RSA verification keys');
    }
    seen.add(key.kid);
    // Copy the narrow public material. A later mutation of host config cannot
    // change the trust policy or add private keys/remote key locations.
    return { kty: 'RSA', kid: key.kid, n: key.n, e: key.e, alg: 'RS256', use: 'sig', key_ops: ['verify'] };
  }) };
}
function numericDate(value) { return Number.isSafeInteger(value) && value >= 0; }

/**
 * Verify a narrowly supported JWT access token, then consult trusted membership.
 * issuer/audience/keys/activeTenantId are SERVER configuration, never client input.
 * resolveMembership({ issuer, subject, activeTenantId }) must return an internal
 * { principalId, tenantId, role } or null. It receives no token roles/tenant claims.
 * Invalid credentials return null; operational/resolver errors are not swallowed.
 */
export function createAccessTokenAuthenticator({
  issuer, audience, algorithms, jwks, activeTenantId, resolveMembership,
  maxTokenBytes = 8192, maxTokenAgeSeconds = 3600, clockToleranceSeconds = 0
} = {}) {
  if (!boundedString(issuer, 2048) || !boundedString(audience, 2048)) throw new TypeError('Explicit issuer and audience are required');
  if (!Array.isArray(algorithms) || algorithms.length !== 1 || algorithms[0] !== 'RS256') throw new TypeError('Explicit RS256-only algorithm policy required');
  if (typeof activeTenantId !== 'string' || !TENANT_ID.test(activeTenantId)) throw new TypeError('A server-configured active tenant is required');
  if (typeof resolveMembership !== 'function') throw new TypeError('A trusted membership resolver is required');
  integerOption(maxTokenBytes, 1024, 16384, 'maxTokenBytes');
  integerOption(maxTokenAgeSeconds, 1, 86400, 'maxTokenAgeSeconds');
  integerOption(clockToleranceSeconds, 0, 60, 'clockToleranceSeconds');
  const verifyKey = createLocalJWKSet(localKeys(jwks));

  return async function authenticate(request) {
    // This adapter intentionally accepts credentials only in Authorization.
    // Match the API's URL policy even when used outside createOpenDocHandler.
    const url = new URL(request.url);
    if (url.search || url.hash || url.username || url.password) return null;
    const authorization = request.headers.get('authorization');
    if (typeof authorization !== 'string' || authorization.length > maxTokenBytes + 7) return null;
    const match = /^Bearer (\S+)$/i.exec(authorization);
    if (!match || !COMPACT_JWT.test(match[1])) return null;
    const token = match[1]; // ASCII compact tokens: character length equals bytes.
    let header;
    try { header = decodeProtectedHeader(token); } catch (error) {
      // jose's decode-only helper uses TypeError for malformed JSON/base64url.
      // Keep this catch separate from key imports and signature verification.
      if (error instanceof TypeError) return null;
      throw error;
    }
    // Unverified fields are used only to reject inputs, never to grant access
    // or choose a URL. ID tokens, remote/embedded keys and JOSE extensions fail.
    if (Object.keys(header).some(k => !HEADER_FIELDS.has(k)) || header.alg !== 'RS256' || header.typ !== 'at+jwt' ||
      typeof header.kid !== 'string' || !KEY_ID.test(header.kid)) return null;
    let payload;
    try {
      ({ payload } = await jwtVerify(token, verifyKey, {
        issuer, audience, algorithms: ['RS256'], typ: 'at+jwt',
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
        maxTokenAge: maxTokenAgeSeconds, clockTolerance: clockToleranceSeconds
      }));
    } catch (error) {
      if (INVALID_TOKEN_ERRORS.some(ErrorType => error instanceof ErrorType)) return null;
      // A broken key/runtime/configuration is not an invalid password. Let the
      // API turn operational failures into its sanitized dependency-unavailable 503.
      throw error;
    }

    // jose checks signatures, issuer/audience, nbf, expiry and token age. Tighten
    // numeric dates to finite safe integers and bound the total issued lifetime.
    if (!boundedString(payload.sub, 512) || !numericDate(payload.iat) || !numericDate(payload.exp) ||
      payload.exp <= payload.iat || payload.exp - payload.iat > maxTokenAgeSeconds ||
      (payload.nbf !== undefined && (!numericDate(payload.nbf) || payload.nbf >= payload.exp)) ||
      !(typeof payload.aud === 'string' || (Array.isArray(payload.aud) && payload.aud.length > 0 && payload.aud.every(a => typeof a === 'string')))) return null;

    // Do not catch membership outages, and never forward the JWT or its roles,
    // tenant, groups, scopes, client-supplied IDs or other arbitrary claims.
    const membership = await resolveMembership(Object.freeze({ issuer, subject: payload.sub, activeTenantId }));
    if (!plainObject(membership) || typeof membership.principalId !== 'string' || !ID.test(membership.principalId) ||
      membership.tenantId !== activeTenantId || !ROLES.has(membership.role)) return null;
    return { principalId: membership.principalId, tenantId: activeTenantId, role: membership.role };
  };
}
