#!/usr/bin/env bash
# Statistics and access log format v3 (docs/design/statistics.md).
#
#   SCP_ADMIN_PASSWORD=... ./scripts/verify-statistics.sh
#
# Drives real traffic through a real Squid and then asks the statistics
# endpoint about it. The numbers on that page are only worth anything if they
# match what actually crossed the proxy, so that is what is checked: traffic is
# generated with known shape, and the answer has to reproduce it.

set -u
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${SCP_BASE_URL:-http://localhost:8080}/api/v1"
ADMIN_USER="${SCP_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${SCP_ADMIN_PASSWORD:-}"
AGENT_IMAGE="${SCP_AGENT_IMAGE:-squid-control-plane/node:dev}"
NODE=scp-stats-node
COMPOSE="docker compose --env-file .env -f deployments/compose/compose.yml -f deployments/compose/compose.test.yml"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }
contains() { if echo "$1" | grep -q "$2"; then ok "$3"; else bad "$3"; fi; }
atleast() { if [ "$1" -ge "$2" ] 2>/dev/null; then ok "$3"; else bad "$3 (expected at least $2, got '$1')"; fi; }

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
psql_() { $COMPOSE exec -T postgres psql -U squidcp -d squidcp -tAc "$1" 2>/dev/null | tr -d ' \r'; }
# field <json> <name> -> the numeric value of a "name":"123" pair
field() { echo "$1" | sed -n "s/.*\"$2\":\"\([0-9]*\)\".*/\1/p" | head -1; }

echo "== preparing =="
$COMPOSE up -d origin client >/dev/null 2>&1
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
for id in $(get /nodes | grep -o '"id":"[0-9a-f-]\{36\}"' | sed 's/"id":"//;s/"//'); do del "/nodes/$id"; done
for id in $(get /access-rules | grep -o '"id":"[^"]*"' | sed 's/"id":"//;s/"//'); do del "/access-rules/$id"; done
psql_ "delete from traffic_events; delete from traffic_rollups; delete from traffic_destination_rollups; delete from traffic_client_rollups" >/dev/null
psql_ "delete from proxy_users where username like 'stats-%'" >/dev/null
ok "fixture reset"

post /proxy-users '{"username":"stats-anna","displayName":"Anna","password":"stats-anna-password"}' >/dev/null
post /access-rules '{"position":10,"name":"Authenticated users","action":"ALLOW","source":{"kind":"ANY"},"identity":{"kind":"AUTHENTICATED"},"destination":{"kind":"SPECIFIC","domains":["origin"],"cidrs":[],"ports":[]},"schedule":{"kind":"ALWAYS"}}' >/dev/null
post /access-rules '{"position":90,"name":"Deny the rest","action":"DENY","source":{"kind":"ANY"},"identity":{"kind":"ANY"},"destination":{"kind":"ANY"},"schedule":{"kind":"ALWAYS"}}' >/dev/null
patch /proxy-auth/config '{"mode":"REQUIRED","defaultAccess":"DENY"}' >/dev/null
ok "policy prepared"

NODE_ID=$(post /nodes "{\"name\":\"$NODE\",\"adapterId\":\"squid-6-debian\"}" | id_of)
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
  code=$($COMPOSE exec -T client curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -x "http://$NODE:3128" -U stats-anna:stats-anna-password http://origin/ 2>/dev/null)
  [ "$code" = "200" ] && { READY=1; break; }
  sleep 3
done
expect "$READY" "1" "the node serves authenticated traffic"

echo
echo "== the emitted configuration uses format v3 =="
CONF=$(docker exec "$NODE" cat /etc/squid/scp/squid.conf 2>/dev/null)
contains "$CONF" 'logformat scp_v3' "the node was told to write format v3"
contains "$CONF" '%<st|%>st' "the format records both directions"

echo
echo "== traffic of a known shape =="
# 10 allowed, 3 denied (blocked destination), 2 challenged (no credentials),
# and one upload, so every counter has something distinguishable in it.
$COMPOSE exec -T client sh -c "
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null -x http://$NODE:3128 -U stats-anna:stats-anna-password http://origin/
  done
  for i in 1 2 3; do
    curl -s -o /dev/null --max-time 5 -x http://$NODE:3128 -U stats-anna:stats-anna-password http://blocked.invalid/
  done
  for i in 1 2; do
    curl -s -o /dev/null --max-time 5 -x http://$NODE:3128 http://origin/
  done
  curl -s -o /dev/null -x http://$NODE:3128 -U stats-anna:stats-anna-password \
    --data 'payload=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' http://origin/
" 2>/dev/null

DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  [ "$(psql_ "select count(*) from traffic_events")" -ge 15 ] 2>/dev/null && break
  sleep 3
done
atleast "$(psql_ "select count(*) from traffic_events")" 15 "the requests reached the control plane"

echo
echo "== upload bytes actually arrive =="
atleast "$(psql_ "select count(*) from traffic_events where bytes_uploaded > 0")" 1 \
  "at least one request recorded bytes received from the client"
atleast "$(psql_ "select coalesce(sum(bytes_uploaded),0) from traffic_rollups")" 1 \
  "and the hourly counters carry them too"

echo
echo "== the aggregates were written =="
atleast "$(psql_ "select count(*) from traffic_destination_rollups")" 1 "destinations were rolled up"
atleast "$(psql_ "select count(*) from traffic_client_rollups")" 1 "client addresses were rolled up"
atleast "$(psql_ "select coalesce(sum(duration_count),0) from traffic_rollups")" 1 "response times were counted"

echo
echo "== the endpoint reproduces what crossed the proxy =="
S=$(get "/statistics?from=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
contains "$S" '"source":"events"' "a recent range is answered from individual requests"
atleast "$(field "$S" requests)" 15 "the total matches the traffic sent"
atleast "$(field "$S" denied)" 3 "the denied requests are counted"
atleast "$(field "$S" challenged)" 2 "the challenged requests are counted"
atleast "$(field "$S" bytes_uploaded)" 1 "upload bytes appear in the totals"
contains "$S" '"topDestinations"' "destinations are reported"
contains "$S" '"errorReasons"' "error reasons are available on the detail path"

echo
echo "== resolution follows the range, not the storage =="
H1=$(get "/statistics?from=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
contains "$H1" '"granularity":"every minute"' "an hour is charted per minute"
contains "$(get "/statistics?from=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")"   '"granularity":"every 15 minutes"' "a day is charted per quarter hour"
contains "$(get "/statistics?from=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")"   '"granularity":"hourly"' "a week is charted hourly"

# The hourly counters cannot go below the hour they are named after, so a range
# they answer must never claim a finer resolution than they have.
contains "$(get "/statistics?from=$(date -u -d '300 days ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")"   '"granularity":"weekly"' "a long range falls back to the counters' own resolution"

# Proof rather than a label: traffic in two different minutes has to produce two
# points, which an hour-wide bucket could not show.
echo "  ..  waiting a minute so a second bucket exists"
sleep 65
$COMPOSE exec -T client sh -c "
  for i in 1 2 3; do curl -s -o /dev/null -x http://$NODE:3128 -U stats-anna:stats-anna-password http://origin/; done
" 2>/dev/null
DEADLINE=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BUCKETS=$(get "/statistics?from=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)" |
    grep -o '"at":"[^"]*"' | sort -u | wc -l | tr -d ' ')
  [ "$BUCKETS" -ge 2 ] 2>/dev/null && break
  sleep 5
done
atleast "$BUCKETS" 2 "requests a minute apart land in separate points"

echo
echo "== the reader picks the aggregation =="
W="from=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)"
contains "$(get "/statistics?$W&interval=5m")" '"granularity":"every 5 minutes"' "five minutes can be asked for"
contains "$(get "/statistics?$W&interval=1h")" '"granularity":"hourly"' "so can hourly"
contains "$(get "/statistics?$W&interval=6h")" '"granularity":"every 6 hours"' "so can six hours"
contains "$(get "/statistics?$W&interval=7d")" '"granularity":"weekly"' "so can a week"

# Summing the same traffic at different widths has to give the same total; if it
# does not, the aggregation is losing or double counting requests.
FINE=$(field "$(get "/statistics?$W&interval=5m")" requests)
COARSE=$(field "$(get "/statistics?$W&interval=1d")" requests)
expect "$FINE" "$COARSE" "the total is the same however it is bucketed"

# The counters are written every five minutes, so they cannot answer a finer
# question and must not pretend to.
LONG="from=$(date -u -d '300 days ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)"
contains "$(get "/statistics?$LONG&interval=5m")" '"granularitySeconds":300'   "the counters offer five minutes, which is what they store"

echo
echo "== counters are collected five minutes at a time =="
# Deliberately not "two buckets": traffic a minute apart belongs in the same
# five minute counter, and asserting otherwise would be asserting a bug.
#
# The exact claim instead: every counter bucket is the five minute floor of some
# real request, and every such floor has a counter. That pins the width without
# depending on which minute the test happened to run in.
expect "$(psql_ "select count(*) from ((select distinct bucket from traffic_rollups) except (select distinct to_timestamp(floor(extract(epoch from occurred_at)/300)*300) from traffic_events)) x")" "0"   "every counter bucket matches a five minute floor of real traffic"
expect "$(psql_ "select count(*) from ((select distinct to_timestamp(floor(extract(epoch from occurred_at)/300)*300) from traffic_events) except (select distinct bucket from traffic_rollups)) x")" "0"   "and no five minute window of traffic is missing a counter"
expect "$(psql_ "select count(*) from traffic_rollups where extract(epoch from bucket)::bigint % 300 <> 0")" "0"   "every bucket sits on a five minute boundary"

echo
echo "== filters =="
contains "$(get "/statistics?username=stats-anna")" '"source"' "filtering by user is accepted"
U=$(get "/statistics?username=stats-anna&from=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
atleast "$(field "$U" requests)" 11 "one person's requests are counted separately"
CIP=$(psql_ "select client_ip from traffic_events limit 1")
F=$(get "/statistics?clientIp=$CIP&from=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
atleast "$(field "$F" requests)" 1 "filtering by client address works"
D=$(get "/statistics?destination=origin&from=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
atleast "$(field "$D" requests)" 10 "filtering by destination works"

echo
echo "== the page is told which store answered =="
# A year back is beyond raw retention, so it has to fall to the counters.
LONG=$(get "/statistics?from=$(date -u -d '300 days ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
contains "$LONG" '"source":"rollups"' "a long range is answered from the hourly statistics"
contains "$LONG" 'responseTimePercentiles' "and says which questions it cannot answer"
atleast "$(field "$LONG" requests)" 15 "the long range still counts the traffic"

# A detail filter over a long range cannot be served by the counters at all.
TRUNC=$(get "/statistics?clientIp=$CIP&from=$(date -u -d '300 days ago' +%Y-%m-%dT%H:%M:%SZ)&to=$(date -u -d '1 hour' +%Y-%m-%dT%H:%M:%SZ)")
contains "$TRUNC" '"truncatedToRawRetention":true' "a detail filter beyond retention is reported as truncated"
contains "$TRUNC" '"appliedDetailFilter":"clientIp"' "and names the filter that caused it"

echo
echo "== retention is an operator setting =="
contains "$(get /settings)" '"retentionDays":365' "statistics are kept for a year by default"
patch /settings '{"statisticsRetentionDays":0}' >/dev/null
contains "$(get /settings)" '"retentionDays":0' "an administrator can set it to keep indefinitely"
contains "$(get '/audit-events?limit=10')" 'SETTINGS_UPDATED' "the change is audited"
patch /settings '{"statisticsRetentionDays":365}' >/dev/null

echo
echo "== compaction folds old detail into hours =="
# Age the buckets so the compactor treats them as old, then run it by restarting.
psql_ "update traffic_rollups set bucket = bucket - interval '30 days'" >/dev/null
psql_ "update traffic_destination_rollups set bucket = bucket - interval '30 days'" >/dev/null
psql_ "update traffic_client_rollups set bucket = bucket - interval '30 days'" >/dev/null
BEFORE_ROWS=$(psql_ "select count(*) from traffic_rollups")
BEFORE_REQ=$(psql_ "select coalesce(sum(requests),0) from traffic_rollups")
$COMPOSE restart api >/dev/null 2>&1
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "${SCP_BASE_URL:-http://localhost:8080}/api/health/ready")" = "200" ] && break
  sleep 2
done
DEADLINE=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  [ "$(psql_ "select count(*) from traffic_rollups where extract(epoch from bucket)::bigint % 3600 <> 0")" = "0" ] 2>/dev/null && break
  sleep 5
done
expect "$(psql_ "select count(*) from traffic_rollups where extract(epoch from bucket)::bigint % 3600 <> 0")" "0"   "old buckets are folded onto whole hours"
# The point of the fold: fewer rows, identical totals.
expect "$(psql_ "select coalesce(sum(requests),0) from traffic_rollups")" "$BEFORE_REQ"   "folding loses no requests"
if [ "$(psql_ "select count(*) from traffic_rollups")" -le "$BEFORE_ROWS" ] 2>/dev/null; then
  ok "and it does not grow the table"
else
  bad "and it does not grow the table"
fi

TOKEN=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json'   -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}" |
  sed -n 's/.*"token":"\([^"]*\)".*//p')
AUTH="Authorization: Bearer $TOKEN"

echo
echo "== cleanup =="
docker rm -f "$NODE" >/dev/null 2>&1
docker volume rm -f "$NODE-state" >/dev/null 2>&1
[ -n "$NODE_ID" ] && del "/nodes/$NODE_ID"
ok "verification node removed"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
