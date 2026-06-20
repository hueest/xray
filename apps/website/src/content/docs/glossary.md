---
title: Glossary
description: Every xray term defined, with the words each one replaces.
---

xray captures the real rendered DOM of components as the developer browses the
dev server, and renders faithful skeleton loading states from those captures.
This glossary keeps the rendered thing and the stored thing from ever sharing a
word. Decision records behind the terms live in
[`docs/adr`](https://github.com/hueest/xray/tree/main/docs/adr).

### Absorb

The only non-text merge: a painted surface (a box with a contrast-bearing fill, border, or shadow) whose content reduces to a single Run and nothing else renders as one box Bone, subsuming that label. A second distinct shape inside, or any replaced media, makes it a container instead: draw the parts, keep the surface as a frame. See ADR 0021.
_Avoid_: subsume, swallow, collapse, flatten

### Annotation

A field a Distil pass sets on a Light-DOM node (`dropped {reason}`, `count`, `flattened`, `folded`, a size override), never deleting, merging, or overwriting a prior one. Annotations accumulate and compose; Serialize realizes each. The vocabulary is closed (ADR 0022's table).
_Avoid_: hint (the author's DOM attribute), mutation, patch

### Bake

The build-time lowering of a committed plate into its importer's chunk: the virtual module reads `plates/<name>.json` and emits the tree-only default export plus its css imports (ADR 0026), per-chunk, with no global registry. The concrete work of the Bundle seam.
_Avoid_: bundle (the seam; Bake is the module emission), inline

### Blink

The one-shot dev visual confirming a capture landed and changed the stored result: a sharp negative invert (an x-ray is a negative) framed by a soft shadow ring over the captured element's box; reduced-motion drops the invert and keeps only the ring pulse. Dev-only.
_Avoid_: flash (reads as content flashing / FOUC), exposure, blip

### Bone

A single placeholder shape inside a Skeleton, one of five kinds (ADR 0021): a **box** (a rounded rect whose radius is carried from the author CSS, so circles and pills fall out), a **text-line** bar, a **text-block**, **media** (replaced content, with its own radius token), or **hidden** (explicit-only via a Hint or Walker decision, never inferred: holds its measured box, paints nothing — the space-preserving complement to `data-xr-ignore`). The on-screen paint of a Plate's Leaf; the pieces the `--xr-bone-*` tokens style. A Skeleton is composed of Bones but is never itself called "bones."
_Avoid_: leaf (that's the structural node), chip, block (alone; `text-block` is a kind), text (alone; the kind is `text-line`)

### Bundle

The gen-side (build-time) step that adds host-coupled optimizations the self-contained Plate deliberately leaves room for (e.g. the opt-in Tailwind class passthrough) without storing them in the committed Plate. The Serialize | Bundle seam is "as close to final as re-renderability allows": Serialize writes the framework-agnostic Plate; Bundle couples it to the host app.
_Avoid_: build, pack, emit

### Capture

The dev-time act of serializing a live component's rendered subtree into a Plate, triggered by browsing. A Plate's name comes from its virtual-module specifier (`virtual:xray/plates/<name>`) and travels with the imported Plate; it is never typed at a call site.
_Avoid_: expose, snapshot, crawl, scan

### Chunk

The shipped render unit a Plate's tree is lowered to at the ship boundary (ADR 0008): pre-serialized HTML string runs, with a mount point per Stitch, so an adapter injects strings instead of walking a tree and no per-framework serializer reaches the client.
_Avoid_: fragment, block, node (the tree form Chunks are lowered from)

### Classify

The content-addressing transform inside Serialize (ADR 0007): each distinct (cascade-rank, media, declarations) body becomes one per-plate class emitted once in cascade order, and nodes trade their ids for class tokens. Distinct from Mark-ink, which classifies what a node _paints_.
_Avoid_: hash (the names are sequential), dedup (the effect, not the act)

### Collect

The stage before Measure that decides what enters a capture: which elements are roots, where the walk stops (a nested `<Skeleton>` becomes a Stitch, never walked into), and the size limits (breadth, depth, node count) past which a capture is refused rather than truncated. Owned by the orchestration, not a pass (ADR 0022).
_Avoid_: walk, gather, cap (the limits refuse, they don't trim)

### Continuation

A standalone Skeleton that replaces a Stitch a still-showing parent was just rendering. Because it was continuously on screen, it Reveals instantly (no delay, no fade) instead of re-paying the grace delay. Detected by a loading-keyed live-stitch registry, never wall-clock time (ADR 0020).
_Avoid_: handoff, remount, resume

### Coverage

Which of a Plate's width bands hold a captured View and which are missing — the HUD's per-plate readout, sourced from the committed plate files. Filling Coverage is the point of browsing and resizing with a capture session on.
_Avoid_: completeness, progress

### Crop

The pass that drops every Bone past the **fold** (the visible bottom/right edge of its nearest scrolling or clipping ancestor, or the viewport as the base case) on both axes, per View. No spacer is reserved: content past the fold is off-screen and costs no layout shift; a longer real body simply grows the scroll. Position against the fold, so distinct from Superset (overlap) and Flatten (chains). See ADR 0022.
_Avoid_: fold (the op is "Crop"; "fold" collides with Glyph-fold), clip, truncate, defer

### Diagnostic

A dev-only record of a silent capture degradation (an unreadable cross-origin stylesheet, a skipped pseudo-class, a refused subtree), collected during capture and distillation and logged as one "captured with reduced Fidelity" report (ADR 0024). It rides transient channels only; not a byte reaches the committed Plate or production.
_Avoid_: warning (the log form, not the record), error, telemetry

### Distil

The stage between Measure and Serialize: a fixed pipe of annotate-only passes (the walker, mark-ink, glyph-fold, Flatten, Superset, Crop, Template) that pares the measured Light-DOM down to what a viewer perceives. Invisible, covered, and off-screen content drops; what reads as one shape folds into one Bone. Lossy by design and, Template aside, never mutating: every other pass only annotates, and Serialize realizes the annotations; Template alone collapses a run's cells in place and writes the count. See ADR 0022.
_Avoid_: reduce/reduction, optimize, minify, shrink, compress (Template's own job)

### Fidelity

How faithfully a Skeleton reads as the component it stands in for — layout, shape, rhythm — at a glance. The axis every capture decision and Distil pass is weighed on, against payload size; judged by eye in the live app, never by byte-equality.
_Avoid_: accuracy, quality, pixel-perfection (the standard is glance-level reading, not pixel identity)

### Fixture

Stored render-_input_ data for a `<Skeleton>`: the `data` that produced a captured Plate, serialized (dev-only) to a sidecar (`plates/<name>.fixture.json`) so a skeleton can be captured from hard-to-reproduce or deliberately frozen state. A Fixture is the input; a Plate is the output. One width-independent Fixture per Plate. Never exists in the production bundle.
_Avoid_: mock, stub, snapshot, "captured fixture" (capture is reserved for Plates)

### Flatten

The pass that collapses a geometry-redundant node chain (a passthrough wrapper whose box is coincident with its child, or an ancestor that only adds spacing), preserving the chain's accumulated spacing. Layout- and responsive-preserving; never crosses a Stitch. Distinct from Absorb (perceptual) and Template (compression). See ADR 0022.
_Avoid_: prune, contract, collapse, fuse

### Gate

The `@media display:none` rule that confines a View's island (its Projection) to the width range it owns (ADR 0004). Serialize attaches the gates; at render the browser's media engine turns exactly one View on, with no JS.
_Avoid_: breakpoint (the derived width; the Gate is the rule), guard, switch

### Glyph-fold

The test, and the pass that applies it, deciding whether an inline mark (icon-sized replaced media, an inline-block) _reads as a letter_: sized within the surrounding text's height and spaced within a word gap. A mark that passes folds into the adjacent Run's ink and ships as part of the text bar; one that fails stays its own box Bone. One of Salience's two jobs (ADR 0021); Serialize realizes the folded bars.
_Avoid_: fold (alone; collides with Crop's fold), inline-merge, icon test

### Hint

A declarative capture-customization attribute the author writes on the DOM: `data-xr-ignore` (drop this subtree, space included) or `data-xr-bone-kind` (collapse it to one Bone of that kind, `hidden` included). Capture-only, never a Plate concept. `data-xr-ignore` acts at Collect — the subtree is never measured, so no Walker or Distil pass ever sees it; the Walker outranks every Hint it can see (`data-xr-bone-kind`); neither crosses a Stitch (ADR 0018).
_Avoid_: annotation (a pass-set IR field), directive, attribute (the mechanism, not the concept)

### Hot-swap

The dev act of updating a mounted Skeleton the moment a capture lands, with no reload: the tree-only plate arrives through the dev store (the ws announce), the css over CSS-HMR (ADR 0026). Never re-fires capture.
_Avoid_: live reload, HMR (the css half's channel, not the whole act)

### HUD

The opt-in dev toolbar: per-plate Coverage, the capture-session toggle, Light Box, and the capture-all control. Lives in its own shadow DOM; dev-only, never ships.
_Avoid_: toolbar, overlay, devtools

### Ink

What an element actually paints, as opposed to its bounding box. For text this is the real glyph rectangles (from Range/pretext), which a stretched or shrink-wrapped box routinely misreports. Grouping reads ink, not boxes: a flex-stretched label's box is full-width while its ink is not. See ADR 0021.
_Avoid_: paint, pixels, glyphs, extent

### Leaf

A terminal node in a Plate's tree, one with no children, which renders as a Bone. Non-terminal nodes are branches: containers that preserve layout and are not painted. The structural counterpart to a Bone.
_Avoid_: bone (that's the rendered piece), node

### Light Box

The dev-only mode (HUD/console toggle) that forces every `<Skeleton>` to render in place of its content so the skeletons can be inspected, like holding the plates up to the light. Never ships to production.
_Avoid_: preview, force, view box, x-ray vision

### Light-DOM (the IR)

The in-memory tree Capture builds and then distils, mirroring the rendered structure, each node carrying its geometry, text ink, and a frozen snapshot of the computed style it needs. Measure is the only stage that touches the browser; every Distil pass only _annotates_ it, and Serialize projects the annotated tree into the shipped Plate. Its geometry is analysis-only and never shipped. See ADR 0021 / 0022.
_Avoid_: AST, virtual DOM, shadow tree, snapshot

### Mark-ink

The pass that classifies what each node paints (glyph ink, replaced media, a painted surface, an invisible element, or a transparent wrapper) and the Bone kind that follows, reading only the Light-DOM snapshot: grouping is ink-driven, not markup-driven (ADR 0021).
_Avoid_: classify, paint, detect

### Measure

The one stage of Capture that touches the browser: it reads each node's geometry, text ink, and computed style once and freezes them onto the Light-DOM, resolving the browser-only values so no later pass needs the DOM. See ADR 0022.
_Avoid_: walk, build, read, capture (Capture is the whole act)

### Plate

The serialized structural capture of a component's rendered DOM, the data a Skeleton renders from — like an x-ray plate, the recorded image rather than the live body. The Plate is the tree only; the scoped CSS captured with it travels beside it as an independent sibling artifact (ADR 0026). Imported per-component via `virtual:xray/plates/<name>` and passed in as the `plate` prop; committed to the `plates/` directory and lowered to render chunks at build time. A Plate may reference child Plates at its stitches; those resolve through the static import graph (and the dev store), never from a global runtime registry.
_Avoid_: cast, skull, snapshot, tree, orchard

### Projection

One View's entire tree serialized as a single gated island inside the Plate — the serialized form of a View, the way one radiographic projection is one whole image. Structural divergence across widths is carried by whole-View duplication, one island per View; a divergent subtree is never gated on its own inside a shared tree (ADR 0004). CSS-driven responsiveness is carried in the captured CSS (the Plate's sibling artifact, ADR 0026).
_Avoid_: fork, variant, breakpoint

### Readiness

The single condition that flips a `<Skeleton>` from skeleton to content and, in dev, the only capture trigger (ADR 0002). Composed from the `loading` prop and suspension; there is no separate "capture now" signal, so what is ready on screen is exactly what gets captured.
_Avoid_: loaded, done, ready-state, capture trigger

### Record

The dev-time act of writing a `<Skeleton>`'s current `data` to its Fixture. Distinct from Capture: Record stores render _input_; Capture stores rendered _DOM_.
_Avoid_: capture, save, snapshot

### Replay

The dev-time act of feeding a Fixture's data into a `<Skeleton>`'s render prop in place of live data, so the resulting Plate reflects the recorded state. The data source swaps; the single capture trigger (readiness, ADR 0002) does not.
_Avoid_: mock, restore, capture

### Reveal

The skeleton→content swap and the timing that governs it (ADR 0016): a grace delay before the skeleton is ever shown (resolve inside it and no skeleton appears), a minimum visible duration once shown (no flicker), and the swap fade, all driven by the `--xr-skeleton-*` tokens. The delay and fade are pure CSS at render; the minimum visible duration is the one part CSS cannot express, enforced by the adapter's timing hook reading the same token.
_Avoid_: swap, unveil, transition (the fade is one part of it)

### Run

The grouping atom: the glyph ink of a single inline formatting context (the inline content of one block box), plus any inline replaced-media that reads as a glyph (text-height, within a space). A run whose ink spans two or more baselines renders as a text-block; a single baseline, a text-line. Runs never merge across block boxes, so two stacked labels stay two Bones while a wrapped paragraph stays one (ADR 0021).
_Avoid_: line, span, fragment, chunk

### Salience

A node's _visual relevance_, scored from measurable visual signals only (contrast, spacing, size, type-scale), never from rasterized pixels, computer vision, or semantic markup — a `<button>` says nothing about how it looks. Its two jobs: the Glyph-fold test and surface detection (ADR 0021).
_Avoid_: importance, priority, weight, attention

### Serialize

The single step that projects the fully-annotated Light-DOM into the shipped Plate, the one place structure changes: dropped nodes fall out, Template counts expand, flattened wrappers splice, folded bars realize; then the rules are content-addressed (ADR 0007) and the Views gated (ADR 0004). Runs in the browser over the whole per-Plate bundle and writes a Plate as close to the final rendered HTML/CSS as re-renderability allows. See ADR 0022.
_Avoid_: project, projection (reserved for the View-divergence sense), emit, lower, merge

### Settle

The quiescence wait between readiness and Capture: fonts ready, lazy images decoded, a quiet `ResizeObserver`, plus the configured delay, bounded by the settle cap so a busy subtree is eventually captured anyway (ADR 0025). Settle decides when the final rendering is on screen, not whether to capture.
_Avoid_: debounce, wait, stabilize, idle

### Site

One mounted `<Skeleton>` as a capture location: the boundary element plus its plate name. Capture coalesces per Site (one in flight, ADR 0025), and the per-site overrides attach here: settle delay, Walker, Collect limits.
_Avoid_: instance, component, boundary (the Stitch edge)

### Skeleton

The placeholder rendered in place of a component while its data loads, and the `<Skeleton>` component that renders it. Always the runtime, on-screen thing, never the stored data.
_Avoid_: ghost, placeholder, loader

### Stitch

A point in a Plate where a nested `<Skeleton>` boundary was met during capture. Instead of serializing the child's subtree, the parent records a `ref` to the child Plate by name and stitches it in at render, the way a stitched radiograph joins separate plates. Every `<Skeleton>` boundary is a stitch (ADR 0006): the unit of capture, edit, and hot-swap.
_Avoid_: seam, reference, link, include, slot

### Superset

The pass that drops a Bone whose box sits wholly inside a **solid** Bone's box: the enclosing Bone paints the same area, so the two render as one (an overlay caption over a thumbnail, stacked panels). Only the enclosing Bone must be solid; the dropped **subset** may be any kind. Decided by geometry between Bones, never by nesting. Distinct from Flatten (redundant chains) and Absorb (a surface swallowing its single-Run label). See ADR 0022.
_Avoid_: cull, contain, cover, occlude, eclipse, nest

### Sweep

The capture-all act (ADR 0010): one dev session drives the viewport through every discovered width band, via the extension's emulation, capturing each View of every mounted Plate into its per-Plate bundle. The same DOM persists across a Plate's View captures, so the whole bundle is built in one session.
_Avoid_: crawl, scan, resize loop, capture-all (the feature; Sweep is the act)

### Template

The last pass, a lossless compression: collapse a run of consecutive, structurally-similar sibling cells (a grid/feed) into one representative cell carrying a count, expanded back at render. Running last, it compresses only what survives the removal passes (the on-screen Bones left after Crop, never the raw DOM count), and it never templates across a Stitch. See ADR 0022.
_Avoid_: cap, truncate, prune, dedup, repeat

### View

A viewport-width band whose structure a capture targets (e.g. mobile, tablet, desktop) — a radiographic view of the same body. Each View is captured on its own and carried whole in the one Plate, gated to the width range it owns; Views are never merged into a single tree (ADR 0004).
_Avoid_: regime, breakpoint, variant

### Walker

The programmable capture-customization hook (ADR 0018): it inspects each non-boundary element top-down and decides to drop the subtree, collapse it to one Bone, or defer to the default classifier. It exposes helpers rather than raw Plate nodes, shapes the capture without becoming a Plate concept, and never crosses a Stitch.
_Avoid_: visitor, plugin, override, transformer
