# ADR 0001 — Plain SQL migrations instead of an ORM

Status: accepted
Date: 2026-08-16

## Context

`PLAN.md` Gate I requires that the stack builds from a plain git checkout with
local images and no registry dependency, and §36 requires the build to work on
a server that has no Node.js toolchain. ORMs such as Prisma download platform
specific query engines during install and generate code at build time, which
adds a network dependency and a failure mode inside the image build.

The schema is also security relevant (two strictly separate identity planes,
append-only audit table); explicit DDL is easier to review than generated DDL.

## Decision

Use `pg` with numbered SQL migration files in `apps/api/migrations` and a small
runner that records applied files in `schema_migrations`. Migrations are
forward-only and run through a dedicated `migrate` compose service.

## Consequences

- Positive: no code generation, no engine download, reviewable DDL, migration
  step is a plain container run that fits the documented production workflow.
- Positive: `packages/shared` stays free of persistence concerns.
- Negative: no generated types for query results — repositories map rows to
  domain types by hand and must be covered by tests.
- Negative: no automatic down-migrations. Rollback follows the documented
  application-rollback path with a minimum schema version per release
  (`PLAN.md` §18).
