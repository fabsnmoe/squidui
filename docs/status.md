# Implementation status

Honest account of what exists today, verified against the running stack on
2026-08-16. Anything not listed as implemented is not implemented, regardless
of whether the plan mentions it.

## Verified

Reproduce with `./scripts/install.sh`, `./scripts/healthcheck.sh` and
`SCP_ADMIN_PASSWORD=... ./scripts/verify-e2e.sh`.

| Check | Result |
| --- | --- |
| `npm run test --workspace @scp/shared` | 111 tests pass |
| `npm run test --workspace @scp/api` | 30 tests pass |
| `npm run typecheck --workspace @scp/web` | clean, strict mode |
| `docker compose build` (prod overlay) | both images build from a plain checkout |
| `docker compose run --rm migrate` | schema applied, bootstrap idempotent |
| `docker compose up -d` | postgres, redis, api, web all healthy |
| `GET /api/health/ready` | `200 {"status":"ready"}` |
| `./scripts/verify-e2e.sh` | 49 checks pass |
| `./scripts/verify-listeners.sh` | 22 checks pass: corporate and guest listener on one node |
| `./scripts/verify-squid.sh` | 38 checks pass against a real Squid and OpenLDAP |
| `./scripts/verify-nodes.sh` | 26 checks pass across two real proxy nodes with their agents |
| `./scripts/verify-traffic.sh` | 31 checks pass: real requests ingested, parsed, filtered and aggregated |
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

Testing against a real Squid surfaced bugs that no unit test would have
caught. All are fixed and now carry regression tests.

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
5. **A guest listener was still challenged by the rules.** A listener set to
   `DISABLED` carries no credentials guard, but the first rule requiring an
   identity still made Squid evaluate `proxy_auth` and answer 407 on the guest
   port. Rules that need an identity are now restricted to the listeners that
   can produce one. See ADR 0003, "A dedicated listener is not sufficient on
   its own".
6. **A fresh installation had no listener at all.** The bootstrap still wrote
   the default into the superseded `listeners` table, so on an empty database
   `listener_profiles` stayed empty and the compiler produced a configuration
   without a single `http_port`. Every new installation shipped a Squid that
   would not have accepted traffic. Found while setting up a clean instance,
   not by any suite, because every existing environment had the profile from
   the 0005 migration.

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
| ✅ | **6.5 Architecture adjustment** | Node groups, listener profiles, configuration scope, authentication per listener (ADR 0003). Verified by `verify-listeners.sh`: corporate `:3128 REQUIRED` and guest `:3129 DISABLED` on one real node at the same time |
| 1 | **Visual regression foundation** | Deterministic demo environment, reference screens for the Anti-SAP gate |
| 2 | **7 Safe deployment** | Semantic diff, config diff, per-node deployment result, rollback, SERIAL, CANARY + SERIAL |
| 3 | **13 Multi-node completion** | Desired state and per-group deployment. Node groups UI, group assignment and group-specific listener config landed with 6.5 |
| 4 | **6 UI completion** | Schedules, drag and reorder, advanced rule wizard |
| 5 | **2 Control plane identity completion** | Users UI, roles UI, OIDC alongside local, break-glass administrator |
| 6 | **12 Advanced administration** | Backup and restore, advanced configuration, diagnostics |
| 7 | **14 Production and UX hardening** | N → N+1 update test, component showcase, security review |
| 8 | **15 Release 1.0** | |

After 1.0: TLS inspection with CA management and certificate lifecycle (1.1),
then cache management and upstream proxies (1.2).

### Standing requirement for every new feature

A feature is not done until its actual end-to-end path has been tested against
a real Squid. Seven defects so far were invisible to unit tests and only
appeared under real traffic — see "Defects this found" above.

For phase 7 specifically, failure injection is part of the deliverable, not a
follow-up: invalid configuration, a node disappearing mid-deployment, a failing
reconfigure, a failing health check, a failing canary, and the rollback path
itself.



## Defect five: tightening the mode was refused as an open proxy

Found by `verify-nodes.sh` after the phase 6.5 change, diagnosed and fixed.

**Symptom.** An anonymous client received `200` where it should have received
`407`. The generated configuration looked correct and both nodes reported
themselves in sync, which made it look like a Squid or agent problem.

**Cause.** Since ADR 0003 the open proxy check reads the *listeners*, not the
global mode. The dry run in `PATCH /proxy-auth/config` built its projection by
overwriting only the global mode, while the listeners in that IR still carried
the value they had been resolved with. Switching from `DISABLED` to `REQUIRED`
was therefore judged against the old listeners, reported as an open proxy and
refused with `409` — the exact opposite of what the change did. The mode never
changed, the nodes kept serving the previous allow-any policy, and the request
was allowed entirely correctly.

**Fix.** The IR records whether a listener inherited its mode, and the
projection re-resolves those against the new default before the check runs.

**Why it stayed hidden for two runs.** The verification asserted the switch
with an unconditional `ok` that never checked the response, so a `409` passed
silently. That assertion is now real, and a regression check in
`verify-e2e.sh` covers the tightening path directly. A leftover node record
from a manual diagnosis additionally skewed the summary counters, which let the
convergence gate pass before the second node had converged.

**Lesson worth keeping.** Three of the assertions in this repository have now
been wrong in a way that hid product behaviour rather than revealing it. An
assertion that cannot fail is worse than no assertion, because it is counted
as evidence.


## Defect six: the guest listener was challenged by a rule, not by its listener

Found by `verify-listeners.sh` while verifying the phase 6.5 acceptance
criterion, and the most instructive one so far because every intermediate
assertion passed.

**Symptom.** `:3129` was configured `DISABLED` and answered `407`. The
generated configuration carried exactly one credentials guard, that guard was
scoped by `myportname` to the corporate port, and the guest port carried none.
By every structural check the configuration was right.

**Cause.** Squid evaluates the rule list for every listener. The first rule
required an identity and compiled to `http_access allow scp_authenticated`;
evaluating that ACL is itself what triggers the challenge, so the guest was
asked for credentials at rule 10 and never reached the rule that would have
admitted it. Moving authentication onto the listener removes the guard but not
the rules.

**Fix.** Rules requiring an identity are restricted to the listeners that can
produce one, via a single `scp_auth_ports` ACL built from repeated `myportname`
lines. The term is omitted when every listener authenticates.

**Lesson worth keeping.** The structural assertions were all true and all
irrelevant. Only the request itself — an anonymous client on `:3129` expecting
`200` — could distinguish a configuration that looks right from one that
behaves right.


## Defect seven: a fresh installation compiled a proxy with no listener

Found by installing the product from an empty database, which no verification
script did until now.

**Symptom.** A clean install came up healthy - all containers running, the API
ready, demo data seeded - and the compiled configuration contained no
`http_port`. Squid would have started and served nothing.

**Cause.** Migration 0005 made `listener_profiles` the source of truth and left
`listeners` in place for rollback only. The bootstrap was never moved across.
On an existing database this was invisible: 0005 had already copied the
listener into a profile. On an empty one the migration ran over an empty table,
the bootstrap wrote a row nothing reads, and the profile list stayed empty.

**Fix.** The bootstrap ensures a default listener profile. `verify-e2e.sh` now
asserts that the compiled configuration opens at least one port and that the
compiler reports no `NO_LISTENER` warning.

**Lesson worth keeping.** Every environment in this project grew through the
migrations. A defect that only exists on a database that starts empty is
invisible to all of them, and no amount of end-to-end testing against a
long-lived environment would have found it. The install path needs testing as
its own path.


## Defect eight: every overlay stole focus on each keystroke

Reported by the first person to use the product who did not write it, which is
the only reason it was found at all.

**Symptom.** In any drawer or dialog, typing one character moved the cursor out
of the field and onto the close button in the header. Filling in a form meant
one keystroke, one click back into the field, repeat.

**Cause.** `useOverlayBehaviour` listed `onClose` in its dependency array.
Callers build that handler during render, so it has a new identity on every
render; typing changed parent state, the overlay re-rendered, and the effect
re-ran - moving focus to the first focusable element, which in DOM order is the
header close button rather than any field.

**Fix.** The handler is read through a ref, so the effect depends only on
whether the overlay is open. Initial focus now looks in the overlay body first
and only considers fields, never the control that discards the work.

**Lesson worth keeping.** Every automated check passed, every screen rendered
correctly, and the product was close to unusable for its actual purpose. Nothing
in this repository types into a form. Until something does, this class of defect
is invisible here - which is an argument for the interaction tests in phase 14
being real tests, not screenshots.
