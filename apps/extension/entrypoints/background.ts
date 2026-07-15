/// <reference types="chrome" />
// Background service worker (MV3) — the thin executor (ADR 0010, protocol v2 in ADR 0030). No UI,
// no widths, no loop: it answers commands relayed from the page by the dev-bridge content script.
// `emulate`/`reset` are the two blessed shorthands (attach + device-metrics override / clear +
// detach); `cdp` executes an ALLOWLISTED raw command (Emulation.*, Input.*) so new package
// capabilities ship as npm updates without an extension release — the allowlist, not the
// extension version, is the security boundary (utils/protocol.ts). The page (the xray dev client)
// is the controller and owns all orchestration.
//
// The toolbar action injects the same dev bridge into ANY page on click (activeTab + scripting):
// auto-injection stays scoped to dev loopback origins, and everything else — tunnels, LAN hosts,
// custom dev domains — is an explicit per-tab user gesture, never a broad host permission.

import { cdpDenialError, isDeniedCdp, parseBridgeCommand } from '../utils/protocol'

const attached = new Set<number>()

type Ack = { ok: true; result?: unknown } | { ok: false; error: string }

const fail = (error: unknown): Ack => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
})

async function ensureAttached(tabId: number): Promise<chrome.debugger.Debuggee> {
  const target: chrome.debugger.Debuggee = { tabId }
  if (!attached.has(tabId)) {
    await chrome.debugger.attach(target, '1.3')
    attached.add(tabId)
  }
  return target
}

async function emulate(
  tabId: number,
  params: { width: number; height: number; mobile: boolean },
): Promise<Ack> {
  try {
    const target = await ensureAttached(tabId)
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width: params.width,
      height: params.height,
      deviceScaleFactor: 1,
      mobile: params.mobile,
    })
    return { ok: true }
  } catch (error) {
    return fail(error)
  }
}

async function reset(tabId: number): Promise<Ack> {
  if (!attached.has(tabId)) return { ok: true }
  const target: chrome.debugger.Debuggee = { tabId }
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride')
    return { ok: true }
  } catch (error) {
    return fail(error)
  } finally {
    try {
      await chrome.debugger.detach(target)
    } catch {
      // Already detached (tab closed, DevTools took over) — the set is pruned below.
    }
    attached.delete(tabId)
  }
}

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<Ack> {
  try {
    const target = await ensureAttached(tabId)
    const result = await chrome.debugger.sendCommand(target, method, params)
    return { ok: true, result }
  } catch (error) {
    return fail(error)
  }
}

export default defineBackground(() => {
  // Forget a tab whose debugger detaches for any reason (tab closed, DevTools
  // opened, user dismissed the infobar) so the next command re-attaches cleanly.
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId === 'number') attached.delete(source.tabId)
  })

  // webextension-polyfill responds with the Promise the listener returns; the
  // tab is the content script's own tab (sender.tab), so the page never handles
  // tab ids. Returning the pending promise also keeps the worker alive.
  browser.runtime.onMessage.addListener((message: unknown, sender): Promise<Ack> | undefined => {
    const tabId = sender.tab?.id
    if (typeof tabId !== 'number') return undefined
    const command = parseBridgeCommand(message)
    if (command?.kind === 'emulate') {
      return emulate(tabId, {
        width: command.width,
        height: command.height ?? 2400,
        mobile: command.mobile ?? false,
      })
    }
    if (command?.kind === 'reset') return reset(tabId)
    if (command?.kind === 'cdp') return cdp(tabId, command.method, command.params)
    // A cdp command whose method the allowlist refuses gets an EXPLANATORY ack
    // (the page learns why instead of timing out); everything else is ignored.
    if (isDeniedCdp(message)) {
      return Promise.resolve({ ok: false, error: cdpDenialError(message.method) })
    }
    return undefined
  })

  // The toolbar action: inject the dev bridge into the current tab on demand.
  // activeTab grants this tab's origin for exactly this user gesture — no broad
  // host permissions, no announcing the extension's presence to every site. The
  // content script guards itself against double-injection, so clicking a dev
  // origin where it auto-ran is a no-op.
  chrome.action.onClicked.addListener((tab) => {
    const tabId = tab.id
    if (typeof tabId !== 'number') return
    const file = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0]
    if (!file) return
    chrome.scripting
      .executeScript({ target: { tabId }, files: [file] })
      .then(() => {
        void chrome.action.setBadgeBackgroundColor({ tabId, color: '#5c88c5' })
        void chrome.action.setBadgeText({ tabId, text: 'ON' })
      })
      .catch((error: unknown) => {
        // Restricted page (chrome://, Web Store) or a denied gesture — nothing to do.
        console.warn('[xray] bridge injection failed:', error)
      })
  })
})
