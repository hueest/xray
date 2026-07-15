// Dev-bridge content script — the extension's only page surface (ADR 0010, protocol v2 in ADR
// 0030). The page (the xray dev client) is the controller; this is a two-way relay plus a
// presence beacon. It announces the extension (version + capabilities), answers `whois`, and
// forwards the page's commands to the background, acking each by id.
//
// It AUTO-injects only on dev loopback origins (localhost, 127.0.0.1, *.localhost). Any other
// origin — tunnels, LAN hosts, custom dev domains — gets the SAME script injected by the toolbar
// action's explicit per-tab click (background.ts), which is why the double-injection guard below
// must make a second run a no-op.

import { BRIDGE_CAPS } from '../utils/protocol'

declare global {
  interface Window {
    xrayBridgeInstalled?: boolean
  }
}

type PageMessage = { source?: string; kind?: string; id?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function announce(): void {
  window.postMessage(
    {
      source: 'xray-ext',
      kind: 'hello',
      version: browser.runtime.getManifest().version,
      caps: [...BRIDGE_CAPS],
    },
    '*',
  )
}

function isPageMessage(value: unknown): value is PageMessage {
  return (
    isRecord(value) &&
    (!('source' in value) || typeof value.source === 'string') &&
    (!('kind' in value) || typeof value.kind === 'string') &&
    (!('id' in value) || typeof value.id === 'number')
  )
}

export default defineContentScript({
  matches: [
    'http://localhost/*',
    'https://localhost/*',
    'http://127.0.0.1/*',
    'https://127.0.0.1/*',
    'http://*.localhost/*',
    'https://*.localhost/*',
  ],
  main() {
    // The toolbar action injects this same script on click; a repeat run must be
    // a no-op or the page would receive duplicate ACKs for every command.
    if (window.xrayBridgeInstalled) return
    window.xrayBridgeInstalled = true

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (!isPageMessage(event.data) || event.data.source !== 'xray') return
      const message = event.data
      if (message.kind === 'whois') {
        announce()
        return
      }
      if (message.kind === 'emulate' || message.kind === 'reset' || message.kind === 'cdp') {
        void browser.runtime.sendMessage(message).then(
          (result: unknown) => {
            const details = isRecord(result)
              ? result
              : { ok: false, error: 'invalid extension response' }
            window.postMessage({ source: 'xray-ext', kind: 'ack', id: message.id, ...details }, '*')
          },
          (error: unknown) =>
            window.postMessage(
              {
                source: 'xray-ext',
                kind: 'ack',
                id: message.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              '*',
            ),
        )
      }
    })

    // Proactively, in case the page's client installed before this script loaded
    // (or the user just clicked the action on an already-loaded page).
    announce()
  },
})
