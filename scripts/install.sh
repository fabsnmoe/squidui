#!/usr/bin/env sh
# Fresh installation on a server that has Docker and Git and nothing else
# (PLAN.md section 16, section 36).
#
#   cp .env.example .env && edit .env
#   ./scripts/install.sh

. "$(dirname "$0")/lib.sh"

require_docker
require_env
export_build_metadata

log "building images locally (version $APP_VERSION, revision $GIT_SHA)"
compose build

log "applying database migrations"
compose run --rm migrate

log "starting the stack"
compose up -d --remove-orphans

log "waiting for readiness"
WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
WEB_PORT="${WEB_PORT:-8080}"

attempt=1
while [ "$attempt" -le 30 ]; do
  if curl -fsS "http://localhost:${WEB_PORT}/api/health/ready" >/dev/null 2>&1; then
    log "control plane is ready on http://localhost:${WEB_PORT}"
    compose ps
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

warn "the control plane did not become ready within 60 seconds"
compose ps
compose logs --tail 50 api
exit 1
