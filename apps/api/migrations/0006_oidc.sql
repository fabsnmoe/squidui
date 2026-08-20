-- OIDC identity providers for the web interface (ADR 0004).
--
-- OIDC authenticates people, never traffic. Squid speaks HTTP Basic and cannot
-- consume a token, so a portal user signs in with their organisational identity
-- and provisions a proxy account whose password reaches Squid through the same
-- NCSA path as any local one.

create table identity_providers (
  id                  uuid primary key default gen_random_uuid(),
  key                 text        not null,
  name                text        not null,
  enabled             boolean     not null default true,

  issuer              text        not null,
  client_id           text        not null,
  -- Encrypted with the same key as the LDAP bind passwords; never returned.
  client_secret_enc   text,
  scopes              text        not null default 'openid profile email',

  -- Which door this provider opens. Both can be off, which disables it without
  -- deleting the configuration.
  allow_admin_login   boolean     not null default false,
  allow_portal_login  boolean     not null default true,

  -- Admission is one claim comparison per door (ADR 0004 section 2). An empty
  -- claim name admits every authenticated user.
  admin_claim         text,
  admin_value         text,
  portal_claim        text,
  portal_value        text,

  -- Where the username comes from. preferred_username is what Keycloak sends.
  username_claim      text        not null default 'preferred_username',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint identity_providers_key_shape check (key ~ '^[a-z0-9-]{1,32}$')
);
create unique index identity_providers_key_idx on identity_providers (key);

-- One row per authorisation request. Consumed once at the callback, swept by
-- expiry: a state that can be replayed is not a state.
create table oidc_login_states (
  state          text        primary key,
  provider_id    uuid        not null references identity_providers (id) on delete cascade,
  audience       text        not null,
  nonce          text        not null,
  code_verifier  text        not null,
  redirect_uri   text        not null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  constraint oidc_login_states_audience_check check (audience in ('control-plane', 'proxy-portal'))
);
create index oidc_login_states_expiry_idx on oidc_login_states (expires_at);

-- --- control plane users ----------------------------------------------------
-- An OIDC administrator has no password here, so the column has to allow one
-- to be absent. Local accounts keep theirs, and the check below keeps a local
-- account from ever existing without one.
alter table cp_users alter column password_hash drop not null;
alter table cp_users add column source text not null default 'LOCAL';
alter table cp_users add column oidc_issuer text;
alter table cp_users add column oidc_subject text;
alter table cp_users add constraint cp_users_source_check check (source in ('LOCAL', 'OIDC'));
alter table cp_users add constraint cp_users_local_password_check
  check (source <> 'LOCAL' or password_hash is not null);
create unique index cp_users_oidc_subject_idx
  on cp_users (oidc_issuer, oidc_subject) where oidc_subject is not null;

-- --- proxy users ------------------------------------------------------------
-- A provisioned proxy account is bound to the subject, not the username: people
-- get renamed, subjects do not (ADR 0004 section 3).
alter table proxy_users add column source text not null default 'LOCAL';
alter table proxy_users add column oidc_issuer text;
alter table proxy_users add column oidc_subject text;
alter table proxy_users add constraint proxy_users_source_check check (source in ('LOCAL', 'OIDC'));
create unique index proxy_users_oidc_subject_idx
  on proxy_users (oidc_issuer, oidc_subject) where oidc_subject is not null;
