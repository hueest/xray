---
status: accepted
---

# Carried intent and salience-driven capture

> **Amends ADR 0005** (revisits its accepted "var() frozen / fluidTracks" costs)
> and **builds on ADR 0004 / 0007** (per-View `@media`/`@container` gates,
> content-addressed classes). These invariants raise fidelity via carried intent
> and shrink payload via a perceptual summary. This ADR records only what is
> settled and durable; the payload ladder is resolved rung by rung in
> [ADR 0022](./0022-uniform-pass-pipeline.md)'s consequences.
>
> **Revisited by ADR 0021:** §3 (Fuse/Absorb as a Salience-weighted adjacent-Leaf
> merge) and §4 (Salience as the merge driver) are superseded by ink-driven,
> run-based grouping. §1–§2 (carried intent, engine text reflow) stand.

The mechanisms that raise fidelity (carrying author intent so the engine
reflows; reproducing text wrap) tend to grow the Plate, and a Plate that
transcribes the DOM near-1:1 already carries inert weight. One stance resolves
both: carry the author's intent and a perceptual model of what renders, and let
the browser re-derive the rest, rather than freezing computed output or
transcribing the DOM.

## Decision — the invariants

### 1. Carry intent; freeze only the irreducible (amends ADR 0005)

ADR 0005 chose copied author rules over frozen computed styles, but accepted two
freezes as costs: `var()` resolved to its capture-time value, and px-only grid
tracks reconstructed by heuristic (`fluidTracks`). Both repeat the mistake 0005
named, one layer up: freezing output the author wrote as intent.

- **Carry author custom-property definitions, conditionally.** A token referenced
  by a kept layout declaration is carried as a definition on the Plate's scoped
  root (or the node that redefined it) **when its definition varies across the
  captured conditions** (`@media`/`@container`); a **constant** token is inlined
  (frozen) because that is smaller and identical. The engine then re-resolves
  responsive spacing, grid, and `var()` at render; `fluidTracks` shrinks to a
  last resort for genuinely unrecoverable px grids.
- **Self-containment (ADR 0003) is preserved.** The Plate emits its own
  `--tokens` in its scoped `<style>` and still depends on nothing in the
  consumer's build. Freezing `var()` was the simplest way to be self-contained,
  not the only one.
- **The irreducible freeze floor:** content-measured leaf/text sizes (no author
  rule produces them) and the genuinely unreadable (cross-origin sheets, `env()`,
  JS-set inline custom props). Freezing is the exception.

### 2. Text reflows in the engine; pretext is capture-side only

Text height is `f(content, font, width, break rules)`. No author rule or stored
line _count_ expresses it, and a render-time line-count model would need JS
width measurement on resize, which ADR 0004's render forbids (no JS
measurement, no flash, SSR-safe).

- **The Plate ships a width-faithful _profile_ the browser re-wraps** — the
  `@container` line-count rep (leaf-scoped, name-qualified bands) for a wrapping
  run, a single-line text bar otherwise — never a frozen height. The engine is
  the wrapping authority at render.
- **`pretext` ([@chenglou/pretext](https://github.com/chenglou/pretext)) is a
  capture-side / build oracle only; it never ships in a Plate.** It supplies the
  Unicode-correct token-width profile and the multi-width line-count function
  offline. Using it at render (per-width JS) is off-model and banned; confining
  it to the dev/build capture path also contains its dependency risk (zero
  runtime weight).
- **Any injected query container is leaf-scoped, name-qualified, and only placed
  on a full-width block** that carries the captured node's layout role, so it
  cannot hijack an author `@container` chain (queries resolve upward; a leaf
  can't intercept) nor collapse a shrink-to-fit box. Prefer reusing a captured
  author container when one is the bone's immediate sizing context.

### 3. A Plate is a perceptual summary, not a DOM transcription

Node distillation comes in two kinds:

- **Perceptual distillation** combines what _reads as one_, Salience-driven and
  fidelity-positive, so it ships in the baseline: **Fuse** (adjacent Leaves that
  paint as one Bone) and **Absorb** (a contrast surface rendering as one Bone,
  subsuming its children — the `hasContrastingFill` branch it generalized).
- **Structural distillation** removes geometry-redundant nesting with no
  perceptual change (**Flatten**), plus the lossy ladder (quantize, template
  runs, sub-threshold drop, depth LOD), most-fidelity-preserving first.
- **Structural distillation must be geometry- and responsive-preserving:** collapse
  only a chain whose boxes are coincident across _all_ breakpoints, or whose
  ancestors only add margin/padding, and carry that accumulated spacing
  (conditionally if it varies). Never flatten across a Stitch (ADR 0006); never
  flatten away conditional spacing.

### 4. Salience is visual relevance, measured, never inferred

**Salience** is one score: a node's visual relevance, from **contrast + spacing +
size + type-scale**. It drives perceptual distillation in the baseline and gates
structural distillation.

- **Measurable visual signals only**, computed from the DOM tree, CSSOM,
  geometry, and resolved colors/fonts the capture already holds.
- **Never** rasterized pixels, computer-vision saliency/face detection, or
  semantic markup/intent. Semantic role (`<button>`, landmarks, ARIA) is
  _excluded entirely, not even as a guard_: it doesn't correlate with visual
  salience (two `<button>`s can look opposite) and isn't reliably present
  (div-soup is the norm). Visual-only Salience is markup-agnostic, the same
  "measure what renders, not the intent" stance the project takes everywhere
  else (no headless browser, no hand-drawn placeholders). The visual signals
  (size, contrast) are their own non-drop guard, so no semantic guard is needed.
- `MEDIA_TAGS` _kind_ classification is unaffected: that is "what does this
  replaced element paint," not a Salience ranking.

## Considered alternatives

- **Keep freezing `var()`/grid (status quo, ADR 0005 costs).** Rejected: the
  responsive drift it causes is exactly what carried author rules were chosen to
  avoid; the fix is the same principle one layer up.
- **A render-time text model (pretext, or a CSS line-count formula at render).**
  Rejected: reintroduces JS width measurement and breaks SSR-safety (ADR 0004);
  CSS can't divide a length by the resolved width anyway. The engine re-wraps a
  shipped profile for free.
- **Semantic role as a Salience signal or a non-drop guard.** Rejected (see §4):
  unreliable on both correlation and coverage.
- **One mega-ADR, or build directly.** Rejected: the per-technique choices are
  exploratory and churn; only these invariants are firm enough for an ADR.

## Consequences

- ADR 0005's "var() frozen / fluidTracks" accepted costs are superseded by §1; its
  copy-over-freeze decision otherwise stands and is reinforced.
- `pretext` enters the **dev/build** dependency surface only; the runtime adapter
  and the shipped Plate stay free of it.
- The high-fidelity baseline (carried intent + engine text) shipped first;
  structural distillation followed one technique at a time,
  most-fidelity-preserving first, measured against a fidelity/size dial. Every
  rung of the payload ladder is resolved — built, held, or rejected — in
  [ADR 0022](./0022-uniform-pass-pipeline.md)'s consequences.
