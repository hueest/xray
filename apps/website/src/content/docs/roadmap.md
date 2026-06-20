---
title: Roadmap
description: What's next for xray, what's deliberately deferred, and the known limits.
---

What's next and what's deliberately deferred. How the pieces work lives in
[Architecture](/architecture/); the why behind each decision lives in the
[decision records](https://github.com/hueest/xray/tree/main/docs/adr).

## Planned

- **More frameworks & metaframeworks.** A second adapter (Solid or Preact) to
  prove the
  [ADR 0008](https://github.com/hueest/xray/blob/main/docs/adr/0008-framework-agnostic-core-thin-adapters.md)
  chunk contract on a non-React host, then the Vite metaframeworks (Astro,
  TanStack Start, Solid Start) where SSR/hydration and dev-client bootstrap
  differ from a plain SPA. The two axes are independent: a UI-framework adapter
  is a small unit of work against a settled contract; metaframework support is
  mostly a bootstrap + SSR problem, and largely framework-shared.
- **Animated enter/exit.** An opt-in `viewTransition` for the skeleton→content
  swap (crossfade, or a shared-name morph), feature-detected and reduced-motion
  gated. Decided but not built; touches the prod adapter and per-framework
  swap. Decision:
  [ADR 0012](https://github.com/hueest/xray/blob/main/docs/adr/0012-enter-exit-via-view-transitions.md).
- **Capture fidelity.** Carry author custom properties conditionally instead of
  freezing `var()`/grid tracks; reflow text via the engine with `pretext` as a
  capture-side oracle. Decisions:
  [ADR 0019](https://github.com/hueest/xray/blob/main/docs/adr/0019-carried-intent-and-salience-driven-capture.md)
  (carried intent + engine reflow) and
  [ADR 0021](https://github.com/hueest/xray/blob/main/docs/adr/0021-ink-driven-grouping.md)
  (the ink-driven IR pipeline). The payload track is **resolved**: the shipped
  Distil stack (Flatten, Template, dead-decl drop, invisible-element skip,
  Superset, 2D Crop) takes ~⅕–¼ off raw, more on overlay-heavy views. Atomic
  CSS factoring was measured and rejected (compressed worse,
  [ADR 0007](https://github.com/hueest/xray/blob/main/docs/adr/0007-content-addressed-style-classes.md));
  quantize and the sub-threshold ink drop are postponed and depth-LOD shelved
  ([ADR 0022](https://github.com/hueest/xray/blob/main/docs/adr/0022-uniform-pass-pipeline.md)).
- **Tailwind class passthrough (opt-in).** For Tailwind projects, read the
  config and keep the layout-relevant utility classes on the bone rather than
  extracting their computed decls into the plate's own CSS, so the app's
  already-loaded global Tailwind styles the skeleton for zero extra CSS. The
  biggest CSS-payload win for Tailwind apps, and it avoids the entropy problem
  that ruled out self-contained atomic factoring
  ([ADR 0007](https://github.com/hueest/xray/blob/main/docs/adr/0007-content-addressed-style-classes.md)):
  the utility classes are already on the wire, so no new rule text ships.
  Opt-in because it trades
  [ADR 0003](https://github.com/hueest/xray/blob/main/docs/adr/0003-self-contained-plates.md)
  self-containment (the skeleton would depend on the app's Tailwind
  stylesheet); the self-contained default stays for everyone else. Keep layout
  classes, drop or override paint (a bone is a grey rect); watch arbitrary
  values, JIT, and purge. No ADR yet.

## Deferred / known limits

- **Capture-all distribution & coverage.** The dev-only extension
  ([ADR 0010](https://github.com/hueest/xray/blob/main/docs/adr/0010-capture-all-views-via-extension.md))
  works but loads unpacked: no Chrome Web Store package yet (a GitHub Releases
  zip comes first, the Web Store later), its content script matches only
  `localhost`/`127.0.0.1` (broaden for other dev origins), and tall/lazy
  (`IntersectionObserver`) content may need a driven scroll at short emulated
  heights.
- **Bones in the Blink.** The dev capture Blink is a cyan bloom, a negative
  `invert` blink, and a scan-line sweep over the element's box. Overlaying the
  _actual captured bones_ (a true x-ray of what was captured) drifts
  vertically: reconstructing the captured flow layout inside an
  absolutely-positioned overlay misplaces first-child margins,
  capture-vs-current height differences, and stale-sized stitched children.
  Revisit once the Sweep gives multi-width data to reconstruct faithfully, or
  anchor a small overlay per captured root rather than one box for the whole
  plate.
- **Capture-walker prod-stripping.** The `captureWalker`
  ([ADR 0018](https://github.com/hueest/xray/blob/main/docs/adr/0018-capture-customization-hints-and-walker.md))
  is a dev-only concern but ships to prod as small dead code in v1. A
  build-time prop strip (the xray plugin removing the `captureWalker`
  attribute, letting the walker tree-shake) is deferred until the weight is
  worth it.
- **Next.js integration.** Deliberately a roadmap item, not an ADR yet. Tackle
  non-React UI adapters and Vite-based metaframeworks first; they should define
  the shared adapter/bootstrap constraints. A Next-specific decision record
  comes only when a spike is close enough to decide load-bearing scope (modern
  Next, App Router, Turbopack, generated modules, dev sidecar, etc.).
- **Non-width axes** (dark mode, `orientation`): out of scope for v1.
- **Pseudo-element rules.** Dropped in v1; revisit if a real app leans on
  `::before/::after` for layout.
- **Degenerate replaced boxes.** Leaves with a near-zero axis grow to their
  parent's content box when they are an only child (overflow-painting charts);
  broader low-ink heuristics deferred.
