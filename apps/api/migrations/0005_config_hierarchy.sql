-- ---------------------------------------------------------------------------
-- Configuration hierarchy: node groups, listener profiles, policy scope.
-- See docs/architecture/adr/0003-configuration-hierarchy.md
--
--   Global      security policies, blocklists, defaults
--     └── Node group   listener profiles, group-scoped policies, local networks
--           └── Node   technical overrides only
--
-- Authentication moves onto the listener. Squid runs one basic auth helper,
-- but which ports require an identity is an ACL on the port name - that is
-- what makes "corporate :3128 requires auth, guest :3129 does not" expressible
-- at all, which no rule in OPTIONAL mode can do.
-- ---------------------------------------------------------------------------

create table node_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  -- Metadata for search, filtering and inventory. Deliberately not a policy
  -- scope in 1.0: making it one turns the rule list into something nobody can
  -- reason about.
  labels      jsonb       not null default '{}'::jsonb,
  is_default  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index node_groups_name_key on node_groups (lower(name));
-- Exactly one default group: it is where a node lands when nobody assigned it.
create unique index node_groups_single_default on node_groups (is_default) where is_default;

alter table proxy_nodes
  add column group_id uuid references node_groups (id) on delete set null;
create index proxy_nodes_group_idx on proxy_nodes (group_id);

-- A listener profile is what a node actually listens on, and carries its own
-- authentication decision.
create table listener_profiles (
  id                  uuid primary key default gen_random_uuid(),
  name                text        not null,
  description         text,
  address             text        not null default '0.0.0.0',
  port                integer     not null default 3128,
  mode                text        not null default 'FORWARD',
  enabled             boolean     not null default true,
  -- INHERIT takes the global default, so a single-node installation never has
  -- to think about this.
  authentication_mode text        not null default 'INHERIT',
  -- Empty means every source; otherwise traffic arriving on this listener from
  -- anywhere else is refused before any rule runs.
  source_network_ids  uuid[]      not null default '{}',
  -- Null means every group. A profile is assigned to a group, never to a node:
  -- nodes carry technical overrides only.
  group_id            uuid references node_groups (id) on delete cascade,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint listener_profiles_mode_check check (mode in ('FORWARD', 'INTERCEPT')),
  constraint listener_profiles_port_check check (port between 1 and 65535),
  constraint listener_profiles_auth_check
    check (authentication_mode in ('INHERIT', 'DISABLED', 'OPTIONAL', 'REQUIRED'))
);
create index listener_profiles_group_idx on listener_profiles (group_id);
-- Two listeners on the same address and port would make Squid refuse to start.
create unique index listener_profiles_bind_key
  on listener_profiles (coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid), address, port);

-- Policy scope. GLOBAL by default; NODE_GROUP when a site genuinely differs.
-- There is deliberately no per-node scope.
alter table access_rules
  add column scope          text   not null default 'GLOBAL',
  add column scope_group_ids uuid[] not null default '{}',
  add constraint access_rules_scope_check check (scope in ('GLOBAL', 'NODE_GROUP'));

-- --- migrate existing data -------------------------------------------------

-- One default group holding everything that exists today, so current
-- installations behave exactly as before.
insert into node_groups (name, description, is_default)
values ('Default', 'Nodes that have not been assigned to a specific group.', true);

update proxy_nodes set group_id = (select id from node_groups where is_default);

-- Existing listeners become profiles available to every group, inheriting the
-- global authentication mode that governed them until now.
insert into listener_profiles (name, address, port, mode, enabled, authentication_mode, group_id)
select name, address, port, mode, enabled, 'INHERIT', null
from listeners;

-- listeners is kept for one release so a rollback has its data. It is no longer
-- read; listener_profiles is the source of truth.
comment on table listeners is
  'Superseded by listener_profiles (ADR 0003). Retained for one release to keep application rollback possible.';
