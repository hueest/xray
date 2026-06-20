---
title: Fixtures
description: Record a component's data once and replay it for deterministic captures.
---

A capture reflects whatever data happened to load. Some states are hard to catch
live — a rare admin view, a populated cart, a flaky third-party feed — and even
easy ones drift as real data changes. A **Fixture** solves this: Record a
`<Skeleton>`'s render-input `data` once, then Replay it so every capture renders
that exact state.

The Fixture is a dev-only sidecar, `plates/<name>.fixture.json`, written next to
the Plate it feeds. Record stores the `data`; Replay feeds it back through the
render prop in place of live data. Capture itself is unchanged — the component
still captures when it renders ready; Replay only changes what renders.

## Use the render-prop form

Fixtures flow through the `data` prop and children-as-a-function, so the
Skeleton knows exactly which input to store and substitute:

```tsx
<Skeleton plate={plate} loading={isLoading} data={products}>
  {({ data }) => <SimilarProductsCarousel products={data} />}
</Skeleton>
```

Fixtures are serialized with devalue, so `Map`, `Set`, `Date`, `BigInt`, and
cyclic values all survive. Recording fails loudly on the unrecordable
(functions, class instances, promises, DOM nodes).

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

- `'manual'` (default) — only via the HUD's **Record fixture** button, so live
  app data is never silently committed.
- `'first-ready'` — record once, the first time a Skeleton renders ready and no
  Fixture exists yet.
- `'always'` — re-record on every ready render.

`replay` controls when the Fixture feeds the render prop:

- `false` (default) — never; live data always renders.
- `'prefer'` — always use the Fixture when one exists.
- `'missing-only'` — use the Fixture only when live `data` is nullish. An empty
  array or object counts as present, so genuine empty states stay capturable.

The HUD marks plates that have a Fixture with a `◆ fixture` tag.

## Notes

- **Dev-only.** Fixtures never exist in the production bundle; the sidecar, the
  devalue dependency, and the Record/Replay machinery ship only under `serve`.
- **Git-tracked and hand-editable.** Commit the sidecar for stable, reviewable
  captures — or hand-author one to design a state that is awkward to reach.
  Scrub recorded data from auth-walled views before committing.
- **One Fixture per Plate.** Data does not change with viewport, so a single
  recorded input plus a [Sweep](/guides/capture-all/) produces a
  full multi-view Plate with zero live state.
