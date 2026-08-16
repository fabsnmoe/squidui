# Layout

## App shell

```text
┌──────────────────────────────────────────────────────────────┐
│ Topbar                                          56px         │
├───────────────┬──────────────────────────────────────────────┤
│               │  PageHeader                                  │
│  Sidebar      │  ──────────────────────────────────────────  │
│  264px        │  Page content   max 1280px, centered         │
│               │                                              │
└───────────────┴──────────────────────────────────────────────┘
```

- Topbar and sidebar are fixed; only the content column scrolls.
- Content column padding: `--space-6` horizontal, `--space-6` vertical.
- Content max width `1280px` so text lines stay readable on 1920px displays.
  Tables may opt into full width via the `wide` page variant.

## Reference resolutions

Primary targets `1440 × 900` and `1920 × 1080`; additionally verified at
`1280 × 720` and tablet (`PLAN.md` §22).

| Breakpoint | Token | Behaviour |
| --- | --- | --- |
| `< 640px` | `sm` | not a target; shell stays usable, tables scroll |
| `≥ 768px` | `md` | sidebar becomes an icon rail, page padding `--space-4` |
| `≥ 1024px` | `lg` | full sidebar with labels |
| `≥ 1280px` | `xl` | content max width applies |
| `≥ 1536px` | `2xl` | unchanged, content stays centered |

## Page anatomy

```text
PageHeader
├── breadcrumb        optional, only on nested detail pages
├── title             one line, sentence case
├── description       one sentence, what this page controls
└── actions           at most one primary, rest secondary/menu

Content
├── alerts            InlineAlert, full width, above the fold
├── summary           MetricCard / StatusCard row (optional)
└── main              DataTable, form sections, or cards
```

Every page has a title and a description. A page without a description does
not pass the quality gate.

## Grid

Card grids use CSS grid with `repeat(auto-fit, minmax(260px, 1fr))` and
`--space-4` gaps. Forms use a single column of labelled fields grouped into
`FormSection`s; two columns only for short paired values (e.g. port + protocol).

## Density

Base font size is `14px`. Table rows are `44px`, inputs `36px`, buttons `36px`
(`32px` for `sm`, `44px` for `lg`). Vertical rhythm is a multiple of `4px`.
