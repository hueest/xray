import { describe, expect, it } from 'vitest'

import {
  ALLOWED_CDP_PREFIXES,
  cdpDenialError,
  isAllowedCdpMethod,
  isDeniedCdp,
  parseBridgeCommand,
} from './protocol'

/**
 * The allowlist is the bridge's security boundary (ADR 0030): the relay is reachable by any script
 * on the page, so these tests pin what may and may not reach `chrome.debugger`.
 */

describe('the CDP method allowlist', () => {
  it('admits only viewport/input emulation domains', () => {
    expect(isAllowedCdpMethod('Emulation.setDeviceMetricsOverride')).toBe(true)
    expect(isAllowedCdpMethod('Emulation.setEmulatedMedia')).toBe(true)
    expect(isAllowedCdpMethod('Input.synthesizeScrollGesture')).toBe(true)
  })

  it('refuses every data-reading or execution domain', () => {
    for (const method of [
      'Network.getAllCookies',
      'Runtime.evaluate',
      'Target.createTarget',
      'Page.captureScreenshot',
      'Storage.getCookies',
      'Browser.getVersion',
      'DOM.getDocument',
      // Prefix tricks must not pass.
      'EmulationX.setDeviceMetricsOverride',
      'emulation.setDeviceMetricsOverride',
      '',
    ]) {
      expect(isAllowedCdpMethod(method), method).toBe(false)
    }
    expect(isAllowedCdpMethod(undefined)).toBe(false)
    expect(isAllowedCdpMethod(42)).toBe(false)
  })
})

describe('parseBridgeCommand', () => {
  it('parses the two blessed shorthands', () => {
    expect(parseBridgeCommand({ source: 'xray', kind: 'emulate', id: 1, width: 390 })).toEqual({
      kind: 'emulate',
      id: 1,
      width: 390,
      height: undefined,
      mobile: undefined,
    })
    expect(parseBridgeCommand({ source: 'xray', kind: 'reset', id: 2 })).toEqual({
      kind: 'reset',
      id: 2,
    })
  })

  it('parses an allowlisted cdp command and drops junk params', () => {
    expect(
      parseBridgeCommand({
        source: 'xray',
        kind: 'cdp',
        id: 3,
        method: 'Input.synthesizeScrollGesture',
        params: { x: 0, y: 0, yDistance: -800 },
      }),
    ).toEqual({
      kind: 'cdp',
      id: 3,
      method: 'Input.synthesizeScrollGesture',
      params: { x: 0, y: 0, yDistance: -800 },
    })
    expect(
      parseBridgeCommand({ source: 'xray', kind: 'cdp', id: 4, method: 'Emulation.x', params: 7 }),
    ).toEqual({ kind: 'cdp', id: 4, method: 'Emulation.x', params: undefined })
  })

  it('returns null for junk, wrong sources, missing ids, and DENIED cdp methods', () => {
    expect(parseBridgeCommand(null)).toBeNull()
    expect(parseBridgeCommand('emulate')).toBeNull()
    expect(parseBridgeCommand({ source: 'evil', kind: 'emulate', id: 1, width: 390 })).toBeNull()
    expect(parseBridgeCommand({ source: 'xray', kind: 'emulate', width: 390 })).toBeNull()
    expect(parseBridgeCommand({ source: 'xray', kind: 'emulate', id: 1 })).toBeNull()
    expect(
      parseBridgeCommand({ source: 'xray', kind: 'cdp', id: 5, method: 'Runtime.evaluate' }),
    ).toBeNull()
  })

  it('flags denied cdp for the explanatory ack, but never other junk', () => {
    expect(isDeniedCdp({ source: 'xray', kind: 'cdp', id: 5, method: 'Runtime.evaluate' })).toBe(
      true,
    )
    expect(isDeniedCdp({ source: 'xray', kind: 'cdp', id: 6 })).toBe(true)
    expect(isDeniedCdp({ source: 'xray', kind: 'emulate', id: 1, width: 390 })).toBe(false)
    expect(isDeniedCdp({ source: 'evil', kind: 'cdp', id: 5, method: 'Runtime.evaluate' })).toBe(
      false,
    )
    expect(cdpDenialError('Runtime.evaluate')).toContain('Runtime.evaluate')
    expect(cdpDenialError('Runtime.evaluate')).toContain(ALLOWED_CDP_PREFIXES[0])
    expect(cdpDenialError(42)).toContain('(invalid)')
  })
})
