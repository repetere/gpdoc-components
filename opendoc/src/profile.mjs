/**
 * OpenDoc deployment profile v1: closed configuration validation and optional
 * Ed25519 compact-JWS verification against administrator-supplied public keys.
 *
 * No network, filesystem, trust persistence, enrollment, or token operations.
 * This is not an OIDC login implementation, document authorization, an audited
 * security product, or proof that a deployment is air-gapped. See docs/profile.md.
 */
import { createPublicKey, KeyObject, verify } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/;
const LABEL_UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}<>]/u;
const PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/;
const MAX_JWS = 16_384;
const MAX_HEADER = 512;
const MAX_PAYLOAD = 8_192;
const MAX_KEYS = 32;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class DeploymentProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeploymentProfileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeploymentProfileError(code, message);
}

/** Inspect descriptors before reading values so accessors are never invoked. */
function record(value, allowed, required, label, code = 'PROFILE_INVALID') {
  if (value === null || typeof value !== 'object') fail(code, `${label} must be a data object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain data object`);
  const names = Reflect.ownKeys(value);
  if (names.length > allowed.length) fail(code, `${label} has unsupported fields`);
  const result = Object.create(null);
  for (const name of names) {
    if (typeof name !== 'string' || !allowed.includes(name)) fail(code, `${label} has unsupported fields`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      fail(code, `${label} must have enumerable data properties only`);
    }
    result[name] = descriptor.value;
  }
  for (const name of required) {
    if (!Object.hasOwn(result, name)) fail(code, `${label} is missing a required field`);
  }
  return result;
}

function identifier(value, label, code = 'PROFILE_INVALID') {
  if (typeof value !== 'string' || !ID.test(value)) fail(code, `${label} must be a bounded ASCII identifier`);
  return value;
}

function positiveInteger(value, label, code = 'PROFILE_INVALID') {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${label} must be a positive safe integer`);
  return value;
}

function publicIdentifier(value, label) {
  if (typeof value !== 'string' || value.length > 256 || !VISIBLE_ASCII.test(value)) {
    fail('PROFILE_INVALID', `${label} must be a bounded nonempty public identifier without spaces`);
  }
  return value;
}

function displayLabel(value, maxLength, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value || LABEL_UNSAFE.test(value)) {
    fail('PROFILE_INVALID', `${label} must be a bounded plain display label`);
  }
  return value;
}

function protectedUrl(value, scheme, label) {
  if (typeof value !== 'string' || value.length > 2_048 || !VISIBLE_ASCII.test(value) || /[\\?#]/.test(value)
      || /%(?![0-9A-Fa-f]{2})|%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff]|5[Cc])/.test(value)) {
    fail('PROFILE_INVALID', `${label} must be a bounded URL without credentials, query, or fragment`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('PROFILE_INVALID', `${label} must be an absolute URL`);
  }
  // Reject even empty user information, which URL.username does not expose.
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]*)/);
  if (!authority || authority[1].includes('@') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('PROFILE_INVALID', `${label} must not contain user information, query, or fragment`);
  }
  if (parsed.protocol !== `${scheme}:` || !parsed.hostname) fail('PROFILE_INVALID', `${label} has an unsupported scheme or host`);
  if (value !== parsed.href && `${value}/` !== parsed.href) fail('PROFILE_INVALID', `${label} must use normalized URL spelling`);
  // Retain the issuer's exact spelling, including whether a root slash exists.
  return value;
}

function instant(value, label) {
  if (typeof value !== 'string') fail('PROFILE_INVALID', `${label} must be a UTC timestamp`);
  const match = UTC_INSTANT.exec(value);
  if (!match) fail('PROFILE_INVALID', `${label} must be a UTC timestamp`);
  const millis = Date.parse(value);
  const normalized = `${match[1]}${match[2] ?? '.000'}Z`;
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== normalized) {
    fail('PROFILE_INVALID', `${label} must be a real UTC instant`);
  }
  return millis;
}

function clock(value) {
  const millis = value === undefined ? Date.now() : value instanceof Date ? Date.prototype.getTime.call(value) : value;
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8_640_000_000_000_000) {
    fail('PROFILE_OPTIONS_INVALID', 'now must be a valid Date or nonnegative Unix milliseconds');
  }
  return millis;
}

/**
 * Validate unsigned data only; this function does not establish trust.
 * @spec OD-PROFILE-SCHEMA Closed fields; no secrets or document/workspace authority.
 * @spec OD-PROFILE-TIME issuedAt <= now < expiresAt, with no grace period.
 */
export function validateDeploymentProfile(input, options = {}) {
  const settings = record(options, ['now'], [], 'options', 'PROFILE_OPTIONS_INVALID');
  const now = clock(settings.now);
  const required = ['version', 'deploymentId', 'tenantId', 'generation', 'issuedAt', 'expiresAt', 'endpoints', 'identity'];
  const data = record(input, [...required, 'tenantHint', 'brand', 'telemetry'], required, 'profile');
  if (data.version !== 1) fail('PROFILE_VERSION_UNSUPPORTED', 'Only deployment profile version 1 is supported');
  const deploymentId = identifier(data.deploymentId, 'deploymentId');
  const tenantId = identifier(data.tenantId, 'tenantId');
  const generation = positiveInteger(data.generation, 'generation');
  const issuedAt = instant(data.issuedAt, 'issuedAt');
  const expiresAt = instant(data.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt) fail('PROFILE_INVALID', 'expiresAt must follow issuedAt');
  if (now < issuedAt) fail('PROFILE_NOT_YET_VALID', 'The deployment profile is not yet valid');
  if (now >= expiresAt) fail('PROFILE_EXPIRED', 'The deployment profile has expired');

  const endpoints = record(data.endpoints, ['api', 'collaboration'], ['api', 'collaboration'], 'endpoints');
  const identity = record(data.identity, ['issuer', 'audience', 'clientId'], ['issuer', 'audience', 'clientId'], 'identity');
  const result = {
    version: 1,
    deploymentId,
    tenantId,
    generation,
    issuedAt: data.issuedAt,
    expiresAt: data.expiresAt,
    endpoints: Object.freeze({
      api: protectedUrl(endpoints.api, 'https', 'endpoints.api'),
      collaboration: protectedUrl(endpoints.collaboration, 'wss', 'endpoints.collaboration'),
    }),
    identity: Object.freeze({
      issuer: protectedUrl(identity.issuer, 'https', 'identity.issuer'),
      audience: publicIdentifier(identity.audience, 'identity.audience'),
      clientId: publicIdentifier(identity.clientId, 'identity.clientId'),
    }),
  };
  if (Object.hasOwn(data, 'tenantHint')) result.tenantHint = displayLabel(data.tenantHint, 128, 'tenantHint');
  if (Object.hasOwn(data, 'brand')) {
    const brand = record(data.brand, ['displayName'], ['displayName'], 'brand');
    result.brand = Object.freeze({ displayName: displayLabel(brand.displayName, 80, 'brand.displayName') });
  }
  if (Object.hasOwn(data, 'telemetry') && data.telemetry !== 'off') {
    fail('PROFILE_INVALID', 'Profile v1 supports telemetry off only');
  }
  result.telemetry = 'off';
  return Object.freeze(result);
}

function decodeSegment(segment, maxBytes) {
  if (segment.length === 0 || segment.length > Math.ceil(maxBytes * 4 / 3) || segment.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    fail('PROFILE_JWS_INVALID', 'JWS segments must be bounded canonical base64url');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== segment) {
    fail('PROFILE_JWS_INVALID', 'JWS segments must be bounded canonical base64url');
  }
  return bytes;
}

/**
 * @spec OD-PROFILE-ENCODING Exact JSON.stringify serialization, not sorted JCS.
 * Duplicate keys (including escaped/nested duplicates), invalid UTF-8, whitespace
 * outside strings, and alternate numeric/escape spellings fail this equality.
 */
function normalizedJson(bytes) {
  try {
    const source = decoder.decode(bytes);
    const parsed = JSON.parse(source);
    if (JSON.stringify(parsed) !== source) fail('PROFILE_JWS_INVALID', 'JWS JSON must use exact compact JSON.stringify serialization');
    return parsed;
  } catch (error) {
    if (error instanceof DeploymentProfileError) throw error;
    fail('PROFILE_JWS_INVALID', 'JWS segments must contain bounded normalized UTF-8 JSON');
  }
}

function publicKey(value) {
  let key;
  if (value instanceof KeyObject) {
    key = value;
  } else if (typeof value === 'string' && value.length <= 2_048 && PUBLIC_PEM.test(value)) {
    try {
      key = createPublicKey(value);
    } catch {
      fail('PROFILE_TRUST_INVALID', 'Trusted keys must be valid Ed25519 public keys');
    }
  } else {
    fail('PROFILE_TRUST_INVALID', 'Trusted keys must be public KeyObjects or SPKI public PEM text');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    fail('PROFILE_TRUST_INVALID', 'Trusted keys must be Ed25519 public keys, not private keys');
  }
  return key;
}

function trustMap(value) {
  let entries;
  if (value instanceof Map && Object.getPrototypeOf(value) === Map.prototype && Reflect.ownKeys(value).length === 0) {
    const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(value);
    if (size > MAX_KEYS) fail('PROFILE_TRUST_INVALID', 'The trust store is too large');
    entries = [...Map.prototype.entries.call(value)];
  } else {
    if (value === null || typeof value !== 'object') fail('PROFILE_TRUST_INVALID', 'trustedKeys must be a Map or plain data object');
    const names = Reflect.ownKeys(value);
    if (names.length > MAX_KEYS) fail('PROFILE_TRUST_INVALID', 'The trust store is too large');
    const data = record(value, names.filter((name) => typeof name === 'string'), [], 'trustedKeys', 'PROFILE_TRUST_INVALID');
    entries = Object.entries(data);
  }
  const result = new Map();
  for (const [kid, value] of entries) result.set(identifier(kid, 'kid', 'PROFILE_TRUST_INVALID'), publicKey(value));
  return result;
}

/**
 * Verify against an externally provisioned trust map and deployment binding.
 * minGeneration defaults to 1; persistence of a monotonic floor is caller-owned.
 * @spec OD-PROFILE-SIGNATURE EdDSA/Ed25519 only, with an exact protected header.
 * @spec OD-PROFILE-BINDING Expected deployment and minimum generation are local.
 * @spec OD-PROFILE-LOCAL No filesystem, DNS, HTTP, telemetry, or enrollment writes.
 */
export function verifyDeploymentProfile(compactJws, options = {}) {
  const settings = record(options, ['trustedKeys', 'expectedDeploymentId', 'minGeneration', 'now'], ['trustedKeys', 'expectedDeploymentId'], 'options', 'PROFILE_OPTIONS_INVALID');
  const expectedDeploymentId = identifier(settings.expectedDeploymentId, 'expectedDeploymentId', 'PROFILE_OPTIONS_INVALID');
  const minGeneration = positiveInteger(settings.minGeneration === undefined ? 1 : settings.minGeneration, 'minGeneration', 'PROFILE_OPTIONS_INVALID');
  const now = clock(settings.now);
  const trustedKeys = trustMap(settings.trustedKeys);
  if (typeof compactJws !== 'string' || compactJws.length === 0 || compactJws.length > MAX_JWS) {
    fail('PROFILE_JWS_INVALID', 'A bounded compact JWS string is required');
  }
  const parts = compactJws.split('.');
  if (parts.length !== 3) fail('PROFILE_JWS_INVALID', 'Compact JWS must have exactly three segments');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const headerBytes = decodeSegment(encodedHeader, MAX_HEADER);
  const payloadBytes = decodeSegment(encodedPayload, MAX_PAYLOAD);
  const signature = decodeSegment(encodedSignature, 64);
  if (signature.length !== 64) fail('PROFILE_JWS_INVALID', 'An Ed25519 signature must be exactly 64 bytes');
  const header = record(normalizedJson(headerBytes), ['alg', 'typ', 'kid'], ['alg', 'typ', 'kid'], 'protected header', 'PROFILE_JWS_INVALID');
  if (header.alg !== 'EdDSA' || header.typ !== 'opendoc-profile+jws') fail('PROFILE_JWS_INVALID', 'Unsupported JWS algorithm or profile type');
  const kid = identifier(header.kid, 'kid', 'PROFILE_JWS_INVALID');
  const key = trustedKeys.get(kid);
  if (!key) fail('PROFILE_KEY_UNTRUSTED', 'The profile signing key is not trusted');
  let validSignature = false;
  try {
    validSignature = verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), key, signature);
  } catch {
    fail('PROFILE_SIGNATURE_INVALID', 'The profile signature could not be verified');
  }
  if (!validSignature) fail('PROFILE_SIGNATURE_INVALID', 'The profile signature is invalid');
  const result = validateDeploymentProfile(normalizedJson(payloadBytes), { now });
  if (result.deploymentId !== expectedDeploymentId) fail('PROFILE_DEPLOYMENT_MISMATCH', 'The profile does not match the expected deployment');
  if (result.generation < minGeneration) fail('PROFILE_GENERATION_STALE', 'The profile generation is below the required minimum');
  return result;
}
