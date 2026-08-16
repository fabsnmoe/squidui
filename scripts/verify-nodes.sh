#!/usr/bin/env bash
# Verifies single and multi node operation end to end (PLAN.md Phase 3).
#
#   ./scripts/install.sh
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-nodes.sh
#
# It declares two nodes in the control plane, starts a real agent container for
# each on a separate network, and checks that both enrol, pull the compiled
# configuration, run Squid with it and serve traffic. Then it changes the policy
# and checks that both converge on their own.
#
# The agents reach the control plane over HTTP inside a compose network here.
# In a real deployment they reach it over the network the proxy hosts can use,
# which is the whole point of the pull model.

set -u
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
AGENT_IMAGE="${SCP_AGENT_IMAGE:-squid-control-plane/node:dev}"
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }

[ -n "$ADMIN_PASSWORD" ] || { echo "Set SCP_ADMIN_PASSWORD." >&2; exit 2; }

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "control plane sign in failed" >&2; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

get() { curl -s "$BASE$1" -H "$AUTH"; }
post() { curl -s -X POST "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "${2:-{\}}"; }
patch() { curl -s -X PATCH "$BASE$1" -H "$AUTH" -H 'Content-Type: application/json' -d "$2"; }

FRONTEND_NET=$(docker network ls --format '{{.Name}}' | grep -E 'frontend$' | head -1)
PROXY_NET=$(docker network ls --format '{{.Name}}' | grep -E 'proxytest$' | head -1)

# The node list is nested JSON, so splitting it on braces mixes fields from the
# apply and configuration objects into the wrong node. Fetching the node by id
# returns exactly one object and keeps the assertions honest.
node_id() {
  get /nodes | tr ',' '\n' | grep -B40 "\"name\":\"$1\"" | tail -60 |
    sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | tail -1
}

node_json() {
  id=$(node_id "$1")
  [ -n "$id" ] && get "/nodes/$id" || echo '{}'
}

cleanup_agent() {
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker volume rm -f "$1-state" >/dev/null 2>&1 || true
}

# Declares a node, issues a token and starts an agent container for it.
start_node() {
  name="$1"
  cleanup_agent "$name"

  existing=$(node_id "$name")
  [ -n "$existing" ] && curl -s -o /dev/null -X DELETE "$BASE/nodes/$existing" -H "$AUTH"

  created=$(post /nodes "{\"name\":\"$name\",\"description\":\"Verification node\",\"adapterId\":\"squid-6-debian\"}")
  id=$(echo "$created" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$id" ] || { bad "node $name created"; return 1; }

  enrol=$(post "/nodes/$id/enrollment-token")
  token=$(echo "$enrol" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$token" ] || { bad "enrolment token for $name"; return 1; }

  docker run -d --name "$name" \
    --network "$FRONTEND_NET" \
    -v "$name-state:/var/lib/scp-agent" \
    -e SCP_API_URL=http://web \
    -e SCP_ENROLLMENT_TOKEN="$token" \
    -e SCP_NODE_HOSTNAME="$name.example.internal" \
    -e SCP_POLL_INTERVAL_SECONDS=5 \
    "$AGENT_IMAGE" >/dev/null 2>&1 || { bad "agent container for $name started"; return 1; }

  # The proxy has to reach the origin, which lives on the test network.
  docker network connect "$PROXY_NET" "$name" >/dev/null 2>&1
  return 0
}

wait_for() {
  # wait_for <node name> <grep pattern> <seconds>
  deadline=$(( $(date +%s) + ${3:-60} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    node_json "$1" | grep -q "$2" && return 0
    sleep 2
  done
  return 1
}

through() {
  # through <node container> [credentials]
  if [ "$#" -eq 2 ]; then
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$1:3128" -U "$2" http://origin/ 2>/dev/null
  else
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$1:3128" http://origin/ 2>/dev/null
  fi
}

echo "== preparing =="
$COMPOSE up -d origin client >/dev/null 2>&1 && ok "origin and client running" || bad "origin and client running"
[ -n "$FRONTEND_NET" ] && [ -n "$PROXY_NET" ] && ok "networks resolved" || bad "networks resolved"

# A policy every enrolled node can serve without credentials.
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do
  curl -s -o /dev/null -X DELETE "$BASE/access-rules/$id" -H "$AUTH"
done
post /access-rules '{"name":"Allow any","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
patch /proxy-auth/config '{"mode":"DISABLED","defaultAccess":"ALLOW","acknowledgeOpenProxy":true}' >/dev/null
ok "baseline policy set"

echo
echo "== single node: declare, enrol, apply =="
start_node scp-node-a && ok "node A declared and agent started"
if wait_for scp-node-a '"enrolled":true' 90; then ok "node A enrolled itself with the one-time token"; else bad "node A enrolled"; fi
if wait_for scp-node-a '"inSync":true' 90; then ok "node A pulled and applied the configuration"; else bad "node A applied"; fi
contains "$(node_json scp-node-a)" '"result":"APPLIED"' "node A reported APPLIED"
contains "$(node_json scp-node-a)" 'scp-node-a.example.internal' "node A reported its hostname"
expect "$(through scp-node-a)" "200" "traffic passes through node A"

echo
echo "== the token is single use =="
ID_A=$(node_id scp-node-a)
SECOND=$(curl -s -X POST "$BASE/agent/enroll" -H 'Content-Type: application/json' \
  -d '{"token":"scpe_this-token-was-never-issued","hostname":"attacker"}' -o /dev/null -w '%{http_code}')
expect "$SECOND" "401" "an unknown enrolment token is refused"

echo
echo "== second node: same operation, nothing single-node specific =="
start_node scp-node-b && ok "node B declared and agent started"
if wait_for scp-node-b '"enrolled":true' 90; then ok "node B enrolled"; else bad "node B enrolled"; fi
if wait_for scp-node-b '"inSync":true' 90; then ok "node B applied the same configuration"; else bad "node B applied"; fi
expect "$(through scp-node-b)" "200" "traffic passes through node B"

SUMMARY=$(get /nodes)
contains "$SUMMARY" '"enrolled":2' "the control plane counts two enrolled nodes"
contains "$SUMMARY" '"inSync":2' "both nodes are in sync"
contains "$SUMMARY" '"drifted":0' "no drift reported"

echo
echo "== a policy change converges on every node =="
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
post /proxy-users '{"username":"node-verify","displayName":"Node verification","password":"node-verify-password"}' >/dev/null
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do
  curl -s -o /dev/null -X DELETE "$BASE/access-rules/$id" -H "$AUTH"
done
post /access-rules '{"name":"Authenticated only","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
# A real assertion, not an unconditional pass. An unconditional ok here hid a
# 409 for two full runs and made the product look broken.
MODE=$(get /proxy-auth/overview | grep -o '"configuration":{"mode":"[A-Z]*"' | grep -o '[A-Z]\{4,\}')
expect "$MODE" "REQUIRED" "policy switched to REQUIRED"

converged=0
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if get /nodes | grep -q '"inSync":2'; then converged=1; break; fi
  sleep 3
done
[ "$converged" -eq 1 ] && ok "both nodes converged on the new configuration without operator action" ||
  bad "both nodes converged"

expect "$(through scp-node-a)" "407" "node A now challenges anonymous clients"
expect "$(through scp-node-a node-verify:node-verify-password)" "200" "node A accepts the local proxy user"
expect "$(through scp-node-b)" "407" "node B now challenges anonymous clients"
expect "$(through scp-node-b node-verify:node-verify-password)" "200" "node B accepts the same user"

echo
echo "== revoking a credential stops that node from pulling =="
curl -s -o /dev/null -X POST "$BASE/nodes/$ID_A/revoke" -H "$AUTH"
rejected=0
deadline=$(( $(date +%s) + 40 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  docker logs --tail 60 scp-node-a 2>&1 | grep -q 'credential was rejected' && { rejected=1; break; }
  sleep 3
done
[ "$rejected" -eq 1 ] && ok "node A reports its credential was rejected" ||
  bad "node A reports its credential was rejected"
expect "$(through scp-node-a node-verify:node-verify-password)" "200" \
  "node A keeps serving the configuration it already had"

echo
echo "== cleanup =="
for name in scp-node-a scp-node-b; do
  cleanup_agent "$name"
  id=$(node_id "$name")
  [ -n "$id" ] && curl -s -o /dev/null -X DELETE "$BASE/nodes/$id" -H "$AUTH"
done
ok "verification nodes removed"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
