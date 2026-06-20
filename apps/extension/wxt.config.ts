import { defineConfig } from 'wxt'

// xray capture-all-views extension (ADR 0010). Chrome-first / MV3.
// The faithful viewport sweep needs `chrome.debugger` → CDP `Emulation`, so the
// `debugger` permission is the core ask (it shows the "started debugging this
// browser" infobar, and can't attach while DevTools is open on the tab — both
// documented limits). See docs/adr/0010-capture-all-views-via-extension.md.
// https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'xray — capture all views',
    description: "Dev-only: sweep a skeleton's breakpoints and capture every view in one click.",
    permissions: ['debugger', 'activeTab'],
  },
})
