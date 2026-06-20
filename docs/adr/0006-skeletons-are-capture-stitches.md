---
status: accepted
---

# Skeletons are capture stitches; parents reference child plates

A `<Skeleton>` boundary is a **stitch**: when one component's capture meets a nested `<Skeleton>` in the DOM, it does not descend into that subtree. It emits a `ref` node naming the child plate, and at render the stitch mounts the child's own skeleton (`<PlateView plate={child} />`). A parent plate is its own structure plus references to its children's plates, never a re-serialization of them.

## Why

Re-serializing a nested skeleton's subtree is wrong two ways. If the child has loaded real content, the parent duplicates structure the child already owns (and a 1.6 MB dashboard capture from the dogfood app showed how fast that balloons toward the size cap). If the child is still loading, the parent serializes the child's _bones_ — empty painted divs whose copied `border-radius` plus the media-leaf parent-expansion heuristic render as stretched ellipses ("eggs"). Either way the parent swallows something that isn't its own content.

Treating every `<Skeleton>` as a stitch fixes both: the parent stops at the boundary and the child is captured, edited, and hot-swapped entirely on its own. Capture size is bounded by composition rather than depth.

## Always a stitch (not opportunistic)

The boundary is marked deterministically: `<Content>`'s capture wrapper always carries `data-xr-boundary="<name>"`, and a child mid-loading shows `data-xr-root="<name>"`. The walk (`walkAll`, measure.ts) references either, so a stitch is emitted regardless of whether the child happens to be loaded at capture time — the dashboard plate _always_ references `news-feed` and `content-cards`, never sometimes-inlines-them. The accepted cost: a child never captured yet renders as a blank hole at its stitch until captured once (the HUD lists which plates exist).

## Resolution: a static import graph, no registry

A runtime registry (load every plate up front, look up by name) was rejected: it pulls the whole app's plates into any page that renders one skeleton. Instead the reference is a **relative import between plates**. The loader scans the plate's tree for `ref` nodes and emits a real `import` of each child's virtual module, wired into a `refs` map on the default export:

```js
import __xr0 from 'virtual:xray/plates/news-feed'
export default Object.assign({/* plate */}, { refs: { 'news-feed': __xr0 } })
```

The bundler builds the actual reference graph and chunks only the transitive closure a page uses. The plate JSON stores only the bare name (a `{ ref }` node); the import is synthesized at load. An unknown child resolves to its own empty plate — a blank stitch, never a build break. Self-references are dropped (a module cannot import itself).

This refines ADR 0003: a plate is still self-contained, but at the **module/import-graph** level rather than the single-file level. The renderable thing has no dependency on the consumer's build; it may depend on _other plates_, resolved the same way it itself is.

In dev the live store takes precedence over the static `refs` (so re-capturing a child hot-swaps it inside every parent), and `PlateView` seeds the store from its resolved `refs` on mount — so a stitch resolves before its child is re-captured and survives a parent hot-swap, whose pushed plate carries no resolved `refs`.

## One writer per plate name: the first in document order

A stitch turns a plate into a shared, reusable unit, so the same `<Skeleton plate={x}>` is often mounted many times at once (one `content-cards` per offering on the dashboard). Each mount is a capture site under the same name. If they all wrote, they'd race and overwrite each other's plate file, last-settled winning, non-deterministically and often on the least-representative instance (the `content-cards` circle vanished this way: a portrait-less offering captured last).

So for any plate name, exactly one site writes it: **the first in document order**. The rest still render the plate (read side, via the store/refs); they just don't capture. The rejected alternatives:

- _Last-settled_ is the race above: which offering's async cards finish last is arbitrary.
- _First-registered_ is timing-dependent too: mount order doesn't track visual order under batched fetching and intersection observers.

Document order is the only choice that is both deterministic across reloads and usually the above-the-fold, most-representative instance. Primacy is checked before settling (non-writers bail immediately) and again after (an earlier twin may have mounted during the delay); when the writer unmounts, its twins re-attempt so the new first-in-DOM takes over. The trade-off: a single shared plate can only resemble one instance's content, so when instances vary a lot (different card sets per offering) the skeleton matches whichever the first one happens to be.

## Costs accepted

- A blank hole at an uncaptured stitch until the child is captured once.
- `BASE_CSS` is emitted by the outermost view only, never by a nested stitch. Its selectors are the fixed base classes (`.xr-root`/`.xr-node`/`.xr-leaf`, ADR 0007) and match every node at any depth, so one copy suffices. A nested copy would be worse than redundant: landing later in document order at equal specificity, it would override an ancestor plate's own scoped leaf rules (this regressed `border-radius: 50%` avatars to the BASE `4px`, rendering circles as squares). _Refined by ADR 0026_: for plugin-imported plates, BASE and "once per page" are the `virtual:xray/base.css` module's identity; the inline outermost-only emission (the `nested` flag) survives only on the explicit-`css` path for runtime-captured plates.
- Reference cycles are not guarded beyond dropping self-references; ESM tolerates them via live bindings, and refs are read at React render time (post-eval). Skeleton graphs are not expected to cycle.
