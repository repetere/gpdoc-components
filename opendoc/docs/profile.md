# Deployment profile v1

This is an original, limited OpenDoc configuration and verification foundation. It is not an audited security product, an OIDC login implementation, document authorization, or evidence of an air-gapped deployment. All code uses Node.js 22+ standard-library APIs.

The [unsigned example](../examples/profile.json) uses reserved `.test` hosts and a fixed illustrative validity window. **It cannot enroll a client.** It is a human-readable schema example, not a trusted profile. Neither this file nor an untrusted profile can nominate its own trust anchor.

## Public API

- `validateDeploymentProfile(object, { now })` validates data and returns a detached, deeply frozen profile. This does not authenticate it or grant enrollment authority.
- `verifyDeploymentProfile(compactJws, { trustedKeys, expectedDeploymentId, minGeneration, now })` verifies the signature and validates the profile, returning the same frozen shape. A successful result is configuration metadata, not permission to open a document or access a workspace.
- `DeploymentProfileError` includes a stable `code`; error messages do not echo payloads, tokens, or key material.

`now` defaults to `Date.now()` and accepts a valid `Date` or nonnegative safe-integer Unix milliseconds. Tests and examples should inject a clock. The host must maintain a trustworthy clock. Unknown options fail closed. Input objects must be ordinary JSON-like data records without accessors, symbol properties, or custom prototypes. Do not pass executable objects or proxies from an untrusted JavaScript realm.

## Closed schema

Required fields:

| Field | Contract |
| --- | --- |
| `version` | Integer `1` only. |
| `deploymentId`, `tenantId` | 1–128 ASCII letters, digits, dots, underscores, or hyphens; first character a letter or digit. |
| `generation` | Positive safe integer. |
| `issuedAt`, `expiresAt` | Real UTC instants, `YYYY-MM-DDTHH:mm:ssZ` or exactly three fractional digits before `Z`. Expiry must follow issue time; `issuedAt <= now < expiresAt`. No grace period. |
| `endpoints.api` | Absolute HTTPS base URL. |
| `endpoints.collaboration` | Absolute WSS base URL. |
| `identity.issuer` | Absolute HTTPS issuer URL; issuer paths are supported and the exact string is retained. |
| `identity.audience` | Opaque, nonempty printable ASCII string without spaces, at most 256 characters. A URN such as `urn:example:opendoc:api` is valid. It need not be a URL. |
| `identity.clientId` | Public client identifier, using the same string bounds as the audience. Never a client secret. |

Optional fields:

- `tenantHint`: a plain display label of 1–128 UTF-16 code units. It cannot change the tenant binding or authorize access.
- `brand`: only `{ "displayName": "Example OpenDoc" }`, at most 80 UTF-16 code units. Labels cannot contain control characters, formatting controls, lone surrogates, angle brackets, or leading/trailing whitespace. Render labels as text, never HTML.
- `telemetry`: `"off"` only, also the default. This version implements no telemetry and cannot enable it.

Every object uses an exact field allowlist. Credentials, document IDs, workspace IDs, permission claims, embedded keys, branding URLs, and arbitrary extension fields are rejected. The caller still must ensure that opaque public identifiers are not mistakenly populated with secrets.

URLs are bounded to 2,048 ASCII characters. User information, query strings (including a bare `?`), fragments (including a bare `#`), whitespace, backslashes, malformed percent escapes, and percent-encoded ASCII controls/backslashes are rejected. URLs must already be in the form produced by `new URL(value).href`, except that an absent root slash is accepted and retained. This rejects parser normalization surprises such as dot segments, uppercase hosts, and redundant default ports. HTTPS/WSS syntax alone does not establish that a service exists, is safe, has the right certificate, or enforces authentication. Private-network endpoints are not prohibited; callers need their own outbound-network policy. Do not put secret tokens in URL paths: the validator cannot infer whether an arbitrary path segment is a secret.

## Signed envelope

`OD-PROFILE-SIGNATURE` uses compact JWS with exactly three unpadded, canonical base64url segments. The protected header has exactly these fields, in any order:

```json
{"alg":"EdDSA","typ":"opendoc-profile+jws","kid":"example-admin-1"}
```

Only Ed25519 keys and 64-byte Ed25519 signatures are supported. `none`, HMAC, ECDSA, Ed448, detached payloads, unencoded payloads, `crit`, embedded JWKs, certificate fields, and remote key URLs are not supported. The JWS is at most 16,384 characters; decoded header/payload limits are 512/8,192 bytes.

### Exact JSON encoding

`OD-PROFILE-ENCODING` intentionally uses a narrow serialization contract rather than claiming to implement a general canonical-JSON standard. Header and payload must contain valid UTF-8 and be **exactly equal to `JSON.stringify(JSON.parse(text))`**. Object member order is preserved, not sorted. No indentation, whitespace outside strings, alternate escape spellings, duplicate keys, or non-normalized numeric spellings are accepted. Sign the compact UTF-8 serialization directly. This restriction removes duplicate-key ambiguity at every depth; a signature cannot override it. An arbitrary JWT/JWS producer may need an encoding adjustment.

### External trust configuration

`trustedKeys` is a `Map` or plain data object mapping up to 32 key IDs to **public** Ed25519 Node `KeyObject`s or SPKI `PUBLIC KEY` PEM text (at most 2,048 characters). Private keys, key-file paths, certificates, and JWK input are rejected. The application must obtain trust anchors through a separate administrator-controlled channel. There is no default trusted key, bundled enrollment key, key fetch, or automatic key discovery.

`expectedDeploymentId` is mandatory and must come from the caller's trusted configuration, not from the unverified profile. `minGeneration` defaults to `1`; a profile below this floor fails. The host must atomically persist the highest accepted generation per deployment and supply it on future checks to prevent rollback. Reuse of the same generation is allowed for idempotent validation, and this module does not detect two differently signed profiles at the same generation. Issuers must keep generations monotonic and avoid conflicting releases.

Administrator-installed keys are authorized for the expected deployment by the host's trust-store choice. Provision separate per-deployment trust maps if administrators must not sign profiles for other deployments. Rotation, revocation, persistence, and conflict resolution belong to the host, not this module.

```js
import { verifyDeploymentProfile } from '../src/profile.mjs';

// All four values below come from the host, not from the unverified token.
const verified = verifyDeploymentProfile(receivedCompactJws, {
  trustedKeys: new Map([['example-admin-1', administratorPublicKey]]),
  expectedDeploymentId: configuredDeploymentId,
  minGeneration: previouslyAcceptedGeneration,
  now: trustedClockMilliseconds,
});
// Persist the generation floor safely before activating this configuration.
```

## Error codes

Callers can distinguish `PROFILE_INVALID`, `PROFILE_VERSION_UNSUPPORTED`, `PROFILE_OPTIONS_INVALID`, `PROFILE_NOT_YET_VALID`, `PROFILE_EXPIRED`, `PROFILE_JWS_INVALID`, `PROFILE_TRUST_INVALID`, `PROFILE_KEY_UNTRUSTED`, `PROFILE_SIGNATURE_INVALID`, `PROFILE_DEPLOYMENT_MISMATCH`, and `PROFILE_GENERATION_STALE`. Never activate configuration after any error. Avoid reflecting raw tokens or trust-store data into logs when handling failures.

## Limits and caller responsibilities

`OD-PROFILE-LOCAL` performs no network requests, DNS lookups, filesystem access, telemetry, or enrollment writes. Verification does not save trust state, open endpoints, authenticate the user, mint tokens, configure a client, fetch identity discovery/JWKS, or establish a collaboration session. Document/workspace authorization must be checked independently by the server for every operation. A profile never overrides it.

Use the authenticated result only after successful verification. Restrict who may install trust anchors and deployment bindings. Protect persisted generation state against rollback, choose reasonable validity windows, monitor clock integrity, and define key revocation/rotation procedures. Removing a key from the external map prevents future verification with that key, but does not invalidate already-created sessions elsewhere.

The provided negative tests exercise the v1 contract. They do not replace external security review or prove air-gap compliance.

Run from the repository root:

```sh
node --test opendoc/test/profile.test.mjs
```
