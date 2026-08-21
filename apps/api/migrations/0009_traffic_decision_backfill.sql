-- Reclassify requests the proxy never served.
--
-- The decision was derived from the HTTP status alone, so anything that was not
-- 407, DENIED or 5xx was recorded as ALLOWED - including requests Squid refused
-- to parse. On a proxy reachable from the internet that fills the traffic log
-- with rows reading "Allowed" for scanner noise that was never allowed at all.
--
-- Squid's result code is the authority: NONE_* means nothing was forwarded or
-- tunnelled. It is stored, so history can be corrected rather than merely
-- explained.

create temporary table scp_misclassified as
select date_trunc('hour', occurred_at at time zone 'UTC') at time zone 'UTC' as bucket,
       node_id,
       (username is not null) as authenticated,
       coalesce(username, '') as username,
       count(*)::bigint as requests,
       coalesce(sum(bytes), 0)::bigint as bytes
from traffic_events
where decision = 'ALLOWED' and squid_status like 'NONE%'
group by 1, 2, 3, 4;

-- The hourly counters outlive the raw rows, so leaving them wrong would leave
-- the dashboard wrong for good. Only buckets whose raw events still exist can
-- be corrected; anything older than the retention window keeps its original
-- classification, which is stated here rather than hidden.
update traffic_rollups r
   set requests = greatest(0, r.requests - m.requests),
       bytes = greatest(0, r.bytes - m.bytes)
  from scp_misclassified m
 where r.bucket = m.bucket
   and r.node_id = m.node_id
   and r.authenticated = m.authenticated
   and r.username = m.username
   and r.decision = 'ALLOWED';

insert into traffic_rollups (bucket, node_id, authenticated, username, decision, requests, bytes)
select bucket, node_id, authenticated, username, 'ERROR', requests, bytes
  from scp_misclassified
    on conflict (bucket, node_id, authenticated, username, decision) do update
   set requests = traffic_rollups.requests + excluded.requests,
       bytes = traffic_rollups.bytes + excluded.bytes;

update traffic_events
   set decision = 'ERROR'
 where decision = 'ALLOWED' and squid_status like 'NONE%';

drop table scp_misclassified;
