---
status: accepted
---

# The dev HUD renders with SolidJS 2.0, bundled into its own chunk and reaching nothing else

> **Builds on [ADR 0027](./0027-one-session-one-mode.md) §4 (the HUD is a pure
> projection of the client's stores) and keeps
> [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md) intact: the core
> and the adapters stay framework-neutral/React — Solid is an implementation
> detail of one dev-only internal module, invisible to consumers.**

The HUD grew from a coverage badge into a stateful instrument: a mode machine
with per-plate scopes, live session and sweep state, a scrollable plates list
with hover-driven page highlights, and cards that come and go. The old
implementation re-rendered the whole panel on every store change, which resets
scroll position, kills hover state, steals focus, and restarts CSS transitions
— acceptable for a badge, disqualifying for an instrument. The alternatives
were hand-written DOM surgery per state transition or fine-grained reactivity.

## Decision

### 1. SolidJS 2.0 (beta), pinned exact

Solid's model — signals updating exactly the DOM nodes that depend on them, no
virtual DOM, no component re-runs — is precisely "fine-grained reactivity",
and it maps 1:1 onto the client's store shape: a ~10-line `fromStore` bridge
(subscribe → boxed signal) turns every `__XRAY__` store into a Solid read, and
the whole HUD is a projection. The beta is pinned exact (`solid-js` and
`@solidjs/web` on the SAME beta number — mismatched copies mean two runtimes
and broken reactivity); the API surface used (signals, memos, `For`/`Show`,
`render`, `onSettled`) is the stable heart of the design, and a fallback to
Solid 1.x would be a small mechanical diff. Vanilla-with-manual-updates was
rejected as the bug farm the rewrite exists to escape; Preact was rejected
because a VDOM re-render has the same state-resetting failure mode the old
HUD had, just faster.

### 2. An isolated build graph

The hud entry compiles in its OWN tsdown config with `vite-plugin-solid` (the
Solid-2-track compiler; `unplugin-solid` is 1.x-only). No other entry shares
the config, so the Solid JSX transform can never touch the React or neutral
sources, and the few `plate.ts` types the HUD imports are erased rather than
shared as chunks. Solid ships as a devDependency, so it bundles INTO `hud.js`:
the consumer resolves no Solid package, ever. `dist-isolation.test.ts` pins
both directions — the `@solidjs` marker present in `hud.js`, absent from every
other chunk — alongside the ADR 0019 pretext pin. The one Solid-authored file
carries a `@jsxImportSource @solidjs/web` pragma; the package tsconfig stays
on React JSX for everything else.

### 3. Shadow-root containment

The HUD renders into the same shadow root as before. Solid 2.0 scopes event
delegation to the render root, so listeners live and die with the HUD and
nothing leaks into the consumer's document — the property that made a
framework inside someone else's app tolerable.

## Consequences

- `hud.js` is ~60 KB (Solid runtime + wordmark asset included), dev-only,
  loaded only when `hud: true`. Prod bundles are untouched by construction.
- Upgrading the beta is deliberate: bump both packages to the same version,
  re-run the gates, re-verify against the upstream migration notes.
- The Solid transform exists in two places (tsdown config, vitest config) and
  must stay scoped to the hud sources in both.
- The roadmap's Solid adapter (the ADR 0008 second-framework proof) inherits a
  team already dogfooding Solid internals.
