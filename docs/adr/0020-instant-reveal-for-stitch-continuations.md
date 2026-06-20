---
status: accepted
---

# Instant reveal for stitch continuations

> **Amends ADR 0016** (skeleton display timing). The reveal delay and the pure-CSS
> `--xr-reveal` channel are unchanged; this ADR adds one exception to _when_ the
> delay applies. It also further uses the prod-hooks relaxation ADR 0016 opened.

A nested skeleton (ADR 0006) renders its child as a **Stitch**: while the parent
`<Skeleton>` is loading, its captured Plate references the child by name, the
stitched child injects no css of its own (ADR 0026; BASE is once-per-page by
module identity), and it **inherits** the parent's `--xr-reveal` channel. Parent
and child bones fade in together on the parent's single delayed reveal.

The bug sits at the seam where the parent resolves. When the parent flips
`loading=false` and renders real content, a descendant component renders its own
standalone `<Skeleton plate={child} loading>`. That is a brand-new **outermost**
skeleton: BASE's delay-hide applies to it afresh (its own
`@starting-style { --xr-reveal: 0 }`) and it re-pays the full
`--xr-skeleton-delay` (250ms) from zero. The child skeleton, continuously on
screen as a Stitch, **visually disappears for ~250ms and fades back in**: a
"stitch flash." The standalone child has no way, on its own, to know it was
just a Stitch.

## Decision

A skeleton that is **replacing a Stitch a still-showing parent skeleton was just
rendering** must reveal **instantly**, with no delay and no fade, matching how
the Stitch inherited the parent's already-revealed channel. This is a
_continuation_, not a fresh skeleton.

Detect a continuation with a **loading-keyed, ref-counted live-stitch registry**,
NOT wall-clock time. Wall clock is race-prone and over-applies; the registry is
deterministic via React's render-before-effect ordering and applies only to a
genuine continuation.

## Mechanism

- A module-level **ref-counted registry** in `react.core.tsx` (shared, ships to
  prod — the flash is a prod issue too; the cost is a `Map` plus a few bytes):
  `markStitchesLive(names): () => void` increments each name and returns a disposer
  that decrements (deferred to a microtask — see "same-commit → same-task" below);
  `isStitchLive(name)` reports whether the count is `> 0`. "Live" means: currently
  rendered as a Stitch inside a SHOWING parent skeleton.
- A `<Skeleton>`, **while it is showing its skeleton**, marks its Plate's **direct
  stitch names** live via an effect; the cleanup unmarks them when it stops showing
  (resolve) or unmounts. Direct stitch names come from
  `collectStitchNames(plate.chunks)` (walk the shipped chunks for `{ r: name }`,
  recurse `{ c, k }`).
- A `<Skeleton>` reads, **once at its first render**, whether its OWN Plate name is
  a live Stitch: `const [instant] = useState(() => isStitchLive(plate.name))`. A
  read-once initializer: no re-read, no tearing, no render-purity concern, and the
  decision is fixed for the instance's lifetime. If `instant`, the **outermost**
  root renders with `data-xr-instant`.
- `BASE_CSS`: the delay-hide (the rest-state transition and the
  `@starting-style { --xr-reveal: 0 }`) is scoped to
  `.xr-root:not([data-xr-instant])`, and a sibling rule
  `.xr-root[data-xr-instant] { --xr-reveal: 1 }` rests a continuation at fully
  visible with no `@starting-style` and no transition. **A non-instant skeleton
  is unaffected**: the delay-hide still applies via the `:not()` guard.

### Critical timing: mark on the VISIBLE-skeleton state, through the hold

`useSkeletonTiming(loading, ref)` returns `showSkeleton = loading || holding` (ADR
0016's min-duration hold keeps the skeleton on screen past `loading=false`). The
mark is keyed on `showSkeleton`, **not** `loading`: during the hold the parent
still shows its skeleton (and the Stitch), so content (the child standalone) is not
mounted yet. The child mounts only when `showSkeleton` flips false and content
renders — at which point the first-render read still sees the live entry, because
the parent's unmark cleanup runs after that commit. Keying on `loading` alone would
drop the mark during the hold and re-introduce the flash.

### The unmark is microtask-deferred: same-commit → same-task

The render-before-effect argument above holds when the continuation mounts in the
**same commit** as the parent resolving (the common case: parent content renders the
child standalone synchronously). But a real consumer can mount the continuation a
**tick later in the same task** — its `loading` flips in a mount effect, not in the
parent's resolve commit — so the child first-renders _after_ the parent's unmark
effect has already run. The synchronous decrement would have cleared the entry and
the read would miss it: flash. (Observed in the dogfood app: a dashboard's
card seams mount a hair after the dashboard resolves, in the same task.)

So the disposer **defers its decrement to a `queueMicrotask`** rather than running it
synchronously. The live window widens from same-_commit_ to same-_task_: any
continuation that mounts before the task's microtask queue drains still reads the
Stitch live. The bound is the current task's microtask queue — **not** a wall-clock
window — so it stays deterministic and can never keep a name live into a later
macrotask (a tab, a network-paced mount), which would be a false continuation. This
is the microtask analogue of the same race the loading-key already guards, one level
finer; it does not reintroduce the rejected wall-clock approach.

Same-task is a **deliberate ceiling.** A continuation whose
`loading` flips only after a real `await` (a fetch resolving in a later macrotask)
mounts after the entry has been decremented and reveals on the normal delay. That is
by design: such a child was genuinely absent across a task boundary, so treating it
as a fresh skeleton is correct, and the only way to "fix" it would be the wall-clock
window this ADR rejects. The flash this ADR targets is specifically the synchronous /
same-task seam (e.g. a child whose `loading` is derived from the parent's resolved
state in the same tick), which is the case observed in practice.

### Why this is exactly "continuation" (the determinism argument)

- **No race.** The parent marks `child` live in an effect when it first shows its
  skeleton (an earlier commit). When the parent resolves, React renders the content
  tree — the child standalone first-renders and reads `isStitchLive('child')`
  **before** the parent's unmark effect runs (render happens before that commit's
  effect phase). So the read deterministically sees `child` still live; then the
  unmark clears it. "Recently" is defined by React's render-before-effect ordering,
  not a timer.
- **Tab / independent nested.** A skeleton behind a tab (or a later "load more")
  was never marked live by a currently-showing parent (its parent resolved long ago
  and unmarked, or it was never a Stitch) → not live → normal delay. This is the
  over-application a pure "am I nested" policy would suffer.
- **Portal-correct for free.** Only genuine Stitches (names in a parent Plate's
  stitch set) are ever registered; a portaled child is never a Stitch → never live
  → normal delay. No Context and no `parentRef.contains` DOM check are needed.
- **Cascades to any depth.** The outermost parent registers its direct Stitch
  `child`; when it resolves, `child`'s standalone Skeleton mounts instant and — now
  a real `<Skeleton>` — registers ITS direct Stitch `grandchild` while it loads. So
  each level self-registers as it becomes real; one level of stitch names per
  Skeleton covers arbitrary nesting.

## Considered alternatives

- **Pure-context "all nested skeletons instant."** A Context that says "you are
  inside a skeleton tree, reveal instantly." Rejected: too rigid — a tab-hidden
  nested skeleton is _not_ a continuation, yet a pure context would force it
  instant. The registry instead keys on a Stitch being live _right now_.
- **Wall-clock-timestamp registry** (record "last seen as a Stitch at time T",
  treat as continuation if within N ms). Rejected: race-prone (depends on timer
  drift and scheduling), and it both over- and under-applies depending on load
  timing. The loading-keyed registry needs no clock.
- **View Transitions (ADR 0012).** The CSS-native cross-unmount bridge, but it
  requires wrapping the consumer's resolve in `startViewTransition`, which xray does
  not control. Deferred. The registry is the pragmatic solution and composes with
  VT later (VT governs the swap _animation_; this governs the reveal _delay_).

## Consequences

- `data-xr-instant` affects only the REVEAL (delay + fade); the min-duration HOLD
  (JS, ADR 0016) is unchanged — a continuation that resolves fast still holds
  briefly, which is smoother than flashing away.
- The prod `<Skeleton>` gains a register effect plus a read-once `useState`,
  further using the prod-hooks allowance ADR 0016 opened. Contained and consistent.
- The capture path, the Plate format, and `measure.ts` are untouched — this is
  entirely render-side. Dev and prod share the registry and the register/read; only
  `BASE_CSS` carries the new selectors.
