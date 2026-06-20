---
status: accepted
---

# Capture customization: hints and the capture walker

Default capture is automatic and should stay that way for almost everything. But
the classifier is sometimes wrong: a chart, a decorative SVG, an embedded widget,
an avatar stack, or a custom button leaks its internal DOM into the skeleton
where one clean shape was wanted. The escape hatches must not complicate the
default path, and they come at two levels of power.

## Decision

A two-level capture-customization model, both **capture-only** (they shape the
walk, never become Plate concepts) and both subordinate to stitch isolation.

**Hints — the declarative 90%.** Capture-only DOM attributes the consumer writes
on their own elements:

- **`data-xr-ignore`** — drop this element and its entire subtree, layout
  included (no Leaf, no Bone). For decorative content that shouldn't reserve
  skeleton space. Applied at Collect: the subtree is never measured, which
  both makes it free for heavy content (charts, canvases) and makes respecting
  it structural — nothing downstream can see the element to override it.
- **`data-xr-bone-kind="text-line | text-block | media | box | hidden"`** — collapse
  the subtree into a _single_ Bone of that kind (stop descending _and_ set the
  kind). The primitive for "give me one shape, don't leak the internals."
  `hidden` is the space-preserving complement to `data-xr-ignore`: the Bone
  holds the element's measured box in the layout but paints nothing
  (`.xr-leaf-hidden { visibility: hidden }`), for decoration that occupies real
  space — dropping it would shrink the skeleton below the loaded component and
  shift content at swap. `hidden` is explicit-only: the default classifier
  never infers it.

**The walker — the programmable 10%.**
`defineXrayCaptureWalker({ element(ctx) })`, passed as a `captureWalker` prop
(or to the core `captureElement`). It exposes **helpers, never raw
`PlateNode`s**, so xray keeps ownership of the Plate format, CSS extraction,
stitches, and sizing — the full helper surface:

- `ctx.ignore()` — drop subtree (the `data-xr-ignore` primitive).
- `ctx.bone({ kind })` — collapse to one Bone (`{ kind }` open for future
  fields; `ctx.bone()` with no `kind` uses `inferLeafKind`, the single source
  of truth for a collapsed bone's kind — the default classifier reaches the
  same media/box outcomes through its own structural branches).
- `ctx.keep()` — one decision covering "defer to the default classifier and
  recurse" (there is no separate `next()` or `ctx.walk()`).
- `ctx.el` — the live element to inspect.

The walker runs as the `applyWalker` **pass over the measured IR**
(annotate-then-lower; ADR 0022 §5), not a mid-walk ladder.

v1 ships the **`element` hook only**; `text` / `declarations` / `media` / `list`
are names this ADR reserves so the object shape can grow without breaking
existing walkers.

**Precedence is a fall-through chain:**

```
[stitch guard]  →  custom walker  →  hints  →  default classifier
```

- The **stitch guard runs before any walker** and **always wins**: a nested
  `<Skeleton>` (`data-xr-boundary` / `data-xr-root`) always emits its `ref`.
  Neither the walker nor a hint can collapse, ignore, or descend into a
  boundary: ADR 0006 isolation is non-negotiable, so the walker only ever sees
  non-boundary elements.
- **`data-xr-ignore` acts at Collect** and is absolute: the element and its
  subtree are dropped before measurement, so the walker — which runs as a pass
  over the measured IR (ADR 0022 §5) — never sees them. This is deliberate
  policy: every pass and walker respects an ignore because the enforcement is
  structural, not cooperative.
- **The walker outranks every hint it can see**: a deciding walker
  (`ignore`/`bone`) overrides a `data-xr-bone-kind` on the element; `keep()`
  lets the hint stand and falls through to the default classifier. And since
  the walker receives the live element, a design system can define its own
  attributes (`data-myteam-*`) and honor them in its walker.
- `ctx.keep()` (or the default deciding to descend) recurses the **same** walker
  over the subtree, so one `captureWalker` governs the whole tree under its
  `<Skeleton>`.

## Considered alternatives

- **boneyard's `snapshotConfig`.** Rejected: the two-level model keeps simple
  cases local and declarative (hints) while complex cases get full runtime JS
  (the walker).
- **Exposing raw `PlateNode`s to the walker.** Rejected: it would freeze the Plate
  format. Decision helpers keep walkers forward-compatible.
- **Hints beat the walker (locality wins).** Rejected: the walker is
  first-crack and can defer to the default via `ctx.keep()`. Design-system authors
  get one policy hook; per-element hints remain the fall-through.
- **`ctx.default()` helper.** Dropped — redundant with `ctx.keep()`; "bypass
  hints, force default" is a niche that can be added later.
- **Stripping the walker from prod up front.** Deferred: the walker config and
  `defineXrayCaptureWalker` are small (the heavy capture runtime is already
  dev-only), so v1 ships it as minor dead code rather than adding a build-time
  transform. Tracked for a future version.

## Consequences

- New dev-capture attributes (`data-xr-ignore`, `data-xr-bone-kind`, inert in
  prod) and a public `defineXrayCaptureWalker` API.
- The precedence ladder is a documented invariant; stitch-always-wins protects
  ADR 0006 at every level of customization.
- v1 production carries minor walker dead weight (deferred optimization).
