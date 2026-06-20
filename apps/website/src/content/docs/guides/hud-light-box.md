---
title: The HUD & Light Box
description: The dev overlay for inspecting coverage and previewing skeletons.
---

With `xrayVitePlugin({ hud: true })`, a small dev overlay appears in the corner.
It shows per-Plate Coverage: every detected width band, captured bands lit, the
rest dim, sourced from the committed Plate files on disk.

- **Capture** starts and stops a capture session.
- **Light Box** flips every mounted `<Skeleton>` on the page to its skeleton, to
  inspect the bones without waiting on a loading state. `?xray-lightbox` in the
  URL does the same.

## Enable it

```ts
import { xrayVitePlugin } from '@hueest/xray'

export default defineConfig({
  plugins: [xrayVitePlugin({ hud: true })],
})
```

The HUD is dev-only. Production builds use the lean React adapter and do not
ship the HUD, capture client, Light Box store, or plate hot-swap machinery.

## Capture

The **Capture** checkbox starts a capture session. It is sticky per tab, and the
URL parameter `?xray-capture` starts it on for that tab.

While the session runs, each `<Skeleton>` that reaches real content settles and
is captured, and mounted skeletons hot-swap live as captures land. Turn Capture
off to end the session and write the updated Plates to `plates/`.

## Light Box

Light Box is the fastest visual check. It forces every mounted `<Skeleton>` to
show its skeleton regardless of the component's loading state. Use it to compare
the captured bones against a fully loaded page.

Drive it three ways:

- tick **Light Box** in the HUD;
- open the page with `?xray-lightbox`;
- run `__XRAY__.lightbox.set(true)` in the console.

The setting is stored in `sessionStorage`, so it follows reloads in the same tab
without affecting other tabs.
