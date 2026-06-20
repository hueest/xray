---
status: accepted
---

# Render-prop `<Skeleton>`: typed data and a manual capture root

The default `<Skeleton>` takes plain children gated by `loading` (ADR 0002), and
inserts a `display:contents` boundary wrapper so a parent capture knows where to
stop (ADR 0006). Two advanced needs don't fit that shape: (1) xray wants to know
the _data_ that produced the captured DOM, to record/replay it (Fixtures, ADR
0015); (2) some components must own their real capture root element — the wrapper,
though layout-neutral, still perturbs grid/flex item counts and selector-sensitive
CSS. Both need xray to hand values _back_ to the consumer's render. That is what
render props are for.

## Decision

Add an **additive** render-prop children form, `({ data, ref }) => ReactNode`,
alongside plain children, which stays the default 90% path. It unlocks a
first-class `data` prop and a `root: 'auto' | 'manual'` discriminant.

- **`data` is typed `T` verbatim, a pure pass-through.**
  The render prop receives exactly what the consumer passed. xray neither widens
  nor narrows. An earlier draft's `NonNullable<T>` was rejected: production has no
  Fixture to substitute, so xray cannot honor a non-null guarantee, and forcing
  it would erase the legitimate `loading=false, data=null` _error_ state. The
  consumer is the single source of truth for nullability — they type their prop
  non-null when they know data is present, and get zero null-checks for free.
- **The render prop is always called at `loading=false`**, null included.
  `loading` stays the sole readiness axis (ADR 0002); data presence is never
  folded into readiness.
- **`root="manual"`**: the callback `ref` imperatively writes the existing
  `data-xr-boundary="<name>"` marker (ADR 0006) onto the consumer's own element
  and registers it as the capture root — no wrapper. A parent capture reads the
  identical marker (`measure.ts` already does `BOUNDARY_ATTR ?? ROOT_ATTR`), so
  it cannot tell a manual root from an auto one. Dev-only; the prod `ref` is a
  no-op and SSR renders only the consumer's element. `root="manual"` **requires**
  render-prop children (the only way to hand back a `ref`).
- **Dev-time assertion**: in `root="manual"`, if no element in the boundary
  carries `data-xr-boundary` after mount, `console.error`. A missing ref means the
  parent descends into the child and silently captures its DOM into the _parent's_
  Plate — the exact stitch-isolation breakage ADR 0006 exists to prevent, and the
  worst failure xray can produce. It must be loud.

## Considered alternatives

- **Plain children only; the consumer closes over `data`.** Rejected: xray then
  can't see the data (no Fixtures) and there's no `ref` seam for a manual root.
- **`NonNullable<T>` for ergonomics.** Rejected: unsound in prod, and it hijacks
  the error state. Ergonomics come from the consumer's own prop type instead.
- **`as` / `asChild` composition for the manual root.** Rejected: more machinery
  and a new composition concept, when a callback ref writing the _existing_
  boundary marker reuses ADR 0006 wholesale.

## Consequences

- The render-prop form is the prerequisite for Fixtures (ADR 0015) and the manual
  root; plain children is untouched.
- `root="manual"` trusts a single host element; the dev assertion is the guardrail
  against silent capture leakage.
- Per the dev/prod split (ADR 0008), prod ships the render-prop call but none of
  the ref/boundary capture logic.
