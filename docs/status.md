# Implementation status

Honest account of what exists today, verified against the running stack on
2026-08-16. Anything not listed as implemented is not implemented, regardless
of whether the plan mentions it.

## Verified

Reproduce with `./scripts/install.sh`, `./scripts/healthcheck.sh` and
`SCP_ADMIN_PASSWORD=... ./scripts/verify-e2e.sh`.

| Check | Result |
| --- | --- |
| `npm run test --workspace @scp/shared` | 95 tests pass |
| `npm run test --workspace @scp/api` | 21 tests pass |
| `npm run typecheck --workspace @scp/web` | clean, strict mode |
| `docker compose build` (prod overlay) | both images build from a plain checkout |
| `docker compose run --rm migrate` | schema applied, bootstrap idempotent |
| `docker compose up -d` | postgres, redis, api, web all healthy |
| `GET /api/health/ready` | `200 {"status":"ready"}` |
| `./scripts/verify-e2e.sh` | 44 checks pass |
| `./scripts/verify-squid.sh` | 38 checks pass against a real Squid and OpenLDAP |
| `./scripts/verify-nodes.sh` | 26 checks pass across two real proxy nodes with their agents |
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
| Per-node configuration | not implemented | Every node receives the same policy. Node groups, site-specific listeners and staged rollouts are not modelled. |
| Phase 4 — monitoring | partial | Node reachability, apply result and configuration drift are reported. No metrics, no alerting. |
| Phase 7 — safe deployment, drift detection | not started | `config_versions` are stored; there is no diff view and no rollout. |
| Phase 8 — logs and traffic | not started | The dashboard reports `available: false` for traffic metrics instead of inventing numbers. |
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

## Suggested next steps

1. Build the node agent (Phase 3). It is now the only thing between "the
   configuration is proven correct" and "the configuration is deployed". The
   export endpoint and the ownership manifest already define its contract.
2. Model anonymous-only access as a dedicated listener, so `OPTIONAL` mode can
   enforce the distinction instead of reporting a widening.
3. Finish the rule editor: schedules, reordering, and the wizard for complex
   rules.
4. Add the control plane user and role administration screen.
5. Add the component gallery and visual regression baselines.
6. Connect the traffic log pipeline (Phase 8) so the dashboard and the portal
   can show real per-identity statistics instead of an empty state.
