# Observability → Statistics

Concept for a per-node statistics page. Written before implementation, because
two of the decisions in it change the data model and one changes the log format.

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

### 4. Upload bytes — needs a decision, changes the log format

`%<st` is download only. Recording upload as well means `%>st` and a format v3.
The parser already handles versioned formats, so the cost is one more field and
a migration; the benefit is that "bandwidth" stops meaning half of it.

### 5. Squid's own counters — larger, out of 1.0 in my view

The access log cannot show concurrent connections, file descriptor pressure,
Squid CPU or cache disk usage. Squid exposes all of it through the cache
manager, and the agent already runs next to it and already reports. This would
be the right way to make the page a real operations view — and it is a new
collection path with its own failure modes, so it belongs after 1.0.

## Recommendation

Build the page on **1** alone first. It delivers every KPI above at 30-day
depth, and the rollup-backed ones at any depth, without a single new collection
path. Then decide **2** and **3** once the page exists and it is obvious which
numbers people actually look at — that is a much better basis for spending
storage than my guess today.

**4** I would do with **3**, because both touch ingestion and doing them
together costs one migration instead of two.
