---
status: accepted
---

# Per-view plates, gated by @media (supersedes the merged-tree model)

A skeleton must adapt to viewport: structure and styling differ across
breakpoints (a stacked mobile column vs a desktop grid, `matchMedia` choosing
which subtree to render). xray captures one **view** per viewport range and
renders the one that matches.

**Breakpoint derivation.** Candidate breakpoints are derived per-plate from the
subtree's own `@media` width rules plus the `matchMedia` queries intercepted
during capture; there is no static breakpoints config. They partition the width
axis into views; a capture is filed under the view its width lands in (see
`breakpoints.ts` — `deriveBreakpoints`/`viewSpanFor`).

**Composition: keep each view whole, don't merge the trees.** Each captured
view renders as its own subtree with its own ids and rules, shown only across
the contiguous viewport range it owns via `@media display:none` gates on its
root nodes. A single-view plate renders verbatim.

The superseded first design merged all views into one tree, sharing
structurally-common nodes and forking the rest with `display:none`. It failed:
aligning two genuinely-different DOM trees (mobile stacked vs desktop
two-column) without stable keys is unreliable. Three alignment heuristics
(shape-similarity, exact-signature, position) each mis-paired nodes and
remapped one view's rules onto another's elements — ~120 node mismatches on a
real banner where a single capture had zero. A lone capture is faithful, so
each view stays lone.

The trade-off is size: the plate holds roughly the sum of its views rather
than a deduplicated union, bounded by the plates size cap. That buys
correctness, which the merge never reliably delivered. Sharing common structure
is a possible future optimization only if made provably non-corrupting (a real
keyed tree-diff), not a heuristic.
