---
title: The Sweep
description: One press of record captures every view of every mounted skeleton, driven by the companion extension.
---

Capturing each View by hand means resizing the window through every width band.
With the companion extension connected, pressing **record** in the
[HUD](/guides/hud-light-box/) runs the whole arc unattended: the Sweep drives
the viewport through each discovered band, captures every mounted `<Skeleton>`
at each one, and ends the session itself — sweep, write, done, one press.

The page is the controller; the extension is a thin executor. It answers a
narrow, allowlisted set of viewport-emulation commands and nothing else — it
never reads page data, and the allowlist is pinned by tests
([ADR 0030](https://github.com/hueest/xray/blob/main/docs/adr/0030-dev-bridge-protocol.md)).

## Install the extension

1. Download the zip from
   [GitHub Releases](https://github.com/hueest/xray/releases) (or build it:
   `pnpm --filter xray-extension build`).
2. Load it unpacked at `chrome://extensions` (enable Developer mode).
3. Open your dev server. On `localhost`, `127.0.0.1`, or any `*.localhost`
   domain, the bridge connects by itself — the HUD's install prompt disappears.
4. On any other origin — a tunnel, a LAN host, a custom dev domain — click the
   xray toolbar icon once. That injects the same bridge into the current tab
   and badges it; nothing is injected anywhere without that click.

## Run it

1. Enable the HUD with `xrayVitePlugin({ hud: true })`.
2. Render the page into the state you want captured: open menus, choose
   filters, reveal any interaction-gated content. The Sweep captures the state
   you are holding, at every width.
3. Keep Chrome DevTools closed on the tab — the extension uses Chrome's
   debugger viewport emulation, and DevTools blocks that attachment.
4. Press **record**. The button shows a progress ring per width; when the
   Sweep completes, the session writes itself and the ticker reads
   `✓ n plates`.
5. Commit the updated `plates/` files.

A per-plate record key does the same for a single Plate: it sweeps just that
Plate's bands and keys itself off.

## What the Sweep captures

Width discovery is in-session: the target widths come from the `matchMedia`
queries the page evaluates plus the `@media` thresholds carried in the Views
captured so far, recomputed each pass until no new width appears. At every
width, each mounted Skeleton settles and captures one View into its Plate's
session bundle.

Absence is captured too. A component that is unmounted — or renders nothing —
at a width records an **empty View** for that band: the skeleton renders the
faithful nothing there, and Coverage reads the band as captured rather than as
a gap that can never be filled. At write time, identical adjacent Views fold
into one, so a component that only exists above a breakpoint stores exactly
two Views: nothing below it, content above it.

## When it fails

A failed Sweep never writes: the session stays engaged, the HUD shows the
error, and you decide — fix the cause and press record again, or stop and keep
the partial session.

- **Install prompt showing**: the bridge has not announced itself. On a
  non-loopback origin, click the toolbar icon; otherwise check the extension
  is loaded and the tab was reloaded after installing it.
- **"extension can't sweep — update it"**: the installed bridge predates the
  current protocol. Reinstall from Releases.
- **Sweep fails immediately**: close DevTools on the tab and press record
  again.
