# Dependency and distribution boundaries

OpenDoc's original code uses the repository MIT license. Third-party packages retain their own licenses and notices. This file is an inventory of the pinned Node package graph, not a complete deployment SBOM or a security certification.

- The HTTP core, memory demo and Ed25519 deployment-profile verifier use Node standard-library APIs only.
- The access-token adapter imports `jose` for JWT/JWK verification. The package is pinned exactly rather than reimplementing signature verification.
- The experimental collaboration transport imports `ws`; its client and isolated merge worker import `yjs`. Yjs imports `lib0` and `isomorphic.js`. These are pinned in the lockfile, not copied from a private application.
- The PostgreSQL adapter accepts a caller-owned Pool-compatible object and does not import a driver. Integration tests use the pinned `pg` driver. A host must install and configure its runtime database driver separately if it installs OpenDoc with development dependencies omitted.
- `npm ci --ignore-scripts` installs the lockfile without package lifecycle scripts. It needs network access or a pre-populated approved cache. It is not an offline/air-gap installer.
- PostgreSQL server binaries, container images, operating systems and cloud services are not distributed in this package. Their licenses and operational requirements need their own inventory before shipping a deployment.
- Preserve dependency license files/notices when packaging. Public source links are not a substitute for required notices in a redistributed bundle. Existing GPDoc brand reservations still apply.

## Locked packages

| Package | Version | Declared license | Use |
| --- | --- | --- | --- |
| isomorphic.js | 0.2.5 | MIT | transitive collaboration runtime |
| lib0 | 0.2.120 | MIT | transitive collaboration runtime |
| ws | 8.22.2 | MIT | collaboration runtime |
| yjs | 13.6.33 | MIT | collaboration runtime |
| jose | 6.2.17 | MIT | runtime |
| pg | 8.23.1 | MIT | test/driver dependency |
| pg-cloudflare | 1.4.1 | MIT | test/driver dependency |
| pg-connection-string | 2.14.1 | MIT | test/driver dependency |
| pg-int8 | 1.0.1 | ISC | test/driver dependency |
| pg-pool | 3.14.0 | MIT | test/driver dependency |
| pg-protocol | 1.16.1 | MIT | test/driver dependency |
| pg-types | 2.2.0 | MIT | test/driver dependency |
| pgpass | 1.0.5 | MIT | test/driver dependency |
| postgres-array | 2.0.0 | MIT | test/driver dependency |
| postgres-bytea | 1.0.1 | MIT | test/driver dependency |
| postgres-date | 1.0.7 | MIT | test/driver dependency |
| postgres-interval | 1.2.0 | MIT | test/driver dependency |
| split2 | 4.2.0 | ISC | test/driver dependency |
| xtend | 4.0.2 | MIT | test/driver dependency |

Versions, integrity hashes and resolved URLs are recorded in [`package-lock.json`](../package-lock.json). The lockfile is authoritative if this table changes. Node.js itself has its own distribution notices.

Sources: [Yjs](https://github.com/yjs/yjs), [ws](https://github.com/websockets/ws), [jose](https://github.com/panva/jose), [node-postgres](https://github.com/brianc/node-postgres), and each installed package's license file. A registry audit with no reported advisories is only a point-in-time registry result; it does not prove the dependencies or application are free of vulnerabilities.
