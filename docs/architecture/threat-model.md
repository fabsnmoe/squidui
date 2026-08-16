# Threat Model (Phase 0)

Scope: the control plane itself. The managed Squid nodes and their traffic are
in scope only where the control plane influences them (generated config,
authentication artefacts).

## Assets

| Asset | Impact if compromised |
| --- | --- |
| Proxy user password hashes | offline cracking, impersonation of proxy users |
| LDAP bind credentials | read access to the directory, possible lateral movement |
| Control plane sessions | full policy control, ability to open the proxy |
| Generated Squid configuration | traffic interception or unrestricted egress |
| Audit log | loss of accountability |

## Trust boundaries

```text
browser ─┬─ TLS (operator responsibility, reverse proxy in front)
         │
      web (nginx)  ── no credentials, static assets only
         │
        api  ── authenticates every request, enforces RBAC
         │
   postgres / redis  ── internal networks only, no host exposure
```

## Threats and mitigations

| # | Threat | Mitigation | Status |
| --- | --- | --- | --- |
| T1 | Accidental open proxy (`Disabled` + `Allow` + wide listener) | detection in `shared/policy/openProxy.ts`, blocking warning + explicit acknowledgement, dashboard alert, audit record | implemented |
| T2 | Proxy password disclosure | crypt(3) hash only, never returned by the API, redaction list in the audit sink, no password in logs | implemented |
| T3 | Control plane credential stuffing | scrypt hashing, generic login error, per-IP + per-account rate limit on login and auth-test | implemented |
| T4 | Privilege escalation via missing authorisation | permission required declaratively per route; a route without a permission declaration fails closed | implemented |
| T5 | LDAP bind password theft from the database | AES-256-GCM with a key outside the database; API returns `null` for secret fields | implemented |
| T6 | LDAP injection through crafted usernames | username is escaped per RFC 4515 before filter interpolation | implemented |
| T7 | Provider outage locks out all proxy users | independent provider health, local provider unaffected by LDAP failure, ordered fallback | implemented |
| T8 | Audit tampering | append-only enforced by a database trigger, no update/delete API surface | implemented |
| T9 | Secrets in build args / image layers | secrets only via runtime environment; `.dockerignore` excludes `.env` | implemented |
| T10 | Database exposed to the host network | no port mapping in any compose file | implemented |
| T11 | Compromised agent pushes rogue config | agent enrollment, signed config bundles | not implemented (Phase 3) |
| T12 | Session theft via XSS | strict CSP on the web image, token in memory mirrored to `sessionStorage`, never placed in a URL | partial - an httpOnly cookie would be stronger, see docs/status.md |

## Non-goals for 1.0

- Multi-tenancy. One control plane instance manages one organisation.
- TLS termination inside the stack. Deployments put a reverse proxy in front.
- Protection against a hostile host administrator.

## Review triggers

This document is revisited when: a new provider type is added, the agent
protocol is introduced, or any component gains a network listener.
