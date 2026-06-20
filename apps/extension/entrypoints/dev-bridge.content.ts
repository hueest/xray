// Dev-bridge content script — the extension's only surface (ADR 0010). The page
// (the xray HUD) is the controller; this is a two-way relay plus a presence
// beacon. It announces the extension to the page, answers `whois`, and forwards
// the page's emulate/reset commands to the background, acking each by id.
//
// Note: this injects only on matched origins (dev hosts). An unmatched dev host
// won't get the extension, and the HUD will show its "install" promo even when
// it's installed — broaden the matches to cover your dev origins.
const VERSION = '0.0.0'

type PageMessage = { source?: string; kind?: string; id?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
  matches: ['http://localhost/*', 'http://127.0.0.1/*'],
  main() {
    const announce = () =>
      window.postMessage({ source: 'xray-ext', kind: 'hello', version: VERSION }, '*')

    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      if (!isPageMessage(event.data) || event.data.source !== 'xray') return
      const message = event.data
      if (message.kind === 'whois') {
        announce()
        return
      }
      if (message.kind === 'emulate' || message.kind === 'reset') {
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

    // Proactively, in case the page's HUD mounted before this script loaded.
    announce()
  },
})
