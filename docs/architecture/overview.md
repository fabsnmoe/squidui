# Architecture Overview

## Components

```text
                         ┌──────────────┐
   browser ─────────────▶│  web (nginx) │  static SPA + /api reverse proxy
                         └──────┬───────┘
                                │ frontend network
                         ┌──────▼───────┐
                         │  api (node)  │  Fastify, REST /api/v1
                         └──┬────────┬──┘
             backend network│        │database network
                     ┌──────▼──┐  ┌──▼────────┐
                     │  redis  │  │ postgres  │
                     └─────────┘  └───────────┘
```

`postgres` and `redis` have no host port mapping. The only published port is
the web entrypoint (`WEB_PORT`, default `8080`).

A `migrate` service runs the SQL migrations from the same image as the API and
exits. It is never part of `up`; it is invoked explicitly
(`docker compose run --rm migrate`).

## Packages

```text
packages/shared   pure TypeScript domain core, no I/O:
                  - proxy authentication model (mode, providers, identity)
                  - policy IR + evaluation engine
                  - Squid configuration compiler
                  - crypt(3) password formats for the Squid auth helper
                  - permissions and audit action catalogue

packages/ui       design tokens + component library (the design system)

apps/api          HTTP layer, persistence, provider adapters (local, LDAP),
                  secret storage, audit sink, bootstrap

apps/web          React SPA composed exclusively from packages/ui
```

The dependency direction is strict: `apps/*` depend on `packages/*`, never the
other way round; `packages/shared` depends on nothing but the standard library.
This is what makes the policy engine and the config compiler unit testable
without a database.

## Two identity planes

```text
Control Plane Identity            Proxy Identity
─────────────────────             ──────────────
cp_users                          proxy_users
cp_roles / cp_user_roles          proxy_groups / proxy_user_groups
                                  auth_providers (LOCAL, LDAP)
                                  external_groups
                                  logical_identity_groups

login to the web UI               authenticating clients against Squid
API access, RBAC, audit           proxy policies, access rules, traffic

no shared table, no shared        no implicit membership between the two
password store, no implicit
mapping
```

A control plane administrator is not a proxy user, and creating one never
creates the other (`PRODUCT.md` §1, `PLAN.md` §9.1).

## Request path for a policy change

```text
UI  ──▶ API  ──▶ validation (zod)  ──▶ persistence (postgres)
                                     └▶ audit event
                                     └▶ IR rebuild
                                          └▶ Squid compiler
                                               └▶ squid.conf + auth artefacts
```

The compiler is deterministic and side-effect free: the same IR always yields
byte-identical output, which is what makes configuration review and diffing
meaningful.

## Configuration IR

The intermediate representation decouples the product model from any specific
Squid version. Identity matchers (`ANY`, `AUTHENTICATED`, `UNAUTHENTICATED`,
`USER`, `GROUP`) live in the IR, so the policy engine never needs to know which
authentication provider produced an identity (`PRODUCT.md` §26).

Squid-version specifics (helper binary names, directive spellings, supported
ACL types) belong in a version adapter behind `SquidVersionAdapter`.

## Persistence

Plain SQL migrations under `apps/api/migrations`, applied by a small runner
(`apps/api/src/db/migrate.ts`) that records applied files in
`schema_migrations`. No ORM, no code generation step, no engine download —
the image stays buildable offline once the npm dependencies are cached.

## Secrets

- Control plane passwords: `scrypt` (Node standard library), per-user salt.
- Proxy passwords: `crypt(3)` in the format the Squid helper expects
  (`sha512-crypt` by default, `md5-crypt` for musl based helpers).
- Provider secrets (LDAP bind password): AES-256-GCM at rest, key from
  `SECRET_ENCRYPTION_KEY`, never returned by any API.

## Build and deployment

Multi-stage Docker builds from the repository root, local images only, no
registry required (`PLAN.md` Gate H, Gate I). See `docs/deployment.md`.
