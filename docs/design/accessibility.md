# Accessibility

Target: WCAG 2.1 AA for the whole control plane. Accessibility is part of the
Definition of Done (`PLAN.md` §35), not a later pass.

## Keyboard

- Every interactive element is reachable and operable by keyboard.
- Tab order follows visual order. No positive `tabindex`.
- Overlays (`Dialog`, `Drawer`, `CommandPalette`, `Popover`) trap focus while
  open, close on `Esc`, and restore focus to the trigger on close.
- A "Skip to content" link is the first focusable element in the shell.
- No keyboard trap: menus and comboboxes release focus on `Esc` and `Tab`.

## Focus

- `:focus-visible` renders a `2px` ring in `--color-focus-ring` with a `2px`
  offset. The ring is never removed without an equivalent replacement.
- Focus is moved deliberately after actions: to the drawer on open, to the
  error summary on failed submit, back to the trigger on close.

## Semantics and labels

- Native elements first: `button`, `a`, `input`, `select`, `table`, `nav`,
  `main`, `dialog`. ARIA only where no native element exists.
- Every input has a programmatically associated `<label>`. Placeholder text is
  never a substitute for a label.
- Hints and errors are linked via `aria-describedby`; invalid fields set
  `aria-invalid="true"`.
- Icon-only controls require `aria-label` (enforced by the `IconButton` type).
- Tables use real `<th scope="col">` headers and a `<caption>` when the page
  title does not already name the table.

## Announcements

- Toasts render into an `aria-live="polite"` region; errors use `assertive`.
- Async region updates (table reload, validation results) announce their new
  state, not every intermediate step.
- Route changes move focus to the page `<h1>`.

## Contrast

- Body text ≥ `4.5:1`, large text (`≥ 20px`) and UI boundaries ≥ `3:1`, in
  both themes.
- Status is never encoded by colour alone: badges carry text,
  `HealthIndicator` carries a distinct shape and label.
- Charts remain readable in greyscale.

## Motion and preferences

- `prefers-reduced-motion: reduce` disables transforms and sets transition
  durations to `0ms`.
- `prefers-color-scheme` selects the initial theme; the explicit user choice
  is stored and wins.
- The UI works at `200%` browser zoom without horizontal page scrolling;
  wide tables scroll inside their own container.

## Verification per page

Before merge (`PLAN.md` §20):

```text
[ ] tab through the whole page, no trap, order sensible
[ ] every control has an accessible name
[ ] focus ring visible on every focusable element in both themes
[ ] contrast checked for text and status colours
[ ] works at 1280×720 and tablet width
[ ] reduced motion respected
```
