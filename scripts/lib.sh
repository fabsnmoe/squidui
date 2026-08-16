#!/usr/bin/env sh
# Shared helpers for the deployment scripts.
#
# The scripts are thin wrappers around the documented docker compose commands
# and contain no hidden deployment logic (PLAN.md section 15). Everything they
# do can be typed by hand from docs/deployment.md.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_DIR="$REPO_ROOT/deployments/compose"
ENV_FILE="$REPO_ROOT/.env"

# Compose resolves relative paths against the directory of the first -f file,
# so --env-file is passed explicitly to keep .env at the repository root.
compose() {
  overlay="${SCP_OVERLAY:-compose.prod.yml}"
  docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_DIR/compose.yml" \
    -f "$COMPOSE_DIR/$overlay" \
    "$@"
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$1" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed."
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is not available."
  docker info >/dev/null 2>&1 || die "the docker daemon is not reachable."
}

require_env() {
  [ -f "$ENV_FILE" ] || die ".env is missing. Run: cp .env.example .env and fill in the secrets."

  missing=''
  for key in JWT_SECRET SECRET_ENCRYPTION_KEY POSTGRES_PASSWORD DATABASE_URL; do
    value="$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    [ -n "$value" ] || missing="$missing $key"
  done
  [ -z "$missing" ] || die "these variables are empty in .env:$missing"

  if grep -qE '^JWT_SECRET=change-me' "$ENV_FILE"; then
    die "JWT_SECRET still holds the example value. Generate one: openssl rand -base64 32"
  fi
}

# Records the version being deployed so the image labels and /health/version
# match the checkout (PLAN.md section 10).
export_build_metadata() {
  APP_VERSION="$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo '0.0.0-dev')"
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export APP_VERSION GIT_SHA BUILD_DATE
}
