import { defineConfig } from 'wxt'

// xray dev-bridge extension (ADR 0010; protocol v2 + activation model in ADR 0030). Chrome-first /
// MV3. The faithful viewport sweep needs `chrome.debugger` → CDP `Emulation`, so the `debugger`
// permission is the core ask (it shows the "started debugging this browser" infobar, and can't
// attach while DevTools is open on the tab — both documented limits). `activeTab` + `scripting`
// power the toolbar action's per-tab injection for non-loopback dev origins — an explicit user
// gesture instead of broad host permissions.
export default defineConfig({
  manifest: {
    name: 'xray dev bridge',
    description: "Dev-only: sweep a skeleton's breakpoints and capture every view in one click.",
    permissions: ['debugger', 'activeTab', 'scripting'],
    action: {
      default_title: 'xray: connect this tab (dev bridge)',
    },
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
  },
})
