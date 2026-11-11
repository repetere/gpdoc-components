# Access-token authentication foundation

`src/access-token-auth.mjs` provides a server-side JWT access-token verifier and a trusted membership boundary. It uses the pinned, MIT-licensed [`jose` 6.2.17](https://www.npmjs.com/package/jose/v/6.2.17) package for JWT parsing, signature verification and standard claim checks. It does not implement cryptography itself. The module has no network or filesystem calls.

**This is not a browser login implementation, a complete OIDC integration or turnkey Ping, Entra, Google or other provider support.** It has synthetic key/token tests, not provider certification or an external security audit. The loopback demo still uses its separate temporary development token. Enterprise login and air-gap verification remain unimplemented.

## Server integration

Install the repository's locked dependencies with `npm ci` in `opendoc`. Configure the adapter on the server and pass the returned function to `createOpenDocHandler`:

```js
import { createAccessTokenAuthenticator } from './src/access-token-auth.mjs';
import { createOpenDocHandler } from './src/api.mjs';

// The application supplies these from trusted operator configuration and its
// own server-side membership database. No browser/profile/request sets them.
const authenticate = createAccessTokenAuthenticator({
  issuer: 'https://issuer.example.test',
  audience: 'https://opendoc.example.test/api',
  algorithms: ['RS256'],
  jwks: operatorPublicJwks,
  activeTenantId: 'team.example',
  resolveMembership: async ({ issuer, subject, activeTenantId }) => {
    const member = await membershipRepository.findActiveMember({
      issuer, subject, tenantId: activeTenantId
    });
    if (!member) return null;
    return {
      principalId: member.internalPrincipalId,
      tenantId: member.tenantId,
      role: member.role
    };
  }
});

const handle = createOpenDocHandler({
  store: applicationStore,
  authenticate,
  allowedOrigins: ['https://editor.example.test']
});
```

This is an integration sketch, not a complete server: `operatorPublicJwks`, `membershipRepository` and `applicationStore` are application-supplied. Production TLS, ingress limits, timeouts, abuse controls and secret-safe logging also belong to the host.

## Credential and claim contract

- Accept only a compact signed JWT in `Authorization: Bearer <token>`. The scheme is case-insensitive, with one separating space. Cookies, query parameters and request bodies do not supply credentials. Requests with any query, fragment or URL user information are rejected by this adapter; the API also enforces its own URL policy. Never put tokens in URLs, source control, telemetry or shared logs.
- The protected header must contain `alg: "RS256"`, `typ: "at+jwt"` and a configured `kid`. No other header fields are accepted. In particular, `jku`, `x5u`, embedded `jwk`, certificates, critical extensions and client-selected key locations are rejected. Nothing is fetched from a token.
- The exact lowercase `at+jwt` type is mandatory to distinguish access tokens from ID tokens. This uses the type-separation principle in [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html#section-4), with a deliberately narrower header contract. The adapter does not claim full RFC 9068 profile compliance: it does not implement every profile claim or OAuth authorization policy. Some providers emit different token types or headers and will be rejected. Do not loosen this check to use an ID token as an API credential.
- The configured issuer must match `iss` exactly. The configured audience must appear in `aud`, which must be a string or a nonempty array of strings. Signature, algorithm, key ID, issuer, audience and required claim checks are handled by `jose` before any membership lookup.
- `iss`, `aud`, `sub`, `iat` and `exp` are required. `sub` must be a nonblank string of at most 512 UTF-16 code units without control characters. It is an external identity, not an internal OpenDoc ID.
- `iat` and `exp`, and optional `nbf`, must be nonnegative safe integer seconds. Fractional, overflowing, nonfinite or string timestamps fail. The token must have started, must not be expired, and must not be issued in the future beyond the configured clock tolerance. `exp` must be greater than `iat` and any `nbf`.
- By default, both token age and the issued lifetime `exp - iat` are limited to 3,600 seconds. A valid signature does not make an indefinitely long-lived token acceptable. Hosts must keep clocks synchronized.

Options are intentionally bounded:

| Option | Default | Accepted values |
| --- | --- | --- |
| `maxTokenBytes` | 8192 | Integer 1024–16384; ASCII compact token bytes, excluding the scheme |
| `maxTokenAgeSeconds` | 3600 | Integer 1–86400; caps both current age and issued lifetime |
| `clockToleranceSeconds` | 0 | Integer 0–60; applied to expiry, not-before and age checks |

Issuer and audience must be explicitly configured nonblank strings of at most 2,048 code units without control characters. `algorithms` must explicitly be `['RS256']`; no algorithm fallback is implemented. Invalid configuration throws rather than constructing a permissive authenticator.

## Membership is server authority

Each accepted token triggers `resolveMembership({ issuer, subject, activeTenantId })`. These three values are the only resolver input; the input object is frozen. The resolver never receives token `roles`, `groups`, `scope`, tenant claims, arbitrary principal IDs or the token itself. They cannot grant membership or select a tenant.

The host must resolve the pair `(issuer, subject)` to a stable internal principal, check that account and membership are active, and return a permitted role for the server-selected active tenant. Return `null` to deny access; do not default to an owner, editor or public tenant when lookup fails. A tenant-switching implementation must separately authorize the switch on the server before choosing an authenticator. A deployment profile, request header, token tenant claim or UI selection alone is not authorization.

Accepted results are plain objects with:

- `principalId`: `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`.
- `tenantId`: exactly the configured `activeTenantId`, whose grammar is `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`.
- `role`: `owner`, `editor`, `viewer` or `commenter`.

Only those three fields are returned to the API. Invalid results or tenant mismatches deny authentication. Owner/editor writes and viewer/commenter reads remain the API's tenant-wide policy; `commenter` currently has no comment endpoint. This is not per-document sharing or a complete scope/ACL policy.

The adapter does not cache memberships. Fresh lookup lets the host stop access for a disabled member, subject to the host's own data freshness and caching. It does not by itself implement per-token revocation, logout or introspection.

## Pinned keys and operator-managed replacement

`jwks` is a local JSON object with exactly a `keys` array of 1–32 administrator-approved public RSA keys. Each key needs `kty: "RSA"`, a unique `kid`, and base64url public `n` and `e` values. The modulus representation is bounded for 2048–8192-bit keys; `jose` enforces cryptographic requirements. Key IDs match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`.

Supported optional metadata is `alg: "RS256"`, `use: "sig"`, `key_ops: ["verify"]` and boolean `ext`. Private key parameters, symmetric secrets, certificates, URL references and other fields are not accepted. Obtain and verify keys through the operator's trusted process; never accept a JWKS supplied by the client or as part of the JWT. The administrator must maintain the binding between these keys and the configured issuer.

The adapter snapshots its key configuration. Mutating the original object does not rotate keys. To replace a signing key:

1. Through a trusted operator channel, verify the new public key and assign a distinct `kid`.
2. Construct a new authenticator with an explicitly approved overlap set if uninterrupted transition is needed. Test it before directing traffic to it.
3. Replace the host's authenticator/handler or restart with the approved configuration. Roll out consistently across instances.
4. Remove the old key and replace the configuration again according to the incident or rotation policy. Do not retain a compromised key merely to preserve active tokens.

This is manual host configuration, not automatic live discovery or rotation. Key imports occur on first use; syntactically valid but unusable key material can fail then. Validate the host configuration with appropriate nonproduction test credentials before accepting traffic. No key material or credentials are stored by this module.

## Failure handling and limits

Invalid credentials and denied/malformed memberships return `null`. The API returns a generic `401` with `WWW-Authenticate: Bearer`. A missing key ID in the pinned set is an invalid credential, not a reason to fetch keys.

Operational failures, unusable key configuration and resolver exceptions propagate. `createOpenDocHandler` converts them to its sanitized `503 DEPENDENCY_UNAVAILABLE`; it never includes exception details or tokens in the response. A membership database outage must not be treated as successful membership or silently disguised as a bad password. Hosts should monitor failures without logging credentials or sensitive dependency details.

Still required for a real deployment: provider-specific interoperability checks, browser authorization-code/PKCE login, sessions and logout, revocation/introspection where applicable, discovery and managed key rotation, membership administration, transport security, rate limits, audit policy and deployment tests. No identity-provider application or cloud resource is provisioned. A no-fetch verifier does not establish air-gap readiness: installation artifacts, dependency/license inventory and blocked-egress operational tests are separate work.

## Verification and sources

Run `node --test test/access-token-auth.test.mjs` from `opendoc`. Tests generate synthetic RSA keys through `jose` and cover valid tokens, tampering, unsigned/HS algorithm confusion, ID tokens, unknown keys, unsafe headers, issuer/audience/time errors, missing claims, numeric overflow, credential size/URL rules, role/tenant injection, membership denial, configuration snapshots/replacement, and sanitized API failures.

- **OD-AUTH-001:** Verify bounded, explicitly typed access tokens against pinned issuer/audience/algorithm/key and temporal claims.
- **OD-AUTH-002:** Resolve internal principal, active tenant and role only through trusted server membership.
- **OD-AUTH-003:** Use a bounded snapshot of local administrator-pinned public keys without remote fetching or credential URLs.
- **OD-AUTH-004:** Distinguish rejected credentials from operational failures without exposing secrets to API callers.

Public dependencies and standards: [`jose` upstream](https://github.com/panva/jose), [`jose` local JWKS API](https://github.com/panva/jose/blob/main/docs/jwks/local/functions/createLocalJWKSet.md), [RFC 9068 access-token validation](https://www.rfc-editor.org/rfc/rfc9068.html#section-4), and [RFC 8725 JWT best practices](https://www.rfc-editor.org/rfc/rfc8725.html).
