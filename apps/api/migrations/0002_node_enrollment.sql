-- ---------------------------------------------------------------------------
-- Node enrollment and agent state (PLAN.md Phase 3).
--
-- The control plane runs separately from the proxies. Agents therefore pull:
-- an agent on the proxy host authenticates with its own credential, fetches
-- the compiled configuration and reports back. No inbound connection to the
-- proxy host is ever required, which is what makes nodes behind NAT or a
-- restrictive firewall work the same as local ones.
-- ---------------------------------------------------------------------------

alter table proxy_nodes
  add column description        text,
  add column labels             jsonb       not null default '{}'::jsonb,
  add column enrolled_at        timestamptz,
  add column agent_version      text,
  add column applied_version_id uuid references config_versions (id) on delete set null,
  add column applied_at         timestamptz,
  add column apply_result       text,
  add column apply_message      text,
  add column last_error         text,
  add constraint proxy_nodes_apply_result_check
    check (apply_result is null or apply_result in ('APPLIED', 'FAILED', 'VALIDATION_FAILED'));

-- Hostname is informational until the agent reports its own, so the unique
-- name is the identity an operator works with.
alter table proxy_nodes alter column hostname drop not null;

-- One-time enrolment tokens. Only the hash is stored: a leaked database row
-- must not let anyone enrol a node.
create table node_enrollment_tokens (
  id           uuid primary key default gen_random_uuid(),
  node_id      uuid        not null references proxy_nodes (id) on delete cascade,
  token_hash   text        not null,
  created_at   timestamptz not null default now(),
  created_by   text,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_from_ip text
);
create index node_enrollment_tokens_node_idx on node_enrollment_tokens (node_id);
create unique index node_enrollment_tokens_hash_key on node_enrollment_tokens (token_hash);

-- Long lived agent credential, again stored as a hash only.
create table node_credentials (
  id           uuid primary key default gen_random_uuid(),
  node_id      uuid        not null references proxy_nodes (id) on delete cascade,
  key_hash     text        not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create unique index node_credentials_hash_key on node_credentials (key_hash);
create index node_credentials_node_idx on node_credentials (node_id);

-- What each node reported the last time it checked in. Kept separate from
-- proxy_nodes so a chatty agent does not rewrite the row an operator edits.
create table node_heartbeats (
  node_id       uuid primary key references proxy_nodes (id) on delete cascade,
  observed_at   timestamptz not null default now(),
  agent_version text,
  squid_version text,
  squid_running boolean,
  config_hash   text,
  detail        jsonb       not null default '{}'::jsonb
);
