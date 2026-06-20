// @vitest-environment happy-dom
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'

import { installXrayHud } from './hud.ts'
import type { CaptureHook, CoverageStore, PlateCoverage, ToggleStore } from './plate.ts'

/**
 * DOM tests for the dev HUD (hud.ts). The HUD renders entirely from the `globalThis.__XRAY__` hook,
 * probes for the companion extension over `window.postMessage`, and shows a sweep button (extension
 * present) or a promo (absent). We drive the real seams: a hand-built `__XRAY__` hook, a dispatched
 * extension `hello`, and a stubbed `captureAllViews` for the status path.
 *
 * The panel lives in a shadow root on a `[data-xray-hud]` host appended to body.
 */

let hud: { dispose: () => void } | undefined

/** A minimal in-memory toggle store, like the client's `createToggleStore`. */
function makeToggle(initial = false): ToggleStore {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      for (const cb of listeners) cb()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

/** A minimal in-memory coverage store, like the client's. */
function makeCoverage(initial: Record<string, PlateCoverage> = {}): CoverageStore {
  const map = new Map(Object.entries(initial))
  const listeners = new Set<() => void>()
  return {
    get: () => map,
    set(name, coverage) {
      map.set(name, coverage)
      for (const cb of listeners) cb()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

function installHook(overrides: Partial<CaptureHook> = {}): void {
  globalThis.__XRAY__ = {
    captured: () => undefined,
    capture: makeToggle(false),
    lightbox: makeToggle(false),
    coverage: makeCoverage(),
    captureAllViews: () => Promise.resolve(),
    ...overrides,
  }
}

/** The HUD's shadow root, after install. */
function shadow(): ShadowRoot {
  const host = document.querySelector('[data-xray-hud]')
  if (!host?.shadowRoot) throw new Error('HUD host not mounted')
  return host.shadowRoot
}

/** The sweep button, asserted present (only rendered once the extension says hello). */
function actionButton(): HTMLButtonElement {
  const button = shadow().querySelector<HTMLButtonElement>('.action')
  assert(button, 'expected the sweep button to be rendered')
  return button
}

/** A promise plus its resolve handle, for controlling an in-flight sweep. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Simulate the extension announcing itself with a `hello`. */
function sendHello(): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'xray-ext', kind: 'hello' },
      source: window,
    }),
  )
}

beforeEach(() => {
  installHook()
})

afterEach(() => {
  hud?.dispose()
  hud = undefined
  globalThis.__XRAY__ = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('installXrayHud rendering', () => {
  it('mounts a shadow-rooted panel on the body', () => {
    hud = installXrayHud()
    const host = document.querySelector('[data-xray-hud]')
    expect(host).not.toBeNull()
    expect(host?.shadowRoot?.querySelector('.hud')).not.toBeNull()
  })

  it('titles itself with the plate count from coverage', () => {
    installHook({
      coverage: makeCoverage({
        hero: { breakpoints: [], spans: [] },
        card: { breakpoints: [], spans: [] },
      }),
    })
    hud = installXrayHud()
    expect(shadow().querySelector('.title')?.textContent).toBe('xray — 2 plates')
  })

  it('renders per-plate band chips, lit for covered spans and dim for missing', () => {
    installHook({
      coverage: makeCoverage({
        hero: { breakpoints: [768], spans: [{ min: undefined, max: 768 }] },
      }),
    })
    hud = installXrayHud()
    const chips = [...shadow().querySelectorAll('.band')]
    // breakpoints:[768] → two bands: [0,768) covered, [768,∞) missing.
    expect(chips.map((c) => c.textContent)).toEqual(['[0,768)', '[768,∞)'])
    expect(chips[0]?.className).toContain('covered')
    expect(chips[1]?.className).toContain('missing')
  })
})

describe('installXrayHud extension detection (promo vs button)', () => {
  it('posts a whois probe on install', () => {
    const post = vi.spyOn(window, 'postMessage')
    hud = installXrayHud()
    expect(post).toHaveBeenCalledWith({ source: 'xray', kind: 'whois' }, '*')
  })

  it('shows the promo (no button) before the extension is detected', () => {
    hud = installXrayHud()
    expect(shadow().querySelector('.action')).toBeNull()
    expect(shadow().querySelector('.promo')?.textContent).toContain('Install the xray extension')
  })

  it('flips to the sweep button when a hello arrives', () => {
    hud = installXrayHud()
    expect(shadow().querySelector('.action')).toBeNull()
    sendHello()
    const button = shadow().querySelector('.action')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('Capture all views')
    expect(shadow().querySelector('.promo')).toBeNull()
  })

  it('ignores hello-shaped messages from a different window source', () => {
    hud = installXrayHud()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'xray-ext', kind: 'hello' },
        source: null,
      }),
    )
    expect(shadow().querySelector('.action')).toBeNull()
    expect(shadow().querySelector('.promo')).not.toBeNull()
  })

  it('hides both button and promo when captureAllViews is absent (prod-like hook)', () => {
    installHook({ captureAllViews: undefined })
    hud = installXrayHud()
    sendHello()
    expect(shadow().querySelector('.action')).toBeNull()
    expect(shadow().querySelector('.promo')).toBeNull()
  })
})

describe('installXrayHud sweep status', () => {
  it('disables the button mid-sweep and shows a success status when it resolves', async () => {
    const sweep = deferred()
    const captureAllViews = vi.fn(() => sweep.promise)
    installHook({ captureAllViews })
    hud = installXrayHud()
    sendHello()

    const button = actionButton()
    button.click()
    expect(captureAllViews).toHaveBeenCalledTimes(1)
    // Re-query: render() rebuilds the panel on each state change.
    expect(shadow().querySelector<HTMLButtonElement>('.action')?.disabled).toBe(true)
    expect(shadow().querySelector<HTMLButtonElement>('.action')?.textContent).toBe(
      'Capturing all views…',
    )

    sweep.resolve()
    await vi.waitFor(() => {
      expect(shadow().querySelector('.status')?.textContent).toBe('Done — coverage updated.')
    })
    expect(shadow().querySelector<HTMLButtonElement>('.action')?.disabled).toBe(false)
  })

  it('shows a failure status with the error message when the sweep rejects', async () => {
    const captureAllViews = vi.fn(() => Promise.reject(new Error('debugger detach')))
    installHook({ captureAllViews })
    hud = installXrayHud()
    sendHello()

    actionButton().click()
    await vi.waitFor(() => {
      expect(shadow().querySelector('.status')?.textContent).toBe('Failed: debugger detach')
    })
    // Button re-enabled so the user can retry.
    expect(shadow().querySelector<HTMLButtonElement>('.action')?.disabled).toBe(false)
  })

  it('ignores a second click while a sweep is already in flight', async () => {
    const sweep = deferred()
    const captureAllViews = vi.fn(() => sweep.promise)
    installHook({ captureAllViews })
    hud = installXrayHud()
    sendHello()

    actionButton().click()
    expect(captureAllViews).toHaveBeenCalledTimes(1)

    // After the first click, render() rebuilt the button with `disabled = true`,
    // and happy-dom (like a real browser) drops BOTH `.click()` and a dispatched
    // click on a disabled button. So a second `.click()` would prove the DOM's
    // disabled behavior, NOT the `if (sweeping) return` guard — the handler never
    // even runs. To genuinely RE-ENTER `startSweep` while the sweep is still in
    // flight, re-enable the button (bypassing only the DOM gate) and dispatch a
    // click: the SAME path the button triggers (`void startSweep()`) now runs a
    // second time with `sweeping` still true. Only the `sweeping` guard can keep
    // `captureAllViews` at one call; delete it and the handler calls it twice.
    const reentered = actionButton()
    assert(reentered.disabled, 'the button should be disabled mid-sweep')
    reentered.disabled = false
    reentered.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(captureAllViews).toHaveBeenCalledTimes(1)

    sweep.resolve()
    await vi.waitFor(() => {
      expect(shadow().querySelector('.status')?.textContent).toContain('Done')
    })
  })
})

describe('installXrayHud toggle rows', () => {
  it('renders Capture and Light Box checkboxes reflecting the stores', () => {
    installHook({ capture: makeToggle(true), lightbox: makeToggle(false) })
    hud = installXrayHud()
    const labels = [...shadow().querySelectorAll('.toggle')]
    const texts = labels.map((l) => l.textContent)
    expect(texts).toEqual(['Capture', 'Light Box'])
    const boxes = shadow().querySelectorAll<HTMLInputElement>('.toggle input')
    expect(boxes.item(0).checked).toBe(true)
    expect(boxes.item(1).checked).toBe(false)
  })

  it('the Capture checkbox writes the capture store on change', () => {
    const capture = makeToggle(false)
    installHook({ capture })
    hud = installXrayHud()
    const box = shadow().querySelectorAll<HTMLInputElement>('.toggle input').item(0)
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(capture.get()).toBe(true)
  })

  it('the Light Box checkbox writes the lightbox store on change', () => {
    const lightbox = makeToggle(false)
    // No capture toggle, so Light Box is the only row.
    installHook({ capture: undefined, lightbox })
    hud = installXrayHud()
    const box = shadow().querySelector<HTMLInputElement>('.toggle input')!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(lightbox.get()).toBe(true)
  })
})

describe('installXrayHud dispose', () => {
  it('removes the host and stops reacting to coverage and messages', () => {
    const coverage = makeCoverage()
    installHook({ coverage })
    hud = installXrayHud()
    expect(document.querySelector('[data-xray-hud]')).not.toBeNull()
    hud.dispose()
    hud = undefined
    expect(document.querySelector('[data-xray-hud]')).toBeNull()
    // A late hello must not throw now that the listener is gone.
    expect(() => sendHello()).not.toThrow()
    // A coverage change has no panel to update.
    expect(() => coverage.set('late', { breakpoints: [], spans: [] })).not.toThrow()
  })
})
