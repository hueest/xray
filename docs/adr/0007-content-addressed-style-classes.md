---
status: accepted
---

# Content-addressed style classes

> **Superseded in part by [ADR 0022](./0022-uniform-pass-pipeline.md):** the
> content-addressing decision here **stands**; ADR 0022 folds it into its single
> in-browser **Serialize** step (the `classify` pass). Only the _mechanism_
> moved: the separate gen-side merge-then-classify build step this ADR
> originally sketched no longer exists.

Id-scoped rules style every node individually:
`[data-xr-root="name"] [data-xr="name:1234"] { … }`. Measured on the
dogfood dashboard plate, that ships ~47 KB gzip, of which the **CSS string
is 78%** (the tree only 18%): 2,911 rules drawn from just **294 distinct
declaration bodies**, the scope-prefix repeated 9,666 times. The repetition is
the cost, and per-node id scoping forces it.

Styles are addressed **by content** instead: each distinct
`(cascade-rank, media, container, declarations)` body becomes **one** class,
emitted once as `[data-xr-root] .xr-<plate>-<n> { … }`, and a node carries the
list of class tokens it needs (replacing its `id`). Rules stay **unlayered**
and the cascade is reproduced by emission order (below). Measured on
the dashboard plate: **~47 → ~10 KB gzip (≈79%)**, with the class rules also
recalc-ing far cheaper than ~2,900 descendant-attribute selectors.

## The identifier: a per-plate sequential counter

The class name is a per-plate base36 counter (`xr-<plate>-0`, `xr-<plate>-1`,
…) handed out in cascade-emit order. Identity — what dedupes — is the content
key `(cascade-rank, media, container, declarations)`; the counter is only the
emitted _name_ for each distinct key.

The name was originally a truncated SHA-256 of the content, with a build-time
collision guard. Measured against the counter (2026-06-14 amendment), the
hash's randomness was a brotli floor — ~300 distinct 9-char hashes don't
compress, a low-entropy counter does — and switching won **−32% brotli / −39%
gzip** across the dogfood plates (the dashboard plate 6.7 → 4.5 KB brotli).
A counter needs only per-plate uniqueness, which it has by construction, so
the collision guard went with the hash.

What the counter costs: class names are not content-stable across edits. That
costs nothing here: the committed artifact is the _id-form_ plate JSON (class
names never reach git; classify runs at load), and a plate inlines into a JS
bundle that re-hashes on any change regardless. Assignment is fully
deterministic (emit order), so builds stay reproducible.

## Isolation lives in the token, not the selector

Class names are **namespaced by plate** (`xr-<plate>-…`), replacing `nodeKey`.
Two rejected variants show why:

- **Global content classes** (`xr-<hash>`) — "a collision is a
  match, so it's safe" is true for a single shared declaration but **false when
  an element carries several shared classes whose relative order matters**.
  Each plate ships its own self-contained CSS (ADR 0003), so a class shared by
  two plates (e.g. a global `img { height: auto }`) is re-emitted in a _later_
  block, re-asserting that declaration past an earlier plate's winning rule
  (this collapsed media leaves: a headshot's measured `height: 79.6px` lost to
  a sibling plate's later `height: auto`). Per-plate namespacing keeps every
  plate's classes disjoint, the same isolation `nodeKey` gave (ADR 0006), now
  carried in the token. Cross-plate dedup is deliberately given up (plates are
  separate modules, so it was never a shipped-size win).
- **Attribute-value scoping** (`[data-xr-root="name"] .x`, freeing the token of
  the prefix) — breaks nested skeletons. A stitch renders a child plate's root
  _inside_ the parent's (ADR 0006), so a child node is a descendant of _both_
  roots; `[data-xr-root="parent"] .x` reaches through the nested child root via
  the descendant combinator whenever the two plates share a token. Isolation
  must live in the token.

**The name→prefix map is injective.** The prefix is the whole isolation
boundary, so distinct plate names must never collide to one prefix. A name may
carry `/` (nested paths, ADR 0006), which is not class-safe; `encodePlateName`
(`classify.ts`) renders each `/` as `--` (`product/card → product--card`). For
that to stay injective, `isValidPlateName` (`name.ts`) **disallows a literal
`--`, doubled hyphens, and edge hyphens** inside a segment — without the ban,
`a/-b` and `a-/b` would both encode to `a---b` and fuse two plates' isolation
boundaries.

## Why NOT CSS `@layer` (considered, rejected)

Ordering rules with one `@layer` per cascade tier looks natural but carries
three hazards:

1. **Unlayered styles beat layered ones.** The host app's CSS is unlayered; a
   global reset (`* { box-sizing }`, `body div { … }`) would then override every
   layered skeleton rule. The scoped class selector (specificity `0,2,0`) wins
   on specificity instead; that moat must be kept.
2. **`@layer` inverts `!important`.** An `!important` in a lower layer beats one
   in a higher layer, so the view `display: none !important` gates could lose
   to an author `!important`, and gates breaking is a correctness regression.
3. **Layer order is per-document, shared across every injected style block.** A
   stitched page carries one CSS block per plate; reasoning about cross-block
   layer composition adds risk for no size benefit (layers don't shrink
   anything — an element still selects rules by class _name_).

So rules stay **unlayered** under the `[data-xr-root] .token` scope
(specificity `0,2,0`), the same moat id-scoped selectors had.

## Cascade correctness without layers

Every rule is flattened to one specificity and the cascade is reproduced by
**emission order** (losers first, winners last), sorted layered-first (a rule
captured inside `@layer` loses to unlayered ones, so it is emitted early),
then by `spec`, then source `order`; all classes are single-class at equal
specificity, so emission order decides. The requirement that makes this safe:
**the cascade rank is part of the class identity** — the key is
`(layered, spec, media, container, decls)`, not decls alone. A _fallback_
`display: flex` and an _author_ `display: flex` are different classes emitted
at their own positions, so a node never holds two classes whose relative order
is ambiguous. The rank is carried at full `spec`
resolution (`SPEC_FOLD = 'full'` in `classify.ts` — provably no intra-author
inversion; a discrete-tier fold that hashes marginally smaller sits behind the
same constant if size ever matters).

## Render-side scope; capture and plate format unchanged

Capture and the on-disk `plates/*.json` (id-form) are untouched. Classify,
inside Serialize (ADR 0022), computes each rule's class, adds the token to
every node in the rule's id list, emits each distinct class once (media-
wrapped, in cascade order), and strips `id` from the shipped tree; a shipped
node carries `cls` (its class tokens), and the render key is the array index
(the tree never reorders). The per-node `data-xr` attribute is **dropped**;
`data-xr-root` stays on the root (marks where a skeleton starts; also the dev
capture-time stitch marker), as does `data-xr-boundary`.

**The outermost view emits `BASE` first; nested stitches don't.** `BASE`
(`.xr-root`, `.xr-node`, `.xr-leaf`, plus `@property --xr-o` and `@keyframes
xr-pulse`) precedes that view's node rules, so a node's captured
`border-radius: 50%` beats the BASE `.xr-leaf` default by source order,
fixing the nested-stitch BASE-override bug (squares-not-circles) without
`@layer`. BASE must be emitted by the component so it lands in server-rendered
HTML; there is no dev "bootstrap" in production or SSR.
_Refined by [ADR 0026](./0026-two-artifact-css-via-vite-pipeline.md)_: for
plugin-imported plates, BASE and "once per page" are now the
`virtual:xray/base.css` module's identity (imported before each plate's own
`.css` module, preserving the same source-order win); the inline
outermost-only emission survives only on the explicit-`css` path for
runtime-captured plates.

## Framework-agnostic & SSR

The rendering model is deliberately portable: a node is "an element with a
`className` and children," plus the scoped CSS and a `data-xr-root` marker on
the root. That is what keeps per-framework adapters thin (the core + adapter
architecture is [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md)'s
record). The SSR contract every adapter honors: BASE ships in the
server-rendered HTML (see above); store reads expose a server snapshot equal
to the static prop plate, so hydration is clean; capture is a client effect,
never run on the server.

## Considered alternatives

- **Status quo (id-scoped rules).** Correct, but the size/recalc cost above and
  the `nodeKey` scoping burden.
- **Bare global sequential indices (`.c0`).** ~6 KB gzip (smaller still), but
  _position_-addressed with no plate prefix: reintroduces the cross-stitch leak
  and gives no scoping safety. The per-plate **prefixed** counter keeps the
  isolation and takes the compression win anyway.
- **CSS `@layer` per tier.** Rejected; see hazards above.
- **A per-plate dictionary for the tree's class refs** (small integers into a
  table). Measured and **not smaller**, 10.2 vs 9.8 KB: the class names must
  appear in the CSS regardless, and gzip already back-references the tree's
  copies against them; a dictionary merely lists them a third time.
- **Atomic per-property computed values.** Maximal dedup, but it is the
  `computed` strategy ADR 0005's bake-off rejected (frozen widths compose wrong,
  no responsiveness). Content-addressing is orthogonal to _which_ declarations
  are kept: whole author bodies are copied (ADR 0005 stands).
- **Atomic class factoring over the content-addressed rule-sets** — factor
  shared declarations into atomic classes, deduping partial overlaps across
  bodies. Measured and rejected: the factored output carries more entropy
  (repeated rule text, which gzip/brotli compress nearly for free, becomes long
  per-node class lists that don't), so the compressed payloads _grew_. Whole
  content-addressed bodies stay the unit of dedup. (Status of the related
  payload passes: ADR 0022's consequences.)
- **Open Shadow DOM per plate.** Encapsulation fights the within-plate sharing,
  doesn't touch intra-plate ordering, and complicates capture/inline layout.
  Open shadow DOM serves only the HUD, where encapsulation is the point.

## Consequences

- **Format break, no version bump (pre-public).** Capture is unchanged, so
  existing plate files re-render through the classify pass with no recapture.
- Classify owns the id→class→strip transform; the rule emitter emits classes.
- `nodeKey` and the per-node `data-xr` attribute are gone.
- Class assignment is deterministic (cascade-emit order) → reproducible
  builds; names are not content-stable across edits, which costs nothing (see
  the identifier section).
