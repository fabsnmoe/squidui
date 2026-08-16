# Colour

Colours are never used directly by feature code. Feature code uses semantic
tokens; the theme decides the value. Tokens are defined in
`packages/ui/src/styles/tokens.css`.

## Semantic surface and text tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#f6f7f9` | `#0b0d10` | app background |
| `--color-surface` | `#ffffff` | `#14171c` | cards, tables, panels |
| `--color-surface-raised` | `#ffffff` | `#191d24` | popovers, dropdowns |
| `--color-surface-overlay` | `#ffffff` | `#1c212a` | dialogs, drawers |
| `--color-surface-sunken` | `#f0f2f5` | `#0f1216` | code blocks, wells |
| `--color-border-subtle` | `#eceef2` | `#1e232b` | dividers inside a surface |
| `--color-border` | `#dfe3e9` | `#272d37` | card and input borders |
| `--color-border-strong` | `#c3cad5` | `#3a424f` | hovered/active borders |
| `--color-text` | `#12161c` | `#e9edf3` | primary text |
| `--color-text-secondary` | `#4d5766` | `#a3adbb` | labels, secondary text |
| `--color-text-muted` | `#6b7686` | `#7a8493` | hints, timestamps |
| `--color-text-inverted` | `#ffffff` | `#0b0d10` | text on accent fills |

## Accent

| Token | Light | Dark |
| --- | --- | --- |
| `--color-accent` | `#4f46e5` | `#818cf8` |
| `--color-accent-hover` | `#4338ca` | `#a5b4fc` |
| `--color-accent-active` | `#3730a3` | `#c7d2fe` |
| `--color-accent-subtle` | `#eef2ff` | `#1e1b4b` |
| `--color-accent-text` | `#4338ca` | `#a5b4fc` |

## Status colours

Every status has a `-fg` (text/icon), `-bg` (subtle fill) and `-border` token.

| Status | Meaning in this product | Light fg | Dark fg |
| --- | --- | --- | --- |
| `success` | healthy, deployed, active, authenticated | `#15803d` | `#4ade80` |
| `warning` | degraded, drift, unsafe-but-allowed configuration | `#b45309` | `#fbbf24` |
| `danger` | failed, unreachable, denied, destructive | `#b91c1c` | `#f87171` |
| `info` | informational, in progress | `#0369a1` | `#38bdf8` |
| `neutral` | disabled, unknown, not configured | `#4d5766` | `#a3adbb` |

Product-specific mapping that must stay consistent everywhere:

| Concept | Status |
| --- | --- |
| `ALLOW` action | `success` |
| `DENY` action | `danger` |
| Authentication mode `REQUIRED` | `success` |
| Authentication mode `OPTIONAL` | `info` |
| Authentication mode `DISABLED` | `warning` |
| Provider health `HEALTHY` | `success` |
| Provider health `DEGRADED` | `warning` |
| Provider health `UNREACHABLE` | `danger` |
| Provider health `DISABLED` / `UNKNOWN` | `neutral` |
| Open proxy detected | `danger` |

## Rules

- Colour is never the only carrier of meaning. Status badges always pair colour
  with a label, and health indicators with a shape/icon.
- Body text against its background meets WCAG AA (`4.5:1`); large text and
  non-text UI boundaries meet `3:1`.
- Charts use the sequence accent → info → success → warning → danger and must
  remain distinguishable in greyscale.
- No `opacity` based "disabled greys" for text that must stay readable; use
  `--color-text-muted`.
