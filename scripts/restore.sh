#!/usr/bin/env sh
# Restores a dump produced by backup.sh (PLAN.md section 15).
#
#   ./scripts/restore.sh backups/squidcp-20260816T101500Z.sql.gz
#
# This overwrites the current database. The same SECRET_ENCRYPTION_KEY that was
# in place when the dump was taken must be present in .env, otherwise provider
# secrets cannot be decrypted afterwards.

. "$(dirname "$0")/lib.sh"

require_docker
require_env

DUMP="${1:-}"
[ -n "$DUMP" ] || die "usage: ./scripts/restore.sh <dump.sql.gz>"
[ -f "$DUMP" ] || die "no such file: $DUMP"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_USER="${POSTGRES_USER:-squidcp}"
POSTGRES_DB="${POSTGRES_DB:-squidcp}"

warn "this replaces every row in $POSTGRES_DB with the contents of $DUMP."
printf 'Type the database name (%s) to continue: ' "$POSTGRES_DB"
read -r answer
[ "$answer" = "$POSTGRES_DB" ] || die "aborted."

log "stopping the api so nothing writes during the restore"
compose stop api

log "restoring $DUMP"
gzip -dc "$DUMP" | compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

log "applying migrations in case the dump predates the current schema"
compose run --rm migrate

log "starting the api"
compose up -d api

log "done"
