#!/usr/bin/env bash
# End-to-end verification of the proxy authentication feature against a running
# stack (PRODUCT.md section 27, PLAN.md 9.14 - 9.19).
#
#   ./scripts/install.sh
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-e2e.sh
#
# It changes the authentication mode and creates a test user, so run it against
# an evaluation environment, not production.
#
# What it does NOT cover: driving traffic through a real Squid instance. That
# needs the node agent (Phase 3) and is tracked in docs/status.md.

set -u

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }
excludes() { if echo "$1" | grep -q "$2"; then bad "$3"; else ok "$3"; fi; }

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Set SCP_ADMIN_PASSWORD to the control plane administrator password." >&2
  exit 2
fi

echo "== control plane session =="
TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$TOKEN" ]; then ok "administrator can sign in"; else bad "administrator can sign in"; exit 1; fi
AUTH="Authorization: Bearer $TOKEN"

get() { curl -s "$BASE$1" -H "$AUTH"; }
patch() { curl -s -X PATCH "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
post() { curl -s -X POST "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
mode_of() { get /proxy-auth/overview | sed -n 's/.*"configuration":{"mode":"\([A-Z]*\)".*/\1/p'; }

echo "== scenario B: authentication REQUIRED, local provider =="
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
expect "$(mode_of)" "REQUIRED" "mode switched to REQUIRED"

post /proxy-users '{"username":"e2e-verify","displayName":"E2E verification","password":"e2e-verify-password"}' >/dev/null
R=$(post /auth-test '{"username":"e2e-verify","password":"e2e-verify-password"}')
contains "$R" '"success":true' "local user authenticates"
contains "$R" '"providerKey":"local"' "answered by the local provider"
R=$(post /auth-test '{"username":"e2e-verify","password":"definitely-wrong-pw"}')
contains "$R" '"success":false' "wrong password rejected"
R=$(post /auth-test '{"username":"no-such-user","password":"definitely-wrong-pw"}')
contains "$R" '"success":false' "unknown user rejected"

echo "== password handling (PRODUCT.md section 15) =="
U=$(get /proxy-users)
excludes "$U" 'password_hash' "no password hash in the user list"
excludes "$U" 'e2e-verify-password' "no plaintext in the user list"
A=$(get '/audit-events?limit=100')
excludes "$A" 'e2e-verify-password' "no password in the audit log"
contains "$A" 'PROXY_USER_CREATED' "PROXY_USER_CREATED recorded"
contains "$A" 'AUTH_MODE_CHANGED' "AUTH_MODE_CHANGED recorded"
contains "$A" 'AUTH_TEST_PERFORMED' "AUTH_TEST_PERFORMED recorded"

echo "== scenario A: open proxy needs acknowledgement (PLAN.md 9.19) =="
CODE=$(curl -s -o /tmp/scp-openproxy.json -w '%{http_code}' -X PATCH "$BASE/proxy-auth/config" \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"mode":"DISABLED","defaultAccess":"ALLOW"}')
expect "$CODE" "409" "unacknowledged open proxy configuration is refused"
contains "$(cat /tmp/scp-openproxy.json)" 'OPEN_PROXY' "the refusal names the finding"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/proxy-auth/config" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"mode":"DISABLED","defaultAccess":"ALLOW","acknowledgeOpenProxy":true}')
expect "$CODE" "200" "acknowledged open proxy configuration is accepted"
O=$(get /proxy-auth/overview)
contains "$O" 'OPEN_PROXY' "the warning stays visible afterwards"
contains "$O" 'openProxyAcknowledgedBy' "the acknowledgement is attributed"

echo "== configuration compilation =="
C=$(get /configuration/preview)
contains "$C" 'http_access allow all' "disabled mode compiles an allow-any policy"
excludes "$C" 'auth_param' "no auth_param while authentication is disabled"

patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
C=$(get /configuration/preview)
contains "$C" 'basic_ncsa_auth' "required mode wires up basic_ncsa_auth"
# Since ADR 0003 the challenge is scoped to the listener that demands it, so a
# guest listener beside it is never asked for credentials.
contains "$C" 'myportname' "each listener gets its own named port"
contains "$C" 'deny scp_lp_.*!scp_authenticated' "the challenge is scoped to the listener that requires it"
contains "$C" '"sensitive":true' "the password file is marked sensitive"
excludes "$C" 'e2e-verify-password' "no plaintext in the configuration preview"
excludes "$C" '\$6\$' "no password hashes in the configuration preview"

echo "== scenario E: OPTIONAL mode (PRODUCT.md section 7) =="
# The rule set is built here rather than assumed from seed data, so the script
# is independent of what other verification runs left behind.
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do
  curl -s -o /dev/null -X DELETE "$BASE/access-rules/$id" -H "$AUTH"
done
GUEST_ID=$(post /networks '{"name":"E2E guest network","cidrs":["10.20.0.0/24"]}' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$GUEST_ID" ] || GUEST_ID=$(get /networks | tr '{' '\n' | grep 'E2E guest network' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
post /access-rules "{\"position\":10,\"name\":\"Guests\",\"action\":\"ALLOW\",\"source\":{\"kind\":\"NETWORKS\",\"networkIds\":[\"$GUEST_ID\"]},\"identity\":{\"kind\":\"UNAUTHENTICATED\"},\"destination\":{\"kind\":\"SPECIFIC\",\"domains\":[],\"cidrs\":[],\"ports\":[80,443]},\"schedule\":{\"kind\":\"ALWAYS\"}}" >/dev/null
post /access-rules '{"position":20,"name":"Authenticated","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
post /access-rules '{"position":30,"name":"Deny the rest","action":"DENY","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null

patch /proxy-auth/config '{"mode":"OPTIONAL","defaultAccess":"DENY"}' >/dev/null
S=$(post /access-rules/simulate '{"sourceIp":"10.20.0.5","authenticated":false,"destinationHost":"example.com","destinationPort":443}')
contains "$S" '"decision":"ALLOW"' "anonymous guest reaches the web"
S=$(post /access-rules/simulate '{"sourceIp":"10.10.0.5","authenticated":true,"username":"e2e-verify","providerKey":"local","destinationHost":"example.com","destinationPort":443}')
contains "$S" '"decision":"ALLOW"' "authenticated employee is allowed"
S=$(post /access-rules/simulate '{"sourceIp":"10.99.0.5","authenticated":false,"destinationHost":"example.com","destinationPort":443}')
contains "$S" '"decision":"DENY"' "anonymous client from an unknown network is denied"


echo "== tightening the mode is never refused as an open proxy =="
# Regression: the security check judged the new mode against the old listeners,
# so switching from disabled to required was refused with a 409 - the exact
# opposite of opening the proxy.
patch /proxy-auth/config '{"mode":"DISABLED","defaultAccess":"ALLOW","acknowledgeOpenProxy":true}' >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/proxy-auth/config" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"mode":"REQUIRED","defaultAccess":"DENY"}')
expect "$CODE" "200" "switching from disabled to required is accepted without acknowledgement"
contains "$(get /proxy-auth/overview)" '"mode":"REQUIRED"' "the mode actually changed"

echo "== self-service portal =="
# Idempotent fixture: the scenario below changes this user's password, so it is
# reset first and the script can be run repeatedly.
post /proxy-users '{"username":"e2e-portal","displayName":"Portal verification","password":"e2e-portal-password"}' >/dev/null
PORTAL_USER_ID=$(get /proxy-users | tr '{' '\n' | grep '"username":"e2e-portal"' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$PORTAL_USER_ID" ] && post "/proxy-users/$PORTAL_USER_ID/password" \
  '{"password":"e2e-portal-password"}' >/dev/null
PORTAL=$(curl -s -X POST "$BASE/portal/session" -H 'Content-Type: application/json' \
  -d '{"username":"e2e-portal","password":"e2e-portal-password"}')
PORTAL_TOKEN=$(echo "$PORTAL" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$PORTAL_TOKEN" ]; then ok "proxy user signs in to the portal"; else bad "proxy user signs in to the portal"; fi
PAUTH="Authorization: Bearer $PORTAL_TOKEN"

contains "$(curl -s "$BASE/portal/me" -H "$PAUTH")" '"canChangePassword":true' "local account may change its password"
contains "$(curl -s "$BASE/portal/access-profile" -H "$PAUTH")" '"entries"' "the access profile is returned"
contains "$(curl -s "$BASE/portal/activity" -H "$PAUTH")" '"signIns"' "own activity is returned"

# The security boundary between the two identity planes: same signing key,
# different audience (PRODUCT.md section 1).
for path in /proxy-users /auth-providers /audit-events /configuration/export /session /dashboard; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$path" -H "$PAUTH")
  expect "$CODE" "401" "portal token is refused on $path"
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/portal/me" -H "$AUTH")
expect "$CODE" "401" "control plane token is refused on the portal"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/portal/password" -H "$PAUTH" \
  -H 'Content-Type: application/json' -d '{"currentPassword":"wrong-current-pw","newPassword":"another-password-1"}')
expect "$CODE" "401" "changing the password requires the current one"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/portal/password" -H "$PAUTH" \
  -H 'Content-Type: application/json' -d '{"currentPassword":"e2e-portal-password","newPassword":"changed-portal-password"}')
expect "$CODE" "200" "the user changes their own password"
contains "$(post /auth-test '{"username":"e2e-portal","password":"changed-portal-password"}')" '"success":true' \
  "the new password authenticates against the proxy identity"

A=$(get '/audit-events?limit=100')
excludes "$A" 'changed-portal-password' "the new password is not in the audit log"
contains "$A" 'PROXY_USER_SELF_PASSWORD_CHANGED' "the self-service change is audited"

echo "== authorisation fails closed =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/proxy-users")
expect "$CODE" "401" "API access without a session is refused"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
