---
status: accepted
---

# Plates are self-contained: the captured tree and its scoped CSS owe nothing to the consumer's build

A Plate is one serialized node tree; a single CSS string is captured alongside it (a sibling artifact, ADR 0026) and scoped to the skeleton root. The CSS carries the layout-relevant rules that apply to the subtree, including their `@media` queries, with paint stripped. Nodes reference those rules through plate-local identifiers that travel with the CSS, so rendering a Plate depends on nothing in the consumer's build.

Reusing the live class names (rendering with the real `className`s and resolving against the app's stylesheet) was rejected: it couples a dev-time capture to the build's CSS-module hashes, which can differ by mode and rehash on any CSS edit, collapsing committed plates. Carrying the CSS with the plate removes that coupling, and because the actual `@media` rules are lifted, CSS-driven responsive reflow reproduces natively at render time, with no fixed height and no absolute positioning.

Inlining per-node _computed_ styles instead would also be self-contained, but frozen: every CSS view would need its own capture. Carrying the rules avoids both the hash coupling and the per-view recapture.

The responsiveness CSS cannot carry (structure that JS decides per viewport) is handled per ADR 0004. Of the two capture-time extraction strategies — copy matching source rules vs. computed base plus media-query deltas — copy won a fidelity bake-off (ADR 0005).

**Refined by ADR 0006.** Self-containment holds at the module/import-graph level, not strictly per file: a plate may _reference_ child plates (at `<Skeleton>` stitches) through real imports the loader synthesizes. The renderable thing still depends on nothing in the consumer's build; it depends only, transitively, on other plates resolved the same way it is.

**Refined by ADR 0026.** The tree and the css are two independent artifacts rather than one css-carrying object: the `Plate` type is the tree only, and the scoped css string travels beside it (through Vite's CSS pipeline for plugin-imported plates, as an explicit sibling value elsewhere). Both artifacts originate from the capture and depend on nothing in the consumer's build.
