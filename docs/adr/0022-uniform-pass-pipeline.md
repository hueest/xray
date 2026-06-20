---
status: accepted
---

# Capture is a uniform pipe of annotate-only passes projected once into a per-Plate Plate

> **Extends [ADR 0021](./0021-ink-driven-grouping.md) §1 (capture as a pipeline
> of pure passes over a measured light-DOM) into a precise contract, and folds in
> the `dropped` annotate-then-lower model the Superset / Crop / invisibility passes
> introduced. Keeps [ADR 0004](./0004-dynamic-breakpoint-derivation.md) (per-View
> capture; no cross-View tree-merge) and [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md)
> (framework-agnostic core, thin adapters) intact; absorbs
> [ADR 0007](./0007-content-addressed-style-classes.md) content-addressing into
> the projection step.** The optimization ladder is resolved: every rung is
> built, held, or rejected in the consequences below.

The pipeline grew organically and its passes were not of one kind. Some mutated
the tree destructively (Flatten promoted-and-dropped, glyph-fold merged into
synthetic bars, `pruneRuns` truncated); others only annotated (Superset/Crop set
`dropped`, Template set `count`). Classification was tangled into the measuring
walk; the passes read the live `CSSStyleDeclaration`, so they were stuck
in-session and awkward to test; and `emit`, `mergeViews`, and `classify` were
three steps split across the commit boundary. The cost showed as each
distillation pass landed: tree-surgery bugs, order coupling, and a structure
that fought every new pass.

The package is **pre-public**, so the refactor went straight to the simplest
end-state, free to break output: **the light-DOM IR is a single representation
that passes only _annotate_ (additive, never destructive); once all passes run,
one **Serialize** step projects the annotated IR into the shipped Plate.
Measure is the only code that touches the browser; every pass is a pure
`IR → IR` transform over snapshotted data; and the whole pipeline, Serialize
included, runs in the browser, so what lands on disk is already as close to
the final rendered HTML/CSS as re-renderability allows.**

## Decision — the invariants

### 1. Two levels: a framework-agnostic core, orchestration above

The core is `capture(el, ir?) → ir`: it walks one element subtree and returns (or
augments) an IR. **Stitches and Views are orchestration**, not core: the
framework adapter (ADR 0008) and the HUD fire multiple `capture()` calls, one per
`<Skeleton>` boundary and one per View, and join the results into one per-Plate IR
bundle. This is why Collect (boundaries) is not a pass: where the walk stops (a
nested `<Skeleton>` → a Stitch `ref`) and which elements are roots are decisions
the orchestration owns, above a single `capture()`.

### 2. The IR is a per-Plate bundle, Serialized once in the browser

`PlateIR = { views: ViewIR[] }`. The orchestration threads one bundle through a
Plate's per-View `capture(el, ir)` calls, each appending that View's measured
sub-tree. Capture-all resizes in place in one session (the same DOM node
persists across a Plate's View captures), so the **whole bundle is built in one
session**.

The bundle holds the Views **side by side**; it does not merge them into
corresponding nodes — that cross-View tree-merge is exactly what ADR 0004 found
unreliable. A cross-View pass that wants node correspondence establishes it on
the fly by live element identity (`el`) across `views`, in-session. Cross-View
passes remain deferred (their payoff, cross-View dedup, measures at ~1% of page
JS), and the substrate makes adding one a pass rather than a restructure.

**Serialize runs in the browser, over the whole bundle, once** (§4). Because it
runs where the IR lives, the analysis-only geometry never crosses the wire; only
the finished Plate is posted and committed (ADR 0021: geometry is ephemeral).
There is **no gen-side merge**: merging and classifying happen inside the one
Serialize. Re-capturing a Plate re-runs capture-all (all Views in one session)
and re-Serializes; there is no per-View commit to merge later.

### 3. A pass is a full `IR → IR` transform, in a fixed, load-bearing order

Not a per-node visitor. A per-node, visit-once pipe cannot serve a non-local
pass: Template (similarity across siblings) and Superset (global box
containment) need the whole tree measured and grouped first. So the unit is a
full pass that traverses however it needs (top-down, bottom-up, a global scan,
or a down-then-up "capture+bubble"). The pass signature is `PlateIR → PlateIR`:
a per-View pass uses an `eachView` helper; a cross-View pass reads across
`views`.

- **The order is the contract.** Passes pipe in a fixed sequence and each sees the
  prior's annotations, so the order is explicit and load-bearing:
  **mark-ink → group (runs / glyph-fold / Absorb) → Flatten → Superset → Crop →
  Template → Serialize.** The shape is _measure faithfully → drop the imperceptible
  (mark-ink invisibility, Superset bone-on-bone, Crop off-screen) → compress what
  remains (Template)_. Template runs **last** so it only ever collapses Bones a human
  would actually see: it counts the post-Crop **survivors**, not the raw DOM count.
  (Earlier passes earn their place by what later ones read: Superset needs grouping
  done, Crop needs boxes, Template needs the survivors; Crop folds its own
  orphan-prune in.)
- **Passes read only the IR.** Every pass reads snapshotted fields, never the live
  DOM (no `getComputedStyle`, no `getBoundingClientRect`). Ancestor-dependent
  signals leave the passes two ways, both keeping Measure the sole DOM stage. The
  **clip bottoms and rights** (Crop is 2D: a vertical _and_ a horizontal fold)
  thread down the IR as inherited accumulators inside the pass (as `cropNode`
  threads `clipBottom`/`clipRight`), since the clip context lives within the
  captured subtree. Signals whose climb can reach **above the capture root**
  (nearest painted background for contrast, base font-size) are resolved by
  Measure and snapshotted as the per-node result: Measure seeds the root from the
  host page and descendants inherit through the IR. Either way the ~60
  ancestor-climbs stay out of the passes.
- **Geometry is read through the effective box.** Because no pass mutates structure,
  a later geometry pass sees the full un-reduced tree plus prior annotations. The
  rule that makes this tractable: a merge/restructure annotation records the
  **effective bone box on the surviving node**, so a downstream pass reads
  `boneBox(node)` (the override if present, else the raw `box`) for live nodes and
  skips `dropped` ones. No annotation-replay engine, no mid-pipeline re-projection;
  the raw measured `box` is preserved alongside the override (fidelity).
- **A Stitch is opaque to every pass.** It has no box (ADR 0006), so it is never a
  container, a subset, a fold target, a flatten target, or a crop candidate, and no
  pass ever descends through it. Stated once here instead of re-checked per pass.

### 4. Annotate-only; additive-only; Serialize is the sole projection

A pass **only sets fields** on IR nodes; it never deletes, merges, restructures, or
overwrites a prior annotation. Annotations **accumulate** and **compose**: one
pass makes a node the surviving bone, a later pass may `dropped` that same
survivor (Superset dropping a glyph-folded bar that landed inside a solid), and
`dropped` simply wins at projection. The closed annotation vocabulary, each with
its Serialize rule:

| Annotation         | Set by                                             | Serialize realizes it as                          |
| ------------------ | -------------------------------------------------- | ------------------------------------------------- |
| `dropped {reason}` | Superset, Crop, mark-ink, glyph-fold, apply-walker | omit the node **and its whole subtree**           |
| `count = N`        | Template (lossless)                                | expand the representative cell back to N          |
| `flattened`        | Flatten                                            | splice the node out, **hoist its kids** to parent |
| `folded {box,…}`   | glyph-fold                                         | replace the survivor with the synthetic bar       |
| size/dim override  | Template (median dims)                             | apply the override onto the surviving bone        |

`reason` covers `subset` / `orphaned` (Superset), `cropped` (Crop), `folded`
(glyph-fold: a glyph-sized icon absorbed into the adjacent synthetic bar),
`invisible` (mark-ink: `visibility:hidden` / `opacity ≤ ε`), `absorbed`
(mark-ink: a contrast surface's content reduced to one label; its kids are
lowered so it ships as one box), `collapsed` (mark-ink: the author/walker
declared this element one bone via `data-xr-bone-kind`; its measured subtree is
lowered so it renders as one childless bone of the declared kind), and
`ignored` (apply-walker: the programmable `captureWalker`'s `ctx.ignore()`
dropped this element and its subtree, measured then lowered). `ignored` is
WALKER-ONLY: the declarative `data-xr-ignore` Hint stays walk-time (the element
is never built into the IR), so it never produces a `dropped` reason.

**Serialize is the one place structure changes**, and it runs once, in the browser,
over the whole per-Plate bundle. It realizes every annotation above, then (folding in
ADR 0007) content-addresses the rules into shared classes and gates the Views
(ADR 0004). Its output is the shipped Plate, written **as close to the final
rendered HTML/CSS as re-renderability allows**: structured `{tree, css}`, not
frozen HTML, geometry-stripped, so the Bundle step can still rewrite it. The wins
are isolation (a pass is tested by feeding an IR and asserting the fields it set),
no tree-surgery bugs (structure changes in one place), and a single projection
point.

### 5. Measure is the only browser-coupled stage; classification is a pass

Measure (the walk) is the **sole code that touches the DOM**. It reads
`getComputedStyle` / `getBoundingClientRect` / `scrollWidth`·`scrollHeight` /
the colour canvas / `pretext` once per node, **resolves** the browser-only values
(colours → rgb, text → line dims), and **snapshots** them: each node carries its
geometry, its text ink, and a frozen **`LiteStyleDeclaration`**, a plain object
holding the bounded set of computed properties the passes read, expandable as
new passes need more. The IR carries no live `CSSStyleDeclaration`, so a pass
_cannot_ re-read the DOM; the decoupling is structural, not conventional, and
every pass is testable with a synthetic IR.

The only logic Measure keeps is the **structural skips it alone can honor**: a
Stitch boundary (it must stop; it cannot measure into another Plate),
`data-xr-ignore` (skip, so a discarded subtree is never paid for), and
`display:none` (no box to measure). Everything richer is a pass: paint-leaf /
bone-kind classification is **mark-ink** (making "ink-driven, not markup-driven"
literal, ADR 0021); `visibility:hidden` / `opacity` invisibility is a mark-ink
`dropped: 'invisible'` annotation; Salience, Run grouping, Absorb, Flatten,
Template, Superset, and Crop all run post-Measure over the snapshot.

## Considered alternatives

- **A single walk that pipes per-node plugins.** Rejected: it cannot serve
  non-local passes (Template, Superset), which need the whole tree first.
- **Destructive passes that mutate the IR in place** (the status quo). Rejected: it
  is the source of the tree-surgery bugs and order coupling; annotate-only with one
  Serialize confines structure change to a single, testable place.
- **Keep `cs` on the IR (or cast the live view as a narrow type) instead of copying.**
  Rejected: a pass reading a live `CSSStyleDeclaration` is still a DOM touch, stuck
  in-session and a footgun the moment a pass goes async or an IR is inspected after
  the capture. A frozen `LiteStyleDeclaration` copy is the only thing that makes
  "Measure is the sole DOM stage" literally true; the copy cost is dwarfed by the
  `getComputedStyle` flush already paid.
- **Keep the gen-side merge (two projections: capture-side `emit`, build-side
  `mergeViews`/`classify`).** Rejected: "one projection" can't straddle the commit
  boundary, and doing all the work in-session (where the bundle and geometry already
  are) is simpler and keeps geometry off the wire.
- **A forced-aligned per-Plate tree** (one tree, per-View geometry per node).
  Rejected: it reopens ADR 0004's unreliable cross-View tree-merge at the substrate.

## Consequences

- The pipeline reads: **Collect → Measure (the only DOM stage) → Distil
  (`PlateIR → PlateIR` passes, annotate-only, fixed order) → Serialize
  (in-browser, per-Plate, the sole projection) → Bundle.** Serialize writes the
  gated `StoredPlate` (`{tree, css}`) to `plates/`. **Bundle** is the gen-side
  step that adds host-coupled optimizations the self-contained Plate
  deliberately leaves room for (e.g. the opt-in Tailwind class passthrough),
  never stored in the committed Plate. The Serialize | Bundle seam is "as close
  to final as re-renderability allows."
- **Output is not byte-stable, by design.** Correctness is judged by the
  capture-path test, the dogfood golden, and visual QA (ADR 0021), never byte
  equality; the goldens are change-detectors, not gates.
- **Cross-View passes stay deferred** (cross-View dedup is low-leverage payload), but
  §2's per-Plate bundle is the built substrate, so adding one is a pass, not a
  restructure.
- **In code:** the bundle is `PlateIR`, projected by `serializePlateIR`;
  classification is the `markInk` + `applyWalker` passes; the frozen snapshot is
  `LiteStyleDeclaration`. The `pruneRuns` truncator of the pre-pipeline era is
  gone: off-screen extent is Crop's job, faithful counts are Template's.
- **Pass semantics**, in pipe order:
  - **Flatten** collapses passthrough / coincident wrapper chains, preserving
    author-CSS layout and the chain's accumulated spacing; it never crosses a
    Stitch (§3).
  - **Superset** drops a Bone whose box sits wholly inside a **solid** (`box` /
    media) Bone's box. Containment is a visual set union, so order / opacity /
    stacking are irrelevant. Only the superset must be solid (a paint-less /
    outline card keeps its content); the subset may be any kind, and a boxless
    `text-block` reflow bone stands in with its nearest box-bearing ancestor's
    box. Drops ~12% of nodes on overlay/feed-heavy views.
  - **Crop** drops Bones past the **fold** — the visible bottom/right of the
    nearest clipping context (a scrolling / `overflow`-clipping ancestor, or the
    viewport as the base case), buffered by `CROP_BUFFER` (the pass's only knob,
    applied on both axes) because the render-time fold is width-dependent — and
    folds in its orphan-prune. **No spacer** is emitted: below-fold / clipped
    content is off-screen and only in-viewport shifts score CLS, so the drop is
    layout-shift-free; a longer real body just grows the scroll. (LTR-first on
    the horizontal axis; RTL is a known limit.)
  - **Template** collapses a uniform sibling run to one modal cell + `count`
    behind a **clear-majority gate (≥ 2/3)**, so a minority variant cannot force
    a wrong shape on the run.
  - Serialize also drops **inert font/text declarations** before
    content-addressing (a bone paints no glyphs): 11 always-dead props go
    unconditionally, keeping `line-height` only as the inline-flow per-row pin
    and `font-size` only when the plate uses `em`/`ex`/`ch`. Lossless, and it
    merges rule-sets that differed only by a font decl.
  - Measure **eager-loads lazy images and awaits `decode()`** (bounded by the
    settle cap, ADR 0025) before snapshotting, so replaced elements carry their
    real box.
- **Every unbuilt rung of the lossy ladder is resolved.** The shipped stack
  above takes roughly a fifth to a quarter off raw/parse cost on typical
  content, ~⅓ on overlay/feed-heavy views, with brotli down high-single-digits.
  The unbuilt rungs, and why:
  - **Atomic CSS factoring: rejected.** Factoring shared declarations across
    the content-addressed rule-sets into atomic classes was measured and
    proved counterproductive: the factored output carries more entropy
    (repeated, and therefore highly compressible, rule text becomes long
    per-node class lists), so the gzip/brotli payloads _grew_. Recorded with
    ADR 0007's other rejected alternatives.
  - **Depth-LOD: shelved after an attempt was reverted.** Collapsing a deep
    subtree to a box at its footprint assumes "deep == fine detail," which fails
    on content-dense cards: an offering card's specs panel and its INVEST CTA
    are deep but important, and size gates (height, then area) cannot tell an
    unimportant overlay from an important CTA, since both are small.
    Footprint-preserving (no drift), but it kept mangling the most important
    card, and the net win after sparing the panels was modest. Revisit only
    with a Salience/contrast gate (spare high-contrast / CTA / surface
    content), which needs the contrast signal snapshotted onto the IR — the
    deferred mark-ink.
  - **Quantize: postponed.** Rounding sizes/spacing to amplify ADR 0007 dedup
    compounds the existing ~1px vertical-rhythm drift (coarse rounding
    accumulates down a column); a last resort.
  - **Sub-threshold ink drop: held.** Removing negligible bones is lossy
    (localized reflow) and needs a Salience gate before it is safe.
