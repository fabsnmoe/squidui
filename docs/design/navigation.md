# Navigation

## Model

Three navigation planes:

```text
Sidebar          primary, persistent, grouped by operator intent
Topbar           context: environment, theme, account, global search
Command palette  Ctrl/Cmd + K, keyboard-first jump to any page or action
```

Breadcrumbs appear only on detail pages that are more than one level deep.

## Sidebar structure

```text
Overview
└── Dashboard

Infrastructure
├── Nodes
└── Listeners

Policies
├── Access Rules
└── Networks

Authentication
├── Overview
├── Providers
├── Local Users
├── Groups
└── Test

Configuration
├── Review
└── Deployments

Observability
└── Logs

System
├── Users & Roles
├── Audit Log
└── Settings
```

The `Authentication` group is the proxy identity plane. Control plane accounts
live under `System → Users & Roles`. The two are never mixed in navigation,
because they are never mixed in the data model (`PRODUCT.md` §1).

## Rules

- Maximum depth two. A third level becomes tabs inside a page.
- A group is collapsible; the group holding the active route is always open.
- Active state marks the item, not the group.
- Sidebar collapses to icon rail below `lg`; labels then live in tooltips.
- Every nav item maps to exactly one route. No route is reachable only by
  a deep link from another page.

## Route table

| Route | Page | Permission |
| --- | --- | --- |
| `/` | Dashboard | `DASHBOARD_READ` |
| `/nodes` | Nodes | `NODE_READ` |
| `/listeners` | Listeners | `LISTENER_READ` |
| `/policies/rules` | Access Rules | `POLICY_READ` |
| `/policies/networks` | Networks | `POLICY_READ` |
| `/authentication` | Authentication Overview | `PROXY_AUTH_READ` |
| `/authentication/providers` | Providers | `AUTH_PROVIDER_READ` |
| `/authentication/users` | Local Proxy Users | `PROXY_USER_READ` |
| `/authentication/groups` | Proxy Groups | `PROXY_GROUP_READ` |
| `/authentication/test` | Authentication Test | `AUTH_PROVIDER_TEST` |
| `/configuration/review` | Configuration Review | `CONFIG_READ` |
| `/system/audit` | Audit Log | `AUDIT_READ` |
| `/system/settings` | Settings | `SETTINGS_READ` |

Items the current user has no permission for are hidden, not disabled.

## Command palette

Sources, in this order: pages, then contextual actions of the current page,
then recently visited entities. Results are grouped with a section label.
`Enter` executes, `Esc` closes, arrow keys move. Actions that mutate state show
their consequence in the result row and still run through their normal
confirmation flow.
