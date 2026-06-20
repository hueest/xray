---
status: accepted
---

# A framework-agnostic core with thin per-framework adapters

> **Realized 2026-06-15** (branch `thin-prod-adapter`; see git history).
> Two refinements emerged in implementation, folded into the contract below:
> the core ships **chunks** (pre-serialized HTML runs), which makes the adapter
> thinner than first specced — it injects strings and mounts stitches, it does
> not walk a per-node tree. The dev↔prod split is `@hueest/xray/react` (prod) vs
> `@hueest/xray/react/dev` (dev), aliased by the `serve`-only plugin.
>
> **Revised 2026-06-21** (plan `public-core-surface`): the framework-neutral
> capture/render surface IS published, as `@hueest/xray/core` — the public,
> framework-neutral utility surface for demos, playgrounds, tests, and future
> non-React integrations. Only the React _renderer_ core (`react.core.tsx`, the
> `Chunk[]` → React-node bundle shared by the prod and dev adapters) stays
> internal. So "internal core" below means that renderer bundle, not the
> capture/serialize surface, which `core.ts` re-exports publicly.

xray ships a React adapter and is built to grow Solid, Svelte, Vue, and Preact
adapters, plus server-side rendering. Almost everything is framework-neutral:
capture (`client.ts`), serialization (`measure.ts`/`serialize.ts`),
breakpoints, classify/css, the plate schema (`plate.ts`), the Vite plugin
(`index.ts`), the HUD (`hud.ts`), and the dev stores (lightbox / capture / live
plate). The only React-coupled modules are the adapter trio `react.tsx` /
`react.dev.tsx` / `react.core.tsx`.

The split is explicit: a **framework-neutral core** owns everything above, and
each framework ships a **thin adapter** implementing one small contract. Only
the React adapter exists; others are built on demand against the stable
contract. Content-addressed classes (ADR 0007) make this cheap — rendering a
node is "an element with a `className` and children," so almost no logic lives
in the adapter.

## The adapter contract

An adapter provides an idiomatic `<Skeleton>` and does four things, the first
two via pure helpers the core exposes:

1. **Render a plate's chunks** — the core (`chunk.ts`) flattens the build-time
   tree to a `Chunk[]` once, at the ship boundary, so the adapter never walks a
   per-node tree on first paint. A chunk is a stitch-free HTML `string` run, a
   stitch `{ r: name }`, a stitch-bearing element `{ c: className, k: chunk[] }`,
   or a template `{ t: html, n }` (ADR 0022). The adapter emits the root element
   (`data-xr-root` + `.xr-root`, plus the plate's `rootCls`), injects each
   `string` run as a `display:contents` HTML island, mounts the referenced child
   plate at each `{ r }` stitch, recurses into `{ c, k }`, and injects each
   template's cell HTML repeated `n` times. Injecting opaque, content-free HTML
   is the whole render — almost nothing framework-specific is left. Styling arrives beside the tree: for
   plugin-imported plates the css (BASE included) rides Vite's CSS pipeline
   (ADR 0026); only the explicit-`css` path for runtime-captured plates injects
   an inline `<style>` on the outermost root.
2. **Resolve the live plate** — read the dev live-store / lightbox / capture
   toggles through the framework's reactivity primitive, with a **server
   snapshot equal to the static prop plate**.
3. **Drive capture** — on content-ready, call `__XRAY__.captured(name,
rootEl, opts)`; dispose on unmount. A client-only effect.
4. **Be the readiness/suspense boundary** per ADR 0002.

## SSR

The contract is SSR-safe by construction: BASE reaches the server-rendered page
with no dev bootstrap (for plugin plates it is a built css asset, ADR 0026; on
the explicit-`css` path the outermost component emits it inline); the
server snapshot is the static plate, so server and client render identically and
hydration is clean; and capture never runs on the server (it's a client effect,
and `__XRAY__` is browser-only).

## Considered alternatives

- **Per-framework cores.** Rejected: duplicates capture/serialize/plugin,
  the hard parts, across frameworks.
- **One universal web-component renderer for all frameworks.** Rejected: loses
  idiomatic integration (props, suspense, the host's reactivity) and complicates
  hydration; the per-node render is already trivial, so a shared custom element
  buys little and costs interop.
- **Build all adapters now.** Rejected as premature: only React is used; the
  others are built when needed against the contract, which content classes keep
  small.

## Consequences

- The framework-neutral core (capture, serialize, breakpoints, classify,
  css, `chunk.ts`) is published as `@hueest/xray/core` — the public,
  framework-neutral capture/render utility surface (demos, playgrounds, tests,
  future non-React integrations). Low-level serialization is reached _through_
  `core`, not a separate public subpath. Public-but-advanced is not unstable:
  everything under `@hueest/xray/core` is a supported surface under normal semver,
  not an escape hatch; a breaking change to a `core` export needs a major bump.
  Each framework ships a
  `@hueest/xray/<framework>` adapter (React first), split into a prod entry
  (`Suspense` + static `refs`, plus the `useSkeletonTiming` and instant-reveal
  hooks ADRs 0016 and 0020 admit) and a `/dev` entry (the live store,
  Light Box, capture), with a small shared **renderer** core (`react.core.tsx`)
  bundled in. That renderer core stays internal; the dev bootstrap
  implementation modules (client, HUD) are private too, reachable only through
  `@hueest/xray/internal/*` for the plugin-generated consumer-side bootstrap.
- The dev↔prod swap is a plugin alias, not an export condition: the `serve`-only
  plugin aliases `@hueest/xray/<framework>` → `…/dev`; `build` falls through to the
  prod entry. The dev client (`__XRAY__`) only exists in `serve`, so this lines
  up exactly with where the dev weight is needed.
- Nothing framework-specific may leak into the core: `chunk.ts` emits plain
  `Chunk[]` (strings + stitch refs + templates), not framework nodes.
- New adapters are a small, well-scoped unit of work, not a fork: a render core
  that maps `Chunk[]` to the host's node type, a `<Skeleton>` wrapper, and a dev
  variant supplying the store-subscribed stitch resolver.

## Realization notes (2026-06-15)

Measured at the dev/prod split:

- **Prod adapter: 1,071 → 707 brotli (−34%)** — by dropping the Light Box,
  hot-swap (`useLivePlate`), capture, the store-subscribed `RefNode`, and the
  refs-seeding effect, none of which do anything in production (`globalThis.__XRAY__`
  is always undefined there). Prod then needs only `Suspense` + the jsx-runtime,
  no `useSyncExternalStore`/`useCallback`/`useEffect`/`useRef` (ADRs 0016 and
  0020 relax this: the prod entry carries `useSkeletonTiming` plus an
  instant-reveal `useState`/`useEffect` pair, leaving `useSyncExternalStore`/
  `useCallback` as the dev-only hooks). Bundles: prod `react.mjs` 0.80 kB gzip +
  shared `react.core` 1.14 kB gzip; the dev adapter (1.47 kB gzip) carries
  everything else.
- **The chunk move is ~payload-neutral** (+0.8% brotli — base classes bake into the
  strings). The win is architectural, not bytes: `toHtml`/`renderChildren` leave
  the client bundle and serialization happens once, at the build boundary, in the
  framework-neutral core.
- **The chunk contract never touches `PLATE_VERSION`.** The shipped shape
  (tree → chunks) is regenerated at load and never persisted, so it can evolve
  freely; the version guards only the on-disk `StoredPlate` schema.
