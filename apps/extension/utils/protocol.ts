/**
 * The dev-bridge protocol (ADR 0030). The extension is a thin, LONG-LIVED relay: the page (the xray
 * dev client) owns all orchestration, and the extension's only jobs are announcing itself, relaying
 * commands to `chrome.debugger`, and acking. New package capabilities must ship as npm updates
 * without touching the extension — hence one generic `cdp` command behind a METHOD ALLOWLIST
 * instead of per-feature commands.
 *
 * The allowlist is the security boundary, not a convenience: the bridge is reachable by ANY script
 * on the page via `window.postMessage`, and an unrestricted `chrome.debugger` proxy would hand page
 * JavaScript cross-origin powers (`Network.getAllCookies`, `Runtime.evaluate` in other frames,
 * `Target.*`). Only viewport/input emulation domains pass — everything the sweep and the roadmap's
 * non-width axes need, nothing that reads data.
 */

/** CDP method prefixes the relay will execute. Widening this list is an ADR-level decision. */
export const ALLOWED_CDP_PREFIXES = ['Emulation.', 'Input.'] as const

/** The capabilities the current bridge announces in its `hello`. */
export const BRIDGE_CAPS = ['emulate', 'cdp'] as const

export function isAllowedCdpMethod(method: unknown): method is string {
  return (
    typeof method === 'string' && ALLOWED_CDP_PREFIXES.some((prefix) => method.startsWith(prefix))
  )
}

/** A command relayed from the page: the two blessed shorthands, or an allowlisted raw CDP call. */
export type BridgeCommand =
  | { kind: 'emulate'; id: number; width: number; height?: number; mobile?: boolean }
  | { kind: 'reset'; id: number }
  | { kind: 'cdp'; id: number; method: string; params?: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Parse a page message into a relayable command, or `null` for anything else (junk, whois — the
 * content script answers that itself, unknown kinds). A `cdp` command with a NON-allowlisted method
 * parses to null here so callers treat it exactly like junk at the type level; the background still
 * answers it with an explanatory error ack (see `cdpDenialError`), so the page learns WHY instead
 * of timing out.
 */
export function parseBridgeCommand(value: unknown): BridgeCommand | null {
  if (!isRecord(value) || value.source !== 'xray' || typeof value.id !== 'number') return null
  if (value.kind === 'emulate' && typeof value.width === 'number') {
    return {
      kind: 'emulate',
      id: value.id,
      width: value.width,
      height: typeof value.height === 'number' ? value.height : undefined,
      mobile: typeof value.mobile === 'boolean' ? value.mobile : undefined,
    }
  }
  if (value.kind === 'reset') return { kind: 'reset', id: value.id }
  if (value.kind === 'cdp' && isAllowedCdpMethod(value.method)) {
    return {
      kind: 'cdp',
      id: value.id,
      method: value.method,
      params: isRecord(value.params) ? value.params : undefined,
    }
  }
  return null
}

/** True when a message LOOKS like a cdp command whose method the allowlist refuses. */
export function isDeniedCdp(value: unknown): value is { id: number; method?: unknown } {
  return (
    isRecord(value) &&
    value.source === 'xray' &&
    value.kind === 'cdp' &&
    typeof value.id === 'number' &&
    !isAllowedCdpMethod(value.method)
  )
}

export function cdpDenialError(method: unknown): string {
  return `xray bridge: CDP method not allowed: ${typeof method === 'string' ? method : '(invalid)'} — allowed prefixes: ${ALLOWED_CDP_PREFIXES.join(', ')}`
}
