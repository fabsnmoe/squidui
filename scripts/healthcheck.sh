#!/usr/bin/env sh
# Application level health check (PLAN.md section 15, section 30).
#
#   ./scripts/healthcheck.sh
#
# Exit code 0 means the control plane is serving; anything else is a failure
# suitable for a monitoring system or a deployment gate.

. "$(dirname "$0")/lib.sh"

require_docker

WEB_PORT="$(grep -E '^WEB_PORT=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
WEB_PORT="${WEB_PORT:-8080}"
BASE="http://localhost:${WEB_PORT}"

failures=0

check() {
  name="$1"
  url="$2"
  if curl -fsS --max-time 10 "$url" >/dev/null 2>&1; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s (%s)\n' "$name" "$url"
    failures=$((failures + 1))
  fi
}

log "container status"
compose ps

log "endpoints"
check "web entrypoint" "$BASE/healthz"
check "api liveness" "$BASE/api/health/live"
check "api readiness" "$BASE/api/health/ready"

if [ "$failures" -eq 0 ]; then
  log "healthy"
  curl -fsS "$BASE/api/health/version"
  echo
  exit 0
fi

die "$failures check(s) failed"
