---
status: accepted
---

# The dev bridge: an allowlisted CDP relay, activated per tab outside dev loopback

> **Amends [ADR 0010](./0010-capture-all-views-via-extension.md): the extension
> keeps its thin-executor role, but the protocol becomes versioned and generic
> (a capability handshake plus one allowlisted `cdp` command) and activation on
> non-loopback origins becomes an explicit per-tab user gesture. Keeps
> [ADR 0027](./0027-one-session-one-mode.md) §2 intact — the bridge remains an
> amplifier the client drives; no orchestration moves into it.**

Two pressures on the ADR 0010 design. First, release coupling: the extension
knew exactly two commands (`emulate`, `reset`), so every future capability —
the roadmap's non-width axes (`Emulation.setEmulatedMedia`), a driven scroll
for lazy content (`Input.synthesizeScrollGesture`) — would need an extension
release marching in step with npm. Second, reach: the content script matched
only `localhost`/`127.0.0.1`, so a dev server on a tunnel, a LAN host, or a
custom domain silently got no bridge and the HUD showed its install promo to
someone who had installed it.

## Decision

### 1. A generic `cdp` command behind a method allowlist

The relay accepts `{ kind: 'cdp', id, method, params }` and executes it via
`chrome.debugger.sendCommand` — but ONLY for methods under the allowlisted
prefixes (`Emulation.`, `Input.`; `utils/protocol.ts`). The allowlist is the
security boundary, not a convenience: the bridge is reachable by ANY script on
the page via `window.postMessage`, and an unrestricted proxy would hand page
JavaScript cross-origin powers (`Network.getAllCookies`, `Runtime.evaluate` in
other frames, `Target.*`). Viewport and input emulation pass — everything the
sweep and the planned axes need, nothing that reads data. A denied method gets
an explanatory error ack (the page learns why instead of timing out), and
widening the list is an ADR-level decision. `emulate`/`reset` remain as the
two blessed shorthands the client uses today; new capabilities ship as npm
updates with zero extension releases.

### 2. A versioned, capability-carrying hello

The bridge announces `{ version, caps: ['emulate', 'cdp'] }` (version from the
manifest). The client keys PURELY on `caps` — a hello without them announces
no usable capability — so the HUD can distinguish "no extension" (promo card)
from "extension too old for X" (warnline) with a precise message rather than
a timeout.

### 3. Auto-inject on dev loopback; explicit per-tab activation everywhere else

The content script auto-runs on `localhost`, `127.0.0.1`, and `*.localhost`
(http and https). Everywhere else, clicking the toolbar action injects the
SAME script into the current tab: `activeTab` grants that origin for exactly
that user gesture, `scripting.executeScript` delivers it, and a badge marks
the connected tab. No `<all_urls>` host permission, no announcing the
extension's presence to every site on the web, and the Web-Store-review story
stays "narrow permissions, explicit activation". The script guards against
double-injection so clicking on a dev origin is a no-op. `[::1]` is left out
of the static matches (match-pattern support is inconsistent); the action
click covers it.

### 4. Distribution

`wxt zip` produces the store-ready archive; a GitHub Releases zip ships first
(loaded unpacked or dragged into `chrome://extensions`), the Web Store later —
`debugger` triggers manual review, and the narrow allowlist plus
gesture-gated activation is the case made to it. The protocol decoupling in §1
is what makes store-review lag survivable: npm never waits on it.

## Considered alternatives

- **Full CDP proxy, no allowlist**: rejected outright — it converts "any
  script on a dev page" into "a debugger on the user's browser".
- **Per-feature commands forever**: rejected — release coupling between the
  npm package and a store-reviewed artifact is the exact failure mode this
  amendment removes.
- **`optional_host_permissions` + an options page**: more machinery and a
  scarier prompt than `activeTab`'s per-gesture grant, for no additional
  capability.

## Consequences

- The extension version signals PROTOCOL capability only; `caps` is what the
  client keys on.
- `chrome.debugger`'s documented limits remain: the "started debugging"
  infobar, and no attach while DevTools is open on the tab (the HUD's
  sweep-failure guidance).
- The protocol module is pure and unit-tested (`utils/protocol.test.ts`,
  wired into the workspace test gate); the allowlist refusals are pinned.
