-- Time-limited proxy access for directory-backed accounts (ADR 0004).
--
-- OIDC tells us nothing about a user who never comes back: there is no standard
-- way to ask "does this subject still exist". So access is granted as a lease
-- that only a successful sign-in renews, and a sign-in re-checks the claim
-- against the provider. A deleted user cannot sign in, cannot renew, and loses
-- access when the lease runs out - without the control plane ever holding a
-- privileged credential on the directory.

alter table proxy_users add column valid_until timestamptz;
alter table proxy_users add column last_verified_at timestamptz;
-- When the person was told how long their access lasts. Null means never, which
-- is what makes the notice appear exactly once.
alter table proxy_users add column lease_notice_ack_at timestamptz;

-- The sweep looks for expired leases; without this it scans every account.
create index proxy_users_lease_idx on proxy_users (valid_until)
  where source = 'OIDC' and status = 'ACTIVE';

-- Accounts provisioned before this migration have no lease. They are left
-- open-ended on purpose: silently expiring existing access during an upgrade
-- would cut people off with no warning. The first sign-in gives them a lease.
