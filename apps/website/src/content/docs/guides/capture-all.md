---
title: Capture all views
description: Sweep every detected width band in one click with the companion extension.
---

Capturing each View by hand means resizing the window to every width band. The
companion Chrome extension automates the **Sweep**: the HUD drives it, resizing the
viewport through each detected band and capturing as it goes — preserving any
interaction-gated state along the way.

The HUD is the controller; the extension is a thin executor. When the extension is
present, the HUD shows a **Capture all views** button; when it isn't, a one-line
prompt to install it.

## How the Sweep works

1. Enable the HUD with `xrayVitePlugin({ hud: true })`.
2. Render the page into the state you want captured: open menus, choose filters,
   or reveal any interaction-gated content first.
3. Keep Chrome DevTools closed on the tab. The extension uses Chrome's debugger
   viewport emulation, and DevTools can block that attachment.
4. Click **Capture all views** in the HUD.
5. Commit the updated `plates/` files.

The page remains the source of truth. It computes the target widths from the
`matchMedia` queries the page evaluates and the `@media` thresholds of the Views
captured so far in the session, recomputing them on each pass until the Sweep
converges. The extension only emulates each width and resets the viewport when the
Sweep finishes.

## What gets captured

The Sweep visits one mobile-ish width plus each detected threshold. At every width,
xray forces a capture for the mounted Skeletons, waits for the subtree to settle,
and accumulates the resulting View into the Plate's session bundle. The Plate file
is written once, when the Sweep completes.

If a component renders different structure at a width, the divergent subtree is
recorded as a Projection, gated to that width band. If it only changes with CSS, the captured CSS carries the
responsive behavior.

## Troubleshooting

- If the HUD only shows the install prompt, the extension has not announced itself
  to the page yet.
- If the Sweep fails with an extension response error, close DevTools on that tab
  and retry.
- If a width band renders wrong, re-run the Sweep. A manual Capture session
  replaces the whole Plate with the Views it recorded, so visit every relevant
  width before toggling Capture off.
