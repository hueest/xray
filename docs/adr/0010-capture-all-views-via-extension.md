---
status: accepted
---

# Capture-all-views via a Chrome extension driving CDP emulation

> **Amended 2026-06-15:** the trigger and orchestration live entirely in the
> in-page HUD/dev client (the _controller_); the extension is a thin, UI-less
> _executor_ that only runs `chrome.debugger` emulate/reset on command. The HUD
> probes for the extension and promotes installing it when absent. See
> "Controller/executor split" below — this supersedes the popup trigger.

xray captures one view per actual viewport width: a capture fires at whatever
width the window happens to be, so covering every view of a skeleton means
resizing through each breakpoint by hand. A one-click "capture all views" sweeps
the breakpoints instead. This ADR records how the sweep is driven: an
**optional, dev-only Chrome extension** that uses `chrome.debugger` to send
`Emulation.setDeviceMetricsOverride` to the live tab.

## Why this lever

The requirement is to change the **live, already-navigated tab's** viewport
metrics **in place, without a reload**, for each target width. In place matters
because skeletons often sit behind interaction (a modal, a tab, a scrolled-in
section): re-rendering the existing DOM at a new width reflows that state,
where a reload loses it.

Changing the live tab's metrics is the constraint that picks the tool:

- **Page JS can't do it.** `window.resizeTo/resizeBy` only act on
  `window.open`-ed popups and are otherwise blocked, so the injected dev client
  cannot resize its own tab. Some external agent must.
- **`chrome.debugger` → `Emulation.setDeviceMetricsOverride` can**, in place,
  faithfully (width, height, `deviceScaleFactor`, `mobile`/touch): it is exactly
  what the DevTools device toolbar uses, and an extension can call it without
  launching a special browser.

So the extension only _drives the metrics_. The capture path is untouched:
changing device metrics re-evaluates `@media`/`matchMedia` and fires the window
`resize` event the dev client listens to (`onResize` in `client.ts`), exactly as
a manual resize does.

During a sweep, though, the sweep is the **sole capture driver**: `onResize`
ignores the emulated resizes (cancelling any pending debounce) and `runCapture`
drops any non-forced browse capture, since the sweep captures each width itself
with a forced, awaited pass and POSTs the accumulated views once per site at the
end. The generation guard stays as the correctness backstop — it already
discards a racing browse capture — so dropping strays is hardening against
wasted settle/walk work and a transient one-view POST mid-sweep, not a
correctness fix; for the same reason it is not isolable in a unit test (a
guard-only run still yields the right final POST).

## Controller/executor split (the amendment)

The page owns everything except the privileged metric change: the capture
machinery, the breakpoint knowledge, and the precise settle observation
(`settle()` per site). So the **HUD/dev client is the controller**:
it shows the "Capture all views" button, computes the target widths, runs the
sweep loop, and awaits each view's real settle (re-capturing every mounted site)
before advancing. The **extension is a thin executor** with no UI and no logic:
it answers two commands over a content-script bridge, _emulate(width, height,
mobile)_ (attach `chrome.debugger` if needed, then `setDeviceMetricsOverride`)
and _reset_ (clear the override + detach). It carries no widths, loop, or
timers; the page drives.

**Presence probe + promotion.** A page detects the companion extension via its
content script, which announces itself (`postMessage` a `hello`, and replies to a
`whois`). The HUD defaults to a small **promotion** ("install the extension to
capture all views") and flips to the active button the instant it hears `hello`;
with no timeout there is no false negative, only a brief promotion before the
button appears. Caveat: the content script only injects on matched origins (dev
hosts), so an unmatched dev host shows the promotion even when the extension is
installed; broaden the match patterns to cover real dev origins.

This replaces the popup: there is no extension UI at all.

## Considered alternatives

- **Hidden same-origin iframe, sized per width (no extension).** Tempting because
  it is pure dev-server script: an iframe has its own viewport, so `@media`
  inside it keys off the iframe width. Rejected — a fresh iframe load **loses all
  interaction-gated state**, which is most of what is worth capturing in a real
  app. It only ever covers a route's initial-render skeletons.
- **A DevTools extension panel.** Considered for a nicer in-workflow UI, accepting
  the friction of opening DevTools. Rejected, and it actively backfires:
  `chrome.devtools.*` has **no** emulation API (its strongest lever,
  `inspectedWindow.eval`, runs page JS, which can't set metrics), _and_ a tab with
  DevTools open is precisely the state in which `chrome.debugger` cannot
  attach. The accepted friction (open DevTools) is the exact thing that disables
  the capability. The trigger therefore lives in the in-page HUD, not a panel.
- **Bare CDP over `--remote-debugging-port` (no extension).** Same `Emulation`
  capability without building/distributing an extension, but it reintroduces the
  boneyard-style "relaunch a specially-flagged browser" friction in-session
  capture exists to avoid. The extension needs no relaunch for everyday use.
- **Cross-browser parity from day one.** Firefox exposes **no** extension API for device
  emulation (`chrome.debugger` is unimplemented — [bug 1316741][bz]; RDM is not
  scriptable). The only Firefox lever is a real `windows.update` window resize:
  disruptive, screen-capped, no DPR/mobile. Not worth blocking the Chrome path on;
  Firefox is deferred (best-effort window-resize at most).

[bz]: https://bugzil.la/1316741

## Consequences

- **Chrome-only.** The faithful, in-place lever is Chrome's; Firefox capture-all
  is deferred. Manual resize-to-capture works everywhere without the extension.
- **The extension is optional and dev-only.** It never ships to production; it
  only adds the one-click sweep on top of the existing pipeline. The capture
  contract, plate format, and dev client are unchanged.
- **Two sharp operational limits, surfaced in the UI.** (1) The sweep requires
  **DevTools closed** on the target tab — `chrome.debugger` cannot attach
  otherwise, and an open DevTools mid-sweep terminates the session. (2) Chrome
  shows a "started debugging this browser" infobar while attached, suppressible
  only by a launch flag xray does not require of its users.
- **MV3 plumbing.** The service worker idles out (~30s); no persistent port is
  held across the sweep — each `emulate`/`reset` command is a `runtime.onMessage`
  round-trip whose returned pending Promise keeps the worker alive for that
  command. The debugger session is attached only for the sweep, then detached and
  the override cleared.
- **A DevTools panel stays viable for a _different_ job** — capture inspection
  (read `__XRAY__` coverage, diff live vs committed plate, watch `POST /__xray`).
  That needs no emulation and is orthogonal to capture-all; noted, not built.

## Realized

Built and working; the controller/executor split landed as designed:

- **Controller — the HUD** (`packages/xray/src/hud.ts`): probes for the extension
  (`whois`/`hello` over `postMessage`), shows the **Capture all views** button when
  it's present or an install promotion when not, and reports sweep progress.
- **Sweep — the dev client** (`__XRAY__.captureAllViews`): discovers target widths
  **in-session** — the matchMedia spy unioned with the breakpoints derived from the
  views captured so far this sweep (the per-site session bundle) — never from the
  on-disk plate, which is a derived, geometry-stripped artifact written only at the
  end. CSS-only `@media` breakpoints fire no `matchMedia`, so the anchor view's
  lifted author rules are what reliably reveal every band; read widths from disk
  instead and a sweep can visit only the anchor width, whose lone view renders
  ungated at every width. Per pass it picks a representative width per uncovered
  band, drives the extension `emulate(width, height, mobile)` for each, awaits the
  real per-site settle (re-capturing every mounted site), then re-derives the
  breakpoint union and repeats to a fixpoint; clears the override at the end.
  Coverage read back from disk survives only for the HUD coverage display. The
  fixpoint is **bounded and fails loudly**: it runs at most `MAX_SWEEP_PASSES`
  passes (the constant lives
  in `client.ts`), and a sweep that keeps discovering new widths without converging
  throws a capture-all failure to the HUD rather than hanging or silently truncating
  coverage.
- **Executor — the extension** (`apps/extension`): `background.ts` answers
  `emulate`/`reset` over `chrome.debugger` (attach-once per tab, then
  `Emulation.setDeviceMetricsOverride` / `clearDeviceMetricsOverride`);
  `dev-bridge.content.ts` relays page↔worker and beacons presence. It carries no
  widths and no loop — the page drives.

Open tail (tracked on the [roadmap](https://xray-js.dev/roadmap/), not blockers): the extension loads unpacked
in dev (no Chrome Web Store package yet); its content script matches only
`http://localhost/*` and `http://127.0.0.1/*` (broaden for other dev origins); and
tall/lazy (`IntersectionObserver`) content below a short emulated height may need a
driven scroll or a taller emulation.
