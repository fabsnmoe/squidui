# Observability → Statistics

Status: **implemented**, verified by `scripts/verify-statistics.sh` (31 checks
against a real Squid).

Written as a concept first, because two of the decisions changed the data model
and one changed the log format. What follows is what was built; the decisions
taken are recorded at the end.

## The question the page answers

Not "how much traffic is there" — the dashboard already hints at that. The page
exists so an operator can answer, for **one node**:

> Is it working, who is using it, is the policy doing what I meant, is it fast,
> and what is going wrong?

Everything below serves one of those five questions. Anything that does not is
decoration.

## What we can compute today

This is the constraint that shapes the whole design, so it comes before the KPI
list rather than after it.

| Source | Kept | Carries |
| --- | --- | --- |
| `traffic_events` | **30 days** (`TRAFFIC_LOG_RETENTION_DAYS`) | time, client IP, username, provider, Squid result code, HTTP status, bytes, **duration**, method, destination host, destination port, decision |
| `traffic_rollups` | **indefinitely** | hour, node, authenticated, username, decision → requests, bytes |
| `node_heartbeats` | current only | agent version, Squid version, Squid running, config hash, last seen |

Two consequences worth stating plainly:

- **Detail is bounded to 30 days.** Response times, cache hit ratio, destinations
  and error reasons exist only in the raw events. Beyond retention, only
  requests and bytes per hour, user and decision survive.
- **"Bandwidth" today means download.** The log format records `%<st`, the bytes
  Squid sent *to the client*. Upload is not logged at all. A bandwidth chart
  built on this is honest only if it says "delivered to clients".

## The KPIs

Grouped by the question they answer. **R** = available from rollups, so it works
over any time range. **E** = needs raw events, so 30 days.

### Is it working?

| KPI | Source | Why it earns a place |
| --- | --- | --- |
| Requests per hour, with peak | R | The base rate. A drop to zero is the first sign a node is deaf. |
| Bytes delivered per hour, with peak | R | Capacity planning, and the number people ask for. |
| Availability from heartbeats | heartbeat history* | "Squid running" over time, not just right now. |
| Time since last successful apply | node | A node that is healthy but stuck on an old revision. |

\* needs a small change: heartbeats are currently overwritten, not kept.

### Who is using it?

| KPI | Source | |
| --- | --- | --- |
| Authenticated vs unauthenticated share | R | The single most telling number when the mode is `REQUIRED`. |
| Top users by requests and by bytes | R | Two different lists, and the difference between them is interesting. |
| Distinct active users | R | Licence-shaped question; also shows a directory rollout progressing. |
| Distinct client addresses | E | On an internet-facing node, separates a few heavy users from many. |

### Is the policy doing what I meant?

| KPI | Source | |
| --- | --- | --- |
| Decision mix: allowed / denied / challenged / error | R | The page's most important chart. |
| Denial rate over time | R | A step change after a rule edit is the fastest feedback loop we can offer. |
| Top denied destinations | E | What people are actually trying to reach that policy blocks. |
| Challenge rate | R | Sustained high 407s means clients are misconfigured, not that policy is tight. |

### Is it fast?

| KPI | Source | |
| --- | --- | --- |
| Median and p95 response time | E | Averages hide the complaint; p95 is the complaint. |
| Cache hit ratio | E | From the Squid result code. **Only meaningful for plain HTTP** — a CONNECT tunnel is never cached, and on a modern, mostly-HTTPS proxy this number is small by nature. Shown with that caveat or not at all. |
| Slowest destinations | E | Usually an upstream problem, and this is where an operator proves it. |

### What is going wrong?

| KPI | Source | |
| --- | --- | --- |
| Error rate | R | |
| Requests the proxy never served | E | `NONE_*` — malformed requests, aborted connections, TLS against the plaintext port. |
| Top error reasons | E | |
| Share of CONNECT vs plain HTTP | E | Tells an operator what kind of proxy they are actually running. |

That fourth row matters more than it looks for a node published on the internet:
it separates real usage from background scanning, which otherwise inflates every
other number on the page. This is exactly the noise that was being mislabelled
as "Allowed" until defect eleven.

## The user plane

Worth stating separately, because it is easy to assume the opposite: **per-user
statistics need no change to the agent at all.** The agent ships raw log lines
and parses nothing; the username is on every line, and `traffic_rollups` is
keyed by it and kept indefinitely. Measured on a real node:

```text
permanent (rollups)                 detail (30 days, raw events)
username     decision  req  bytes   username     req  hosts  ips  avg_ms  max_ms
stats-anna   ALLOWED    25  23544   stats-anna    25      1    1       1      29
stats-bruno  ALLOWED     3   2829   stats-bruno    4      2    1      15      59
stats-bruno  ERROR       1   3555
```

| KPI | Source | Why it earns a place |
| --- | --- | --- |
| Requests and bytes over time | R | The per-person answer to "who is using the proxy". |
| Decision mix per user | R | One person hitting a wall repeatedly is a support ticket waiting to happen. |
| Which nodes a person uses | R | Site assignment in practice rather than on paper. |
| First seen, last seen | R | Dormant accounts - the same question ADR 0004's lease answers from the other side. |
| Accounts with no traffic at all | R | Candidates for removal, which is otherwise guesswork. |
| Top destinations per user | E | |
| Distinct destinations | E | Breadth of use; a service account should be narrow. |
| **Distinct client addresses** | E | A credential used from many addresses at once is the signature of a shared or leaked account. This is a security KPI, not a curiosity. |
| Median and p95 response time | E | "The proxy is slow" is usually one person on one route. |
| Usage by hour of day | R | Distinguishes a person from a scheduled job. |

The one genuinely missing user-plane number is **upload bytes**, and that is a
log format change rather than agent work - see decision 4. Concurrent sessions
per user are not obtainable at all: HTTP proxying has no session, and Squid's
connection counters are per process, not per identity.

## How often a data point exists

Three cadences, and conflating them is easy:

| | |
| --- | --- |
| A request is recorded | **individually**, with its own millisecond timestamp |
| It reaches the control plane | on the agent's next poll, **~30 s** by default |
| Counters are written | **every five minutes** |

### Collected fine, compacted later

Five minutes is twelve times the rows of an hour. That is affordable for a
recent window and not for a year - especially for the destination and client
cubes, which are the widest. So counters are collected at five minutes and, once
they are older than a configurable window (14 days by default), folded into the
hour they fall in.

The fold is a sum. Every counter the page reads survives it exactly; the only
thing lost is the resolution, which is the point of doing it. Both the fine
window and the overall retention are settings under `System -> Settings`.

```text
now ─────────── 14 days ──────────── 365 days ─────>
   five minute buckets   hourly buckets      deleted
```

### The reader picks the aggregation

The page offers **5 minutes, 15 minutes, hourly, 6 hours, daily, weekly** and an
automatic setting that suits the range. Whatever is picked is summed from the
stored buckets, so the total is the same at every width - a property the
verification asserts rather than assumes.

A request finer than the store can produce is clamped rather than faked: the
counters cannot answer below five minutes, the raw events not below a request.
And when a range reaches back past the fine window, the page says that those
points exist only as whole hours - grouping them by five minutes cannot invent
detail that was folded away.

## The honesty problem with the time range

The available KPIs depend on the range chosen. Pick 90 days and half the page
has no data — not because nothing happened, but because the raw events aged out.

Silently empty charts would be the worst outcome. The page therefore:

- offers ranges **24 hours, 7 days, 30 days, 90 days, 1 year**;
- beyond the raw retention, replaces the detail cards with one explicit note
  naming the retention setting and what it would take to keep more;
- never renders an empty chart where the answer is "we no longer know".

## Page shape

```text
Observability → Statistics

[ Node: All nodes ▾ ]   [ Range: Last 7 days ▾ ]

Requests    Bytes delivered    Authenticated    Denied    Errors
1.2 M       84 GB              91 %             3.1 %     0.4 %

  Requests over time — stacked by decision
  Bytes delivered over time

  Top users              Top destinations         Response time
  by requests / bytes    by requests / bytes      median · p95

  Denied destinations    Errors by reason         Traffic mix
                                                  CONNECT vs HTTP
```

The node selector defaults to **All nodes** rather than the first node: a
fleet-wide answer is the more common question, and picking one node silently
would misrepresent totals. It is the same control as the existing filters, not a
new pattern.

## What this needs

### 1. A node filter on the aggregates — small

`/traffic/summary` ignores `nodeId` today even though `traffic_rollups` carries
it. Adding the filter and a `/traffic/statistics` endpoint covers most of the
page. `traffic_events` already has `(node_id, occurred_at desc)`, so the detail
queries are cheap.

### 2. Keeping heartbeats — small, needs a decision

Availability over time needs heartbeat history, which is currently overwritten.
One row per node per poll is too much; one row per node per hour with a count of
observations and a count where Squid was running is enough and costs 8 760 rows
per node per year.

### 3. A per-node hourly metrics rollup — medium, needs a decision

Everything marked **E** dies at 30 days. One extra rollup keyed only by
`(bucket, node)` would keep the shape of it forever at the same trivial
cardinality:

```text
requests, bytes, errors, denied, challenged,
cache_hits, tunnels,
duration_sum, duration_count, duration_max
```

That gives permanent request rate, error rate, cache ratio and mean response
time. Percentiles cannot be aggregated this way — p95 stays a 30-day number
unless we store histogram buckets, which I would not do for 1.0.

### 4. Upload bytes — needs a decision, changes the log format, not the agent

`%<st` is download only. Recording upload as well means adding `%>st` and a
format v3.

This is smaller than it sounds, and it is worth being precise about why: the
agent writes whatever configuration the compiler produces and ships whatever
lines Squid writes. It does not parse them. A format change therefore touches
the compiler, the parser and one migration - and every enrolled node picks it up
on its next poll like any other configuration change. **No agent is rebuilt or
redeployed.** The parser already carries an explicit version token, so v2 lines
still in flight keep being read correctly while nodes converge.

### 5. Squid's own counters — larger, out of 1.0 in my view

The access log cannot show concurrent connections, file descriptor pressure,
Squid CPU or cache disk usage. Squid exposes all of it through the cache
manager, and the agent already runs next to it and already reports. This would
be the right way to make the page a real operations view — and it is a new
collection path with its own failure modes, so it belongs after 1.0.

## What was built

**Storage.** Migration 0010 adds upload bytes and aggregated response time to
`traffic_rollups`, and two new cubes keyed only by `(bucket, node)`:
`traffic_destination_rollups` and `traffic_client_rollups`. Neither carries a
user dimension - the product of those dimensions is what would turn a rollup
into something the size of the raw data it replaces.

**Log format v3** adds `%>st`, the bytes received from the client. The parser
reads v1, v2 and v3 at once, because a format change reaches nodes one poll at a
time and lines written a minute ago are still in flight. No agent was rebuilt.

**Two retentions, and they are different things.** Raw requests carry URLs and
client addresses and stay deployment configuration; the hourly counters carry
neither and are configurable under `System -> Settings`, defaulting to 365 days.
Zero means keep indefinitely, which is what installations had before the setting
existed - a new default must not silently delete their history.

**The endpoint chooses its own store.** `/statistics` answers from raw events
when the range and the filters allow it, and from the counters otherwise, and
reports which one it used, what the two retentions are, and - when a detail
filter forces the raw path - that the answer was truncated to the retention
horizon and which filter caused it. A page that silently switches between
"everything" and "everything we still have" teaches its reader to mistrust all
of it.

**The reader picks the form.** Each time-series chart offers stacked bars,
grouped bars, lines and stacked area, and remembers the choice. They are four
answers to the same question - composition, comparison, trend - and which one is
right depends on what the reader is looking for that day, which is not something
we can know for them.

A fifth option, **Share**, is kept deliberately apart. It is a donut of the whole
selected period, and it does not draw time at all: it answers *what the split
was*, not *when*. The control says so above the chart rather than letting
somebody read a period total as a trend. It is capped at six segments, because
part-to-whole stops being readable at a glance beyond that, and it is a donut
rather than a pie so the hole can carry the total - the number people usually
want when they reach for this form.

**Both time charts carry axes.** A value axis on the left, its gridlines and
numbers being one thing rather than decoration, and a time axis underneath whose
labels are thinned out so they cannot collide and are only as precise as the
bucket justifies. The scale rounds to a step a person would choose - without
that, a chart whose peak is 1 gets the labels 0, 0, 1, 1, 1.

The geometry is measured in real pixels rather than a stretched viewBox. That is
what makes the labels the same size on every screen; a scaled box also distorts
stroke weights and turns markers into ellipses.

**Charts** are inline SVG in `@scp/ui`, not a dependency. The series palette was
picked by running a validator rather than by eye, which turned up something
worth recording: the design system's `--color-danger-fg` and `--color-warning-fg`
sit 9 dE apart in normal vision. Fine as text beside an icon, unusable as
neighbouring segments of a stacked bar. Chart series therefore have their own
`--chart-*` tokens, stepped separately for light and dark, and both sets pass
all six checks.

## Recommendation

Build the page on **1** alone first. It delivers every KPI above at 30-day
depth, and the rollup-backed ones at any depth, without a single new collection
path. Then decide **2** and **3** once the page exists and it is obvious which
numbers people actually look at — that is a much better basis for spending
storage than my guess today.

**4** I would do with **3**, because both touch ingestion and doing them
together costs one migration instead of two.
