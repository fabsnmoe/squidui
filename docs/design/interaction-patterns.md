# Interaction Patterns

## Feedback timing

| Duration | Pattern |
| --- | --- |
| `< 300ms` | no spinner, just apply the result |
| `300ms – 2s` | inline spinner on the triggering control (`Button loading`) |
| `> 2s` | skeleton for the region, keep the shell interactive |
| background job | toast on start, status surface owns the progress |

Never block the whole page for a request that affects one region.

## Create / edit

Entities are created and edited in a `Drawer`, not on a separate page, so the
list stays visible as context. The drawer:

- opens with focus on the first field,
- keeps the primary action pinned in its footer,
- warns on close when the form is dirty,
- shows field errors inline and a summary alert only for form-level errors.

## Rule editor

```text
Basic → Source → Identity → Destination → Schedule → Action → Review
```

Simple rules (single source, `Any` identity, `Any` destination) render all
sections in one scrollable drawer. Rules that use more than two conditions
switch to the stepped wizard with the same section order (`PLAN.md` §24).
The Review step always shows the resulting matcher summary in plain language,
for example:

> Clients from **Guest network** that are **unauthenticated** may reach
> **any destination** — **always**.

## Destructive operations

`ConfirmDialog` is mandatory. It states:

1. what is deleted,
2. what stops working and which entities are affected (enumerated),
3. whether the action is reversible,
4. a typed confirmation (`delete`) when it is not.

The confirm button carries the `danger` variant and the concrete verb
("Delete certificate"), never "OK".

## Unsafe but permitted configurations

When a configuration is legal but risky (`Authentication = Disabled` together
with `Default access = Allow` on a wide listener), the UI:

1. shows a persistent `InlineAlert` with `danger` severity on the affected
   page and on the dashboard,
2. requires an explicit acknowledgement checkbox before saving,
3. records the acknowledgement in the audit event.

It does not block the save. The product must not prevent a deliberate,
authorised open proxy — only an accidental one (`PRODUCT.md` §5).

## Secrets

- An existing password is never rendered, not even masked from the server.
  The field shows a fixed placeholder and a `Replace password` action.
- Password inputs are never pre-filled, never echoed back by the API, never
  logged, and never part of an audit payload.
- The authentication test form clears the password field after submitting.

## Forms

- Validate on blur, re-validate on change once a field has an error.
- Submit is never disabled to communicate validation errors; it submits and
  surfaces the errors (a disabled button with no explanation is a dead end).
- Long forms are split into `FormSection`s with a short description each.

## Tables

- Server-side pagination beyond 100 rows; client-side sort for loaded pages.
- Row click opens the detail view; row actions live in a trailing menu.
- Bulk actions appear in a selection bar above the table when rows are checked.
- Column set is fixed per table; no user column configuration in 1.0.

## Keyboard

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + K` | command palette |
| `/` | focus the page search input |
| `Esc` | close overlay, cancel edit |
| `Ctrl/Cmd + Enter` | submit the focused drawer/dialog form |
| `g` then `d` | go to dashboard |
| `g` then `a` | go to authentication overview |

Shortcuts are discoverable in the command palette and never the only way to
reach a function.

## Motion

Durations come from tokens (`--duration-fast` 120ms, `--duration-normal`
200ms). Overlays fade and translate by `4px`; lists do not animate on data
refresh. All motion respects `prefers-reduced-motion: reduce`, which disables
transforms and reduces durations to `0ms`.
