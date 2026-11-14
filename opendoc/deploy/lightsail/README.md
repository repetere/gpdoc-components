# Single-host OpenDoc proof of concept

This recipe runs OpenDoc, Keycloak, PostgreSQL and Caddy on one Ubuntu 24.04
Lightsail Linux instance. The selected `small_3_0` plan in `us-east-1` costs
$12/month before taxes, including 2 GB RAM, 60 GB disk, public IPv4 and its
bundled transfer allowance. Do not enable snapshots, managed databases, load
balancers or other paid services without a separate budget. Transfer overages
are chargeable; this is a small demonstration, not a public bulk file service.
Stopping the instance does not stop billing: deletion is required.

The AWS account's original 12-month Free Tier has expired. Neither noncommercial
use nor this recipe grants free-tier eligibility. Check current account credits,
regional prices and AWS terms independently before creating an instance.

## Installation

Create one `small_3_0` Ubuntu 24.04 instance with `bootstrap.sh` as its user data.
Use a dedicated SSH key. Limit port 22 to the operator's current public IP;
expose only TCP 80 and 443 publicly. Attach a Lightsail static IP immediately
(free while attached) and point the selected hostname to it. No extra hosted
zone is necessary when DNS is already managed elsewhere.

Copy a verified source archive to `/opt/opendoc/source`, including this recipe.
All following commands run as root on that isolated host. The preparation
command refuses an existing private directory and must never be used to rotate
or replace a running installation's credentials.

```sh
python3 /opt/opendoc/source/opendoc/deploy/lightsail/prepare.py \
  --hostname YOUR_HOSTNAME --directory /opt/opendoc/private
docker compose -f /opt/opendoc/private/compose.json config --quiet
docker compose -f /opt/opendoc/private/compose.json build app keycloak
docker compose -f /opt/opendoc/private/compose.json up -d --wait postgres
```

Initialize each of the four fresh OpenDoc schemas using the administrative
profile, then grant the restricted runtime role its documented permissions:

```sh
for component in accounts documents live sessions; do
  docker compose -f /opt/opendoc/private/compose.json --profile admin run --rm --interactive=false admin \
    init --config /run/opendoc/server.json --component "$component"
done
docker compose -f /opt/opendoc/private/compose.json exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U opendoc_admin -d opendoc \
  < /opt/opendoc/source/opendoc/deploy/runtime-grants.sql
docker compose -f /opt/opendoc/private/compose.json --profile admin run --rm --interactive=false admin \
  account --config /run/opendoc/server.json --input /run/opendoc/owner-account.json
docker compose -f /opt/opendoc/private/compose.json up -d app keycloak caddy
```

Open `https://YOUR_HOSTNAME/`. The selected owner username and randomly generated
password are in `/opt/opendoc/private/credentials.txt`; transfer them through a
private channel. Public registration and password reset are disabled. Keycloak
administration, the master realm and management endpoints are not routed
publicly. No global administrator is bootstrapped. Identity administration must
be performed deliberately through SSH and the local Keycloak tools.

Only the selected realm's browser/OIDC paths and theme resources are exposed.
The application listener, PostgreSQL, container management and Keycloak
management listeners have no host port bindings. The application receives the
canonical Host with forwarding headers stripped, preserving its existing
ingress policy. Database connections verify the private database CA.

## Limits and acceptance

Keycloak has a 384 MB heap within a 768 MB container; OpenDoc has 256 MB,
PostgreSQL 256 MB and Caddy 128 MB limits. A 2 GB disk-backed swap file provides
emergency headroom. These settings target a few POC users. They do not meet
Keycloak's recommended production sizing and must be validated under the actual
workload. Do not automatically upgrade the plan if memory is insufficient.

Validate HTTPS, real Keycloak browser sign-in, document creation/editing,
unauthenticated denial and persistence after service restart. Observe memory,
swap, OOM counters and CPU while testing concurrent requests. Record image
digests and source commit with acceptance evidence. Keep secrets out of logs,
screenshots, source control and public artifacts.

This is one failure domain with local persistent volumes, no HA and no paid
snapshot service. Use synthetic documents. Copy encrypted backups and the
session-encryption key to an existing approved private location before retaining
valuable data. Never run `down -v` on data that must be preserved. The database
certificate expires after one year; renew it before expiry, retaining the trust
chain or planning a tested trust rotation. Caddy renews public certificates via
ACME while ports 80/443 and DNS remain reachable.

Sources: [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/),
[billing and static IP terms](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-frequently-asked-questions-faq-billing-and-account-management.html),
[Keycloak container memory guidance](https://www.keycloak.org/server/containers).
