# Components

The component inventory lives in `packages/ui`. Before creating any new UI
component, check this list and the package (`PLAN.md` §26). Extending an
existing component beats adding a similar one.

Legend: **built** = implemented with all states, **planned** = specified but
not implemented yet.

## Shell

| Component | Status | Notes |
| --- | --- | --- |
| `AppShell` | built | topbar + sidebar + scroll container |
| `Sidebar` | built | grouped nav, collapsible, icon rail below `lg` |
| `Topbar` | built | env badge, command palette trigger, theme, account |
| `PageHeader` | built | breadcrumb, title, description, actions |
| `CommandPalette` | built | `Ctrl/Cmd + K`, pages + contextual actions |

## Form controls

| Component | Status | Notes |
| --- | --- | --- |
| `Button` | built | variants `primary`/`secondary`/`ghost`/`danger`, sizes `sm`/`md`/`lg`, `loading` |
| `IconButton` | built | requires `aria-label` |
| `Input` | built | label, hint, error, prefix/suffix, invalid state |
| `PasswordInput` | built | reveal toggle, never renders an existing secret |
| `Textarea` | built | |
| `Select` | built | native select, styled |
| `Combobox` | planned | filterable, multi-select, keyboard driven. Multi-select is currently a checkbox list. |
| `Checkbox` | built | |
| `Switch` | built | |
| `RadioCard` | built | used for authentication mode selection |
| `FormSection` | built | title + description + fields |
| `Field` | built | label + control + hint/error; the wrapper every input uses |

## Data display

| Component | Status | Notes |
| --- | --- | --- |
| `Card` | built | header/body/footer slots |
| `MetricCard` | built | value, label, trend, empty variant |
| `StatusCard` | built | health headline + key/value rows |
| `DataTable` | built | sorting, row actions, sticky header, loading/empty/error |
| `FilterBar` | built | search + filter chips |
| `SearchInput` | built | debounced, `/` shortcut |
| `DescriptionList` | built | key/value pairs |
| `StatusBadge` | built | colour + label, never colour alone |
| `HealthIndicator` | built | dot + shape + label |
| `Tabs` | built | |
| `Breadcrumbs` | built | part of `PageHeader`, not a standalone export |
| `CodeViewer` | built | monospace, copy to clipboard |
| `DiffViewer` | planned | needed for Configuration Review across versions |
| `ChartContainer` | planned | no chart surface exists yet; metrics use `MetricCard` |

## Feedback and overlays

| Component | Status | Notes |
| --- | --- | --- |
| `Dialog` | built | focus trap, `Esc`, labelled by title |
| `ConfirmDialog` | built | consequence text, affected entities, typed confirmation |
| `Drawer` | built | right side, used by the rule editor |
| `HelpPopover` | built | A question mark beside a field label. Opens on click, not hover, so it works on touch and cannot fire from a passing cursor; positioned absolutely so opening it never moves the form. Closes on `Esc` and on a click outside. |
| `Popover` (general) | planned | |
| `Tooltip` | planned | native `title` is used meanwhile; never the only source of information |
| `Toast` | built | success/error/info, auto dismiss, screen-reader live region |
| `InlineAlert` | built | info/warning/danger/success, optional action |
| `Skeleton` | built | matches the shape of the content it replaces |
| `EmptyState` | built | icon, title, explanation, primary action |
| `ErrorState` | built | what failed, retry action, technical detail collapsed |

## Required states per component

Every interactive component documents and implements:

```text
Default   Hover   Focus-visible   Active   Disabled   Loading   Error   Dark
```

A component showcase rendering every component in every state and both themes -
the Storybook substitute required by `PLAN.md` §5 - is **not implemented yet**.
The states exist in the components; there is no page that displays them side by
side.

## Component rules

- Components never fetch data. Pages fetch, components render.
- No component hard codes a colour, spacing or radius value.
- Anything focusable has a visible `:focus-visible` ring using
  `--color-focus-ring`.
- A component that can be empty must accept an `emptyState` or render one.
