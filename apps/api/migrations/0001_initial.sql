-- ---------------------------------------------------------------------------
-- Initial schema.
--
-- The two identity planes are deliberately separate table families:
--   cp_*     control plane accounts (web UI login, RBAC)
--   proxy_*  proxy identities (clients authenticating against Squid)
-- They share no table, no foreign key and no password column
-- (PRODUCT.md section 1, PLAN.md 9.1).
-- ---------------------------------------------------------------------------

-- --- Control plane identity -------------------------------------------------

create table cp_users (
  id                   uuid primary key default gen_random_uuid(),
  username             text        not null,
  display_name         text,
  email                text,
  password_hash        text        not null,
  status               text        not null default 'ACTIVE',
  must_change_password boolean     not null default false,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint cp_users_status_check check (status in ('ACTIVE', 'DISABLED'))
);
create unique index cp_users_username_key on cp_users (lower(username));

create table cp_roles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  builtin     boolean not null default false
);

create table cp_role_permissions (
  role_id    uuid not null references cp_roles (id) on delete cascade,
  permission text not null,
  primary key (role_id, permission)
);

create table cp_user_roles (
  user_id uuid not null references cp_users (id) on delete cascade,
  role_id uuid not null references cp_roles (id) on delete cascade,
  primary key (user_id, role_id)
);

-- --- Audit ------------------------------------------------------------------

create table audit_events (
  id             bigserial primary key,
  occurred_at    timestamptz not null default now(),
  action         text        not null,
  outcome        text        not null,
  actor_id       uuid,
  actor_username text,
  target_type    text,
  target_id      text,
  target_name    text,
  source_ip      text,
  payload        jsonb       not null default '{}'::jsonb,
  constraint audit_events_outcome_check check (outcome in ('SUCCESS', 'FAILURE', 'DENIED'))
);
create index audit_events_occurred_at_idx on audit_events (occurred_at desc);
create index audit_events_action_idx on audit_events (action);
create index audit_events_actor_idx on audit_events (actor_username);

-- The audit trail is append-only at the database level, so a bug (or a
-- compromised API process) cannot rewrite history (threat model T8).
create function audit_events_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_no_update
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

-- --- Proxy authentication configuration -------------------------------------

create table proxy_auth_config (
  id                         smallint primary key default 1,
  mode                       text        not null default 'DISABLED',
  default_access             text        not null default 'DENY',
  realm                      text        not null default 'Squid Proxy',
  open_proxy_acknowledged_at timestamptz,
  open_proxy_acknowledged_by text,
  updated_at                 timestamptz not null default now(),
  constraint proxy_auth_config_singleton check (id = 1),
  constraint proxy_auth_config_mode_check check (mode in ('DISABLED', 'OPTIONAL', 'REQUIRED')),
  constraint proxy_auth_config_access_check check (default_access in ('ALLOW', 'DENY'))
);
insert into proxy_auth_config (id) values (1);

create table auth_providers (
  id         uuid primary key default gen_random_uuid(),
  key        text        not null unique,
  type       text        not null,
  name       text        not null,
  enabled    boolean     not null default false,
  priority   integer     not null default 100,
  config     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auth_providers_type_check check (type in ('LOCAL', 'LDAP'))
);
create index auth_providers_order_idx on auth_providers (priority, key);

-- Secrets are stored encrypted (AES-256-GCM) and never leave the API.
create table provider_secrets (
  provider_id uuid        not null references auth_providers (id) on delete cascade,
  name        text        not null,
  ciphertext  text        not null,
  updated_at  timestamptz not null default now(),
  primary key (provider_id, name)
);

-- --- Proxy identity ---------------------------------------------------------

create table proxy_users (
  id                  uuid primary key default gen_random_uuid(),
  username            text        not null,
  display_name        text,
  description         text,
  status              text        not null default 'ACTIVE',
  -- crypt(3) string, never plaintext (PRODUCT.md section 15)
  password_hash       text,
  password_format     text,
  password_updated_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint proxy_users_status_check check (status in ('ACTIVE', 'DISABLED')),
  constraint proxy_users_username_shape check (username ~ '^[A-Za-z0-9._@-]{1,64}$')
);
create unique index proxy_users_username_key on proxy_users (lower(username));

create table proxy_groups (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  description  text,
  source       text        not null default 'LOCAL',
  provider_key text,
  external_id  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint proxy_groups_source_check check (source in ('LOCAL', 'EXTERNAL', 'LOGICAL'))
);
create unique index proxy_groups_identity_key
  on proxy_groups (lower(name), source, coalesce(provider_key, ''));

create table proxy_user_groups (
  user_id  uuid not null references proxy_users (id) on delete cascade,
  group_id uuid not null references proxy_groups (id) on delete cascade,
  primary key (user_id, group_id)
);

-- Members of a LOGICAL group: local and external groups unified under one
-- policy name (PRODUCT.md section 18).
create table logical_group_members (
  logical_group_id uuid not null references proxy_groups (id) on delete cascade,
  member_group_id  uuid not null references proxy_groups (id) on delete cascade,
  primary key (logical_group_id, member_group_id),
  constraint logical_group_members_no_self check (logical_group_id <> member_group_id)
);

-- --- Policies ---------------------------------------------------------------

create table networks (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null unique,
  description text,
  cidrs       text[]      not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table listeners (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null unique,
  address    text        not null default '0.0.0.0',
  port       integer     not null default 3128,
  mode       text        not null default 'FORWARD',
  enabled    boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listeners_mode_check check (mode in ('FORWARD', 'INTERCEPT')),
  constraint listeners_port_check check (port between 1 and 65535)
);

create table access_rules (
  id          uuid primary key default gen_random_uuid(),
  position    integer     not null,
  name        text        not null,
  description text,
  enabled     boolean     not null default true,
  action      text        not null,
  source      jsonb       not null default '{"kind":"ANY"}'::jsonb,
  identity    jsonb       not null default '{"kind":"ANY"}'::jsonb,
  destination jsonb       not null default '{"kind":"ANY"}'::jsonb,
  schedule    jsonb       not null default '{"kind":"ALWAYS"}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint access_rules_action_check check (action in ('ALLOW', 'DENY'))
);
create index access_rules_position_idx on access_rules (position);

-- --- Nodes and compiled configuration ---------------------------------------

create table proxy_nodes (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null unique,
  hostname      text        not null,
  status        text        not null default 'UNKNOWN',
  squid_version text,
  adapter_id    text        not null default 'squid-6-debian',
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint proxy_nodes_status_check
    check (status in ('HEALTHY', 'DEGRADED', 'UNREACHABLE', 'UNKNOWN'))
);

create table config_versions (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text,
  adapter_id text        not null,
  ir         jsonb       not null,
  squid_conf text        not null,
  warnings   jsonb       not null default '[]'::jsonb,
  findings   jsonb       not null default '[]'::jsonb
);
create index config_versions_created_at_idx on config_versions (created_at desc);
