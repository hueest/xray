---
title: Capture customization
description: Hints and the capture walker — shape what a capture keeps, collapses, or drops.
---

Default capture is automatic, and for most components it is right. Sometimes the
classifier is wrong: a chart, a decorative SVG, an embedded widget, or an avatar
stack leaks its internal DOM into the skeleton where one clean shape belongs.
Two escape hatches cover this, at two levels of power. Both are capture-only:
they shape what gets captured and never change how a Plate renders.

## Hints

Hints are DOM attributes you write on your own elements. They cover the simple
cases declaratively.

- `data-xr-ignore` drops the element and its entire subtree, layout included.
  No Bone is drawn and no space is reserved. Use it for decorative content that
  should not exist in the skeleton.
- `data-xr-bone-kind="text-line | text-block | media | box | hidden"` collapses the
  element's subtree into a single Bone of that kind. Use it when the internals
  should not leak: one shape stands in for the whole thing.
- `data-xr-bone-kind="hidden"` deserves its own mention: it is the
  space-preserving complement to `data-xr-ignore`. The Bone holds the element's
  exact box in the layout but paints nothing. Use it for decoration that
  occupies real space — dropping such an element with `data-xr-ignore` would
  shrink the skeleton below the loaded component and shift content at swap.

```jsx
{
  /* confetti is decoration; the skeleton should not reserve space for it */
}
;<CanvasConfetti data-xr-ignore />

{
  /* the chart's internal DOM is noise; capture it as one media Bone */
}
;<div data-xr-bone-kind="media">
  <RevenueChart data={data} />
</div>
```

Both attributes are inert in production.

## The Walker

For rules a static attribute cannot express, pass a **Walker**. It sees every
element in the capture and decides what happens to it.

```tsx
import { defineXrayCaptureWalker } from '@hueest/xray/core'

const walker = defineXrayCaptureWalker({
  element(ctx) {
    // Collapse any chart library wrapper to a single media Bone.
    if (ctx.el.matches('.recharts-wrapper')) return ctx.bone({ kind: 'media' })
    return ctx.keep()
  },
})

<Skeleton plate={plate} loading={loading} captureWalker={walker}>
  <Dashboard />
</Skeleton>
```

The `element(ctx)` hook runs for each element and returns one decision:

- `ctx.ignore()` drops the element and its subtree — the `data-xr-ignore`
  primitive.
- `ctx.bone({ kind })` collapses the subtree to one Bone. Omit `kind` and the
  default classifier infers it.
- `ctx.keep()` defers to the default classifier and recurses into the subtree.
- `ctx.el` is the live element to inspect — including your own attributes, so a
  design system can define its own hints (`data-myteam-*`) and honor them in
  its walker.

The Walker receives helpers, never raw Plate nodes, so walkers keep working as
the Plate format evolves. One walker governs the whole tree under its
`<Skeleton>`; the same walker also works with the core `captureElement`.

## Precedence

Decisions fall through in a fixed order:

1. **The stitch guard always wins.** A nested `<Skeleton>` is always captured
   as a reference to its own Plate. Neither a Walker nor a Hint can ignore,
   collapse, or descend into it.
2. **`data-xr-ignore` acts at Collect.** The element and its whole subtree are
   dropped before anything is measured, so the Walker — and every later stage —
   never sees them. There is no override: respecting an ignore is structural.
3. **The Walker outranks every Hint it can see.** It runs over the measured
   tree, so a deciding Walker (`ignore` or `bone`) overrides a
   `data-xr-bone-kind` on the element; `ctx.keep()` lets the Hint stand.
4. **`data-xr-bone-kind` applies next**, then the default classifier.

`data-xr-ignore` cuts before measurement, which is also why it is the right
tool for heavy subtrees (charts, canvases) that are expensive to even measure.
For everything the capture can see, the Walker is the policy level (a
design-system rule written once) and `data-xr-bone-kind` the local level (a
one-off fix on one element).
