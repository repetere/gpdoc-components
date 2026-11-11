# Portable deployment references

These are concrete architecture and configuration **targets**, not provisioned or validated cloud deployments. The default [local demo](../README.md) has volatile memory storage and development authentication. Optional [PostgreSQL](postgres.md), [pinned-key access-token](authentication.md), experimental [collaboration](collaboration.md) and [browser-login](browser-login.md) adapters now exist, but cloud provisioning, production identity-provider integration and production operations remain unvalidated. Browser login defaults to bounded in-memory sessions; an optional [PostgreSQL auth-state adapter](shared-sessions.md) shares transactions, sessions and tickets. This is separate from collaboration coordination and is not proof of a production multi-replica deployment. The [REST web editor](web-client.md) is an explicit client/host integration. Do not deploy that demo as a production service or assume the interfaces below are already implemented.

## One service contract, separate provider adapters

The target architecture separates HTTP API/web clients, authenticated collaboration workers, PostgreSQL metadata/authorization/revisions and binary object storage. The baseline needs **one PostgreSQL database** and **one private object store**, not four databases. The experimental collaboration adapter supports live fan-out within one process only. Multiple replicas require a durable fan-out/coordination design and fencing before being offered as a live service; load-balancer affinity alone is not sufficient. A search index or vector database is not required for the document foundation.

PostgreSQL should own tenants, principals, membership, document metadata, ACLs, share-link hashes, revisions, durable update ordering and audit events. Put attachments and compacted document snapshots in object storage under tenant-scoped keys. Keep small revision bodies in PostgreSQL initially if that makes atomic writes simpler. Object references must become visible only after the corresponding object is durably written; use an outbox and orphan cleanup for cross-store writes. PostgreSQL and a bucket are not an atomic transaction together.

Authorization remains server-side regardless of cloud provider or frontend brand. The storage account, bucket/container and deployment endpoints are operator configuration, never values selected by a document. An object prefix is a useful boundary but does not replace authorization or cloud IAM.

## Provider map

| Function | AWS target | Google Cloud target | Azure target | Self-managed OSS target |
| --- | --- | --- | --- | --- |
| API and collaboration | ECS Fargate behind ALB; separate services when scaling differs | Cloud Run; design for socket reconnects | Azure Container Apps, WebSocket-capable ingress | Kubernetes Deployments/Services, Envoy Gateway |
| Durable metadata/revisions | RDS PostgreSQL | Cloud SQL for PostgreSQL | Azure Database for PostgreSQL Flexible Server | PostgreSQL with CloudNativePG |
| Objects/snapshots | S3 | Cloud Storage | Blob Storage | Rook/Ceph RGW S3 API |
| Workload identity | ECS task role | Dedicated runtime service account | Managed identity | Scoped internal service credentials or local identity integration |
| Secret configuration | Secrets Manager, KMS | Secret Manager, Cloud KMS | Key Vault | Kubernetes secret encryption; optionally SOPS with offline key custody |
| Container images | ECR | Artifact Registry | ACR | Harbor internal registry |
| End-user identity | External OIDC issuer or optional Cognito | External OIDC issuer, including Google when appropriate | External OIDC issuer, including Entra when appropriate | Local Keycloak, or separately licensed local Ping deployment |
| Operations | CloudWatch | Cloud Logging/Monitoring | Azure Monitor | OpenTelemetry, Prometheus, Grafana, local logging backend |

Cloud hosting and user sign-in are independent choices. An AWS deployment can use Google or Entra sign-in; Office add-in publication does not require Azure hosting. Redirect URIs, issuer/audience validation and service credentials still need separate configuration. Internet-only identity services cannot satisfy a fully disconnected deployment.

## Configuration reference

The following keys are a **proposed production adapter contract**, not environment variables consumed by v0.8. Keep the published signed client profile separate from all server credentials.

```yaml
deployment:
  id: example-deployment
  publicOrigin: https://docs.example.test
  allowedWebOrigins: [https://editor.example.test]
identity:
  issuer: https://identity.example.test/realms/example
  apiAudience: urn:example:opendoc:api
  webClientId: opendoc-web
  desktopClientId: opendoc-desktop
  membershipSource: postgres
database:
  engine: postgresql
  connectionSecretRef: opendoc/database
  tlsMode: verify-full
objects:
  driver: s3  # s3 | gcs | azure-blob
  namespace: opendoc-documents
  prefix: deployments/example-deployment/
  authentication: workload-identity
collaboration:
  durableLog: postgres
  roomKey: tenant-id/document-id
  multiReplicaCoordinator: disabled-until-implemented
telemetry:
  enabled: false
```

The native GCS and Azure Blob drivers must implement the same behavioral contract without pretending their endpoints are S3 URLs. Required operations: bounded reads/writes, checksums, create-if-absent/conditional writes, version identity, safe retry behavior, private access and tenant-scoped deletion. Test provider-specific preconditions: S3 ETags, GCS generation matches and Azure blob ETags are not interchangeable data-integrity guarantees. A future adapter test suite must simulate timeouts after successful writes and reconcile before retrying.

### AWS evaluation target

1. Use a dedicated test account or isolated VPC/subnets and synthetic data. Record region, account, resource names, expiration date and a spending cap before provisioning.
2. API/collaboration ECS tasks in private subnets, internet-facing ALB only where appropriate, TLS via ACM, security groups limiting application and PostgreSQL paths. Use VPC endpoints for supported services; compare NAT vs endpoint costs rather than assuming either is free.
3. RDS PostgreSQL with encryption, TLS certificate verification and backups. A small single-AZ evaluation instance is not a production HA design. Keep database credentials in Secrets Manager; restrict the ECS task role to the required secret.
4. S3 bucket with Block Public Access, bucket-owner-enforced object ownership, encryption and scoped IAM. Enable versioning/lifecycle deliberately and account for noncurrent-version storage. Restrict the task role to its bucket/prefix and required methods. No static access keys in client profiles.
5. Configure ALB idle timeout, application heartbeat and client reconnect/resume together. API Gateway WebSocket APIs are not a transparent substitute for a raw binary Yjs WebSocket service: incoming binary frames are unsupported.
6. Estimate ALB, Fargate CPU/memory, RDS/storage/backups, S3 requests/storage, logs, DNS, egress, NAT/endpoints and public IPv4. Produce a region-specific estimate before an authorized test. Budget alerts notify but do not reliably impose a hard spending cap. No current dollar estimate is a guaranteed bill.

### GCP evaluation target

1. Dedicated project, region and runtime service account. Cloud Run services use that identity with only the required bucket, secret and Cloud SQL permissions.
2. Cloud SQL PostgreSQL connectivity uses the supported connector/proxy or approved private-IP path with certificate validation. Set connection pools according to max instances and database limits; autoscaling can otherwise exhaust connections.
3. Cloud Storage bucket uses uniform bucket-level access and public access prevention. Configure retention/versioning/lifecycle based on recovery requirements. Use native generation preconditions, not an S3 compatibility assumption.
4. Cloud Run WebSockets remain HTTP requests and are limited by the configured request timeout (up to 60 minutes). Clients must reconnect and resume. Session affinity is best effort; durable state cannot live only in one instance. Set min/max instances and concurrency consciously and include their cost.

### Azure evaluation target

1. Dedicated resource group/environment and managed identity. Container Apps ingress terminates TLS; validate WebSocket upgrade, connection lifecycle and scaling behavior under load before choosing production settings.
2. PostgreSQL Flexible Server in the approved network with TLS verification and tested backup/restore. Set client pool size and replica limits together.
3. Blob Storage account/container uses private access. Disable anonymous blob access and, when compatible with the chosen integration, shared-key authorization. Assign the managed identity only the required blob data role and use native ETag conditions.
4. Key Vault holds server-only configuration. Entra app registrations for web/desktop/API are separate from managed workload identity and separate from Office add-in publication. Tenant/audience/consent choices require explicit setup review.

## Fully custom, open-source Kubernetes target

The infrastructure can use Kubernetes, Envoy Gateway, cert-manager, CloudNativePG/PostgreSQL, Rook/Ceph, Keycloak, Harbor and OpenTelemetry/Prometheus/Grafana. Pin versions/digests and verify the exact distribution, images and dependencies' licenses. Do not equate a hosted commercial service with its open-source project. Local Ping may be an enterprise identity option, but it is not part of an all-open-source bill of materials.

- Namespaces separate application, identity, storage, ingress and observability. NetworkPolicies default deny and explicitly allow DNS, ingress, PostgreSQL, object storage, local identity and telemetry as required. Verify the chosen CNI actually enforces them.
- Use non-root containers, dropped capabilities, seccomp, read-only roots where supported, resource limits, PodDisruptionBudgets and anti-affinity. Separate tenant authorization from namespace isolation.
- CloudNativePG provides the operator and lifecycle; it does not remove the need to test restore/PITR, operator recovery and PostgreSQL major-version upgrades. Rook/Ceph needs adequate failure domains and capacity planning, not a single toy pod called HA.
- Use Gateway API with a maintained controller such as Envoy Gateway. Do not start a new deployment on the retired ingress-nginx project.
- For disconnected installation, mirror every OCI image, chart, package and required frontend asset. Maintain signed bundle manifests, SBOMs, license notices and internal CA trust. An install that still downloads from public registries is not air-gapped.
- Local identity must include discovery, authorization/token endpoints, JWKS rollover and logout/revocation as designed. Keep DNS, time synchronization, backups, certificates and administration available inside the boundary. External Google/Entra sign-in cannot be assumed to work offline.
- Default telemetry/exporters off. Disable external fonts, CDN scripts, extension auto-updates, marketplace checks, crash reporting and remote AI calls unless specifically allowed by deployment policy. Demonstrate denied egress in tests, not by a configuration label.

## Local shared-primary collaboration option

The opt-in [shared live synchronization](shared-collaboration.md) reference lets
separate collaboration processes poll committed revisions from the **same fixed
PostgreSQL primary and live-document schema**. The default remains local fanout.
Every instance must use the same authorization policy and current membership
source. Browser deployments that route authentication across instances also need
the separate [shared session adapter](shared-sessions.md), matching trust
configuration and encryption-key operations. A load balancer does not provide
any of these guarantees by itself.

Use bounded pools, statement/transaction timeouts and connection limits. Polling
adds database and authorization reads per active room and receiver; load, quota
pressure, network partitions and rolling deployments need deployment-specific
testing. Do not switch a running pool to an independent database, restored clone,
read replica or divergent primary. This reference has no distributed ownership
lease, database failover fencing, multi-primary protocol or recovery-epoch
negotiation. Operator-controlled database failover/restore requires a separate
design and evidence before enabling production failover.

## Optional guarded local persistence

The [guarded live storage guide](guarded-live-storage.md) provides opt-in
transaction-bound account membership checks and a fresh guarded schema with a
pinned authority identifier, durable checkpoints and namespace-wide quarantine.
Authentication, account administration and live writes must share the documented
fixed database and lock protocol. Account locks can delay revocation behind an
already-authorized write; guarded reads serialize and increase contention.

The history option requires an explicitly initialized fresh schema. Older
binaries reject it; no implicit migration, history adoption or quarantine reset
is implemented. One detected document inconsistency blocks the entire namespace,
including other tenants. Recovery remains an operator-owned design and review.
A database restored or cloned together with its checkpoints and authority ID
cannot be distinguished by this database-local guard. It is not HA, failover
fencing, independent backup validation or proof of recovery readiness.

## Required acceptance before calling a target ready

1. Build reproducible images and migrations from the released sources with provenance and license inventory.
2. Complete login/logout, PKCE, state/nonce, issuer/audience/algorithm checks, expiry, key rollover and negative authorization tests. Never send an ID token to an API that expects an access token. Resolve membership server-side and recheck on reconnect or revoked access.
3. Exercise tenant crossing, revoked roles, public-link policy, replay, CSRF/CORS, malicious content and large payloads. Test every enabled sharing route, not just normal document reads.
4. Converge multiple editors through disconnects, process restarts, stale leaders and duplicate updates. Room ownership/fencing and durable sequencing must prevent split-brain writes.
5. Restore PostgreSQL and object snapshots to a clean environment, reconcile references and measure recovery objectives. Document destructive cleanup and rollback behavior.
6. Test TLS, networking, least-privilege identity, cloud scaling, timeouts, rolling deploys and storage preconditions against actual provider services with an approved budget.
7. For air-gap claims, install and run with public egress blocked, inspect attempted destinations and capture evidence for first-run, login, key rollover, edits, uploads, exports, restarts and upgrades.

## Primary references

Consult current provider documentation and region-specific pricing before provisioning. These links support the design choices, not an implementation certification.

- [AWS Fargate task roles](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [ALB connection attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html), [API Gateway WebSocket binary limitations](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api-develop-binary-media-types.html), [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
- [Cloud Run WebSockets](https://cloud.google.com/run/docs/triggering/websockets), [Cloud SQL PostgreSQL from Cloud Run](https://cloud.google.com/sql/docs/postgres/connect-run), [Cloud Storage request preconditions](https://cloud.google.com/storage/docs/request-preconditions).
- [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview), [Blob Storage concurrency](https://learn.microsoft.com/en-us/azure/storage/blobs/concurrency-manage), [Azure PostgreSQL TLS](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/security-connect-tls).
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), [Envoy Gateway](https://gateway.envoyproxy.io/), [ingress-nginx retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), [CloudNativePG](https://cloudnative-pg.io/documentation/), [Rook Ceph](https://rook.io/docs/rook/latest-release/Getting-Started/intro/), [Keycloak server administration](https://www.keycloak.org/docs/latest/server_admin/), [Harbor](https://goharbor.io/docs/).
