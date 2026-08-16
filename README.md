# Squid Control Plane

A modern management layer for [Squid](http://www.squid-cache.org/) forward
proxies. It turns hand-edited `squid.conf` files into a reviewable, auditable
product: access policies, proxy identities, LDAP integration and a generated
configuration you can read before it is deployed.

It runs entirely from `docker compose`. The target server needs Docker and Git
and nothing else — no Node.js, no npm, no PostgreSQL, no Redis.

> **Project status: early, actively built.** The control plane, the policy
> engine, the configuration compiler, the node agent and the traffic log
> pipeline are verified end to end against real Squid 6 nodes and a real
> OpenLDAP: all five authentication acceptance scenarios pass, two nodes enrol
> and converge on a policy change on their own, and real requests are ingested
> and attributed to the identity that made them. What is missing is per-node
> configuration and staged rollouts — every node currently receives the same
> policy. See [Status and roadmap](#status-and-roadmap) for the full breakdown.

---

## Contents

- [Why](#why)
- [Features](#features)
- [Screens](#screens)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [The two identity planes](#the-two-identity-planes)
- [Authentication modes](#authentication-modes)
- [Open proxy safety](#open-proxy-safety)
- [Proxy nodes — one or many](#proxy-nodes--one-or-many)
- [Self-service portal](#self-service-portal)
- [Traffic logs](#traffic-logs)
- [Generated Squid configuration](#generated-squid-configuration)
- [API](#api)
- [Operating](#operating)
- [Security](#security)
- [Development](#development)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Status and roadmap](#status-and-roadmap)
- [Contributing](#contributing)
- [Licence](#licence)

---

## Why

Squid is excellent at what it does and unpleasant to administer at scale. The
usual failure modes are always the same:

- the policy lives in one long file that only one person understands,
- nobody can say who changed a rule, or why,
- proxy user accounts drift apart from the directory,
- and every so often somebody produces an open proxy by accident.

This project addresses exactly those problems. It keeps a structured model of
your policy, compiles it deterministically into `squid.conf`, records every
change, and refuses to let an open proxy happen unnoticed — while still
allowing one when an administrator genuinely wants it.

Three properties are treated as non-negotiable and none is traded for another:

| Modern | Reliable | Portable |
| --- | --- | --- |
| Design system, dark and light, keyboard-first, real empty/error states | Deterministic compilation, validation before deployment, full audit trail | `git clone` + `docker compose build`, local images, no registry |

---

## Features

### Access policy

- Ordered access rules with **source**, **identity**, **destination**,
  **schedule** and **action**; first match decides.
- Named **networks** so rules read `Guest network` instead of `10.20.0.0/24`.
- **Listeners** with an explicit warning when they bind to every interface.
- A **rule simulator**: enter a source IP and an identity and see which rule
  decides, with the reason for every rule that did not match.
- **Deterministic compilation** — the same policy always produces byte
  identical output, which is what makes review and diffing meaningful.

### Proxy identity and authentication

- Three global modes: **`DISABLED`**, **`OPTIONAL`**, **`REQUIRED`**.
- **Several providers active at once**, in a defined priority order. Local
  accounts and one or more LDAP directories authenticate against the same
  proxy.
- **Local proxy users and groups** with full lifecycle management.
- **LDAP provider** with search-then-bind, StartTLS/LDAPS, group lookup,
  RFC 4515 filter escaping and a connection test that reports each step.
- **Provider failure isolation**: an LDAP outage never disables local accounts.
  Emergency and service accounts keep working.
- **Logical groups** that unify a local group and a directory group under one
  policy name, so rules do not care where an identity comes from.
- **`UNAUTHENTICATED` is a first-class identity**, not a special case: guest
  networks are expressed as a normal rule.
- **Authentication test page**: verify credentials exactly the way Squid would,
  with a per-provider breakdown.

### Self-service portal

Proxy users sign in to the same web application with their **proxy** account
and get a small, separate portal:

- see which rules apply to them, in plain language,
- change their own password (local accounts),
- review their recent sign-ins.

They never see an administration surface: a portal session carries no control
plane permission and is rejected by every administrative endpoint.

### Proxy nodes — one or many

The control plane runs **separately** from the proxies. Nodes are added in two
steps and the tenth is the same work as the first:

1. **Declare the node** in `Infrastructure → Nodes` and issue a one-time
   enrolment token (valid one hour, single use, shown once).
2. **Run the agent** on the machine that should serve as the proxy:

```bash
export SCP_API_URL=https://control-plane.example.internal
export SCP_ENROLLMENT_TOKEN=scpe_...

docker compose -f deployments/agent/compose.yml up -d
```

That host needs Docker and network access to the control plane — nothing else.

The agent **pulls**: it exchanges the token for its own credential, fetches the
compiled configuration, writes every artefact with the ownership Squid's
helpers need, validates with `squid -k parse`, applies it with
`squid -k reconfigure` and reports back. Consequences worth knowing:

- **No inbound access to the proxy is required.** A node behind NAT or a
  one-way firewall enrols exactly like one in the next rack.
- **A broken configuration is never applied.** Validation happens on a staged
  file; the node keeps serving what it already had and reports the failure.
- **Policy changes converge on their own.** Change a rule once, every enrolled
  node picks it up on its next poll.
- **Drift is visible.** Each node reports the hash of what it runs; the control
  plane compares it to what it would send and flags the difference.
- **Credentials are revocable per node**, and revoking one does not disturb the
  others.

### Traffic logs

Each node's agent ships its Squid access log to the control plane, which parses
and stores it:

- **Filter by identity**, which is what an operator actually asks: any,
  authenticated only, unauthenticated only, or one specific user — plus
  destination host, outcome and node.
- **A challenge is not a denial.** A `407` is recorded as "challenged", so the
  dashboard does not report a refusal for the first request of every session.
- **Bounded storage.** Individual requests are kept for `TRAFFIC_RETENTION_DAYS`
  (30 by default); hourly counters outlive them and are what the dashboard and
  the portal read, so neither gets slower as the product runs.
- **URLs are treated as personal data and are off by default.** Only the
  destination host and port are recorded, never the path or query string.
  Full URL logging is switched on deliberately under System, with a plain
  statement of what that means for the people using the proxy.
- **Portal statistics are scoped to the signed-in user** and to nothing else.

### Safety and accountability

- **Open proxy detection.** `Authentication = Disabled` together with
  `Default access = Allow` on a widely reachable listener produces a blocking
  warning that must be acknowledged explicitly. The acknowledgement is recorded
  with the operator's name. The configuration is never forbidden — only never
  accidental.
- **Dead rule detection**: rules that can never match in the current mode are
  reported instead of silently doing nothing.
- **Append-only audit log**, enforced by a database trigger, with automatic
  redaction of anything password-shaped at the sink.
- **RBAC** with four built-in roles and per-route permissions that fail closed.

### Operations

- Multi-stage Docker builds, OCI image labels, build metadata surfaced in the
  UI and on `/health/version`.
- Separate `frontend` / `backend` / `database` networks; PostgreSQL and Redis
  never get a host port.
- Forward-only SQL migrations with checksums, run as an explicit step.
- `install` / `update` / `backup` / `restore` / `healthcheck` wrapper scripts
  that contain no hidden logic.

---

## Screens

The UI is a single application with two faces.

**Administrators** get the full control plane:

```text
┌───────────────┬──────────────────────────────────────────────────┐
│ Overview      │  Authentication                                  │
│  Dashboard    │  How clients identify themselves against the …   │
│               │                                                  │
│ Infrastructure│  ⚠ This configuration may create an              │
│  Nodes        │    unauthenticated open proxy                    │
│  Listeners    │                                                  │
│               │  Authentication mode                             │
│ Policies      │   ○ Disabled   ● Optional   ○ Required           │
│  Access rules │                                                  │
│  Networks     │  Providers                                       │
│               │   Local users     ● Healthy      Priority 10     │
│ Authentication│   Company LDAP    ● Healthy      Priority 20     │
│  Overview     │                                                  │
│  Providers    │                                                  │
│  Local users  │                                                  │
│  Groups       │                                                  │
│  Test         │                                                  │
└───────────────┴──────────────────────────────────────────────────┘
```

**Proxy users** get the self-service portal — three tabs, no sidebar, no
administration:

```text
  Proxy account                                    alice    ☾   ⇥

  Hello, alice
  Your proxy account: what you may reach, and how to change your password.

  [ My account ]  [ My access ]  [ My activity ]

  ALLOW   You may reach .dev.example.
          Developer services
  DENY    You are blocked from .social.example.
          No social media
```

---

## Quick start

Requirements on the server: **Docker** (with the Compose v2 plugin) and
**Git**.

```bash
git clone <repository-url>
cd squid-control-plane

cp .env.example .env
```

Fill in the secrets — the application refuses to start with the example values:

```bash
openssl rand -base64 32   # -> JWT_SECRET
openssl rand -base64 32   # -> SECRET_ENCRYPTION_KEY
```

Also set `POSTGRES_PASSWORD` (and keep `DATABASE_URL` in sync) and
`BOOTSTRAP_ADMIN_PASSWORD`.

Then:

```bash
./scripts/install.sh
```

Open <http://localhost:8080> and sign in as **Administrator** with
`BOOTSTRAP_ADMIN_USERNAME`. The UI reminds you to change the bootstrap password.

<details>
<summary>What <code>install.sh</code> runs</summary>

```bash
docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml build

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml run --rm migrate

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml up -d --remove-orphans
```

`--env-file .env` is required: Compose otherwise looks for `.env` next to the
first compose file rather than at the repository root.

</details>

Verify at any time:

```bash
./scripts/healthcheck.sh
curl -fsS http://localhost:8080/api/health/ready
```

---

## Configuration

Everything is configured through `.env`. Full template in
[`.env.example`](.env.example).

| Variable | Required | Default | Purpose |
| --- | :---: | --- | --- |
| `JWT_SECRET` | ✔ | — | Signs session tokens. Minimum 32 characters. |
| `SECRET_ENCRYPTION_KEY` | ✔ | — | AES-256-GCM key for provider secrets. Must be 32 bytes, base64. |
| `POSTGRES_PASSWORD` | ✔ | — | Database password. |
| `DATABASE_URL` | ✔ | — | Connection string; keep in sync with the password. |
| `BOOTSTRAP_ADMIN_USERNAME` | | `admin` | First control plane account, created once. |
| `BOOTSTRAP_ADMIN_PASSWORD` | | — | Required only while no account exists. |
| `WEB_PORT` | | `8080` | The only published host port. |
| `JWT_TTL_SECONDS` | | `43200` | Session lifetime. |
| `PROXY_PASSWORD_HASH_FORMAT` | | `sha512-crypt` | `sha512-crypt` or `md5-crypt`, matched to your Squid helper. |
| `LOG_LEVEL` | | `info` | `debug` also enables request logging. |
| `SEED_DEMO_DATA` | | `false` | Seeds example networks, groups, users and rules. Never enable in production. |
| `APP_VERSION`, `GIT_SHA`, `BUILD_DATE` | | derived | Build metadata; the scripts fill these from the checkout. |

> **Keep `.env` safe.** `SECRET_ENCRYPTION_KEY` is not stored in the database.
> A database backup without it cannot decrypt LDAP bind credentials.

---

## How it works

```text
                         ┌──────────────┐
   browser ─────────────▶│  web (nginx) │  static SPA + /api reverse proxy
                         └──────┬───────┘
                                │ frontend
                         ┌──────▼───────┐
                         │  api (node)  │  Fastify, REST under /api/v1
                         └──┬────────┬──┘
              backend       │        │      database
                     ┌──────▼──┐  ┌──▼────────┐
                     │  redis  │  │ postgres  │
                     └─────────┘  └───────────┘
```

A policy change travels through a single path:

```text
UI  ──▶ API ──▶ validation ──▶ PostgreSQL
                            └▶ audit event
                            └▶ configuration IR
                                 └▶ Squid compiler
                                      └▶ squid.conf + auth artefacts
```

The **intermediate representation (IR)** is the contract between the product
model and any particular Squid version. The policy engine and the compiler both
consume it and neither touches a database, which is what makes them fully unit
testable. Squid-version specifics (helper paths, directive spellings) live in a
version adapter.

---

## The two identity planes

This is the central design decision, and it is deliberate:

| | Control plane identity | Proxy identity |
| --- | --- | --- |
| **Used for** | web UI login, API access, RBAC, administration | authenticating clients against Squid |
| **Tables** | `cp_users`, `cp_roles`, `cp_user_roles` | `proxy_users`, `proxy_groups`, `auth_providers` |
| **Password hashing** | `scrypt` | `crypt(3)` — a Squid helper must verify it |
| **Session audience** | `control-plane` | `proxy-portal` |
| **Holds permissions** | yes | never |

They share no table, no foreign key and no password column. Creating an
administrator does not create a proxy user, and vice versa.

The **web application is shared** — both sign in at the same URL — but the
session token carries an audience claim that is verified on every request. A
portal token presented to an administrative endpoint is rejected outright, even
though both tokens are signed with the same key.

---

## Authentication modes

| Mode | Behaviour |
| --- | --- |
| `DISABLED` | Squid never requests credentials. Policies match on source, destination, port and schedule. Suitable for a trusted network with a transparent forward proxy. |
| `OPTIONAL` | Authenticated and anonymous clients coexist. Employees authenticate via LDAP and get full access; the guest network gets restricted access without credentials. |
| `REQUIRED` | Clients must authenticate before any rule requiring an identity applies. Anonymous clients receive a proxy authentication challenge. |

Identity matchers available in every rule:

```text
ANY               AUTHENTICATED      UNAUTHENTICATED
USER (specific)   GROUP (local, directory or logical)
```

Example of a mixed-mode policy:

```text
Rule 10   Guest network  + Unauthenticated  → ports 80, 443   ALLOW
Rule 20   Any            + Authenticated    → any             ALLOW
Rule 30   Any            + Any              → any             DENY
```

> **A Squid caveat we surface rather than hide:** Squid challenges a client as
> soon as it evaluates any rule referencing `proxy_auth`. An unauthenticated
> rule placed *below* an authenticated one therefore still triggers a
> credentials prompt. The compiler detects that ordering and emits an
> `OPTIONAL_MODE_RULE_ORDER` warning.

---

## Open proxy safety

When `Authentication = Disabled` meets `Default access = Allow`, the control
plane inspects the configured listeners and source networks and produces:

```text
Warning

This configuration may create an unauthenticated open proxy.

Clients from the configured source networks can use this
proxy without credentials.

Verify listener addresses, firewall rules and allowed
source networks before deployment.
```

The save is rejected with `409 OPEN_PROXY_CONFIRMATION_REQUIRED` until the
operator ticks an explicit acknowledgement. The acknowledgement, the operator
and the timestamp go into the audit log, and the warning stays visible on the
dashboard afterwards.

Severity is `CRITICAL` when a listener is reachable beyond private address
space and `WARNING` when every listener is bound to a private address — because
an open proxy inside a lab network is a legitimate thing to want.

---

## Self-service portal

Proxy users sign in at the same address and choose **Proxy user** on the login
screen. Both local and LDAP accounts work.

**My account** — username, display name, authenticating provider, groups, when
the password was last changed. Local accounts can change their password (the
current one must be proven first, and the new one must differ). Directory
accounts are told where their password is managed instead.

**My access** — the access profile, produced by the *same* policy engine the
proxy uses, evaluated against the user's identity and groups:

```text
ALLOW   You may reach .dev.example.                    Developer services
DENY    You are blocked from .social.example.          No social media
ALLOW   You may reach any destination on port 80, 443  when connecting from
        Guest network                                  Guest access
```

Plus the notes that make it honest: rules are evaluated top to bottom, entries
limited to a network only apply from that network, and what the default policy
does with everything else.

**My activity** — sign-ins and failed sign-ins over the last 30 days, scoped
strictly to that account. Per-request traffic statistics are shown as
unavailable rather than as a fabricated zero, because the log pipeline does not
exist yet.

---

## Generated Squid configuration

`Configuration → Review` shows exactly what would be written to a node.

```squid
# Generated by Squid Control Plane 0.1.0
# Adapter:    Squid 6 (Debian/Ubuntu layout) (squid-6-debian)
# IR version: 1.0.0
#
# Do not edit on the node. Changes are overwritten on the next deployment.

# ------ Proxy authentication - mode REQUIRED ------
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/scp/local_users
auth_param basic children 20 startup=0 idle=1 concurrency=0
auth_param basic realm Squid Proxy
acl scp_authenticated proxy_auth REQUIRED

# ------ Source networks ------
acl scp_net_guest_network src 10.20.0.0/24

# ------ Identity groups ------
acl scp_grp_local_services proxy_auth service-api service-batch

# ------ Access rules ------
# Mode REQUIRED: clients without credentials are challenged before any rule runs.
http_access deny !scp_authenticated

# Rule 10 - Services to internal APIs
http_access allow scp_grp_local_services scp_dst_r10_dom scp_dst_r10_port

# Default access policy
http_access deny all
```

Alongside `squid.conf` the compiler produces the artefacts the providers need:

| Artefact | Contents |
| --- | --- |
| `/etc/squid/scp/local_users` | NCSA/htpasswd file with `crypt(3)` hashes. Marked sensitive: never displayed in the UI and never returned by the review endpoint. |
| `/etc/squid/scp/scp_multi_basic_auth` | Generated helper multiplexer, emitted when more than one provider is enabled — Squid accepts only one basic auth helper, so this one queries them in priority order and skips a provider that is down. |
| `/etc/squid/scp/secrets/<provider>.secret` | Bind password for an LDAP provider, read by the helpers via `-W`. Sensitive. |

Each artefact also declares the **owner and group** it must have on the node,
not just a file mode: Squid drops privileges before starting its helpers, so a
password file owned by `root:root` makes every request answer `407`.

Sensitive artefacts are redacted by `GET /configuration/preview`, which is what
the UI uses. They are only available through `GET /configuration/export`, which
requires the `CONFIG_DEPLOY` permission and is audited on every call — that is
the channel the node agent will use, and `scripts/export-config.mjs` is the
manual stand-in for it today.

Password format is chosen to match the helper that actually verifies it:
`sha512-crypt` (`$6$`) by default, `md5-crypt` (`$1$`) for older helpers. Both
implementations are verified against `openssl passwd` reference vectors in the
test suite — that is what guarantees `basic_ncsa_auth` can read the file.

---

## API

REST under `/api/v1`, bearer token authentication. Health endpoints sit outside
the versioned prefix.

| Area | Endpoints |
| --- | --- |
| Health | `GET /api/health/live`, `/ready`, `/version` |
| Control plane session | `POST /session`, `GET /session`, `DELETE /session`, `POST /session/password` |
| Proxy authentication | `GET /proxy-auth/overview`, `PATCH /proxy-auth/config` |
| Providers | `GET/POST /auth-providers`, `PATCH/DELETE /auth-providers/:id`, `POST /auth-providers/:id/test` |
| Authentication test | `POST /auth-test` |
| Proxy users | `GET/POST /proxy-users`, `GET/PATCH/DELETE /proxy-users/:id`, `POST /proxy-users/:id/password` |
| Proxy groups | `GET/POST /proxy-groups`, `PATCH/DELETE /proxy-groups/:id` |
| Policies | `GET/POST /access-rules`, `PATCH/DELETE /access-rules/:id`, `POST /access-rules/reorder`, `POST /access-rules/simulate` |
| Networks, listeners | `GET/POST/PATCH/DELETE /networks`, `/listeners` |
| Configuration | `GET /configuration/preview`, `POST /configuration/compile`, `GET /configuration/versions[/:id]` |
| Dashboard, audit | `GET /dashboard`, `GET /audit-events` |
| Nodes | `GET/POST /nodes`, `PATCH/DELETE /nodes/:id`, `POST /nodes/:id/enrollment-token`, `POST /nodes/:id/revoke` |
| Node agents | `POST /agent/enroll`, `GET /agent/config`, `POST /agent/status`, `POST /agent/logs` |
| Traffic | `GET /traffic/events`, `GET /traffic/summary` |
| Self-service portal | `POST /portal/session`, `DELETE /portal/session`, `GET /portal/me`, `POST /portal/password`, `GET /portal/access-profile`, `GET /portal/activity` |

Every administrative route declares the permission it needs and fails closed.
Errors use one shape:

```json
{ "error": { "code": "OPEN_PROXY_CONFIRMATION_REQUIRED", "message": "…", "details": null } }
```

---

## Operating

```bash
./scripts/install.sh                     # first installation
./scripts/healthcheck.sh                 # container status + endpoint probes
./scripts/backup.sh                      # → ./backups/squidcp-<timestamp>.sql.gz
./scripts/restore.sh backups/<file>      # restore a dump
./scripts/update.sh                      # build, migrate, restart
```

**Updating** is a checkout plus `./scripts/update.sh`. Migrations are
forward-only and recorded with checksums, so an edited migration is detected
instead of silently diverging between environments.

**Rolling back** the application is a git operation:

```bash
git checkout v1.0.0
docker compose --env-file .env -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml build
docker compose --env-file .env -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml up -d
```

Because migrations only move forward, every release documents whether an
application rollback is supported and which schema version it requires. If a
rollback crosses an incompatible schema change, restore the backup instead.

Full detail in [`docs/deployment.md`](docs/deployment.md).

**TLS** is not terminated by this stack. Put a reverse proxy in front; the API
honours `X-Forwarded-For` so audit entries keep real client addresses.

---

## Security

- Control plane passwords: `scrypt` with per-user salt and recorded parameters.
- Proxy passwords: `crypt(3)` in the format the Squid helper can verify. Never
  returned by the API, never logged, never part of an audit payload — enforced
  centrally at the audit sink, not per call site.
- LDAP bind credentials: AES-256-GCM at rest with a key outside the database.
- LDAP filter values are escaped per RFC 4515; injection attempts are covered by
  tests.
- Login and authentication-test endpoints are rate limited per source address
  *and* per account.
- The audit log is append-only at the database level.
- Strict CSP on the web image; the UI loads no external asset, no webfont and
  no CDN script, so it works in an air-gapped deployment.
- PostgreSQL and Redis are never published to the host.

The full threat model, including what is *not* covered, is in
[`docs/architecture/threat-model.md`](docs/architecture/threat-model.md).

Found a security issue? Please report it privately rather than opening a public
issue.

---

## Development

The Docker development environment stays functional at all times:

```bash
cp .env.example .env      # fill in the secrets as above
docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.dev.yml up --build
```

- Web with hot reload: <http://localhost:5173>
- API: <http://localhost:3000>
- PostgreSQL on `127.0.0.1:5432` for `psql`

Running the apps natively is optional; if you do, you need Node.js 22 and
`npm ci` at the repository root.

### UI contributions

The design system in `packages/ui` is the single source of truth. Before
creating a component, check whether one exists; extend it rather than adding a
near-duplicate. Feature code uses design tokens — no hard-coded colours,
spacing or durations. Every page implements loading, empty, error and success
states, works in both themes, and is keyboard operable. The contract is written
down in [`docs/design/`](docs/design/).

---

## Project layout

```text
apps/api            Fastify API, SQL migrations, provider adapters, services
apps/web            React + Vite single page application
apps/agent          node agent: enrols, pulls configuration, ships access logs
packages/shared     domain core: policy IR, engine, Squid compiler, crypt(3)
packages/ui         design system: tokens and components
deployments/        docker compose stack and the nginx configuration
docs/design         UX architecture: principles, navigation, tokens, components
docs/architecture   architecture overview, threat model, ADRs
scripts/            install, update, backup, restore, healthcheck, verify-e2e
```

`packages/shared` depends on nothing but the standard library, and `apps/*`
depend on `packages/*` and never the other way round. That is what keeps the
policy engine and the compiler testable without a database.

---

## Testing

```bash
npm ci
npm run build --workspace @scp/shared
npm run test  --workspace @scp/shared     # domain core
npm run test  --workspace @scp/api        # security primitives
npm run typecheck --workspace @scp/web
```

Against a running stack:

```bash
SCP_ADMIN_PASSWORD=<your-admin-password> ./scripts/verify-e2e.sh
SCP_ADMIN_PASSWORD=<your-admin-password> ./scripts/verify-squid.sh
SCP_ADMIN_PASSWORD=<your-admin-password> ./scripts/verify-nodes.sh
SCP_ADMIN_PASSWORD=<your-admin-password> ./scripts/verify-traffic.sh
```

`verify-e2e.sh` covers the API: authentication modes, wrong and unknown
credentials, password non-disclosure, audit redaction, the open proxy
acknowledgement flow, configuration compilation, mixed-mode policy evaluation,
the self-service portal, and the audience boundary between the two identity
planes.

`verify-nodes.sh` runs two real proxy nodes with their agents: enrolment,
configuration pull, convergence after a policy change, single-use tokens and
credential revocation. `verify-traffic.sh` drives real requests through a node
and checks they are ingested, parsed, filtered per identity and aggregated.

`verify-squid.sh` starts a real Squid 6, a real OpenLDAP and an origin server,
then for each acceptance scenario configures the control plane, exports the
compiled configuration, validates it with `squid -k parse`, boots Squid with it
and drives actual requests through the proxy. It is the test that proves the
generated `crypt(3)` hashes are readable by `basic_ncsa_auth`.

CI runs unit tests, typecheck, `docker compose build`, a fresh installation and
the end-to-end verification on every pull request. A build failure blocks the
merge.

---

## Status and roadmap

**Working today, verified against a real Squid:** control plane with RBAC and
audit, proxy identity management (local + LDAP, multiple providers in
parallel), all three authentication modes, policy engine with five identity
matchers, deterministic Squid compilation, open proxy detection, self-service
portal, full Docker Compose deployment.

**Not there yet:**

| | |
| --- | --- |
| Per-node configuration | Every node receives the same policy. Node groups and site-specific listeners are not modelled yet. |
| Staged rollouts | A policy change reaches all nodes at once; there is no canary or ring deployment. |
| Enforcing "anonymous only" in optional mode | Squid challenges on any `proxy_auth` reference, so such a rule also matches authenticated clients. The compiler reports the widening. |

| TLS inspection, CA management | Deliberately out of 1.0; planned for 1.1. |
| Cache management, upstream proxies | Planned for 1.2. |
| Node groups, listener profiles, per-group configuration | Next up — see ADR 0003. |
| Staged rollouts (serial, canary) | Next up after the architecture adjustment. |
| Rule editor wizard, schedules in the editor, drag-to-reorder | The API supports them; the editor does not expose all of it yet. |
| Control plane user administration UI | Roles and users exist and are seeded; there is no screen yet. |

A complete, verified breakdown — including known limitations and the exact
commands used to verify each claim — is in [`docs/status.md`](docs/status.md).

---

## Contributing

Issues and pull requests are welcome. Two rules matter more than the rest:

1. **Do not invent data.** A metric without a backing source renders its empty
   state and says so. A fabricated dashboard number is treated as a bug.
2. **Use the design system.** New UI goes into `packages/ui` first, with all
   its states and both themes, and is then consumed by feature code.

Before opening a pull request:

```bash
npm run test --workspace @scp/shared
npm run test --workspace @scp/api
npm run typecheck --workspace @scp/web
docker compose --env-file .env -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml build
```

Architecture decisions live in `docs/architecture/adr/`. If a change contradicts
one, write a new ADR rather than editing the old one.

---

## Licence

See [`LICENSE`](LICENSE).

Squid is a trademark of its respective owners. This project is not affiliated
with the Squid project.
