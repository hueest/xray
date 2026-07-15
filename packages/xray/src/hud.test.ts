// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { flush } from 'solid-js'

import { installXrayHud } from './hud.tsx'
import type {
  CaptureHook,
  ModeStore,
  MountedPlate,
  PlateCoverage,
  SessionSnapshot,
  ToggleStore,
  XrayModeState,
} from './plate.ts'

/**
 * DOM tests for the Solid HUD. The HUD is a pure projection of the `__XRAY__` stores (ADR 0027 §4):
 * every test builds a fake hook, mutates its stores, and asserts the shadow DOM. Writes are flushed
 * (Solid batches on microtasks) and the store subscriptions attach on settle, so `tick` runs a
 * flush plus a macrotask.
 */

let handle: { dispose: () => void } | undefined

afterEach(() => {
  handle?.dispose()
  handle = undefined
  globalThis.__XRAY__ = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const tick = async (): Promise<void> => {
  flush()
  await new Promise((r) => setTimeout(r, 0))
  flush()
}

function makeToggle(initial = false): ToggleStore {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const cb of listeners) cb()
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

interface FakeStores {
  hook: CaptureHook
  setMode: (state: XrayModeState) => void
  setSession: (patch: Partial<SessionSnapshot>) => void
  setSites: (entries: Record<string, Partial<MountedPlate>>) => void
  setCoverage: (entries: Record<string, PlateCoverage>) => void
  setExtension: (state: { present: boolean; version?: string; caps: readonly string[] }) => void
  setFixture: (
    name: string,
    status: { participates: boolean; recorded: boolean; replaying: boolean },
  ) => void
  setDiagnostics: (name: string, lines: string[]) => void
  mode: ModeStore
  replay: ToggleStore
  highlight: ReturnType<typeof vi.fn>
}

function makeHook(): FakeStores {
  const listeners = {
    mode: new Set<() => void>(),
    session: new Set<() => void>(),
    sites: new Set<() => void>(),
    coverage: new Set<() => void>(),
    extension: new Set<() => void>(),
    fixtures: new Set<() => void>(),
    diagnostics: new Set<() => void>(),
  }
  const notify = (key: keyof typeof listeners) => {
    for (const cb of listeners[key]) cb()
  }
  const sub =
    (key: keyof typeof listeners) =>
    (cb: () => void): (() => void) => {
      listeners[key].add(cb)
      return () => listeners[key].delete(cb)
    }

  let modeState: XrayModeState = { action: 'idle' }
  let session: SessionSnapshot = { views: new Map(), save: 'idle', savedCount: 0 }
  const sitesMap = new Map<string, MountedPlate>()
  const coverageMap = new Map<string, PlateCoverage>()
  let extension: { present: boolean; version?: string; caps: readonly string[] } = {
    present: false,
    caps: [],
  }
  const fixtureStatuses = new Map<
    string,
    { participates: boolean; recorded: boolean; replaying: boolean }
  >()
  const diagnosticsMap = new Map<string, string[]>()
  const replay = makeToggle(false)
  const highlight = vi.fn()

  const mode: ModeStore = {
    get: () => modeState,
    subscribe: sub('mode'),
    setRecord: vi.fn(async (on: boolean) => {
      modeState = on ? { action: 'record', scope: 'global' } : { action: 'idle' }
      notify('mode')
    }),
    setLightbox: vi.fn((on: boolean) => {
      modeState = on ? { action: 'lightbox', scope: 'global' } : { action: 'idle' }
      notify('mode')
    }),
    recordName: vi.fn(async (name: string, on: boolean) => {
      const scope =
        modeState.action === 'record' && modeState.scope !== 'global'
          ? new Set(modeState.scope)
          : new Set<string>()
      if (on) scope.add(name)
      else scope.delete(name)
      modeState = scope.size > 0 ? { action: 'record', scope } : { action: 'idle' }
      notify('mode')
    }),
    lightboxName: vi.fn((name: string, on: boolean) => {
      const scope =
        modeState.action === 'lightbox' && modeState.scope !== 'global'
          ? new Set(modeState.scope)
          : new Set<string>()
      if (on) scope.add(name)
      else scope.delete(name)
      modeState = scope.size > 0 ? { action: 'lightbox', scope } : { action: 'idle' }
      notify('mode')
    }),
    lightboxed: (name) =>
      modeState.action === 'lightbox' &&
      (modeState.scope === 'global' || modeState.scope.has(name)),
  }

  const hook: CaptureHook = {
    captured: () => undefined,
    mode,
    replay,
    session: { get: () => session, subscribe: sub('session') },
    sites: { get: () => sitesMap, subscribe: sub('sites') },
    coverage: {
      get: () => coverageMap,
      set: (name, cov) => {
        coverageMap.set(name, cov)
        notify('coverage')
      },
      subscribe: sub('coverage'),
    },
    extension: { get: () => extension, subscribe: sub('extension') },
    diagnostics: { get: (name) => diagnosticsMap.get(name) ?? [], subscribe: sub('diagnostics') },
    fixtures: {
      register: () => () => {},
      has: (name) => fixtureStatuses.get(name)?.recorded ?? false,
      status: (name) =>
        fixtureStatuses.get(name) ?? { participates: false, recorded: false, replaying: false },
      read: () => undefined,
      record: async () => {},
      recordAll: async () => {},
      seed: () => {},
      subscribe: sub('fixtures'),
    },
    highlight,
  }

  return {
    hook,
    mode,
    replay,
    highlight,
    setMode: (state) => {
      modeState = state
      notify('mode')
    },
    setSession: (patch) => {
      session = { ...session, ...patch }
      notify('session')
    },
    setSites: (entries) => {
      sitesMap.clear()
      for (const [name, info] of Object.entries(entries)) {
        sitesMap.set(name, { instances: 1, captureRoot: 'auto', tooLarge: false, ...info })
      }
      notify('sites')
    },
    setCoverage: (entries) => {
      coverageMap.clear()
      for (const [name, cov] of Object.entries(entries)) coverageMap.set(name, cov)
      notify('coverage')
    },
    setExtension: (state) => {
      extension = state
      notify('extension')
    },
    setFixture: (name, status) => {
      fixtureStatuses.set(name, status)
      notify('fixtures')
    },
    setDiagnostics: (name, lines) => {
      diagnosticsMap.set(name, lines)
      notify('diagnostics')
    },
  }
}

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-xray-hud]')
  assert(host?.shadowRoot, 'expected the HUD host with a shadow root')
  return host.shadowRoot
}

async function installWith(stores: FakeStores): Promise<void> {
  globalThis.__XRAY__ = stores.hook
  handle = installXrayHud()
  await tick()
}

function q(selector: string): Element {
  const el = shadow().querySelector(selector)
  assert(el, `expected ${selector} in the HUD`)
  return el
}

function qButton(selector: string): HTMLButtonElement {
  const el = q(selector)
  assert(el instanceof HTMLButtonElement, `expected ${selector} to be a button`)
  return el
}

function text(selector: string): string {
  return q(selector).textContent?.replaceAll(/\s+/g, ' ').trim() ?? ''
}

const click = (el: Element) => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
}

/** A standard two-plate scene: hero covered 2/3 bands, card covered 1/1. */
async function standardScene(): Promise<FakeStores> {
  const stores = makeHook()
  stores.setSites({ hero: {}, card: {} })
  stores.setCoverage({
    hero: {
      breakpoints: [640, 1200],
      spans: [
        { min: 640, max: 1200 },
        { min: 1200, max: undefined },
      ],
    },
    card: { breakpoints: [], spans: [{ min: undefined, max: undefined }] },
  })
  await installWith(stores)
  return stores
}

describe('deck', () => {
  it('renders the two controls, the ticker, and the wordmark', async () => {
    await standardScene()
    expect(q('.ctl.rec')).toBeTruthy()
    expect(q('.ctl.play')).toBeTruthy()
    expect(q('.wordmark').getAttribute('aria-label')).toBe('xray')
    // 3 of 4 bands covered across the two mounted plates.
    expect(text('.tick')).toBe('3/4 views')
  })

  it('record click drives mode.setRecord and the recording state renders', async () => {
    const stores = await standardScene()
    click(q('.ctl.rec'))
    expect(stores.mode.setRecord).toHaveBeenCalledWith(true)
    await tick()
    expect(q('.ctl.rec').getAttribute('aria-pressed')).toBe('true')
    expect(qButton('.ctl.play').disabled).toBe(true)
    expect(text('.tick')).toBe('● 0 views')
  })

  it('sweep progress rides the ticker and the ring while recording', async () => {
    const stores = await standardScene()
    stores.setMode({ action: 'record', scope: 'global' })
    stores.setSession({ sweep: { width: 768, index: 2, total: 5 } })
    await tick()
    expect(text('.tick')).toBe('● 768px · 2/5')
    expect(q('.ctl.rec').className).toContain('sweeping')
  })

  it('Light Box on: play pressed, record disabled, skeleton count in the ticker', async () => {
    const stores = await standardScene()
    click(q('.ctl.play'))
    expect(stores.mode.setLightbox).toHaveBeenCalledWith(true)
    await tick()
    expect(q('.ctl.play').getAttribute('aria-pressed')).toBe('true')
    expect(qButton('.ctl.rec').disabled).toBe(true)
    expect(text('.tick')).toBe('▶ 2 skeletons')
  })

  it('write lifecycle: failed shows the error card with the sink message', async () => {
    const stores = await standardScene()
    stores.setSession({ save: 'failed', saveError: 'xray sink POST failed: 413' })
    await tick()
    expect(text('.card.err')).toContain('write failed')
    expect(text('.card.err')).toContain('413')
    stores.setSession({ save: 'saved', saveError: undefined, savedCount: 2 })
    await tick()
    expect(shadow().querySelector('.card.err')).toBeNull()
    expect(text('.tick')).toContain('✓ 2')
  })
})

describe('cards', () => {
  it('no skeletons: guidance card, both controls disabled', async () => {
    const stores = makeHook()
    await installWith(stores)
    expect(text('.card')).toContain('No skeletons on this page')
    expect(qButton('.ctl.rec').disabled).toBe(true)
    expect(qButton('.ctl.play').disabled).toBe(true)
  })

  it('first run: nothing captured card; play disabled until something exists', async () => {
    const stores = makeHook()
    stores.setSites({ hero: {} })
    await installWith(stores)
    expect(text('.card')).toContain('Nothing captured yet')
    expect(qButton('.ctl.rec').disabled).toBe(false)
    expect(qButton('.ctl.play').disabled).toBe(true)
  })

  it('promo card while the extension is absent; swaps for the warnline when it is stale', async () => {
    const stores = await standardScene()
    expect(text('.card.promo')).toContain('Get the xray extension')
    stores.setExtension({ present: true, version: '0.1.0', caps: [] })
    await tick()
    expect(shadow().querySelector('.card.promo')).toBeNull()
    expect(text('.warnline')).toContain('update it')
    stores.setExtension({ present: true, version: '1.0.0', caps: ['emulate'] })
    await tick()
    expect(shadow().querySelector('.warnline')).toBeNull()
  })
})

describe('plates section', () => {
  it('opens with mounted rows (sorted), segments, and dim on-disk rows', async () => {
    const stores = await standardScene()
    stores.setCoverage({
      hero: { breakpoints: [640, 1200], spans: [{ min: 640, max: 1200 }] },
      card: { breakpoints: [], spans: [{ min: undefined, max: undefined }] },
      'news-feed': { breakpoints: [900], spans: [{ min: 900, max: undefined }] },
    })
    await tick()
    click(q('.plates-line'))
    await tick()
    const names = [...shadow().querySelectorAll('.plate .name')].map((el) => el.textContent)
    expect(names).toEqual(['card', 'hero', 'news-feed'])
    // hero: 3 bands, middle covered, outer two dashed-missing.
    const heroSegs = [...shadow().querySelectorAll('.plate')]
      .find((p) => p.querySelector('.name')?.textContent === 'hero')
      ?.querySelectorAll('.seg')
    assert(heroSegs)
    expect([...heroSegs].map((s) => s.className)).toEqual(['seg', 'seg c', 'seg'])
    expect([...heroSegs].map((s) => s.textContent)).toEqual(['‹640', '640–1.2k', '≥1.2k'])
    // news-feed is on disk only: dimmed, with a view count, no keys.
    const disk = [...shadow().querySelectorAll('.plate.unmounted')]
    expect(disk).toHaveLength(1)
    expect(disk[0]?.textContent).toContain('news-feed')
    expect(disk[0]?.textContent).toContain('1 view')
    expect(disk[0]?.querySelector('.key')).toBeNull()
  })

  it('session views render fresh segments while recording', async () => {
    const stores = await standardScene()
    stores.setMode({ action: 'record', scope: 'global' })
    stores.setSession({ views: new Map([['hero', [390]]]) })
    await tick()
    click(q('.plates-line'))
    await tick()
    const heroSegs = [...shadow().querySelectorAll('.plate')]
      .find((p) => p.querySelector('.name')?.textContent === 'hero')
      ?.querySelectorAll('.seg')
    assert(heroSegs)
    expect(heroSegs[0]?.className).toBe('seg f')
  })

  it('per-plate keys drive recordName/lightboxName; global record disables them', async () => {
    const stores = await standardScene()
    click(q('.plates-line'))
    await tick()
    const heroRow = [...shadow().querySelectorAll('.plate')].find(
      (p) => p.querySelector('.name')?.textContent === 'hero',
    )
    assert(heroRow)
    const [recKey, playKey] = heroRow.querySelectorAll('.key')
    assert(recKey && playKey)
    click(playKey)
    expect(stores.mode.lightboxName).toHaveBeenCalledWith('hero', true)
    await tick()
    // The lit key and the disabled opposite side, per the exclusivity matrix.
    expect(
      heroRow.querySelector('.key.on-play') ?? shadow().querySelector('.plate .key.on-play'),
    ).toBeTruthy()
    expect(qButton('.ctl.rec').disabled).toBe(true)
    // Back off, then record the plate instead.
    const litPlay = shadow().querySelector('.key.on-play')
    assert(litPlay)
    click(litPlay)
    await tick()
    const recAgain = [...shadow().querySelectorAll('.plate')]
      .find((p) => p.querySelector('.name')?.textContent === 'hero')
      ?.querySelector('.key')
    assert(recAgain)
    click(recAgain)
    expect(stores.mode.recordName).toHaveBeenCalledWith('hero', true)

    // Global recording disables every key.
    stores.setMode({ action: 'record', scope: 'global' })
    await tick()
    for (const key of shadow().querySelectorAll('.key')) {
      assert(key instanceof HTMLButtonElement)
      expect(key.disabled).toBe(true)
    }
  })

  it('fixture badge, replay line, and diagnostics note', async () => {
    const stores = await standardScene()
    stores.setFixture('hero', { participates: true, recorded: true, replaying: true })
    stores.setDiagnostics('card', ['tree too large: 4913 nodes over the 4096 limit'])
    await tick()
    click(q('.plates-line'))
    await tick()
    const badge = q('.badge.fx')
    expect(badge.getAttribute('title')).toContain('replaying')
    expect(text('.note.err')).toContain('4913 nodes')
    const replaySwitch = qButton('.switch')
    expect(replaySwitch.getAttribute('aria-checked')).toBe('false')
    click(replaySwitch)
    await tick()
    expect(stores.replay.get()).toBe(true)
    expect(q('.switch').getAttribute('aria-checked')).toBe('true')
  })

  it('hovering a row highlights its boundary and unhovering clears it', async () => {
    const stores = await standardScene()
    click(q('.plates-line'))
    await tick()
    const row = shadow().querySelector('.plate')
    assert(row)
    row.dispatchEvent(new MouseEvent('mouseenter'))
    expect(stores.highlight).toHaveBeenCalledWith('card', true)
    row.dispatchEvent(new MouseEvent('mouseleave'))
    expect(stores.highlight).toHaveBeenCalledWith('card', false)
  })
})

describe('plates-line summary', () => {
  it('one grammar across states: skeletons, unsaved-over-gaps, disk stock, empty page', async () => {
    const stores = await standardScene()
    // Idle with a gap, nothing on disk beyond the page.
    expect(text('.plates-line')).toContain('2 skeletons · 1 gap · 2 plates on disk')
    // Disk-only plates close the line.
    stores.setCoverage({
      hero: {
        breakpoints: [640, 1200],
        spans: [
          { min: 640, max: 1200 },
          { min: 1200, max: undefined },
        ],
      },
      card: { breakpoints: [], spans: [{ min: undefined, max: undefined }] },
      'news-feed': { breakpoints: [900], spans: [{ min: 900, max: undefined }] },
    })
    await tick()
    expect(text('.plates-line')).toContain('2 skeletons · 1 gap · 3 plates on disk')
    // Unsaved session views outrank gaps (and the fresh band closes hero's gap).
    stores.setSession({ views: new Map([['hero', [390, 800]]]) })
    await tick()
    expect(text('.plates-line')).toContain('2 skeletons · 2 views unsaved · 3 plates on disk')
    // A page with no skeletons reads as words, not a zero.
    stores.setSession({ views: new Map() })
    stores.setSites({})
    await tick()
    expect(text('.plates-line')).toContain('no skeletons · 3 plates on disk')
  })

  it('suppresses gaps before anything is captured (the card explains instead)', async () => {
    const stores = makeHook()
    stores.setSites({ hero: {}, card: {} })
    await installWith(stores)
    expect(text('.plates-line')).toContain('2 skeletons')
    expect(text('.plates-line')).not.toContain('gap')
  })
})

describe('stitch rows', () => {
  it('a stitch-only plate stays listed: dim row, host note, keys disabled with reasons', async () => {
    const stores = await standardScene()
    // hero light-boxed and rendering content-cards as its stitch.
    stores.setMode({ action: 'lightbox', scope: new Set(['hero']) })
    stores.setSites({
      hero: {},
      card: {},
      'content-cards': { instances: 0, stitchedUnder: ['hero'] },
    })
    await tick()
    click(q('.plates-line'))
    await tick()
    const row = [...shadow().querySelectorAll('.plate')].find(
      (p) => p.querySelector('.name')?.textContent === 'content-cards',
    )
    assert(row)
    expect(row.className).toContain('stitch')
    expect(row.textContent).toContain('↳ stitch of hero')
    for (const key of row.querySelectorAll('.key')) {
      assert(key instanceof HTMLButtonElement)
      expect(key.disabled).toBe(true)
    }
    expect(row.querySelector('.key[title*="light box hero off"]')).toBeTruthy()
  })
})

describe('an engaged Light Box never strands', () => {
  it('the global play stays enabled to disengage after every plate unmounts', async () => {
    const stores = await standardScene()
    stores.setMode({ action: 'lightbox', scope: 'global' })
    stores.setSites({})
    await tick()
    expect(qButton('.ctl.play').disabled).toBe(false)
    click(qButton('.ctl.play'))
    expect(stores.mode.setLightbox).toHaveBeenCalledWith(false)
  })

  it('a scoped plate that unmounts keeps a dimmed row with its lit key', async () => {
    const stores = await standardScene()
    stores.setMode({ action: 'lightbox', scope: new Set(['hero']) })
    stores.setSites({ card: {} })
    await tick()
    click(q('.plates-line'))
    await tick()
    const heroRow = [...shadow().querySelectorAll('.plate')].find(
      (p) => p.querySelector('.name')?.textContent === 'hero',
    )
    assert(heroRow)
    expect(heroRow.className).toContain('unmounted')
    const key = heroRow.querySelector('.key.on-play')
    assert(key instanceof HTMLButtonElement)
    expect(key.disabled).toBe(false)
    click(key)
    expect(stores.mode.lightboxName).toHaveBeenCalledWith('hero', false)
  })
})

describe('dispose', () => {
  it('removes the host and stops reacting to store changes', async () => {
    const stores = await standardScene()
    handle?.dispose()
    handle = undefined
    expect(document.querySelector('[data-xray-hud]')).toBeNull()
    // A post-dispose notify must not throw (subscriptions were cleaned up).
    stores.setSession({ save: 'saved', savedCount: 1 })
    await tick()
  })
})
