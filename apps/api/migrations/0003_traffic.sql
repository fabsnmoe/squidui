-- ---------------------------------------------------------------------------
-- Traffic log ingestion (PLAN.md Phase 8, 9.23).
--
-- Agents ship Squid access log lines; the control plane keeps the raw events
-- for a bounded window and pre-aggregates counters that the dashboard and the
-- self-service portal read. Without the rollups every dashboard load would
-- scan the raw table, which is exactly how a log feature turns into an outage.
-- ---------------------------------------------------------------------------

create table traffic_events (
  id               bigserial primary key,
  node_id          uuid        not null references proxy_nodes (id) on delete cascade,
  occurred_at      timestamptz not null,
  received_at      timestamptz not null default now(),
  client_ip        text,
  -- null means the request carried no proxy identity
  username         text,
  provider_key     text,
  squid_status     text,
  http_status      integer,
  bytes            bigint,
  method           text,
  destination_host text,
  -- Full URL only when TRAFFIC_LOG_URLS is enabled; otherwise the host alone.
  url              text,
  decision         text        not null,
  constraint traffic_events_decision_check
    check (decision in ('ALLOWED', 'DENIED', 'AUTH_REQUIRED', 'ERROR'))
);

create index traffic_events_occurred_idx on traffic_events (occurred_at desc);
create index traffic_events_node_idx on traffic_events (node_id, occurred_at desc);
-- Partial index: "who was this" queries always filter on an identity being
-- present, and the unauthenticated majority would only bloat the index.
create index traffic_events_user_idx on traffic_events (lower(username), occurred_at desc)
  where username is not null;
create index traffic_events_decision_idx on traffic_events (decision, occurred_at desc);

-- Hourly counters. Kept far longer than the raw events, because a year of
-- counters is small and a year of raw requests is not.
create table traffic_rollups (
  bucket        timestamptz not null,
  node_id       uuid        not null references proxy_nodes (id) on delete cascade,
  authenticated boolean     not null,
  username      text        not null default '',
  decision      text        not null,
  requests      bigint      not null default 0,
  bytes         bigint      not null default 0,
  primary key (bucket, node_id, authenticated, username, decision)
);
create index traffic_rollups_bucket_idx on traffic_rollups (bucket desc);
create index traffic_rollups_user_idx on traffic_rollups (lower(username), bucket desc)
  where username <> '';

-- Bookkeeping so an agent can resume where it stopped instead of re-shipping
-- a whole log file after a restart.
create table node_log_state (
  node_id       uuid primary key references proxy_nodes (id) on delete cascade,
  last_offset   bigint      not null default 0,
  last_shipped  timestamptz,
  lines_total   bigint      not null default 0,
  dropped_total bigint      not null default 0
);
