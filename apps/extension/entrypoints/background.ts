/// <reference types="chrome" />
// Background service worker (MV3) — the thin executor (ADR 0010). No UI, no
// widths, no loop: it answers two commands relayed from the page by the
// dev-bridge content script. `emulate` attaches chrome.debugger to the sender's
// tab (once) and sets the device metrics; `reset` clears the override and
// detaches. The page (the xray HUD) is the controller and owns all the
// orchestration — which widths, in what order, and when each view has settled.

const attached = new Set<number>()

type Ack = { ok: true } | { ok: false; error: string }

const settle = (promise: Promise<void>): Promise<Ack> =>
  promise.then(
    () => ({ ok: true }),
    (error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )

async function emulate(
  tabId: number,
  params: { width: number; height: number; mobile: boolean },
): Promise<void> {
  const target: chrome.debugger.Debuggee = { tabId }
  if (!attached.has(tabId)) {
    await chrome.debugger.attach(target, '1.3')
    attached.add(tabId)
  }
  await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
    width: params.width,
    height: params.height,
    deviceScaleFactor: 1,
    mobile: params.mobile,
  })
}

async function reset(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride')
  } finally {
    await chrome.debugger.detach(target)
    attached.delete(tabId)
  }
}

export default defineBackground(() => {
  // Forget a tab whose debugger detaches for any reason (tab closed, DevTools
  // opened, user dismissed the infobar) so the next emulate re-attaches cleanly.
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === 'number') attached.delete(source.tabId)
  })

  // webextension-polyfill responds with the Promise the listener returns; the
  // tab is the content script's own tab (sender.tab), so the page never handles
  // tab ids. Returning the pending promise also keeps the worker alive.
  browser.runtime.onMessage.addListener(
    (
      message: { kind?: string; width?: number; height?: number; mobile?: boolean },
      sender,
    ): Promise<Ack> | undefined => {
      const tabId = sender.tab?.id
      if (typeof tabId !== 'number') return undefined
      if (message?.kind === 'emulate' && typeof message.width === 'number') {
        return settle(
          emulate(tabId, {
            width: message.width,
            height: message.height ?? 2400,
            mobile: message.mobile ?? false,
          }),
        )
      }
      if (message?.kind === 'reset') return settle(reset(tabId))
      return undefined
    },
  )
})
