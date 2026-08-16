#!/usr/bin/env bash
# Verifies the traffic log pipeline end to end (PLAN.md Phase 8, 9.23).
#
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-traffic.sh
#
# Enrols a node, drives real requests through its Squid - both authenticated
# and anonymous - and checks that the control plane receives, parses, stores
# and aggregates them, and that a portal user sees only their own.

set -u
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
AGENT_IMAGE="${SCP_AGENT_IMAGE:-squid-control-plane/node:dev}"
NODE=scp-traffic-node
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }
excludes() { if echo "$1" | grep -q "$2"; then bad "$3"; else ok "$3"; fi; }

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Set SCP_ADMIN_PASSWORD." >&2
  exit 2
fi

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -z "$TOKEN" ]; then
  echo "control plane sign in failed" >&2
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"

get() { curl -s "$BASE$1" -H "$AUTH"; }
post() { curl -s -X POST "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "${2:-null}"; }
patch() { curl -s -X PATCH "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }
del() { curl -s -o /dev/null -X DELETE "$BASE$1" -H "$AUTH"; }

FRONTEND_NET=$(docker network ls --format '{{.Name}}' | grep -E 'frontend$' | head -1)
PROXY_NET=$(docker network ls --format '{{.Name}}' | grep -E 'proxytest$' | head -1)

node_id() {
  get /nodes | tr ',' '\n' | grep -B40 "\"name\":\"$NODE\"" | tail -60 |
    sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | tail -1
}

through_auth() {
  $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -x "http://$NODE:3128" -U traffic-user:traffic-user-password http://origin/ 2>/dev/null
}

through_anon() {
  $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -x "http://$NODE:3128" http://origin/ 2>/dev/null
}

echo "== preparing =="
if $COMPOSE up -d origin client >/dev/null 2>&1; then ok "origin and client running"; else bad "origin and client running"; fi
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
EXISTING=$(node_id)
if [ -n "$EXISTING" ]; then del "/nodes/$EXISTING"; fi

post /proxy-users '{"username":"traffic-user","displayName":"Traffic verification","password":"traffic-user-password"}' >/dev/null
USER_ID=$(get /proxy-users | tr '{' '\n' | grep '"username":"traffic-user"' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$USER_ID" ]; then post "/proxy-users/$USER_ID/password" '{"password":"traffic-user-password"}' >/dev/null; fi
ok "proxy user prepared"

for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do
  del "/access-rules/$id"
done
post /access-rules '{"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
ok "policy prepared"

echo
echo "== enrol a node =="
CREATED=$(post /nodes "{\"name\":\"$NODE\",\"adapterId\":\"squid-6-debian\"}")
NODE_ID=$(echo "$CREATED" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
ENROL=$(post "/nodes/$NODE_ID/enrollment-token")
ETOKEN=$(echo "$ENROL" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

docker run -d --name "$NODE" --network "$FRONTEND_NET" -v "$NODE-state:/var/lib/scp-agent" \
  -e SCP_API_URL=http://web -e SCP_ENROLLMENT_TOKEN="$ETOKEN" \
  -e SCP_POLL_INTERVAL_SECONDS=5 "$AGENT_IMAGE" >/dev/null 2>&1
docker network connect "$PROXY_NET" "$NODE" >/dev/null 2>&1

READY=0
DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$(through_anon)" != "000" ]; then READY=1; break; fi
  sleep 3
done
if [ "$READY" -eq 1 ]; then ok "node enrolled and serving"; else bad "node enrolled and serving"; fi

echo
echo "== drive traffic through the proxy =="
for _ in 1 2 3; do through_auth >/dev/null; done
ok "3 authenticated requests made"
for _ in 1 2; do through_anon >/dev/null; done
ok "2 anonymous requests made (challenged with 407)"

echo
echo "== the control plane receives, parses and stores them =="
FOUND=0
EVENTS=""
DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  EVENTS=$(get '/traffic/events?hours=1&limit=200')
  if echo "$EVENTS" | grep -q '"username":"traffic-user"'; then FOUND=1; break; fi
  sleep 5
done
if [ "$FOUND" -eq 1 ]; then ok "authenticated requests arrived with their identity"; else bad "authenticated requests arrived"; fi
contains "$EVENTS" '"destination_host":"origin"' "the destination host was parsed"
contains "$EVENTS" '"decision":"ALLOWED"' "an allowed request is recorded"
contains "$EVENTS" "\"node_name\":\"$NODE\"" "events are attributed to the node"

echo
echo "== identity filters (PLAN.md 9.23) =="
AUTHED=$(get '/traffic/events?hours=1&identity=AUTHENTICATED&limit=200')
contains "$AUTHED" '"username":"traffic-user"' "the authenticated filter returns identified requests"
excludes "$AUTHED" '"username":null' "the authenticated filter excludes anonymous requests"

ANON=$(get '/traffic/events?hours=1&identity=UNAUTHENTICATED&limit=200')
excludes "$ANON" '"username":"traffic-user"' "the unauthenticated filter excludes identified requests"

USERQ=$(get '/traffic/events?hours=1&identity=USER&username=traffic-user&limit=200')
contains "$USERQ" '"username":"traffic-user"' "filtering by a specific user works"

NOBODY=$(get '/traffic/events?hours=1&identity=USER&username=no-such-user&limit=200')
excludes "$NOBODY" '"username":"traffic-user"' "filtering by another user returns none of theirs"

echo
echo "== aggregates feed the dashboard =="
# The agent ships in batches, so the first event arriving does not mean all of
# them have. Poll until the count matches rather than asserting on a race.
AUTH_COUNT=0
DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  SUMMARY=$(get '/traffic/summary?hours=1')
  AUTH_COUNT=$(echo "$SUMMARY" | sed -n 's/.*"authenticatedRequests":\([0-9]*\).*/\1/p')
  if [ "${AUTH_COUNT:-0}" -ge 3 ]; then break; fi
  sleep 5
done
contains "$SUMMARY" '"available":true' "the summary reports data as available"
if [ "${AUTH_COUNT:-0}" -ge 3 ]; then
  ok "authenticated requests counted ($AUTH_COUNT)"
else
  bad "authenticated requests counted (got ${AUTH_COUNT:-none})"
fi
contains "$SUMMARY" '"username":"traffic-user"' "the user appears among the most active identities"
contains "$(get /dashboard)" '"available":true' "the dashboard no longer reports traffic as unavailable"

echo
echo "== a portal user sees their own traffic, and only that =="
PORTAL=$(curl -s -X POST "$BASE/portal/session" -H 'Content-Type: application/json' \
  -d '{"username":"traffic-user","password":"traffic-user-password"}')
PTOKEN=$(echo "$PORTAL" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ACTIVITY=$(curl -s "$BASE/portal/activity" -H "Authorization: Bearer $PTOKEN")
contains "$ACTIVITY" '"available":true' "the portal reports traffic as measured"
PREQ=0
DEADLINE=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  ACTIVITY=$(curl -s "$BASE/portal/activity" -H "Authorization: Bearer $PTOKEN")
  PREQ=$(echo "$ACTIVITY" | sed -n 's/.*"requests":\([0-9]*\).*/\1/p')
  if [ "${PREQ:-0}" -ge 3 ]; then break; fi
  sleep 5
done
if [ "${PREQ:-0}" -ge 3 ]; then
  ok "the portal shows the user's own request count ($PREQ)"
else
  bad "the portal shows a request count (got ${PREQ:-none})"
fi
PCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/traffic/events" -H "Authorization: Bearer $PTOKEN")
if [ "$PCODE" = "401" ]; then
  ok "a portal token cannot read the fleet wide traffic log"
else
  bad "a portal token cannot read the fleet wide traffic log (got $PCODE)"
fi

echo
echo "== cleanup =="
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
if [ -n "$NODE_ID" ]; then del "/nodes/$NODE_ID"; fi
ok "verification node removed"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
