#!/usr/bin/env sh
# Dumps the database into ./backups (PLAN.md section 15).
#
#   ./scripts/backup.sh [target-directory]
#
# The dump contains password hashes and encrypted provider secrets. Treat it
# like a credential store: it belongs on encrypted storage.
#
# The dump alone is NOT sufficient to restore a working system: provider
# secrets are encrypted with SECRET_ENCRYPTION_KEY from .env, which lives
# outside the database. Back up .env separately and keep it somewhere else.

. "$(dirname "$0")/lib.sh"

require_docker
require_env

TARGET="${1:-$REPO_ROOT/backups}"
mkdir -p "$TARGET"

POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_USER="${POSTGRES_USER:-squidcp}"
POSTGRES_DB="${POSTGRES_DB:-squidcp}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$TARGET/squidcp-$STAMP.sql.gz"

log "dumping $POSTGRES_DB to $FILE"
compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists | gzip -9 > "$FILE"

# A truncated dump is worse than no dump, so fail loudly on an empty file.
[ -s "$FILE" ] || die "the dump is empty - check that the postgres service is running."

log "wrote $(du -h "$FILE" | cut -f1) to $FILE"
warn "back up .env separately: without SECRET_ENCRYPTION_KEY the provider secrets in this dump cannot be decrypted."
