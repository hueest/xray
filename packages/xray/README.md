# @hueest/xray

Auto-captured skeleton loading screens for [Vite](https://vite.dev). Capture the structure, ship the plate.

xray captures the **real rendered DOM** of your components as you browse your dev server, then renders faithful skeleton loading states from those captures. Placeholders are captured rather than hand-drawn, with no separate headless browser and no fixed-height hacks.

> Beta: APIs may move before 1.0. Docs, guides, and the API reference live at
> **[xray-js.dev](https://xray-js.dev)**; source and issues at
> [github.com/hueest/xray](https://github.com/hueest/xray).

## Install

```sh
pnpm add @hueest/xray
```

## Use

```ts
// vite.config.ts
import { xrayVitePlugin } from '@hueest/xray'

export default defineConfig({
  plugins: [xrayVitePlugin({ hud: true })],
})
```

```tsx
import { Skeleton } from '@hueest/xray/react'
import plate from 'virtual:xray/plates/my-banner'

// skeleton while loading; content + (dev) capture when ready
;<Skeleton plate={plate} loading={loading} fallback={<Spinner />}>
  <RealBanner data={data} />
</Skeleton>
```

To inspect skeletons without waiting on loading states, tick **Light Box**
in the HUD (or open the page with `?xray-lightbox`); every mounted
`<Skeleton>` flips to its skeleton until unticked.

Capture starts off. Tick **Capture** in the HUD (or pass `capture: true` to
`xrayVitePlugin`) to start writing Plates as you browse. With Capture on,
captures land in `plates/` (commit them). Resize to capture other views: each
width lands as its own View, carried whole in the one plate and gated by
`@media display:none` (JS-driven structure differences become Projections).
Add `"@hueest/xray/virtual"` to the tsconfig `types` for the
`virtual:xray/plates/*` imports.

## Learn more

- **[xray-js.dev](https://xray-js.dev)** — the docs site: how it works, the
  radiographic mental model (Plate / Capture / Stitch / View / Projection / Light
  Box), and guides for responsive Views, the HUD & Light Box, capture-all-views,
  and theming.
- **[xray-js.dev/reference/api/xray](https://xray-js.dev/reference/api/xray)** —
  full API reference, generated from source.
- **[GitHub](https://github.com/hueest/xray)** — source, issues, and the
  architecture/decision-record trail.
