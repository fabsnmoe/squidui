# Implementation status

Honest account of what exists today, verified against the running stack on
2026-08-16. Anything not listed as implemented is not implemented, regardless
of whether the plan mentions it.

## Verified

Reproduce with `./scripts/install.sh`, `./scripts/healthcheck.sh` and
`SCP_ADMIN_PASSWORD=... ./scripts/verify-e2e.sh`.

| Check | Result |
| --- | --- |
| `npm run test --workspace @scp/shared` | 105 tests pass |
| `npm run test --workspace @scp/api` | 30 tests pass |
| `npm run typecheck --workspace @scp/web` | clean, strict mode |
| `docker compose build` (prod overlay) | both images build from a plain checkout |
| `docker compose run --rm migrate` | schema applied, bootstrap idempotent |
| `docker compose up -d` | postgres, redis, api, web all healthy |
| `GET /api/health/ready` | `200 {"status":"ready"}` |
| `./scripts/verify-e2e.sh` | 44 checks pass |
| `./scripts/verify-squid.sh` | 38 checks pass against a real Squid and OpenLDAP |
| `./scripts/verify-nodes.sh` | 26 checks pass across two real proxy nodes with their agents |
| `./scripts/verify-traffic.sh` | 23 checks pass: real requests ingested, parsed, filtered and aggregated |
| Web UI | login, dashboard, local user management and the portal verified in a browser |

### Verified against a real Squid

`scripts/verify-squid.sh` runs the acceptance scenarios of `PRODUCT.md` §27
end to end: it configures the control plane through the API, exports the
compiled configuration, validates it with `squid -k parse`, starts Squid 6 with
it and drives real requests through the proxy.

| Scenario | Result |
| --- | --- |
| A — authentication disabled, allow any | anonymous client reaches the origin |
| B — required, local provider | anonymous 407, local user 200, wrong password 407, unknown user 407 |
| C — LDAP against OpenLDAP | bind, search base, user authentication, wrong password rejected |
| D — local and LDAP in parallel | both authenticate, through the generated helper multiplexer |
| E — optional mode | anonymous guest 200 and authenticated member 200 at the same time |
| Provider failure isolation | local keeps working while LDAP is down, outage reported as unavailable, recovery works |

Scenario B is the proof of the whole crypt(3) chain: a password hashed by this
project's own SHA-512-crypt implementation, written into the generated NCSA
file, verified by stock `basic_ncsa_auth`. The unit tests additionally check
both crypt implementations against known-answer vectors from
`openssl passwd -6` and `openssl passwd -1`.

### Defects this found

Testing against a real Squid surfaced four bugs that no unit test would have
caught. All four are fixed and now carry regression tests.

1. **Artefact ownership was missing from the contract.** The compiler declared
   mode `0640` but no owner, so the NCSA file landed as `root:root`. Squid
   drops privileges before starting helpers, `basic_ncsa_auth` died with
   "Permission denied", and *every* request answered 407. The artefact contract
   now carries `owner`/`group` from the version adapter.
2. **`UNAUTHENTICATED` was compiled as `!proxy_auth`.** Squid challenges a
   client as soon as it evaluates any ACL backed by `proxy_auth` — including a
   negated one — so the rule challenged exactly the anonymous clients it was
   meant to admit. Scenario E returned 407 instead of 200. It now compiles
   without an identity term, and the widening is reported as a compiler
   warning.
3. **The LDAP bind password file was referenced but never generated.** The
   helper command passed `-W /etc/squid/scp/secrets/<key>.secret` to a file the
   compiler never emitted, so directory authentication could not bind. The
   compiler now emits it when secrets are supplied (export path only).
4. **The LDAP client attempted TLS on plain `ldap://`.** `tlsOptions` was
   always passed to `ldapts`, which made every cleartext provider fail with
   "socket disconnected before secure TLS connection was established". It is
   now only passed when TLS is actually used.

## Implemented

### Phase 0 — architecture and UX
- `docs/design/` complete: principles, navigation, layout, colours, typography,
  components, interaction patterns, accessibility.
- `docs/architecture/`: overview, threat model, two ADRs.

### Phase 1 — repository, Docker, design system, skeleton
- npm workspace monorepo: `packages/shared`, `packages/ui`, `apps/api`,
  `apps/web`.
- Multi-stage Dockerfiles for API and web, build context at the repository
  root, OCI labels, build metadata, healthchecks.
- `deployments/compose/{compose,compose.dev,compose.prod}.yml`, three networks,
  named volumes, no host port for postgres or redis.
- `scripts/{lib,install,update,backup,restore,healthcheck,verify-e2e}.sh`.
- CI workflow: unit tests, typecheck, `docker compose build`, fresh install
  plus end-to-end verification.
- Design tokens and component library; app shell with sidebar, topbar, theme
  system, command palette, routing, error boundary and toasts.

### Phase 2 (slice) — control plane identity
- Separate `cp_*` tables, scrypt password hashing, HS256 sessions, four
  built-in roles, permission checks per route that fail closed.
- Audit log with a database-level append-only trigger and central payload
  redaction.
- Per-IP and per-account rate limiting on login and the authentication test.

### Phase 6 (slice) — policy engine and configuration
- Configuration IR with all five identity matchers, a pure evaluation engine,
  and a deterministic Squid compiler that emits `squid.conf` plus the NCSA
  password file and, for multiple providers, a generated helper multiplexer.
- Open proxy and dead-rule detection.
- Networks, listeners and access rules with CRUD, plus a rule simulator that
  runs the real engine.

### Phase 3 — node agent and enrolment
- Nodes are declared in the control plane and claim themselves with a one-time
  enrolment token; only credential hashes are stored.
- The agent (`apps/agent`, dependency free, shipped as a proxy node image) pulls
  configuration, writes artefacts with the required ownership, validates with
  `squid -k parse`, applies with `squid -k reconfigure` and reports back.
- Configuration drift is detected by comparing a stable configuration hash.
- Credentials are revocable per node; a revoked node keeps serving what it has.
- Verified with `scripts/verify-nodes.sh`: 26 checks across two real nodes.


### Phase 8 — traffic logs
- The compiler emits a versioned structured access log format; agents ship raw
  lines and the control plane parses them, so a format change never requires a
  fleet wide agent update.
- Raw requests are kept for a bounded window (`TRAFFIC_RETENTION_DAYS`); hourly
  rollups outlive them and are what the dashboard and portal read.
- Identity filters: any, authenticated, unauthenticated, a specific user, plus
  destination host, decision and node.
- A 407 is recorded as a credentials challenge rather than a denial, so the
  dashboard does not report a refusal for every first request of a session.
- Full URLs are personal data: `TRAFFIC_LOG_URLS=false` stores only the
  destination host, and the UI says which mode is in effect.
- Portal statistics are scoped to the signed-in identity.
- **Not complete against PLAN.md 9.23:** the plan also lists a *provider*
  filter. Squid's access log reports the username but not which provider
  accepted it, so the column exists and stays null rather than being guessed.
  Attributing a request to a provider needs the authentication helper to report
  it, which stock `basic_ncsa_auth` does not.
- Verified with `scripts/verify-traffic.sh`: 23 checks driving real requests.
### Phase 9 — proxy identity and authentication
- `DISABLED` / `OPTIONAL` / `REQUIRED` understood by backend, IR and UI.
- Local and LDAP providers behind one adapter interface, a registry with
  enabled/priority/health/capabilities, ordered fallback, and independent
  health so an LDAP outage never disables local accounts.
- Local proxy users and groups (local, external, logical) with full CRUD.
- crypt(3) password storage, never returned by the API, never logged, never in
  an audit payload.
- Provider connection test and the central authentication test page.
- Open proxy warning with mandatory acknowledgement, recorded in the audit log.
- Dashboard shows mode, default access and provider health.

## Not implemented

| Area | State | Notes |
| --- | --- | --- |
| Traffic filter by provider (PLAN.md 9.23) | not implemented | The access log carries a username, not the provider that accepted it. |
| Per-node configuration | not implemented | Every node receives the same policy. Node groups, site-specific listeners and staged rollouts are not modelled. |
| Phase 4 — monitoring | partial | Node reachability, apply result and configuration drift are reported. No metrics, no alerting. |
| Phase 7 — safe deployment, drift detection | not started | `config_versions` are stored; there is no diff view and no rollout. |

| Phase 10-13 — TLS inspection, cache, upstreams, multi-node | not started | |
| Control plane user management UI | not implemented | Roles and users exist in the database and are seeded; there is no admin screen yet. |
| Rule editor wizard | partial | Simple rules use the drawer with the section order from `PLAN.md` §24. The stepped wizard for complex rules is missing. |
| Rule reordering in the UI | partial | The API has `POST /access-rules/reorder`; the table has no drag handle yet. |
| Schedules in the rule editor | partial | The IR, engine and compiler support time windows; the editor always writes `ALWAYS`. |
| `DiffViewer` component | not implemented | Needed for configuration review across versions. |
| Component gallery route | not implemented | `docs/design/components.md` specifies it; the states exist in the components but there is no `/system/components` page. |
| Visual regression tests | not implemented | `PLAN.md` §21. |
| Update test (version N → N+1 with data) | not implemented | `PLAN.md` §17. |

## Known limitations to resolve before 1.0

1. **`OPTIONAL` mode cannot enforce "anonymous only".** Squid challenges a
   client as soon as it evaluates any ACL backed by `proxy_auth`, so an
   `UNAUTHENTICATED` rule is compiled without its identity condition and is
   decided by source, destination and schedule alone. Authenticated clients
   meeting the same conditions therefore match it too. The compiler reports
   this as `UNAUTHENTICATED_WIDENED`. Enforcing the distinction requires a
   dedicated listener for anonymous clients, which the product does not model
   yet.

2. **Nothing deploys the configuration automatically.** `GET
   /configuration/export` plus `scripts/export-config.mjs` is the manual
   stand-in for the node agent: it produces the files and the ownership
   commands, and a human copies them. The agent (Phase 3) is what turns this
   into a product feature.

3. **`verify-squid.sh` cannot be run back to back.** The authentication test
   endpoint is rate limited to 20 attempts per five minutes per source address,
   which is deliberate. The script detects the resulting 429 and skips the LDAP
   section with an explanation rather than reporting false failures.

4. **Session token lives in `sessionStorage`.** An httpOnly cookie would be
   stronger. The CSP is strict and the token is never placed in a URL, but
   threat model T12 stays "partial" until the cookie flow lands.

5. **Rate limiting is per API process.** Fine for the single-container
   deployment that compose describes; it must move to a shared store before the
   API is scaled horizontally.

6. **Provider health probes are synchronous.** Listing providers with a slow
   LDAP server waits for the probe (30 second cache, 5 second connect timeout).
   A background health loop would be better.

## Roadmap to 1.0

Order fixed by the product owner on 2026-08-16. TLS inspection and cache /
upstream management are deliberately **out of the 1.0 critical path**: a very
good 1.0 beats an overloaded one with half-hardened CA and MITM management.

| # | Phase | Contents |
| --- | --- | --- |
| 1 | **6.5 Architecture adjustment** | Node groups, listener profiles, configuration scope, authentication per listener (ADR 0003) |
| 2 | **7 Safe deployment** | Semantic diff, config diff, per-node deployment result, rollback, SERIAL, CANARY + SERIAL |
| 3 | **13 Multi-node completion** | Node groups UI, group assignments, desired state, group-specific listener config |
| 4 | **6 UI completion** | Schedules, drag and reorder, advanced rule wizard |
| 5 | **2 Control plane identity completion** | Users UI, roles UI, OIDC alongside local, break-glass administrator |
| 6 | **12 Advanced administration** | Backup and restore, advanced configuration, diagnostics |
| 7 | **14 Production and UX hardening** | Visual regression, N → N+1 update test, component showcase, security review |
| 8 | **15 Release 1.0** | |

After 1.0: TLS inspection with CA management and certificate lifecycle (1.1),
then cache management and upstream proxies (1.2).

### Standing requirement for every new feature

A feature is not done until its actual end-to-end path has been tested against
a real Squid. Five defects so far were invisible to unit tests and only
appeared under real traffic — see "Defects this found" above.

For phase 7 specifically, failure injection is part of the deliverable, not a
follow-up: invalid configuration, a node disappearing mid-deployment, a failing
reconfigure, a failing health check, a failing canary, and the rollback path
itself.


## Open defect — phase 6.5 in progress

`scripts/verify-nodes.sh` fails two checks after the listener profile change:
an anonymous client receives `200` where it should receive `407`.

What is verified as correct:

- the generated configuration contains the port name, the `myportname` ACL and
  the guard `http_access deny scp_lp_<name> !scp_authenticated`,
- the listener resolves to `REQUIRED` in the IR,
- both nodes report themselves in sync.

So the compiler output looks right and the node claims to be running it. What
has **not** been established is whether the node actually applied that
configuration at the moment of the request, or whether Squid evaluates the
guard as intended with the port name in use. Not yet diagnosed, deliberately
not guessed at.

Until this is closed, phase 6.5 is **not** done, and the per-listener
authentication path must not be considered working.
