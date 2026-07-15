---
status: accepted
---

# Serialize folds identical adjacent Views, stores captured spans, and the sweep captures absence

> **Extends [ADR 0022](./0022-uniform-pass-pipeline.md) §5 (the multi-View gate)
> with a fold at the projection step; keeps
> [ADR 0004](./0004-dynamic-breakpoint-derivation.md) (spans align to band boundaries)
> intact — the pruned breakpoint set still partitions the axis, just at the
> thresholds that matter.**

A plate's detected breakpoints arrive as a page-level union: the matchMedia spy
is page-global by construction (a JS query cannot be attributed to a
component), and shared grid systems put the same `@media` thresholds in many
components' lifted rules. So every plate captured in a session tends to carry
the page's full breakpoint set — and the sweep, correctly thorough, captures a
View in every band. A component that does not change across neighboring bands
then ships byte-identical islands with gate boundaries no viewer can observe.
The degenerate case is a CSS-hidden-below-XL component: four empty islands and
a fifth with the content, reported as "5 views" when its real responsive
behavior is one threshold.

## Decision

### 1. The fold, adjacency-required

At `serializePlateIR`, after projecting each View to id-form, compare Views by
an id-normalized signature — ids renumbered from 1 in walk order, capture
width excluded — and merge each identical run of ADJACENT bands into one
island spanning the run. Adjacency is required: two identical Views separated
by an unswept band prove nothing about the middle and must not merge across
it. The stored `breakpoints` drop only the boundaries INSIDE folded runs — the
thresholds proven to separate nothing. An all-identical plate stores a single
ungated View with no breakpoints; a genuinely single-View capture keeps its
detected breakpoints (its other bands are unswept, not proven identical — the
HUD shows them as gaps to fill).

### 2. Stored spans: coverage stops assuming

`StoredPlate` gains `spans` — each surviving island's captured range.
`readCoverage` used to derive complete spans from the breakpoints ("a
StoredPlate sweeps all widths in one session"), an assumption browse sessions
broke: a single-width write read as fully covered. Coverage now reads the
stored spans; a legacy plate without the field keeps the historical
assumption until a re-capture writes the truth. Rendering stays gapless (an
island extends to the next island's start — a render policy, not a coverage
claim).

### 3. Captured absence

Absence at a width is knowledge, not a skip — in BOTH of its forms. A capture
that finds the boundary mounted with ZERO content roots (the component
rendered null at this width) records an EMPTY View directly. And when the
sweep visits a width where a session-known plate is observed UNMOUNTED (the
`<Skeleton>` itself gone), the client records the same EMPTY View for that
band —
including backfill for a plate that first appears mid-sweep, gated on
per-width mount observations so a mounted-but-refused capture never reads as
absence. Manual and sweep recording share ONE observation engine — the only
difference is who visits the widths (your resizes vs the extension's
emulation). Every visited width (engage, resize, emulated pass) snapshots the
mounted names — PRESENCE ∪ capture sites, so a Skeleton showing its loading
skeleton is mounted, never absent — and reconciliation gives every covered,
buffered, seen-on-this-page name an empty View at each observed width where
it was not mounted, with backfill for plates that first appear later. The
pathname guard protects navigation: session buffers survive page changes by
design, so a page change resets the observations and re-seeds from what is
live. Per-name recording is symmetric under FULL
automation (ADR 0027 §2): a manual key-on records until its key-off writes; a
key-on with the extension sweeps the scope and presses its own key-off — the
same off path, automated. The empties are identical and adjacent, so the fold ships them as
one empty island gated to the absent range: the skeleton renders the faithful
nothing there (instead of the nearest captured layout bleeding in), coverage
reads the band as captured, and the plate's one REAL threshold — the mount
boundary, which no stylesheet inspection can discover — survives as its only
breakpoint.

Measured geometry rides in the rule decls, so Views that measured differently
never compare equal; leaf geometry is emitted relatively where the layout is
fluid, so a fluid component whose bands render identically IS identical — the
fold expressing that is the point, not a loss. Structural response (a
matchMedia-driven render adding nodes) and computed differences (an `@media`
padding applying) keep their bands.

Coverage reads straight out: spans derive from the stored breakpoints, so a
folded plate reports the views it actually has, and the HUD segments show each
component's own responsive behavior instead of the page's grid.

## Considered alternatives

- **Fold at capture (skip identical re-captures)**: rejected — identity is
  only knowable after Distil + projection, and the sweep must still LOOK at
  every band to prove identity.
- **Attribute matchMedia queries to components** to avoid the union: not
  possible; a JS query has no component scope.

## Consequences

- Stored plates shrink wherever bands were indistinguishable; the gate rules
  drop with the islands.
- A JS-conditional component's plate converges to its true shape in one
  sweep: empty island below the mount boundary, content above, complete
  spans — where it previously stored one gapless view that painted its wide
  layout at every width and coverage called five views.
- Test harnesses without real layout must make per-width Views genuinely
  differ (structural response), or the fold rightly collapses them —
  happy-dom captures identical geometry at every width.
