-- Statistics that outlive the raw requests (docs/design/statistics.md).
--
-- Raw events answer any question but are personal data and expire. Hourly
-- aggregates answer a fixed set of questions and are cheap enough to keep for
-- years. The page uses whichever can answer the range being asked about, and
-- says which one it used.
--
-- Upload bytes arrive with access log format v3. Rows written before a node
-- picks that format up keep 0, which is why the column defaults rather than
-- being backfilled with a guess.

-- --- upload bytes -----------------------------------------------------------
alter table traffic_events add column bytes_uploaded bigint;
alter table traffic_rollups add column bytes_uploaded bigint not null default 0;

-- --- response time, aggregated ---------------------------------------------
-- Sum and count give a mean over any range. A percentile cannot be aggregated
-- this way, so p95 stays a raw-event number and the page says so rather than
-- computing something that looks like a percentile and is not.
alter table traffic_rollups add column duration_sum bigint not null default 0;
alter table traffic_rollups add column duration_count bigint not null default 0;
alter table traffic_rollups add column duration_max integer not null default 0;

-- --- destinations, per hour and node ----------------------------------------
-- Not per user as well: that product of dimensions is what turns a rollup into
-- something the size of the raw data it was meant to replace. Per-user
-- destinations stay a question for the raw window.
create table traffic_destination_rollups (
  bucket           timestamptz not null,
  node_id          uuid        not null references proxy_nodes (id) on delete cascade,
  destination_host text        not null,
  requests         bigint      not null default 0,
  bytes            bigint      not null default 0,
  bytes_uploaded   bigint      not null default 0,
  primary key (bucket, node_id, destination_host)
);
create index traffic_destination_rollups_bucket_idx on traffic_destination_rollups (bucket desc);
create index traffic_destination_rollups_host_idx on traffic_destination_rollups (destination_host, bucket desc);

-- --- client addresses, per hour and node ------------------------------------
-- On a proxy published to the internet this is mostly scanners, which is
-- precisely why it is worth keeping: it is the only way to tell that noise
-- apart from real use after the raw rows are gone.
create table traffic_client_rollups (
  bucket         timestamptz not null,
  node_id        uuid        not null references proxy_nodes (id) on delete cascade,
  client_ip      text        not null,
  requests       bigint      not null default 0,
  bytes          bigint      not null default 0,
  bytes_uploaded bigint      not null default 0,
  primary key (bucket, node_id, client_ip)
);
create index traffic_client_rollups_bucket_idx on traffic_client_rollups (bucket desc);
create index traffic_client_rollups_ip_idx on traffic_client_rollups (client_ip, bucket desc);

-- --- range queries ----------------------------------------------------------
-- Every statistics query is "this node, this window", so the node leads.
create index traffic_rollups_node_bucket_idx on traffic_rollups (node_id, bucket desc);
create index traffic_destination_rollups_node_idx on traffic_destination_rollups (node_id, bucket desc);
create index traffic_client_rollups_node_idx on traffic_client_rollups (node_id, bucket desc);
