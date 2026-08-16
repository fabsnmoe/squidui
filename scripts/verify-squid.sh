#!/usr/bin/env bash
# Verifies the generated configuration against a real Squid and a real LDAP
# directory (PLAN.md 9.14 - 9.19, 9.24).
#
#   ./scripts/install.sh
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-squid.sh
#
# For each scenario it configures the control plane through the API, exports
# the compiled configuration, runs `squid -k parse`, starts Squid with it and
# drives real requests through the proxy.
#
# It rewrites the authentication mode and the rule set, so run it against an
# evaluation environment.

set -u

# Git Bash rewrites arguments that look like absolute POSIX paths into Windows
# paths, which turns /etc/squid/... inside a container into C:/Program Files/...
# Disabling that keeps this script usable on Windows and changes nothing on
# Linux, where the variable is simply ignored.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Docker needs a native host path for bind mounts; `pwd -W` yields one on
# Windows and does not exist elsewhere.
HOST_REPO="$(cd "$REPO_ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
EXPORT_DIR="$REPO_ROOT/tmp/squid-test"

# Relative paths on purpose: an absolute POSIX path from Git Bash is not a path
# Docker Desktop can resolve, and passing one to --env-file makes every compose
# call fail silently.
cd "$REPO_ROOT"
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Set SCP_ADMIN_PASSWORD to the control plane administrator password." >&2
  exit 2
fi

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "control plane sign in failed" >&2; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

api_get() { curl -s "$BASE$1" -H "$AUTH"; }
api_post() { curl -s -X POST "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
api_patch() { curl -s -X PATCH "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
api_delete() { curl -s -o /dev/null -X DELETE "$BASE$1" -H "$AUTH"; }

# --- helpers ----------------------------------------------------------------

network_name() { docker network ls --format '{{.Name}}' | grep -E 'proxytest$' | head -1; }

client_subnet() {
  docker network inspect "$(network_name)" \
    --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null
}

# Exports the compiled configuration through the audited export endpoint, the
# same way the node agent will.
export_config() {
  rm -f "$EXPORT_DIR"/* 2>/dev/null || true
  mkdir -p "$EXPORT_DIR"
  if ! docker run --rm \
    --network "$(docker network ls --format '{{.Name}}' | grep -E 'frontend$' | head -1)" \
    -v "$HOST_REPO:/repo" -w /repo node:22-alpine \
    node scripts/export-config.mjs --base http://web --user "$ADMIN_USER" \
    --password "$ADMIN_PASSWORD" --out /repo/tmp/squid-test >/tmp/scp-export.log 2>&1; then
    bad "configuration export: $(tail -3 /tmp/scp-export.log)"
    return 1
  fi
  [ -s "$EXPORT_DIR/squid.conf" ] || { bad "export produced no squid.conf"; return 1; }
  return 0
}

parse_config() {
  # Installs the artefacts first, exactly as the service entrypoint does:
  # squid validates that helper programs exist, so parsing against the raw
  # export directory would fail on any generated helper.
  $COMPOSE run --rm --no-deps --entrypoint sh squid -c '
    set -e
    mkdir -p /etc/squid/scp
    cp -r /etc/squid/scp-src/. /etc/squid/scp/
    [ -f /etc/squid/scp/apply-ownership.sh ] && sh /etc/squid/scp/apply-ownership.sh
    squid -k parse -f /etc/squid/scp/squid.conf
  ' >/tmp/scp-parse.log 2>&1
  # Squid must actually have parsed something. Without this check a compose
  # failure produces an empty log and would count as a pass.
  if ! grep -q 'Processing:' /tmp/scp-parse.log; then
    echo "  (squid did not run: $(tail -2 /tmp/scp-parse.log))"
    return 1
  fi
  # Problems are reported as FATAL/ERROR lines; the exit code alone is not
  # reliable across builds.
  ! grep -qE '(^|\| )(FATAL|ERROR)' /tmp/scp-parse.log
}

restart_squid() {
  $COMPOSE up -d origin client >/dev/null 2>&1
  $COMPOSE up -d --force-recreate squid >/dev/null 2>&1
  # Poll the proxy itself rather than parsing logs: any HTTP status means the
  # listener accepts connections.
  for _ in $(seq 1 30); do
    code=$($COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
      -x http://squid:3128 http://origin/ 2>/dev/null || echo 000)
    [ "$code" != "000" ] && return 0
    sleep 1
  done
  return 1
}

# through_proxy [credentials] <url> -> prints the HTTP status
through_proxy() {
  if [ "$#" -eq 2 ]; then
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' \
      --max-time 15 -x http://squid:3128 -U "$1" "$2" 2>/dev/null
  else
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' \
      --max-time 15 -x http://squid:3128 "$1" 2>/dev/null
  fi
}

reset_rules() {
  for id in $(api_get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do
    api_delete "/access-rules/$id"
  done
}

provider_id() {
  api_get /auth-providers | tr '{' '\n' | grep "\"key\":\"$1\"" |
    sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1
}

# The Squid scenarios below run with the local provider alone, so the compiled
# configuration uses the stock basic_ncsa_auth rather than the multiplexer.
disable_directory_providers() {
  for id in $(api_get /auth-providers | tr '{' '\n' | grep '"type":"LDAP"' |
    sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); do
    api_patch "/auth-providers/$id" '{"enabled":false}' >/dev/null
  done
}

echo "== preparing test fixtures =="
if $COMPOSE up -d origin client >/tmp/scp-fixtures.log 2>&1; then
  ok "test containers started"
else
  bad "test containers started: $(tail -3 /tmp/scp-fixtures.log)"
fi
SUBNET="$(client_subnet)"
[ -n "$SUBNET" ] && ok "test network detected ($SUBNET)" || bad "test network detected"

# Idempotent fixture: create the user if missing, and always reset the password
# so a previous run (or the portal verification) cannot affect this one.
api_post /proxy-users '{"username":"squid-local","displayName":"Squid test user","password":"squid-local-password"}' >/dev/null
SQUID_USER_ID=$(api_get /proxy-users | tr '{' '\n' | grep '"username":"squid-local"' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$SQUID_USER_ID" ]; then
  api_post "/proxy-users/$SQUID_USER_ID/password" '{"password":"squid-local-password"}' >/dev/null
  api_patch "/proxy-users/$SQUID_USER_ID" '{"status":"ACTIVE"}' >/dev/null
  ok "local proxy user prepared"
else
  bad "local proxy user prepared"
fi

# The source network is reused across runs; creating it again returns 409.
NETWORK_ID=$(api_get /networks | tr '{' '\n' | grep '"name":"Squid test clients"' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

disable_directory_providers
ok "directory providers disabled for the single-provider scenarios"

# A network covering the container subnet, used as a source condition later.
if [ -z "$NETWORK_ID" ]; then
  NETWORK_ID=$(api_post /networks "{\"name\":\"Squid test clients\",\"cidrs\":[\"$SUBNET\"]}" |
    sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
else
  # The compose network may have been recreated with a different subnet.
  api_patch "/networks/$NETWORK_ID" "{\"cidrs\":[\"$SUBNET\"]}" >/dev/null
fi
[ -n "$NETWORK_ID" ] && ok "source network prepared" || bad "source network prepared"

# ---------------------------------------------------------------------------
echo
echo "== scenario A: authentication disabled, allow any (PLAN.md 9.14) =="
reset_rules
api_post /access-rules '{"name":"Allow any","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
api_patch /proxy-auth/config '{"mode":"DISABLED","defaultAccess":"ALLOW","acknowledgeOpenProxy":true}' >/dev/null

export_config
if parse_config; then ok "squid -k parse accepts the configuration"; else bad "squid -k parse: $(tail -3 /tmp/scp-parse.log)"; fi
if restart_squid; then ok "squid starts with the generated configuration"; else bad "squid starts"; fi
expect "$(through_proxy http://origin/)" "200" "client reaches the origin without credentials"

# ---------------------------------------------------------------------------
echo
echo "== scenario B: authentication required, local provider (PLAN.md 9.15) =="
reset_rules
api_post /access-rules '{"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
api_patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null

export_config
if parse_config; then ok "squid -k parse accepts the configuration"; else bad "squid -k parse: $(tail -3 /tmp/scp-parse.log)"; fi
restart_squid || bad "squid starts"
expect "$(through_proxy http://origin/)" "407" "anonymous client is challenged"
expect "$(through_proxy squid-local:squid-local-password http://origin/)" "200" "local user authenticates and passes"
expect "$(through_proxy squid-local:wrong-password-here http://origin/)" "407" "wrong password is rejected"
expect "$(through_proxy no-such-user:some-password-xx http://origin/)" "407" "unknown user is rejected"

echo "   (this is the crypt(3) chain: control plane hash -> NCSA file -> basic_ncsa_auth)"

# ---------------------------------------------------------------------------
echo
echo "== scenario E: optional mode, guests and members in parallel (PLAN.md 9.18) =="
reset_rules
# Unauthenticated rule first: Squid challenges as soon as it evaluates a rule
# referencing proxy_auth, so ordering is part of the semantics.
api_post /access-rules "{\"position\":10,\"name\":\"Guest network\",\"action\":\"ALLOW\",\"source\":{\"kind\":\"NETWORKS\",\"networkIds\":[\"$NETWORK_ID\"]},\"identity\":{\"kind\":\"UNAUTHENTICATED\"},\"destination\":{\"kind\":\"SPECIFIC\",\"domains\":[],\"cidrs\":[],\"ports\":[80]},\"schedule\":{\"kind\":\"ALWAYS\"}}" >/dev/null
api_post /access-rules '{"position":20,"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
api_post /access-rules '{"position":30,"name":"Deny everything else","action":"DENY","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
api_patch /proxy-auth/config '{"mode":"OPTIONAL","defaultAccess":"DENY"}' >/dev/null

export_config
if parse_config; then ok "squid -k parse accepts the configuration"; else bad "squid -k parse: $(tail -3 /tmp/scp-parse.log)"; fi
restart_squid || bad "squid starts"
expect "$(through_proxy http://origin/)" "200" "anonymous guest reaches the web"
expect "$(through_proxy squid-local:squid-local-password http://origin/)" "200" "authenticated member passes"

# ---------------------------------------------------------------------------
echo
echo "== LDAP provider against a real directory (PLAN.md 9.16) =="
# /auth-test is rate limited per source address (20 attempts per 5 minutes),
# which is deliberate. Running this suite several times in quick succession
# exhausts the bucket, and the resulting 429 would otherwise show up as a
# stream of misleading assertion failures.
RL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth-test" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"username":"rate-limit-probe","password":"rate-limit-probe"}')
if [ "$RL" = "429" ]; then
  echo "  SKIP  the authentication test endpoint is rate limited right now."
  echo "        This is the product working as intended. Wait five minutes and re-run,"
  echo "        or run the suite from a different source address."
  echo
  echo "passed: $PASS, failed: $FAIL (LDAP section skipped)"
  exit 0
fi
SKIP=0
RATE_LIMITED=0

# The rate limit is deliberate product behaviour, and it can be reached in the
# middle of this section. Reporting the resulting 429 as a failed assertion
# would blame the product for working; reporting it as a silent pass would be
# worse still. So it is counted as an explicit skip.
auth_test() {
  RESPONSE=$(curl -s -w '
%{http_code}' -X POST "$BASE/auth-test" -H "$AUTH"     -H 'Content-Type: application/json' -d "$1")
  if [ "$(echo "$RESPONSE" | tail -1)" = "429" ]; then RATE_LIMITED=1; fi
  echo "$RESPONSE" | sed '$d'
}

auth_contains() {
  if [ "$RATE_LIMITED" = "1" ]; then
    echo "  SKIP  $3 (authentication test endpoint rate limited)"
    SKIP=$((SKIP + 1))
    return
  fi
  contains "$1" "$2" "$3"
}

wait_for_ldap() {
  $COMPOSE up -d ldap >/dev/null 2>&1
  for _ in $(seq 1 45); do
    $COMPOSE ps ldap 2>/dev/null | grep -q 'healthy' && return 0
    sleep 2
  done
  return 1
}
if wait_for_ldap; then ok "test directory is up"; else bad "test directory is up"; fi

LDAP_CONFIG='{"uri":"ldap://ldap:389","baseDn":"ou=users,dc=example,dc=internal",
              "userFilter":"(uid=%s)","bindDn":"cn=admin,dc=example,dc=internal",
              "startTls":false,"tlsRejectUnauthorized":false,
              "groupBaseDn":"ou=groups,dc=example,dc=internal",
              "groupFilter":"(&(objectClass=groupOfNames)(member=%u))"}'

PROVIDER_ID=$(provider_id ldap-test)
if [ -z "$PROVIDER_ID" ]; then
  api_post /auth-providers "{\"key\":\"ldap-test\",\"type\":\"LDAP\",\"name\":\"Test directory\",
    \"enabled\":true,\"priority\":20,\"config\":$LDAP_CONFIG,\"bindPassword\":\"ldap-admin-password\"}" >/dev/null
  PROVIDER_ID=$(provider_id ldap-test)
else
  api_patch "/auth-providers/$PROVIDER_ID" \
    "{\"enabled\":true,\"config\":$LDAP_CONFIG,\"bindPassword\":\"ldap-admin-password\"}" >/dev/null
fi
[ -n "$PROVIDER_ID" ] && ok "LDAP provider configured" || bad "LDAP provider configured"

if [ -n "$PROVIDER_ID" ]; then
  T=$(api_post "/auth-providers/$PROVIDER_ID/test" '{}')
  # Anchored to the start of the document: every individual check also carries
  # an "ok" field, so an unanchored match would pass on a failed test.
  contains "$T" '^{"ok":true' "connection test reaches the directory and binds"
  contains "$T" '"label":"Search base accessible","ok":true' "the search base is accessible"
fi

R=$(auth_test '{"username":"ldapuser","password":"ldap-user-password"}')
auth_contains "$R" '"success":true' "LDAP user authenticates"
# Precise: the successful answer must come from the directory, not from a
# same-named local account.
contains "$R" '"success":true,"providerKey":"ldap-test"' "answered by the LDAP provider"

R=$(auth_test '{"username":"ldapuser","password":"wrong-password-abc"}')
auth_contains "$R" '"success":false' "wrong LDAP password rejected"
auth_contains "$R" '"providerKey":"ldap-test","providerName":"Test directory","outcome":"REJECTED"' \
  "rejected by the directory, not reported as an outage"

echo
echo "== scenario D: local and LDAP in parallel (PLAN.md 9.17) =="
R=$(auth_test '{"username":"squid-local","password":"squid-local-password"}')
auth_contains "$R" '"success":true,"providerKey":"local"' "local user authenticates with both providers enabled"
R=$(auth_test '{"username":"ldapuser","password":"ldap-user-password"}')
auth_contains "$R" '"success":true,"providerKey":"ldap-test"' "LDAP user authenticates with both providers enabled"

echo
echo "== provider failure isolation (PLAN.md 9.9) =="
$COMPOSE stop ldap >/dev/null 2>&1
R=$(auth_test '{"username":"squid-local","password":"squid-local-password"}')
auth_contains "$R" '"success":true' "local user still authenticates while LDAP is down"
R=$(auth_test '{"username":"ldapuser","password":"ldap-user-password"}')
auth_contains "$R" '"success":false' "LDAP user cannot authenticate while the directory is down"
auth_contains "$R" 'UNAVAILABLE' "the outage is reported as unavailable, not as a rejection"
if wait_for_ldap; then ok "directory recovers and the provider is usable again"; else bad "directory recovers"; fi
R=$(auth_test '{"username":"ldapuser","password":"ldap-user-password"}')
auth_contains "$R" '"success":true' "LDAP user authenticates again after recovery"

# ---------------------------------------------------------------------------
echo
echo "== scenario D through Squid: both providers behind the generated multiplexer =="
# With more than one provider enabled the compiler emits a helper multiplexer,
# because Squid accepts exactly one basic auth helper. It is a Perl script, so
# the scenario only runs where the Squid image has Perl.
reset_rules
api_post /access-rules '{"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
api_patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null

if export_config; then
  contains "$(cat "$EXPORT_DIR/squid.conf")" 'scp_multi_basic_auth' "the multiplexer is wired up for two providers"
  [ -s "$EXPORT_DIR/scp_multi_basic_auth" ] && ok "the multiplexer is exported as an artefact" ||
    bad "the multiplexer is exported"

  if $COMPOSE run --rm --no-deps --entrypoint "" squid sh -c 'command -v perl >/dev/null' >/dev/null 2>&1; then
    ok "the Squid image provides Perl"
    if parse_config; then ok "squid -k parse accepts the multi-provider configuration"; else
      bad "squid -k parse: $(tail -3 /tmp/scp-parse.log)"
    fi
    restart_squid || bad "squid starts with the multiplexer"
    expect "$(through_proxy squid-local:squid-local-password http://origin/)" "200" \
      "local user passes through the multiplexer"
    expect "$(through_proxy ldapuser:ldap-user-password http://origin/)" "200" \
      "LDAP user passes through the multiplexer"
    expect "$(through_proxy ldapuser:wrong-password-xy http://origin/)" "407" \
      "wrong directory password is rejected by the multiplexer"
  else
    echo "  SKIP  the Squid image has no Perl; the generated multiplexer is not exercised"
    echo "        (documented as a known gap in docs/status.md)"
  fi
fi

# Leave the stack in a defined state rather than whatever the last scenario set.
disable_directory_providers
api_patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null

echo
if [ "$SKIP" -gt 0 ]; then echo "passed: $PASS, failed: $FAIL, skipped: $SKIP"; else echo "passed: $PASS, failed: $FAIL"; fi
[ "$FAIL" -eq 0 ]
