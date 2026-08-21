-- Why an account was disabled (ADR 0004).
--
-- Reactivating on the next successful sign-in is right when the control plane
-- disabled the account itself - the claim came back, or the lease was renewed.
-- It is wrong when an administrator disabled the person deliberately: their
-- decision must not be undone by the user simply signing in again.

alter table proxy_users add column disabled_reason text;
alter table proxy_users add constraint proxy_users_disabled_reason_check
  check (disabled_reason is null or disabled_reason in ('CLAIM_WITHDRAWN', 'LEASE_EXPIRED'));
