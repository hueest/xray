---
title: The HUD & Light Box
description: 'The dev deck: record and Light Box controls, per-plate Coverage, and the plates list.'
---

With `xrayVitePlugin({ hud: true })`, a film-dark panel appears in the corner
of the page: the **deck**. It carries two controls — **record** (the crimson
dot) and **Light Box** (the play triangle) — a one-line status ticker, and a
collapsible plates list. It is dev-only: production builds ship neither the
HUD nor the capture client.

```ts
import { xrayVitePlugin } from '@hueest/xray'

export default defineConfig({
  plugins: [xrayVitePlugin({ hud: true })],
})
```

## Record

Recording is a session: engage, capture, stop, write.

- **With the [extension](/guides/sweep/) connected**, one press runs the whole
  arc: the Sweep visits every discovered width, the button shows a progress
  ring, and the session ends itself — `✓ n plates` in the ticker when the
  write lands.
- **Without it**, recording is manual: each `<Skeleton>` that reaches real
  content is captured at your current width, resizing the window captures the
  other bands (hollow segments in the plates list are the to-do list), and
  pressing stop writes.

A session's writes use replace semantics — the Views you recorded become the
Plate — and nothing touches disk until the stop. A failed write keeps the
recorded Views in memory; the next engage retries them.

Each plate row also carries its own small record key: it records just that
Plate (and with the extension, sweeps just its bands).

## Light Box

Light Box is the fastest visual check: it forces every mounted `<Skeleton>` to
show its skeleton regardless of loading state, like holding the plates up to
the light. The per-row play key flips a single Plate instead — useful for
styling one skeleton in place while the rest of the page stays live.

Drive the global toggle three ways: the play button in the deck, the
`?xray-lightbox` URL parameter, or `__XRAY__.mode.setLightbox(true)` in the
console. It is sticky per tab via `sessionStorage`.

Recording and Light Box never run together, at any scope: Light Box unmounts
content, so nothing could capture under it. Engaging one disables the other,
and the disabled control's tooltip says why.

## The plates list

The summary line reads the same way in every state — mounted skeletons first,
unsaved views or gaps second, total plates on disk last. Open it for the rows:

- **Segments** are the Plate's width bands: solid and steel-tinted when
  captured, dashed and hollow when missing, glowing when captured this
  session. A band captured as _empty_ (the component renders nothing there)
  counts as captured — that is its faithful skeleton.
- **Badges**: `◆` marks a recorded [Fixture](/guides/fixtures/) (its tooltip
  says whether Replay is substituting it), `⚠` a refused capture with the
  reason inline, `×N` multiple mounted instances (the first in document order
  writes).
- **Stitch rows** appear when a showing skeleton renders another Plate as a
  [stitch](/guides/nested-skeletons/): dimmed, annotated with the host, keys
  disabled — a stitch has no mounted content to capture, and its bones already
  show through the parent.
- Hovering or focusing a row outlines that Skeleton's boundary on the page.
- Plates on disk that are not on the current page close the list, dimmed.
- The **replay fixtures** switch appears once any Fixture exists.

## Console and URL surface

Everything the deck does is scriptable per tab:

- `?xray-capture` engages recording on load; `?xray-lightbox` engages Light
  Box.
- `__XRAY__.mode` is the state machine: `setRecord(on)`, `setLightbox(on)`,
  `recordName(name, on)`, `lightboxName(name, on)`.
- Both sticky toggles live in `sessionStorage`, so they follow reloads in the
  same tab without affecting other tabs.
