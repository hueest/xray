---
title: Fixtures
description: Record a component's data once and replay it for deterministic captures.
---

A capture reflects whatever data happened to load. Some states are hard to catch
live (a rare admin view, a populated cart, a flaky third-party feed), and even
easy ones drift as real data changes. A **Fixture** solves this: Record a
`<Skeleton>`'s render-input `data` once, then Replay it so every capture renders
that exact state.

The Fixture lives in the plate module, `src/plates/<name>.ts`, beside the
Plate structure it feeds:

```ts
export const plate = {
  // …the captured Plate structure…
}

export const fixture = {
  items: [{ kind: 'news', id: 'item-1', postedAt: new Date(1753305600000) }],
} as const
```

Record writes or updates that module, preserving the Plate half. The `data`
lands as real source (`Date`, `Map`, and `Set` appear as native constructors),
and Replay imports it back through the module graph to feed the render prop in
place of live data. Capture itself is unchanged: the component still captures
when it renders ready; Replay only changes what renders. Editing the file by
hand hot-reloads straight into a running Replay.

## Use the render-prop form

Fixtures flow through the `data` prop and children-as-a-function, so the
Skeleton knows exactly which input to store and substitute:

```tsx
<Skeleton plate={plate} loading={isLoading} data={products}>
  {({ data }) => <SimilarProductsCarousel products={data} />}
</Skeleton>
```

`Map`, `Set`, `Date`, `BigInt`, and cyclic values all survive recording.
It fails loudly on the unrecordable (functions, class instances, promises,
DOM nodes).

## Configure it

```ts
import { xrayVitePlugin } from '@hueest/xray'

export default defineConfig({
  plugins: [
    xrayVitePlugin({
      hud: true,
      fixtures: { record: 'manual', replay: 'missing-only' },
    }),
  ],
})
```

`record` controls when a Fixture is written:

- `'manual'` (default): only via the HUD's ◆ keys, so live app data is never
  silently committed.
- `'first-ready'`: record once, the first time a Skeleton renders ready and no
  Fixture exists yet.
- `'always'`: re-record on every ready render.

`replay` controls when the Fixture feeds the render prop:

- `false` (default): never; live data always renders.
- `'prefer'`: always use the Fixture when one exists.
- `'missing-only'`: use the Fixture only when live `data` is nullish. An empty
  array or object counts as present, so genuine empty states stay capturable.

In the HUD, every mounted render-prop Skeleton's row carries a ◆ key beside
its rec/play keys: hollow `◇` means no Fixture yet, filled `◆` means one is
recorded (press to re-record), and the key dims while no live data is in
scope: during loading, or under the Light Box. The fixtures footer adds
**record all** (one press records every mounted plate with live data, beside
the replay switch). A plate with a Fixture but no mounted render-prop site
shows a passive `◆` tag instead of the key.

## Typed Fixtures

The dev server generates `src/plates/xray-env.gen.d.ts` and derives each
Fixture's type from its plate module. Your compiler reports a
`FixtureOutOfDate` error on any `<Skeleton>` whose `data` type the committed
Fixture no longer satisfies (a new required field, a renamed one, a value
retired from a union), in any compile of the branch, with xray not running.
Re-record the Fixture to update it.

Commit `xray-env.gen.d.ts` beside the plate modules. The default
`src/plates` sits inside the standard `include: ["src"]`, so the check needs
no tsconfig wiring; a `files`-only tsconfig or a custom Vite `root` lists
the plates directory in `include` itself. The top-level `noTypes: true`
plugin option stops xray writing or updating the file (a previously
committed copy stays in the program until deleted).

Two constraints on the generated files: codegen owns them, so value edits
survive the next Capture or Record while comments and formatting do not
(every write re-renders the whole file), and the `as const` on the fixture
export is load-bearing (it keeps recorded values literal, which is what
lets the check pass against discriminated unions while catching real
drift). Cyclic data falls back to an untyped form the check skips.

## Notes

- **Dev-only.** Fixtures never exist in the production bundle; nothing imports
  the `fixture` exports outside the dev server, and the Record/Replay
  machinery ships only under `serve`.
- **Git-tracked and hand-editable.** Commit the plate module for stable,
  reviewable captures, or hand-author a `fixture` export to design a state
  that is awkward to reach; edits hot-reload into a running Replay. It is
  executed dev source: review it in PRs like any code, and scrub recorded
  data from auth-walled views before committing.
- **One Fixture per Plate.** Data does not change with viewport, so a single
  recorded input plus a [Sweep](/guides/sweep/) produces a
  full multi-view Plate with zero live state.
