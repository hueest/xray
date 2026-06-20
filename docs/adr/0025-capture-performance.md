---
status: accepted
---

# Capture performance: coalesce duplicate triggers, memo computed style within one capture

> **Builds on [ADR 0022](./0022-uniform-pass-pipeline.md) §4–§5 (Measure is the
> only DOM stage; the live `cs` never outlives the capture) and complements its
> generation guard; keeps [ADR 0005](./0005-css-extraction-copies-author-rules.md)
> (CSS extraction copies author rules) and [ADR 0010](./0010-capture-all-views-via-extension.md)
> (capture-all-views) intact.**

The capture hot path is `settle → walk DOM → getComputedStyle per node → build a
CSS rule index → selector-match → Serialize → post`. Capture-all multiplies it by
mounted sites × emulated widths, and mount, resize, the Capture toggle, and the
sweep's own emulated resizes can stack duplicate work before the post-projection
dedupe ever runs. Two costs are separable: doing the same capture _twice_ (a
scheduling problem) and doing each capture _expensively_ (re-reading the same
computed style, re-deriving DOM-independent selector data). The fix targets both,
but avoiding work is worth more than optimizing it.

## Decision

### 1. Coalesce duplicate triggers; one capture in flight per site

A trigger arriving while a site's capture is still settling does **not** start a
parallel settle+walk. `scheduleCapture` marks the site `dirty` and merges in the
**strongest** requested flag (`dirtyForce`), so a forced capture-all trigger is
never downgraded by an overlapping browse trigger. When the
in-flight capture finishes, a drain loop runs **at most one** follow-up against the
latest DOM/viewport state, to a fixpoint. The loop clears the `inflight` slot and
re-reads `dirty` in the **same synchronous turn** (no await between), so a
coalescing trigger lands in exactly one of two safe places, before the check (it
iterates again with merged flags) or after the clear (it starts a fresh loop),
closing the microtask-gap race where a follow-up is silently dropped. The returned
promise resolves only once the site is quiescent, so an awaiting capture-all keeps
full backpressure.

### 2. A generation token guards against stale writes

`captureGeneration` is bumped on every event that invalidates an in-flight capture:
an emulated-width change (the sweep's canonical invalidation), site disposal, and
client uninstall. A capture snapshots the token _before_ settling, measures into a
**local, fresh 1-View `PlateIR`**, and re-checks the token after settle. If it
moved, the View is **discarded, never spliced** into the shared session bundle.
This is structural, not advisory: because `captureView` mutates the bundle in place,
appending a stale View — one width's geometry under another's Gate — would
corrupt the whole Plate's projection with no possible rollback. Capturing locally
first and gating the splice is the only sound order (`captureLocalView`).

### 3. Reuse computed style only within one synchronous capture; never across time

`StyleCache` is a per-capture `WeakMap<Element, CSSStyleDeclaration>` (`style-cache.ts`)
constructed once in `measureBundle` and threaded through `WalkState`. The walk reads
each node's own style through it; the ancestor-climbing helpers (contrast / nearest
painted background, context base font-size, inline-flow checks) memoize the parents
they climb; and `copyRules` resolves each matched selector's decls against the
**same** memoized live view the walk snapshotted from, instead of a second
`getComputedStyle`. The cache lives exactly as long as the one synchronous capture
that built it, then is dropped.

A `CSSStyleDeclaration` is a **live view**, not a snapshot: a stored one silently
goes stale the instant layout changes. So the memo is **forbidden** from outliving a
single capture — never cached across captures or time. This is the same footgun ADR
0022 §5 forecloses for the IR by snapshotting into a frozen `LiteStyleDeclaration`;
this ADR governs the live `cs` _during_ Measure, before that snapshot exists. The
two are complementary: §5 guarantees no _pass_ touches the DOM; this guarantees
Measure itself reads each element's live style at most once.

### 4. Split the rule index into an immutable selector index and per-capture match state

`copyRules` flattens the author stylesheets once (`collectStyleRules`) and builds a
`RuleIndex`: a browser-style hash bucketing each `Selector` by id / class / tag /
universal. A `Selector` holds **only DOM-independent data** — the live `CSSStyleRule`
(read for `.style` / `.selectorText`, never mutated), its conditions, layer, spec,
and source order. Nothing on it depends on which DOM is being matched, so a
`RuleIndex` is structurally **safe to build once and reuse** when the stylesheets are
unchanged. The per-capture results — matched ids, lazily-resolved `decls`, the
computed-style reader they resolved against — live in a separate `SelectorMatch`
keyed by `Selector` identity, **never written onto the `Selector`**, so a shared or
concurrent index can never cross-write.

### 5. Cache conservatively: fidelity beats a stale-cache win

The structural split (§4) is the prerequisite for caching the immutable index across
mounted sites during a capture-all pass, but the cache itself is **not built**; the
index is rebuilt per capture. A cross-capture cache demands an honest
stylesheet-signature + invalidation story (DOM `<style>`/`<link>` mutations, adopted
stylesheet identity/count, and Vite CSS HMR mutating CSSOM via `insertRule()` with no
DOM mutation). A stale index silently misattributes styles, a fidelity bug, the one
class of regression this project refuses. Until that invalidation is proven, the
split stands and the rebuild stays.

## Considered alternatives

- **Optimize repeated work before avoiding it.** Rejected, coalescing comes first:
  not running a redundant settle+walk dominates any saving inside one.
- **Keep capturing into the shared session bundle, roll back stale Views.** Rejected:
  `captureView` mutates in place and there is no rollback once a View is spliced.
  Capturing locally and gating the splice on the generation re-check is the only
  sound order.
- **Cache the computed style across captures.** Rejected: a `CSSStyleDeclaration` is
  a live view that goes stale; a cross-capture memo is a correctness bug, not a perf
  win. The memo is scoped to one synchronous capture by construction.
- **Build the cross-site stylesheet-index cache immediately.** Deferred: the
  immutable/per-capture split makes it _possible_, but the index rebuild is cheap
  relative to the `getComputedStyle` flush, and a cache without proven invalidation
  (CSS HMR `insertRule`, adopted sheets) risks a stale-style fidelity bug. Ship the
  split; gate the cache on its invalidation hook.
- **Drive resize/sweep re-captures off a generation bump too.** Rejected for genuine
  viewport resizes: stacked resizes coalesce to one follow-up at the latest width, so
  a capture settling at the old width simply re-dedupes or is superseded. The
  generation token is reserved for the sweep's _emulated_ width changes, disposal, and
  uninstall — the events with no later trigger to supersede them.

## Consequences

- `client.ts` carries a per-site scheduler (`scheduleCapture`'s drain loop, the
  `dirty`/`dirtyForce` state) and a `captureGeneration` token bumped
  on width-change / disposal / uninstall; `captureLocalView` measures into a local
  1-View IR and re-checks the token before any splice or post.
- `StyleCache` (`style-cache.ts`) is the single per-capture computed-style memo, owned
  by `measureBundle` and threaded through `WalkState`; the walk, the ancestor helpers,
  and `copyRules` all read through it, eliminating the duplicate `getComputedStyle`
  reads. It is never persisted past one capture.
- `css-extract.ts` carries the immutable `RuleIndex` / `Selector` (DOM-independent)
  vs per-capture `SelectorMatch` (ids, lazy `decls`, the resolving reader) split.
  Output is byte-identical to the pre-split single-list sweep (the bucket emission
  order is preserved).
- The cross-capture index cache and its stylesheet-signature invalidation remain the
  one deferred piece, blocked on an honest invalidation hook rather than missing
  effort.
