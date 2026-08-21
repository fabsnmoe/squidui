#!/usr/bin/env bash
# OIDC sign-in and directory-backed proxy access (ADR 0004).
#
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-oidc.sh
#
# Against a real Keycloak, driving the real authorisation code flow with a
# cookie jar rather than mocking it, and proving every access decision where it
# actually matters: a request through a real Squid.
#
# The point of the deprovisioning half is not that a row changes in the
# database. It is that the person stops getting through the proxy.

set -u
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
AGENT_IMAGE="${SCP_AGENT_IMAGE:-squid-control-plane/node:dev}"
NODE=scp-oidc-node
ISSUER=http://keycloak:8080/realms/scp
KC_CLIENT=squid-control-plane
KC_SECRET=verification-client-secret
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }
excludes() { if echo "$1" | grep -q "$2"; then bad "$3"; else ok "$3"; fi; }

if [ -z "$ADMIN_PASSWORD" ]; then echo "Set SCP_ADMIN_PASSWORD." >&2; exit 2; fi

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$TOKEN" ]; then echo "control plane sign in failed" >&2; exit 1; fi
AUTH="Authorization: Bearer $TOKEN"

get() { curl -s "$BASE$1" -H "$AUTH"; }
post() { curl -s -X POST "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "${2:-null}"; }
patch() { curl -s -X PATCH "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
del() { curl -s -o /dev/null -X DELETE "$BASE$1" -H "$AUTH"; }
id_of() { sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -1; }
psql_() { $COMPOSE exec -T postgres psql -U squidcp -d squidcp -tAc "$1" 2>/dev/null; }

# through <credentials> -> HTTP status from a request that really crosses Squid
through() {
  if [ "$#" -eq 1 ]; then
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$NODE:3128" -U "$1" http://origin/ 2>/dev/null
  else
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$NODE:3128" http://origin/ 2>/dev/null
  fi
}

# Waits for Squid to answer as expected rather than sleeping a guessed amount.
# The agent polls, so a decision takes a moment to reach the proxy.
#
# Revocation additionally has to outlive Squid's credential cache: a successful
# check is trusted for credentialsttl, so a disabled account keeps working until
# that expires. The third argument is that allowance, and the number being
# visible here is the point - it is how long revocation actually takes.
await_through() {
  want="$1"; creds="${2:-}"; deadline=$(( $(date +%s) + ${3:-90} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    got=$([ -n "$creds" ] && through "$creds" || through)
    [ "$got" = "$want" ] && { echo "$got"; return; }
    sleep 3
  done
  echo "$got"
}

# oidc_login <username> <password> <audience> -> the control plane's answer
#
# The real authorisation code flow: fetch the login page, post the credentials
# with the session cookies, follow the redirect back and redeem the code. No
# part of this is mocked, which is the only way the signature verification,
# the nonce and the claim mapping are actually exercised.
oidc_login() {
  user="$1"; pass="$2"; audience="$3"
  aurl=$(curl -s -X POST "$BASE/auth/oidc/start" -H 'Content-Type: application/json' \
    -d "{\"providerKey\":\"keycloak\",\"audience\":\"$audience\"}" |
    sed -n 's/.*"authorizationUrl":"\([^"]*\)".*/\1/p')
  [ -n "$aurl" ] || { echo '{"error":{"message":"no authorization url"}}'; return; }

  loc=$($COMPOSE exec -T client sh -c "
    curl -s -c /tmp/cj-$user -o /tmp/p-$user.html '$aurl'
    ACT=\$(grep -o 'action=\"[^\"]*\"' /tmp/p-$user.html | head -1 | sed 's/action=\"//;s/\"\$//' | sed 's/&amp;/\&/g')
    [ -n \"\$ACT\" ] || exit 0
    curl -s -b /tmp/cj-$user -o /dev/null -D - -X POST \"\$ACT\" \
      --data-urlencode 'username=$user' --data-urlencode 'password=$pass' \
      --data-urlencode 'credentialId=' | grep -i '^location:'
  " 2>/dev/null | tr -d '\r')

  code=$(echo "$loc" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
  state=$(echo "$loc" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
  [ -n "$code" ] || { echo '{"error":{"message":"keycloak did not return a code"}}'; return; }

  curl -s -X POST "$BASE/auth/oidc/callback" -H 'Content-Type: application/json' \
    -d "{\"code\":\"$code\",\"state\":\"$state\"}"
}

# Keycloak's own admin API, used only to take a role away and give it back.
kc_admin_token() {
  $COMPOSE exec -T client sh -c "curl -s -X POST \
    'http://keycloak:8080/realms/master/protocol/openid-connect/token' \
    -d 'grant_type=password&client_id=admin-cli&username=kcadmin&password=kcadmin-password'" 2>/dev/null |
    sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}

kc_role() {
  action="$1"; username="$2"; role="$3"
  kct=$(kc_admin_token)
  uid=$($COMPOSE exec -T client sh -c "curl -s -H 'Authorization: Bearer $kct' \
    'http://keycloak:8080/admin/realms/scp/users?username=$username&exact=true'" 2>/dev/null |
    sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -1)
  rid=$($COMPOSE exec -T client sh -c "curl -s -H 'Authorization: Bearer $kct' \
    'http://keycloak:8080/admin/realms/scp/roles/$role'" 2>/dev/null |
    sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -1)
  method=$([ "$action" = "add" ] && echo POST || echo DELETE)
  $COMPOSE exec -T client sh -c "curl -s -o /dev/null -X $method \
    -H 'Authorization: Bearer $kct' -H 'Content-Type: application/json' \
    'http://keycloak:8080/admin/realms/scp/users/$uid/role-mappings/realm' \
    -d '[{\"id\":\"$rid\",\"name\":\"$role\"}]'" 2>/dev/null
}

echo "== preparing =="
$COMPOSE up -d origin client keycloak >/dev/null 2>&1
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  [ "$(docker inspect squid-control-plane-keycloak-1 --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ] && break
  sleep 5
done
expect "$(docker inspect squid-control-plane-keycloak-1 --format '{{.State.Health.Status}}' 2>/dev/null)" \
  "healthy" "a real Keycloak is running with the test realm"

docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
for id in $(get /nodes | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/"id":"//;s/"//'); do del "/nodes/$id"; done
for id in $(get /identity-providers | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/"id":"//;s/"//'); do
  del "/identity-providers/$id"
done
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do del "/access-rules/$id"; done
psql_ "delete from proxy_users where source = 'OIDC' or username like 'oidc-%'" >/dev/null
ok "fixture reset"

PROVIDER=$(post /identity-providers "{
  \"key\":\"keycloak\",\"name\":\"Keycloak\",\"issuer\":\"$ISSUER\",
  \"clientId\":\"$KC_CLIENT\",\"clientSecret\":\"$KC_SECRET\",
  \"allowAdminLogin\":true,\"allowPortalLogin\":true,
  \"adminClaim\":\"realm_access.roles\",\"adminValue\":\"squid-admin\",
  \"portalClaim\":\"realm_access.roles\",\"portalValue\":\"squid-user\"}" | id_of)
if [ -n "$PROVIDER" ]; then ok "identity provider configured"; else bad "identity provider configured"; fi

contains "$(post "/identity-providers/$PROVIDER/test")" '"ok":true' "discovery reaches the provider"
excludes "$(get /identity-providers)" "$KC_SECRET" "the client secret is never returned by the API"

echo
echo "== the administrator door =="
R=$(oidc_login oidc-admin oidc-admin-password control-plane)
contains "$R" '"audience":"control-plane"' "an administrator signs in through Keycloak"
contains "$R" '"permissions":\[' "the session carries permissions"
contains "$R" 'NODE_MANAGE' "the Administrator role is granted in full"

R=$(oidc_login oidc-outsider oidc-outsider-password control-plane)
excludes "$R" '"token"' "a user without the admin claim gets no control plane session"
contains "$R" 'not permitted' "and is told why"

echo
echo "== the portal door =="
R=$(oidc_login oidc-user oidc-user-password proxy-portal)
contains "$R" '"audience":"proxy-portal"' "a portal user signs in through Keycloak"
contains "$R" '"hasProxyAccount":false' "no proxy account exists yet"
PORTAL_TOKEN=$(echo "$R" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# A portal token must not open a control plane endpoint, even though both are
# signed with the same key.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nodes" -H "Authorization: Bearer $PORTAL_TOKEN")
expect "$CODE" "401" "a portal token is refused by the control plane"

R=$(curl -s -X POST "$BASE/portal/proxy-account" -H "Authorization: Bearer $PORTAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"oidc-user","password":"proxy-user-password-1"}')
contains "$R" '"username":"oidc-user"' "the portal user provisions a proxy account"
contains "$R" '"validUntil"' "the account is granted a lease"

ACC=$(curl -s "$BASE/portal/proxy-account" -H "Authorization: Bearer $PORTAL_TOKEN")
contains "$ACC" '"noticeDue":true' "the person is told their access is time limited"
curl -s -o /dev/null -X POST "$BASE/portal/proxy-account/acknowledge" -H "Authorization: Bearer $PORTAL_TOKEN"
contains "$(curl -s "$BASE/portal/proxy-account" -H "Authorization: Bearer $PORTAL_TOKEN")" \
  '"noticeDue":false' "and is not told again once acknowledged"

echo
echo "== the proxy actually accepts the provisioned account =="
post /access-rules '{"position":10,"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
post /access-rules '{"position":90,"name":"Deny the rest","action":"DENY","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null

NODE_ID=$(post /nodes "{\"name\":\"$NODE\",\"adapterId\":\"squid-6-debian\"}" | id_of)
ETOKEN=$(post "/nodes/$NODE_ID/enrollment-token" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
FRONT=$(docker network ls --format '{{.Name}}' | grep -E 'frontend$' | head -1)
PROXY=$(docker network ls --format '{{.Name}}' | grep -E 'proxytest$' | head -1)
docker run -d --name "$NODE" --network "$FRONT" -v "$NODE-state:/var/lib/scp-agent" \
  -e SCP_API_URL=http://web -e SCP_ENROLLMENT_TOKEN="$ETOKEN" -e SCP_POLL_INTERVAL_SECONDS=5 \
  "$AGENT_IMAGE" >/dev/null 2>&1
docker network connect "$PROXY" "$NODE" >/dev/null 2>&1

expect "$(await_through 200 oidc-user:proxy-user-password-1)" "200" \
  "the directory user reaches the origin with their proxy password"
expect "$(through)" "407" "an anonymous client is still challenged"
expect "$(through oidc-user:wrong-password-xxx)" "407" "a wrong proxy password is rejected"

echo
echo "== the claim is withdrawn: the fast half of deprovisioning =="
kc_role remove oidc-user squid-user
R=$(oidc_login oidc-user oidc-user-password proxy-portal)
excludes "$R" '"token"' "the sign-in is refused once the claim is gone"

STATUS=$(psql_ "select status from proxy_users where username = 'oidc-user'")
expect "$STATUS" "DISABLED" "the linked proxy account is disabled at that moment"
contains "$(get '/audit-events?limit=20')" 'CLAIM_WITHDRAWN' "the reason is in the audit log"

# The whole point. A row in a table is not a revocation.
expect "$(await_through 407 oidc-user:proxy-user-password-1 420)" "407" \
  "and the proxy stops letting them through, once the credential cache expires"

echo
echo "== the claim comes back =="
kc_role add oidc-user squid-user
R=$(oidc_login oidc-user oidc-user-password proxy-portal)
contains "$R" '"audience":"proxy-portal"' "the person can sign in again"
expect "$(psql_ "select status from proxy_users where username = 'oidc-user'")" "ACTIVE" \
  "their account is reactivated rather than left dead"
expect "$(await_through 200 oidc-user:proxy-user-password-1)" "200" \
  "and the proxy accepts them again"

echo
echo "== the lease expires: the half that covers a deleted user =="
# A user deleted in the directory produces no signal at all. Ageing the lease is
# how that case is reproduced without waiting ninety days.
psql_ "update proxy_users set valid_until = now() - interval '1 day' where username = 'oidc-user'" >/dev/null
expect "$(psql_ "select status from proxy_users where username = 'oidc-user'")" "ACTIVE" \
  "an expired lease alone does not change the row"

# The sweep runs on its own schedule; restarting the API runs it promptly.
$COMPOSE restart api >/dev/null 2>&1
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  [ "$(psql_ "select status from proxy_users where username = 'oidc-user'")" = "DISABLED" ] && break
  sleep 5
done
expect "$(psql_ "select status from proxy_users where username = 'oidc-user'")" "DISABLED" \
  "the sweep disables an account whose lease ran out"
expect "$(await_through 407 oidc-user:proxy-user-password-1 420)" "407" \
  "and the proxy stops letting them through, once the credential cache expires"

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $TOKEN"
contains "$(get '/audit-events?limit=20')" 'LEASE_EXPIRED' "the expiry is in the audit log"

R=$(oidc_login oidc-user oidc-user-password proxy-portal)
contains "$R" '"audience":"proxy-portal"' "signing in again restores access"
expect "$(await_through 200 oidc-user:proxy-user-password-1)" "200" \
  "and the proxy accepts them once more"

echo
echo "== the lease policy is an operator setting, not a constant =="
contains "$(get /settings)" '"leaseDays":90' "the default lease is ninety days"
patch /settings '{"leaseDays":30,"renewalWindowDays":3}' >/dev/null
contains "$(get /settings)" '"leaseDays":30' "an administrator can change it"
contains "$(get '/audit-events?limit=10')" 'SETTINGS_UPDATED' "the change is audited"
patch /settings '{"leaseDays":90,"renewalWindowDays":5}' >/dev/null

echo
echo "== cleanup =="
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
[ -n "$NODE_ID" ] && del "/nodes/$NODE_ID"
[ -n "$PROVIDER" ] && del "/identity-providers/$PROVIDER"
psql_ "delete from proxy_users where source = 'OIDC'" >/dev/null
ok "verification node and provider removed"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
