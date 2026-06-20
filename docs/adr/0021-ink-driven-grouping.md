---
status: accepted
---

# Ink-driven grouping over a measured light-DOM

> **Supersedes ADR 0019 §3 (perceptual distillation via Fuse/Absorb) and §4
> (Salience as the merge driver); builds on §1–§2 (carried intent, engine text
> reflow), ADR 0004 (per-View capture), and ADR 0007 (content-addressed
> classes). §1 (capture as a pipeline of pure passes) is refined into a precise
> contract by [ADR 0022](./0022-uniform-pass-pipeline.md).** The staged technique
> ladder is resolved in ADR 0022's consequences; the values left to tune are
> listed in this ADR's consequences.

ADR 0019 §3 grouped Leaves by walking the DOM and merging adjacent siblings
(Fuse) under Salience weights. Dogfooding showed the grouping tracked _markup_,
not appearance: a bare text node could never Fuse (it isn't an element); two
flex-stretched labels Fused because their _boxes_ were equal width though their
ink was not; one extra wrapper `<div>` flipped two visually identical tabs to
different bones. The element box and the DOM shape both lie. **Group by what the
text actually inks, bounded by the author's formatting structure, not by element
boxes or nesting depth.**

## Decision — the invariants

### 1. Capture is a pipeline of pure passes over one measured IR

Capture builds a **light-DOM**: an in-memory tree, one per View (ADR 0004),
mirroring the rendered structure, each node carrying its applied author CSS,
computed styles, bounding box, and (for text) `pretext`/`Range` line
dimensions. A pipeline then distils it: **build → mark ink → group → flatten →
quantize → emit**.

- **Only the build pass touches the browser.** It runs once, synchronously, and
  must snapshot _everything_ later passes could need: layout is valid only at
  that instant and no later pass may re-measure. Every pass after build is a
  **pure data transform** over the IR: testable, re-runnable, free of the DOM
  (it could even run at build time).
- **Lossy, most-fidelity-first** (the image-compression stance): each pass drops
  only what earlier passes proved irrelevant. The final emit, content-addressed
  classes (ADR 0007), is the entropy-coding step.
- Geometry on the IR is **analysis-only and ephemeral**: it computes relations to
  decide grouping, then is discarded. The output stays author-CSS-driven (0019
  §1–§2); nothing in a Plate is positioned by captured geometry.

### 2. The grouping atom is the run — one IFC's ink

A **run** is the glyph ink of a single inline formatting context (the inline-level
content of one block box), plus any inline replaced-media that **reads as a
glyph** — height ≈ the run's text and gap ≲ one space. A run whose ink spans ≥2
baselines is a **text-block**; one baseline, a **text-line**.

- **Runs never merge across block boxes.** This subsumes both Fuse paths at
  once: inline siblings are already _one_ run (the horizontal merge), and
  separate block boxes are _separate_ runs (no vertical merge). Stacked distinct
  labels stay distinct; a wrapped paragraph is one run that became a block.
- **The IFC boundary, not geometry, separates runs**, because pure baseline-gap
  geometry cannot tell a paragraph wrapped to two lines from two labels stacked
  one line-height apart (measured: identical spacing). Block-vs-inline is author
  _intent_ and robust; nesting depth is neither.
- **Inline replaced-media folds into the run only when it reads as a glyph**
  (text-height, within a space); otherwise it is its own shape. The fold test
  (measured size + spacing) is Salience's surviving job.

### 3. Absorb is the only non-text merge, and only on painted surfaces

A **painted surface** (a box with a contrast-bearing fill, border, or shadow)
whose content reduces to a **single run and nothing else** renders as one box,
subsuming that label. A second distinct shape inside, or any replaced media,
makes it a **container**: draw the parts and keep the surface as a frame.

- **Replaced media is never a swallowing surface**: a large image with an
  overlaid title is a media box plus its text bones, never one box.
- **Absorb lives inside mark-ink** — one pure IR transform owns all
  classification (paint kind, bone kind, invisibility, Absorb), reading only the
  Measure snapshot — which places it _before_ glyph-fold. A deliberate
  divergence follows: a non-flow icon-button on a contrast surface is not
  absorbed, because the glyph-icon sibling is not yet folded into its run when
  the single-label test fires, so it still reads as a second shape.
  Absorb-after-glyph-fold (ADR 0022 §3's group stage) would restore that
  absorption.
- Whether a _large_ surface holding one short label should swallow or frame is the
  one open Absorb question, settled by eyeballing real captures.

### 4. Five bone kinds; the IR's richer types collapse at emit

The IR may carry as many detection types as decisions need (painted surface,
glyph-fold candidate, …). The **shipped Bone is one of five,
`box` / `text-line` / `text-block` / `media` / `hidden`, all one rounded-rectangle
primitive.**

- **`box`** (non-text painted shapes: painted surface, absorbed control)
  **carries the author `border-radius`**: circle (radius ≥ half the shorter
  side), pill, rounded card, and sharp rect all fall out, with no per-kind
  radius.
- **`media`** (replaced content) carries the author radius through its own
  `--xr-bone-media-border-radius` token, defaulting to the block's soft rect.
- **`text-line`** → rounded ends (reads as a text bar). **`text-block`** → a soft
  rect, _not_ a pill (solid for the foreseeable future; ragged per-line bars from
  `pretext` widths remain an unused, drop-in option).
- **`hidden`** — explicit-only (a `data-xr-bone-kind` Hint or a walker
  decision, never inferred; ADR 0018): holds its measured box, paints nothing.

## Considered alternatives

- **Tune the four Fuse thresholds / keep element-box comparison (status quo §3).**
  Rejected: the failures are structural, not threshold. Flex-stretched boxes read
  equal-width when the ink is not, and a bare text node has no box to compare;
  more knobs cannot fix "the box lies."
- **Pure-geometry grouping (cluster ink by baseline gaps, no IFC).** Rejected: a
  wrapped paragraph and two stacked labels are geometrically identical at a
  line-height gap (measured); only the formatting structure separates them.
- **Geometry-positioned bones (silhouette synthesis / boneyard's `[x,y,w,h,r]`).**
  Rejected: it sacrifices the author-CSS reflow ADR 0004 guarantees. Geometry
  stays analysis-only; layout is re-run from carried CSS.
- **Keep per-kind bone appearance / many shipped kinds.** Rejected: a carried
  radius over three kinds covers circle/pill/rounded/sharp with no taxonomy to
  maintain.

## Consequences

- ADR 0019 §3 (Fuse/Absorb as a Salience-weighted adjacent-Leaf merge) and §4
  (Salience as the merge driver) are superseded; §1–§2 (carried intent, engine
  text reflow) stand and are reinforced. 0019 carries a pointer.
- **Salience** survives, demoted: the glyph-fold test (size + spacing) and surface
  detection (contrast). Its blended scalar as a _merge weight_ is retired.
- Glossary (the [glossary](https://xray-js.dev/glossary/)): **light-DOM / IR**, **Run**, **Ink**; Fuse is retired
  (Run replaces it). Bone kinds are fixed at **box / text-line / text-block / media / hidden**.
- Implementation removes `fuseKids` and the Salience-weighted `surfaceAbsorbs`
  merge; grouping becomes run-based; the bone taxonomy collapses to three.
- Open, to settle by eyeballing real captures: the large-surface Absorb
  size-gate; solid vs ragged text-block; and the radius / glyph-fold / space-gap
  threshold values.
- **Flatten** and the lossy ladder (quantize, …) are named passes in this same
  pipeline; each rung's disposition is recorded in ADR 0022's consequences.
