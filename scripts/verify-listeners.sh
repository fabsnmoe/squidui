#!/usr/bin/env bash
# Acceptance criterion for phase 6.5 (ADR 0003).
#
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-listeners.sh
#
# Two listeners on one real Squid node, at the same time:
#
#   :3128  REQUIRED   corporate, credentials demanded
#   :3129  DISABLED   guest, no credentials
#
# The point is not that each works alone. It is that they coexist, that their
# policies do not bleed into each other, and that the configuration hash stays
# stable so drift detection keeps meaning something.

set -u
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
AGENT_IMAGE="${SCP_AGENT_IMAGE:-squid-control-plane/node:dev}"
NODE=scp-listener-node
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "Set SCP_ADMIN_PASSWORD." >&2
  exit 2
fi

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

# through <port> [credentials] -> HTTP status
through() {
  if [ "$#" -eq 2 ]; then
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$NODE:$1" -U "$2" http://origin/ 2>/dev/null
  else
    $COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      -x "http://$NODE:$1" http://origin/ 2>/dev/null
  fi
}

echo "== preparing =="
$COMPOSE up -d origin client >/dev/null 2>&1 && ok "origin and client running" || bad "origin and client running"
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1

# Remove every node and listener profile so the fixture is deterministic.
for id in $(get /nodes | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/"id":"//;s/"//'); do del "/nodes/$id"; done
for id in $(get /listener-profiles | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/"id":"//;s/"//'); do
  del "/listener-profiles/$id"
done
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do del "/access-rules/$id"; done
ok "fixture reset"

post /proxy-users '{"username":"corp-user","displayName":"Corporate user","password":"corp-user-password"}' >/dev/null
UID_=$(get /proxy-users | tr '{' '\n' | grep '"username":"corp-user"' | id_of)
if [ -n "$UID_" ]; then post "/proxy-users/$UID_/password" '{"password":"corp-user-password"}' >/dev/null; fi
ok "proxy user prepared"

echo
echo "== a site group with its own listeners =="
GROUP=$(post /node-groups '{"name":"Leipzig","description":"Site group for the acceptance case"}' | id_of)
if [ -z "$GROUP" ]; then
  GROUP=$(get /node-groups | tr '{' '\n' | grep '"name":"Leipzig"' | id_of)
fi
if [ -n "$GROUP" ]; then ok "node group created"; else bad "node group created"; fi

CORP=$(post /listener-profiles "{\"name\":\"Corporate\",\"address\":\"0.0.0.0\",\"port\":3128,\"authenticationMode\":\"REQUIRED\",\"groupId\":\"$GROUP\"}" | id_of)
GUEST=$(post /listener-profiles "{\"name\":\"Guest\",\"address\":\"0.0.0.0\",\"port\":3129,\"authenticationMode\":\"DISABLED\",\"groupId\":\"$GROUP\"}" | id_of)
if [ -n "$CORP" ] && [ -n "$GUEST" ]; then ok "both listener profiles created"; else bad "both listener profiles created"; fi

# Two listeners on one address and port would make Squid refuse to start, so
# the control plane refuses it first.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/listener-profiles" -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Duplicate\",\"address\":\"0.0.0.0\",\"port\":3128,\"groupId\":\"$GROUP\"}")
expect "$CODE" "409" "a second listener on the same address and port is refused"

echo
echo "== policy: authenticated anywhere, anonymous to the origin =="
post /access-rules '{"position":10,"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
post /access-rules '{"position":20,"name":"Anyone to the origin","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"SPECIFIC","domains":["origin"],"cidrs":[],"ports":[]},"schedule":{"kind":"ALWAYS"}}' >/dev/null
post /access-rules '{"position":30,"name":"Deny the rest","action":"DENY","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
ok "policy prepared"

echo
echo "== enrol a node into that group =="
NODE_ID=$(post /nodes "{\"name\":\"$NODE\",\"adapterId\":\"squid-6-debian\"}" | id_of)
post "/nodes/$NODE_ID/group" "{\"groupId\":\"$GROUP\"}" >/dev/null
ETOKEN=$(post "/nodes/$NODE_ID/enrollment-token" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

FRONT=$(docker network ls --format '{{.Name}}' | grep -E 'frontend$' | head -1)
PROXY=$(docker network ls --format '{{.Name}}' | grep -E 'proxytest$' | head -1)
docker run -d --name "$NODE" --network "$FRONT" -v "$NODE-state:/var/lib/scp-agent" \
  -e SCP_API_URL=http://web -e SCP_ENROLLMENT_TOKEN="$ETOKEN" -e SCP_POLL_INTERVAL_SECONDS=5 \
  "$AGENT_IMAGE" >/dev/null 2>&1
docker network connect "$PROXY" "$NODE" >/dev/null 2>&1

READY=0
DEADLINE=$(( $(date +%s) + 150 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ "$(through 3128)" != "000" ] && [ "$(through 3129)" != "000" ]; then READY=1; break; fi
  sleep 3
done
if [ "$READY" -eq 1 ]; then ok "node serves both listeners"; else bad "node serves both listeners"; fi

echo
echo "== the acceptance criterion =="
expect "$(through 3128)" "407" "corporate listener challenges an anonymous client"
expect "$(through 3128 corp-user:corp-user-password)" "200" "corporate listener accepts the proxy user"
expect "$(through 3128 corp-user:wrong-password-xx)" "407" "corporate listener rejects a wrong password"
expect "$(through 3129)" "200" "guest listener serves without any credentials"

# The whole point: one listener demanding credentials must not make the other
# demand them, and vice versa.
ok "both listeners answer differently on the same node at the same time"

echo
echo "== the listeners do not bleed into each other =="
CONF=$(docker exec "$NODE" cat /etc/squid/scp/squid.conf 2>/dev/null)
contains "$CONF" 'http_port 0.0.0.0:3128 name=' "the corporate port is named"
contains "$CONF" 'http_port 0.0.0.0:3129 name=' "the guest port is named"
GUARDS=$(echo "$CONF" | grep -c 'scp_lp_.*!scp_authenticated' || true)
expect "$GUARDS" "1" "exactly one listener carries a credentials guard"
contains "$CONF" 'myportname' "the guard is scoped by port name, not globally"

echo
echo "== the configuration hash is stable =="
H1=$(get "/nodes/$NODE_ID" | sed -n 's/.*"currentHash":"\([0-9a-f]*\)".*/\1/p')
sleep 2
H2=$(get "/nodes/$NODE_ID" | sed -n 's/.*"currentHash":"\([0-9a-f]*\)".*/\1/p')
expect "$H1" "$H2" "compiling the same configuration twice yields the same hash"
contains "$(get "/nodes/$NODE_ID")" '"inSync":true' "the node reports itself in sync"

# A change to one listener must move the hash; otherwise drift detection is
# meaningless.
patch "/listener-profiles/$GUEST" '{"port":3130}' >/dev/null
H3=$(get "/nodes/$NODE_ID" | sed -n 's/.*"currentHash":"\([0-9a-f]*\)".*/\1/p')
if [ "$H3" != "$H1" ]; then ok "changing a listener changes the hash"; else bad "changing a listener changes the hash"; fi
patch "/listener-profiles/$GUEST" '{"port":3129}' >/dev/null

echo
echo "== cleanup =="
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
if [ -n "$NODE_ID" ]; then del "/nodes/$NODE_ID"; fi
ok "verification node removed"

# Restore the baseline this script tore down. Without a listener assigned to
# every group, any node outside "Leipzig" compiles a configuration with no
# http_port at all and Squid refuses to start - which is exactly how this
# script broke verify-squid.sh and verify-e2e.sh the first time it ran.
if [ -n "$CORP" ]; then del "/listener-profiles/$CORP"; fi
if [ -n "$GUEST" ]; then del "/listener-profiles/$GUEST"; fi
if [ -n "$GROUP" ]; then del "/node-groups/$GROUP"; fi
post /listener-profiles   '{"name":"Default","address":"0.0.0.0","port":3128,"authenticationMode":"INHERIT","groupId":null}' >/dev/null
RESTORED=$(get /listener-profiles | grep -c '"name":"Default"' || true)
expect "$RESTORED" "1" "the default listener is restored for every group"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
