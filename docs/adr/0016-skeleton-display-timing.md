---
status: accepted
---

# Skeleton display timing: reveal delay and minimum duration

> **Amended by [ADR 0020](./0020-instant-reveal-for-stitch-continuations.md):** a
> skeleton that continues a Stitch a still-showing parent was just rendering
> reveals INSTANTLY (no delay, no fade) via a `data-xr-instant` marker and a
> live-stitch registry. The delay-hide below is scoped to
> `.xr-root:not([data-xr-instant])`; an ordinary skeleton is unchanged.

A skeleton must reserve layout from the first loading frame (no shift), but it
shouldn't _flash_: showing bones for a few frames on a fast load, or yanking them
away the instant data arrives, both read as a flicker. The needs pull opposite
ways (suppress the skeleton on fast loads, yet hold it once shown), and CSS
alone can't express the second.

## Decision

Render the skeleton immediately (reserve layout), but delay and floor its
**visual exposure**. Never `display:none`: layout is always preserved. Three
public tokens (under the `--xr-skeleton-*` family, ADR 0017):

- **`--xr-skeleton-delay`** (default **250ms**) — grace period before the skeleton
  becomes visible. Resolve within it → the skeleton is never seen.
- **`--xr-skeleton-min-duration`** (default **600ms**, anchored at
  _skeleton-visible_, i.e. `loading_start + delay`) — once visible, the skeleton
  stays at least this long; content arriving sooner waits, content arriving later
  swaps instantly.
- **`--xr-skeleton-transition-duration`** (default **150ms**) — the reveal/swap
  fade.

**Mechanism — a composed opacity channel.** The leaf opacity becomes
`calc(var(--xr-o) * var(--xr-reveal))`. The pulse keeps animating `--xr-o`; the
reveal _transitions_ a new private `--xr-reveal` from 0→1 with `@starting-style` +
a `transition-delay` of `--xr-skeleton-delay`. This sidesteps the collision ADR
0012 flagged: an element whose `opacity` an `animation` owns cannot also
`transition: opacity`. Composing two custom-prop channels into one `opacity`
calc is the same trick the pulse itself uses.

**Responsibility split:**

- **Skeleton reveal = pure CSS, zero JS.** The skeleton mounts at `--xr-reveal: 0`
  and only fades in if loading outlasts the delay; a fast load unmounts the
  component before the delay elapses, so it's never seen. No timer, no React
  coordination.
- **Min-duration hold = the only JS.** Holding the swap means keeping the skeleton
  mounted past `loading=false`, which CSS can't do. JS timestamps loading-start,
  reads the computed delay + min-duration off the boundary element, and on
  `loading=false` either swaps immediately or holds to `start + delay + min-duration`.
  When min-duration computes to 0 the swap is synchronous: **no timer, zero
  cost** in the common case.

**Defaults rationale.** 250ms sits under the Doherty ~400ms threshold (fast loads
feel instant). The worst case (data resolving just after 250ms) shows content at
850ms, under the Miller/Nielsen ~1s "flow of thought" ceiling. Min-duration is
anchored at skeleton-visible (not loading-resolve) precisely so latency is added
_only_ in the flash window, never on every slow load.

**Boundaries.** Configuration is **CSS-var-only**, no `<Skeleton>` prop (ADR
0011: theming cascades rather than being passed; the `delay` _prop_ is the
unrelated capture-settle axis). The default reveal is this fade; **View Transitions (ADR 0012) stays the separate, deferred opt-in** for the swap _animation_. Timing
tokens govern _when_ the swap fires; VT governs _how_ it animates; they compose,
and this ADR does not relitigate 0012.

## Resolution (2026-06-21): the hold lives in a shared hook, prod included

The question this decision left open (where the min-duration hold's JS lives,
given the production adapter ships zero hooks) is resolved: the hold is a single
shared `useSkeletonTiming` hook in the React core, used by BOTH the production
(`react.tsx`) and dev (`react.dev.tsx`) `<Skeleton>` adapters, so the two keep
identical timing.

This intentionally **relaxes ADR 0008's "the prod adapter ships zero hooks"**:
the base production `<Skeleton>` gains one timing hook (state plus a single
timer). The reveal delay stays pure CSS (zero JS); only the min-duration hold
needs the hook, and the hook arms a timer only when a hold is actually required
(a synchronous swap when min-duration resolves to `0`). Chosen over a separate
opt-in timing wrapper and over making the hold opt-in, so the anti-flash
behavior is on by default for every consumer without a second component,
accepting one contained hook in production as the cost.

## Considered alternatives

- **`transition: opacity` directly on leaves.** Rejected: it collides with the pulse
  animation (ADR 0012, point 3). The `--xr-reveal` calc channel is the fix.
- **Min-duration measured from loading-resolve (or a fixed post-resolve delay).**
  Rejected: it adds latency on _every_ slow load. From-skeleton-visible adds it
  only when content arrives in the flash window.
- **A `<Skeleton>` prop for timing.** Rejected: CSS-var cascade per ADR 0011.
- **All-zero defaults (fully opt-in).** Rejected: pre-publish, so a behavior
  change is free, and shipping the anti-flash off-by-default means nobody gets it.
  Skeleton-delay is pure upside; min-duration is capped to stay under the 1s wall.

## Consequences

- Visible behavior change: skeletons appear ~250ms later (less flashing); real
  content timing is unchanged except the bounded flash-window hold.
- Three new public tokens (folded into the ADR 0011 taxonomy via ADR 0017).
- The min-duration hold is the single place display timing needs JS; everything
  else is CSS.
- **Graceful degradation, both anti-flash, never an invisible skeleton:**
  - Under `prefers-reduced-motion: reduce`, the delay and min-duration stay (they
    prevent flash, not motion); only the fade drops — `--xr-skeleton-transition-duration`
    collapses to `0s` and the pulse `animation` is `none`.
  - Without `@starting-style`/`@supports selector()` support the reveal can't
    animate from 0, so the `@supports (selector(:has(*)))` guard skips the block
    entirely and `--xr-reveal` rests at its `@property` initial value `1`: the
    fallback is an instant, fully-visible skeleton, never an invisible one.
