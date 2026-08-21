# ADR 0004 — OIDC for control plane administrators and portal users

Status: proposed
Date: 2026-08-20
Requested by: product owner

## Context

Directories that speak LDAP can back proxy authentication directly: Squid's
`basic_ldap_auth` takes the username and password a client sent and asks the
directory. Keycloak, Entra ID, Authentik and Okta are increasingly deployed
**without** an LDAP front end, and an organisation running one of them today has
no way to give its people proxy access without maintaining a second, manual list
of local proxy users.

## The constraint that shapes everything

**Squid cannot consume OIDC.** Proxy authentication is HTTP Basic: the client
sends a username and a password, and a helper answers `OK` or `ERR`. There is no
browser in that exchange, no redirect, no token. An OIDC identity therefore
cannot authenticate a proxy client, and no amount of configuration changes that.

Anything claiming otherwise would have to terminate the proxy connection, which
this product deliberately does not do.

## Decision

OIDC authenticates **people in the web interface**. It never authenticates
traffic. The bridge between the two is an explicit, person-initiated step:

```text
Keycloak  ──OIDC──>  Portal sign-in  ──creates──>  Proxy account
(identity)           (the person)                  (username + password)
                                                          │
                                                          ▼
                                                   NCSA file, Squid
```

A portal user signs in with their organisational identity and provisions
themselves a proxy account: their username, a password they choose. That
password is hashed with crypt(3) and reaches Squid through exactly the same path
as any local proxy user. Nothing in the compiler, the IR or the helper
configuration learns that OIDC exists.

### 1. One provider configuration, two doors

A local administrator configures an OIDC provider under
`System -> Identity providers`. The same provider serves both audiences, and
each door can be opened independently:

```text
allowAdminLogin    -> may sign in to the control plane
allowPortalLogin   -> may sign in to the self-service portal
```

A deployment that wants Keycloak for its users but keeps administration local
simply leaves the first switch off.

### 2. Admission is a claim, not a role mapping

For 1.0 the product owner asked explicitly for no separate permission system.
Admission is therefore one claim comparison per door:

```text
adminClaim  = realm_access.roles     adminValue  = squid-admin
portalClaim = realm_access.roles     portalValue = squid-user
```

The claim may be a string or an array of strings; the value must appear in it.
An empty claim name means "every successfully authenticated user may pass".

A user admitted through the admin door receives the **Administrator** role in
full. There is no partial mapping, no group synchronisation, no per-claim
permission assembly. That is a deliberate simplification: a half-expressive
mapping layer is harder to reason about than none, and the local role system
stays available for anyone who needs finer control.

### 3. The proxy account is bound to the subject, not the username

A provisioned proxy account records `(issuer, subject)`. Usernames in a
directory change - people marry, departments rename accounts - while the subject
does not. Binding on the subject means a renamed user keeps their proxy account
and their statistics.

A person has **at most one** proxy account. The portal shows the one they have;
it does not offer a second.

### 4. The proxy password is not the directory password

The password set on a proxy account is independent of the Keycloak password and
is never checked against Keycloak. It cannot be: the proxy has no way to ask.

This is stated plainly in the portal, because a user who believes their
directory password works at the proxy will be confused when it does not - and
worse, may try their real password repeatedly against a system that logs
failures.

### 5. Local accounts remain

The break-glass local administrator stays (PO decision, phase 2). An identity
provider that is unreachable must never lock every administrator out of the
control plane, and the local proxy users continue to work unchanged.

### 7. Where the admission claim is read

Verifying against a real Keycloak showed the assumption behind the first
implementation was wrong. Keycloak puts `realm_access.roles` in the **access
token**, not the ID token: its realm roles mapper ships with "Add to ID token"
switched off, and most providers treat role and group claims the same way.
Reading only the ID token therefore refuses every correctly configured Keycloak,
and telling operators to go and change a mapper would be blaming them for our
assumption.

Identity still comes from the ID token alone. The admission claim is looked up
in the ID token first, then in the access token, then at the UserInfo endpoint -
and the access token is only consulted after being verified the same way: signed
by the same issuer, unexpired, and naming the same subject. A valid token
belonging to somebody else is refused.

## Security

- **Authorisation code with PKCE.** The state, nonce and code verifier are
  stored server side against an expiry and consumed once.
- **The ID token is verified**, not merely decoded: signature against the
  provider's JWKS, plus issuer, audience, expiry and nonce.
- **The client secret is encrypted at rest** with the existing secret
  encryption key and never returned by the API.
- **The two audiences stay separate.** An OIDC sign-in produces a token for one
  audience only, chosen at the start of the flow and re-checked at the callback.
  A portal user cannot arrive holding a control plane token.
- **Redirect targets are fixed** by the control plane's own base URL, never
  taken from the request, so the flow cannot be pointed at another host.
- **Revocation takes effect within Squid's credential cache**, not instantly.
  Squid trusts a successful credential check for `credentialsttl`, which this
  product now emits as five minutes; it was two hours by inheritance, and a
  revoked user was measured still getting through. Disabling an account is
  therefore effective within five minutes, and that number is a security
  property rather than a tuning knob.
- **An account disabled by an administrator is never reactivated** by a later
  sign-in. Only accounts this control plane disabled itself - claim withdrawn,
  lease expired - come back, which is why the reason is recorded.

## Consequences

- Positive: an organisation with Keycloak and no LDAP can give its people proxy
  access without an administrator creating accounts by hand.
- Positive: the proxy path is unchanged. No new failure mode reaches Squid, and
  an identity provider outage cannot stop traffic - only new sign-ins.
- Deprovisioning is covered by section 6 below rather than left open.
- Negative: two passwords for one person. Mitigated by saying so in the portal,
  not by pretending otherwise.

## 6. Deprovisioning: a refused claim, and a lease

OIDC offers no way to ask whether a subject still exists. UserInfo and token
introspection need a token belonging to that user; SCIM is a push protocol the
provider must be configured for; the Keycloak admin API works but is
vendor-specific and would require a privileged service account inside the
control plane - a powerful new credential in a component that manages proxy
access. None of those are acceptable as the default.

Two mechanisms are used instead, and they cover different halves of the problem.

**A refused claim is acted on immediately.** When someone signs in and is turned
away because the claim is gone, that is evidence of revocation rather than
suspicion. The linked proxy account is disabled at that moment, with an audit
entry. This costs nothing and needs no infrastructure.

**Absence of any signal is bounded by a lease.** A proxy account carries
`valid_until`. A successful sign-in - which re-checks the claim live against the
provider - renews it, and a sweep disables accounts whose lease has run out. A
user deleted in the directory cannot sign in, therefore cannot renew, and loses
access within the lease period without the control plane asking the directory
anything.

```text
claim withdrawn, signs in     -> disabled immediately
claim withdrawn, never signs in -> disabled when the lease expires
user deleted                  -> disabled when the lease expires
returns with the claim intact -> the next sign-in reactivates the account
```

The lease is a fixed term with a renewal window at its end, not a sliding
window: signing in earlier records the verification but does not extend the
date. Both numbers are runtime settings, defaulting to 90 days with renewal
possible 5 days ahead. Accounts are **disabled, never deleted**, so statistics
and the audit trail survive and a returning person is one sign-in away from
working again.

The cost is stated plainly: a person who does not visit the portal loses proxy
access and has to sign in once to get it back. That is the price of not holding
a privileged credential on the directory, and it is the right trade for a
component whose whole purpose is controlling access.

**This product has no mail.** The portal is therefore the only channel that
reaches a person, which is why the notice is shown when access is granted and
again when the renewal window opens - being told once, ninety days ago, is not
being told. An administrator can see every lease and its date in the user list.

A Keycloak admin API connector remains possible later as an opt-in accelerator
for anyone who needs minutes rather than days, with its own credential and its
own explicit decision.

## Not decided here

Group synchronisation from claims into proxy groups, automatic deprovisioning,
SCIM, and back-channel logout. All four are follow-ups; none of them are needed
for a Keycloak deployment to be usable.
