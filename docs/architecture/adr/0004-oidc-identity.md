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

## Consequences

- Positive: an organisation with Keycloak and no LDAP can give its people proxy
  access without an administrator creating accounts by hand.
- Positive: the proxy path is unchanged. No new failure mode reaches Squid, and
  an identity provider outage cannot stop traffic - only new sign-ins.
- Negative: **deprovisioning is not automatic.** Disabling a user in Keycloak
  stops them signing in; it does not disable their proxy account, because the
  control plane only learns about the directory when someone signs in. Until a
  reconciliation job exists, removing proxy access stays an explicit
  administrative act. This is the most important limitation of this decision and
  belongs in the release notes.
- Negative: two passwords for one person. Mitigated by saying so in the portal,
  not by pretending otherwise.

## Not decided here

Group synchronisation from claims into proxy groups, automatic deprovisioning,
SCIM, and back-channel logout. All four are follow-ups; none of them are needed
for a Keycloak deployment to be usable.
