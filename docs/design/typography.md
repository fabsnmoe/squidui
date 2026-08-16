# Typography

## Families

```text
--font-sans  "Inter var", "Inter", system-ui, -apple-system, "Segoe UI",
             Roboto, "Helvetica Neue", Arial, sans-serif
--font-mono  "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono",
             Menlo, Consolas, "Liberation Mono", monospace
```

Fonts are loaded from the system stack. The images ship no webfonts, so the UI
renders identically in an air-gapped deployment and no external request is made
at runtime.

## Scale

Base is `14px`. The scale is deliberately short — a control plane needs four
text sizes, not nine.

| Token | Size | Line height | Use |
| --- | --- | --- | --- |
| `--font-size-xs` | `11px` | `16px` | badges, table meta, keyboard hints |
| `--font-size-sm` | `12px` | `18px` | secondary text, help text, captions |
| `--font-size-base` | `14px` | `20px` | body, tables, inputs, buttons |
| `--font-size-md` | `16px` | `24px` | card titles, section headings |
| `--font-size-lg` | `20px` | `28px` | page title |
| `--font-size-xl` | `26px` | `34px` | dashboard headline metrics |
| `--font-size-2xl` | `32px` | `40px` | empty-state and login headline |

## Weights

| Token | Value | Use |
| --- | --- | --- |
| `--font-weight-regular` | `400` | body |
| `--font-weight-medium` | `500` | labels, table headers, nav items |
| `--font-weight-semibold` | `600` | titles, metric values, emphasis |

Weight `700` is not used; `600` plus size carries hierarchy.

## Rules

- Sentence case for everything: page titles, buttons, table headers, labels.
  No ALL CAPS except two-to-three letter acronyms (LDAP, TLS, ACL, IP).
- Numbers in tables and metrics use `font-variant-numeric: tabular-nums`.
- Identifiers, hostnames, CIDRs, usernames, config snippets and hashes use
  `--font-mono`.
- Line length in prose blocks is capped at `72ch`.
- Never communicate through italics; use secondary colour or a badge.
