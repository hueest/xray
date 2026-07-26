# @hueest/xray

Auto-captured skeleton loading screens for [Vite](https://vite.dev). Capture the structure, ship the plate.

xray captures the **real rendered DOM** of your components as you browse your dev server, then renders faithful skeleton loading states from those captures. Placeholders are captured rather than hand-drawn, with no separate headless browser and no fixed-height hacks.

**[xray-js.dev](https://xray-js.dev)**: docs, guides, and API reference.

> Beta: APIs may move before 1.0. See [Architecture](https://xray-js.dev/architecture/)
> for how it works and the [Roadmap](https://xray-js.dev/roadmap/) for what's next.

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
captures land in `src/plates/` (commit them). Resize to capture other Views:
each width lands as its own View, carried whole in the one Plate and gated by
`@media display:none` (JS-driven structure differences become Projections).
The dev server generates `src/plates/xray-env.gen.d.ts` to type the
`virtual:xray/plates/*` imports. Commit the file. No tsconfig changes are
required. The dev server needs Node 22.18 or later (23.6 within the 23 line).

## Develop

```sh
pnpm install
pnpm build        # tsdown
pnpm test         # vitest
pnpm lint         # oxlint
pnpm format       # oxfmt
pnpm typecheck    # wxt prepare + oxlint + astro check
```
