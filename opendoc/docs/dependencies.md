# Dependency and distribution boundaries

OpenDoc's original code uses the repository MIT license. Third-party packages retain their own licenses and notices. This file is an inventory of the pinned Node package graph, not a complete deployment SBOM or a security certification.

- The HTTP core, memory demo and Ed25519 deployment-profile verifier use Node standard-library APIs only.
- Browser login imports `openid-client` and its `oauth4webapi` dependency. The isolated identity-provider fixture imports `oidc-provider` only in tests/development. Preserve that package’s `THIRD-PARTY-NOTICES.md` as well as dependency licenses when redistributing fixtures. Neither library certification nor a passing local fixture certifies OpenDoc or a deployment.
- The access-token adapter imports `jose` for JWT/JWK verification. The package is pinned exactly rather than reimplementing signature verification.
- The experimental collaboration transport imports `ws`; its client and isolated merge worker import `yjs`. Yjs imports `lib0` and `isomorphic.js`. These are pinned in the lockfile, not copied from a private application.
- The live browser client is bundled locally from the pinned Yjs graph using build-only `esbuild` 0.25.12 (MIT). Its platform-specific optional packages are also MIT. `npm run check:web` verifies that the checked-in bundle and notices match the source; no CDN is used. These assets are not an offline deployment bundle.
- The PostgreSQL adapter accepts a caller-owned Pool-compatible object and does not import a driver. Integration tests use the pinned `pg` driver. A host must install and configure its runtime database driver separately if it installs OpenDoc with development dependencies omitted.
- `npm ci --ignore-scripts` installs the lockfile without package lifecycle scripts. It needs network access or a pre-populated approved cache. It is not an offline/air-gap installer.
- PostgreSQL server binaries, container images, operating systems and cloud services are not distributed in this package. Their licenses and operational requirements need their own inventory before shipping a deployment.
- Preserve dependency license files/notices when packaging. Public source links are not a substitute for required notices in a redistributed bundle. Existing GPDoc brand reservations still apply.

## Locked packages

| Package / lockfile path | Version | Declared license | Use |
| --- | --- | --- | --- |
| @esbuild/aix-ppc64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/android-arm | 0.25.12 | MIT | build-only optional binary |
| @esbuild/android-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/android-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/darwin-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/darwin-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/freebsd-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/freebsd-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-arm | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-ia32 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-loong64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-mips64el | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-ppc64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-riscv64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-s390x | 0.25.12 | MIT | build-only optional binary |
| @esbuild/linux-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/netbsd-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/netbsd-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/openbsd-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/openbsd-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/openharmony-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/sunos-x64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/win32-arm64 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/win32-ia32 | 0.25.12 | MIT | build-only optional binary |
| @esbuild/win32-x64 | 0.25.12 | MIT | build-only optional binary |
| accepts | 1.3.8 | MIT | test/driver dependency |
| accepts/node_modules/mime-db | 1.52.0 | MIT | test/driver dependency |
| accepts/node_modules/mime-types | 2.1.35 | MIT | test/driver dependency |
| content-disposition | 1.0.1 | MIT | test/driver dependency |
| content-type | 1.0.5 | MIT | test/driver dependency |
| cookies | 0.9.2 | MIT | test/driver dependency |
| debug | 4.4.3 | MIT | test/driver dependency |
| deep-equal | 1.0.1 | MIT | test/driver dependency |
| delegates | 1.0.0 | MIT | test/driver dependency |
| depd | 2.0.0 | MIT | test/driver dependency |
| destroy | 1.2.0 | MIT | test/driver dependency |
| ee-first | 1.1.1 | MIT | test/driver dependency |
| encodeurl | 2.0.1 | MIT | test/driver dependency |
| esbuild | 0.25.12 | MIT | build only |
| escape-html | 1.0.3 | MIT | test/driver dependency |
| fresh | 0.5.2 | MIT | test/driver dependency |
| http-assert | 1.5.0 | MIT | test/driver dependency |
| http-assert/node_modules/depd | 1.1.2 | MIT | test/driver dependency |
| http-assert/node_modules/http-errors | 1.8.1 | MIT | test/driver dependency |
| http-assert/node_modules/statuses | 1.5.0 | MIT | test/driver dependency |
| http-errors | 2.0.1 | MIT | test/driver dependency |
| inherits | 2.0.4 | ISC | test/driver dependency |
| isomorphic.js | 0.2.5 | MIT | runtime |
| jose | 6.2.17 | MIT | runtime |
| keygrip | 1.1.0 | MIT | test/driver dependency |
| koa | 3.3.0 | MIT | test/driver dependency |
| koa-compose | 4.1.0 | MIT | test/driver dependency |
| lib0 | 0.2.120 | MIT | runtime |
| media-typer | 1.1.1 | MIT | test/driver dependency |
| mime-db | 1.54.0 | MIT | test/driver dependency |
| mime-types | 3.0.2 | MIT | test/driver dependency |
| ms | 2.1.3 | MIT | test/driver dependency |
| negotiator | 0.6.3 | MIT | test/driver dependency |
| oauth4webapi | 3.8.8 | MIT | runtime |
| oidc-provider | 9.13.3 | MIT | test/driver dependency |
| on-finished | 2.4.2 | MIT | test/driver dependency |
| openid-client | 6.8.9 | MIT | runtime |
| parseurl | 1.3.3 | MIT | test/driver dependency |
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
| setprototypeof | 1.2.0 | ISC | test/driver dependency |
| split2 | 4.2.0 | ISC | test/driver dependency |
| statuses | 2.0.2 | MIT | test/driver dependency |
| toidentifier | 1.0.1 | MIT | test/driver dependency |
| tsscmp | 1.0.6 | MIT | test/driver dependency |
| type-is | 2.1.0 | MIT | test/driver dependency |
| type-is/node_modules/content-type | 2.1.0 | MIT | test/driver dependency |
| vary | 1.1.2 | MIT | test/driver dependency |
| ws | 8.22.2 | MIT | runtime |
| xtend | 4.0.2 | MIT | test/driver dependency |
| yjs | 13.6.33 | MIT | runtime |

Versions, integrity hashes and resolved URLs are recorded in [`package-lock.json`](../package-lock.json). The lockfile is authoritative if this table changes. Node.js itself has its own distribution notices.

Sources: [openid-client](https://github.com/panva/openid-client), [oidc-provider](https://github.com/panva/node-oidc-provider), [Yjs](https://github.com/yjs/yjs), [ws](https://github.com/websockets/ws), [jose](https://github.com/panva/jose), [node-postgres](https://github.com/brianc/node-postgres), and each installed package's license file. A registry audit with no reported advisories is only a point-in-time registry result; it does not prove the dependencies or application are free of vulnerabilities.
