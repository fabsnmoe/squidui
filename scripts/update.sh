#!/usr/bin/env sh
# Update to the currently checked out revision (PLAN.md section 30).
#
#   git fetch --tags && git checkout v1.2.0
#   ./scripts/update.sh
#
# Take a backup first - this script does not do it for you, because a backup
# that silently happens is a backup nobody verifies.

. "$(dirname "$0")/lib.sh"

require_docker
require_env
export_build_metadata

log "current revision: $APP_VERSION ($GIT_SHA)"
printf 'Did you run ./scripts/backup.sh? [y/N] '
read -r answer
case "$answer" in
  y | Y) ;;
  *) die "aborted. Run ./scripts/backup.sh first." ;;
esac

log "building images"
compose build --pull

log "applying database migrations"
compose run --rm migrate

log "restarting services"
compose up -d --remove-orphans

log "done"
compose ps
