# ADR 0003 — Configuration hierarchy, listener profiles and policy scope

Status: accepted
Date: 2026-08-16
Decided by: product owner

## Context

Until now every proxy node received an identical configuration, and the
authentication mode was a single global setting. Two things broke because of
that:

- Sites differ. Leipzig and Frankfurt have different local networks, different
  guest VLANs and different bind addresses, but the same security policy.
- `OPTIONAL` mode cannot express "strictly anonymous". Squid challenges a
  client as soon as it evaluates any ACL backed by `proxy_auth`, so a rule
  meant for anonymous clients also matches authenticated ones. The compiler
  reports this as `UNAUTHENTICATED_WIDENED` (ADR context: PLAN.md 9.18).

The alternative of independent policy sets per node was rejected: it produces
duplicates and divergence that nobody can reason about a year later.

## Decision

### 1. A three-level hierarchy, not a flat set of node configurations

```text
Global configuration
  └── global policies, blocklists, TLS rules, default security rules
        │
Node group
  └── group settings, listener profiles, optionally scoped policies
        │
Node
  └── technical overrides only
```

### 2. Policy scope is `GLOBAL` or `NODE_GROUP`

An access policy is global by default. It may be scoped to a node group when a
site genuinely needs it. **A policy is not scoped to an individual node.**
Nodes remain technically addressable, but making them a normal policy target
would make the rule list unreadable, which is the failure mode this ADR exists
to avoid.

### 3. Tags are metadata, not a policy scope

Tags exist for search, filtering, inventory and — later — dynamic group
membership. They are deliberately **not** a policy scope in 1.0.

### 4. Authentication moves onto the listener

A listener profile carries at least:

```text
Name
Bind address
Port
Authentication mode
Allowed source networks
Node or node group assignment
```

This makes the guest case expressible without relying on a Squid behaviour it
does not have:

```text
Corporate proxy            Guest proxy
10.10.0.2:3128             10.10.0.2:3129
Authentication REQUIRED    Authentication DISABLED
Providers: local, LDAP     Source: guest VLAN
```

Employees reach `:3128` and are challenged; guests reach `:3129` and are not.
The distinction is enforced by the listener rather than approximated by a rule.

`OPTIONAL` remains supported for the mixed case, and the
`UNAUTHENTICATED_WIDENED` warning stays: a dedicated listener is now the
documented answer when the distinction must actually be enforced.

## Consequences

- **The compiler becomes node aware.** It currently produces one configuration
  for the whole fleet; it must produce the configuration for a given node from
  the global layer plus that node's group. The configuration hash, drift
  detection and the agent config pull all become per node.
- **The global authentication mode becomes a default** that a listener profile
  can override, rather than the single source of truth. Migration keeps the
  existing global value as the default so current installations behave the same.
- **`listeners` grows into `listener_profiles`** with an assignment and its own
  authentication settings. The existing single listener list migrates into one
  profile assigned to all nodes.
- Positive: a site adds a guest VLAN without touching a single security rule.
- Negative: the review surface gets more complex — an operator now has to know
  which node they are looking at. Configuration review therefore needs a node
  or group selector rather than one global preview.
- Negative: two more entities to administer. Mitigated by the default being
  "one implicit group, everything global", so a single-node installation never
  has to look at any of it.

## Not decided here

Dynamic group membership from tags, deployment rings beyond canary plus serial,
and per-node policy scope. All three are explicitly out of 1.0.
