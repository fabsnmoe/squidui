# Design Principles

Binding for every UI contribution. A page that violates one of these principles
does not pass the Modern UI Quality Gate (`PLAN.md` §20).

## 1. The design system is the only source of truth

Feature code does not invent layouts, colours, spacing or components. It
composes what `packages/ui` provides. If something is missing, it is added to
`packages/ui` first — with states and both themes — and only then used.

Consequence: no local `<div style={{...}}>` layout scaffolding, no hard coded
hex values, no ad-hoc pixel spacing when a token exists (`PLAN.md` §3, §26).

## 2. Answer the operator's question in five seconds

Every page starts from a question an administrator has, not from a database
table. The dashboard answers "does my proxy work?"; the authentication overview
answers "who can use this proxy right now, and how?".

Information that does not help answer that question moves to a detail view.

## 3. Show state, never a blank screen

Each data surface implements four states: loading, empty, error, success.
Empty is a designed state with an explanation and a primary action, not an
empty table. Error explains what failed and offers a retry.

## 4. Dangerous actions must be understood, not just confirmed

Destructive confirmations name the blast radius (what stops working, which
nodes are affected, whether it is reversible) and require typed confirmation
for irreversible operations (`PLAN.md` §25). "Are you sure?" is a defect.

## 5. Security posture is visible, not hidden

The UI never silently produces an unsafe configuration. It also never blocks a
deliberate decision by an authorised user. Open proxy configurations are
allowed, warned about, and explained (`PRODUCT.md` §5).

## 6. Progressive disclosure over dense forms

Simple things are simple: an allow-any rule is a few fields in a drawer.
Complex things are possible: a full rule uses a stepped wizard
(`PLAN.md` §24). No 40-field single-column form.

## 7. Keyboard first

Everything reachable by mouse is reachable by keyboard. The command palette
(`Ctrl/Cmd + K`) is a first-class navigation path, not a gimmick.

## 8. Both themes are production themes

Light and dark are designed together. Dark mode is not an inverted
afterthought; contrast ratios are verified in both (`docs/design/colors.md`).

## 9. Honest data

The UI does not display placeholder numbers for data sources that are not
connected. A metric without a backing source renders its empty state and says
so. Fabricated dashboard values are a correctness bug.

## 10. Anti-SAP gate

> Would a user opening this for the first time believe it comes from a modern
> web application?

If the answer is "this looks like a legacy ERP / old router UI / phpMyAdmin",
the design goal is not met, regardless of feature completeness (`PLAN.md` §34).
