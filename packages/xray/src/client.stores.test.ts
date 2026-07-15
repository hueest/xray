// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, it, vi } from 'vitest'

import type { CaptureEnvelope, ClientOptions } from './client.ts'
import { installXrayClient } from './client.ts'

/**
 * Tests for the dev client's HUD-facing stores: the one-action mode machine (record/Light Box
 * exclusivity at global and per-name scope), the mounted-sites store, the session store's
 * accumulate/save lifecycle, the per-plate fixture status, the extension presence store, and the
 * per-plate diagnostics mirror.
 */

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.sessionStorage.clear()
})

function install(options?: Partial<ClientOptions>): { sink: ReturnType<typeof vi.fn> } {
  const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
  // Suppress the install-time whois probe's self-delivery noise; presence is
  // simulated via dispatched hello messages where a test needs it.
  vi.spyOn(window, 'postMessage').mockImplementation(() => {})
  uninstall = installXrayClient({ sink, delay: 1, ...options })
  return { sink }
}

function hook() {
  const h = globalThis.__XRAY__
  assert(h, 'client should be installed')
  return h
}

function mountSite(name: string): () => void {
  const id = `site-${name}-${Math.random().toString(36).slice(2)}`
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="${id}" style="display: contents"><div><p>x</p></div></div>`,
  )
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  const dispose = hook().captured(name, el)
  assert(dispose)
  return dispose
}

function helloFromExtension(extra: Record<string, unknown> = {}): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'xray-ext', kind: 'hello', ...extra },
      source: window,
    }),
  )
}

const settleCaptures = () => new Promise((r) => setTimeout(r, 30))

const setWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
}

const resize = async () => {
  window.dispatchEvent(new Event('resize'))
  await new Promise((r) => setTimeout(r, 350))
}

describe('mode store: one action at a time', () => {
  it('starts idle and reports record(global) once engaged', async () => {
    install()
    const mode = hook().mode
    assert(mode)
    expect(mode.get()).toEqual({ action: 'idle' })
    await mode.setRecord(true)
    expect(mode.get()).toEqual({ action: 'record', scope: 'global' })
    await mode.setRecord(false)
    expect(mode.get()).toEqual({ action: 'idle' })
  })

  it('refuses Light Box while recording, and recording while Light Box is on (warned no-op)', async () => {
    install()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mode = hook().mode
    assert(mode)
    await mode.setRecord(true)
    mode.setLightbox(true)
    expect(mode.get()).toEqual({ action: 'record', scope: 'global' })
    await mode.setRecord(false)

    mode.setLightbox(true)
    await mode.setRecord(true)
    expect(mode.get()).toEqual({ action: 'lightbox', scope: 'global' })
    expect(warn).toHaveBeenCalled()
  })

  it('per-name Light Box scopes and the adapter read side (lightboxed)', () => {
    install()
    const mode = hook().mode
    assert(mode)
    mode.lightboxName('hero', true)
    mode.lightboxName('card', true)
    const state = mode.get()
    assert(state.action === 'lightbox' && state.scope !== 'global')
    expect([...state.scope].toSorted()).toEqual(['card', 'hero'])
    expect(mode.lightboxed('hero')).toBe(true)
    expect(mode.lightboxed('other')).toBe(false)
    mode.lightboxName('hero', false)
    expect(mode.lightboxed('hero')).toBe(false)
    // Global wins over any name.
    mode.lightboxName('card', false)
    mode.setLightbox(true)
    expect(mode.lightboxed('anything')).toBe(true)
  })

  it('per-name record scope blocks per-plate and global Light Box, and vice versa', async () => {
    install()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mode = hook().mode
    assert(mode)
    await mode.recordName('hero', true)
    expect(mode.get()).toEqual({ action: 'record', scope: new Set(['hero']) })
    mode.setLightbox(true)
    mode.lightboxName('card', true)
    expect(mode.get()).toEqual({ action: 'record', scope: new Set(['hero']) })
    await mode.recordName('hero', false)

    mode.lightboxName('card', true)
    await mode.recordName('hero', true)
    const state = mode.get()
    expect(state.action).toBe('lightbox')
  })

  it('global record absorbs an active per-name record scope', async () => {
    install()
    const mode = hook().mode
    assert(mode)
    await mode.recordName('hero', true)
    await mode.setRecord(true)
    expect(mode.get()).toEqual({ action: 'record', scope: 'global' })
    await mode.setRecord(false)
    expect(mode.get()).toEqual({ action: 'idle' })
  })

  it('manual per-name recording captures ONLY the scoped plate and writes its slice on key-off', async () => {
    const { sink } = install()
    mountSite('hero')
    mountSite('card')
    const mode = hook().mode
    assert(mode)
    await mode.recordName('hero', true)
    await settleCaptures()
    // Only the scoped plate accumulated.
    const views = hook().session?.get().views
    expect(views?.has('hero')).toBe(true)
    expect(views?.has('card')).toBe(false)
    // Key-off writes exactly that slice.
    await mode.recordName('hero', false)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
    expect(mode.get()).toEqual({ action: 'idle' })
  })
})

describe('sites store', () => {
  it('presence outlives the capture boundary: a light-boxed plate stays listed', () => {
    install()
    const h = hook()
    assert(h.mounted && h.sites)
    // The adapter registers presence for the mounted <Skeleton>…
    const disposeMounted = h.mounted('hero')
    // …and the capture boundary registers while content shows.
    const disposeCaptured = mountSite('hero')
    expect(h.sites.get().get('hero')?.instances).toBe(1)
    // Light Box unmounts the capture boundary; presence keeps the row.
    disposeCaptured()
    expect(h.sites.get().has('hero')).toBe(true)
    // The <Skeleton> itself unmounting is what removes it.
    disposeMounted()
    expect(h.sites.get().has('hero')).toBe(false)
  })

  it('lists stitch-only plates and annotates mounted ones with their hosts', () => {
    install()
    const h = hook()
    assert(h.stitched && h.sites && h.mounted)
    // A showing parent skeleton reports its direct stitches → a stitch-only row.
    const disposeStitched = h.stitched('dashboard', ['news-feed'])
    expect(h.sites.get().get('news-feed')).toEqual({
      instances: 0,
      captureRoot: 'auto',
      tooLarge: false,
      stitchedUnder: ['dashboard'],
    })
    // The same name mounted elsewhere keeps its real entry and gains the hosts.
    const disposeMounted = h.mounted('news-feed')
    expect(h.sites.get().get('news-feed')?.instances).toBe(1)
    expect(h.sites.get().get('news-feed')?.stitchedUnder).toEqual(['dashboard'])
    disposeMounted()
    expect(h.sites.get().get('news-feed')?.instances).toBe(0)
    disposeStitched()
    expect(h.sites.get().has('news-feed')).toBe(false)
  })

  it('tracks mounted plates by name with instance counts, and empties on dispose', () => {
    install()
    const sites = hook().sites
    assert(sites)
    const seen: number[] = []
    sites.subscribe(() => seen.push(sites.get().size))
    const d1 = mountSite('hero')
    const d2 = mountSite('hero')
    const d3 = mountSite('card')
    expect(sites.get().get('hero')?.instances).toBe(2)
    expect(sites.get().get('card')?.instances).toBe(1)
    expect(sites.get().get('hero')?.tooLarge).toBe(false)
    d1()
    d2()
    expect(sites.get().has('hero')).toBe(false)
    d3()
    expect(sites.get().size).toBe(0)
    expect(seen.length).toBeGreaterThanOrEqual(6)
  })
})

describe('session store', () => {
  it('accumulates views while recording and runs the save lifecycle on stop', async () => {
    const { sink } = install()
    mountSite('hero')
    const mode = hook().mode
    const session = hook().session
    assert(mode && session)
    expect(session.get().save).toBe('idle')
    await mode.setRecord(true)
    await settleCaptures()
    expect(session.get().views.get('hero')).toBeDefined()
    await mode.setRecord(false)
    expect(session.get().save).toBe('saved')
    expect(session.get().savedCount).toBe(1)
    expect(session.get().views.size).toBe(0)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('a failed write reports failed + saveError and keeps the buffer for the next engage', async () => {
    const sink = vi
      .fn<(envelope: CaptureEnvelope) => Promise<void>>()
      .mockRejectedValueOnce(new Error('xray sink POST failed: 500'))
      .mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    install({ sink })
    mountSite('hero')
    const mode = hook().mode
    const session = hook().session
    assert(mode && session)
    await mode.setRecord(true)
    await settleCaptures()
    await mode.setRecord(false)
    expect(session.get().save).toBe('failed')
    expect(session.get().saveError).toContain('500')
    // The buffer survived; re-engaging retries the failed write.
    await mode.setRecord(true)
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2))
    expect(session.get().save).toBe('saved')
    await mode.setRecord(false)
  })
})

describe('browse-time captured absence', () => {
  it('records an empty View when a seen plate unmounts on a width change while recording', async () => {
    const { sink } = install()
    const h = hook()
    assert(h.mounted && h.mode && h.session)
    setWidth(1300)
    // The adapter registers presence AND the capture boundary at the wide width.
    const disposeMounted = h.mounted('feed')
    const disposeCaptured = mountSite('feed')
    await h.mode.setRecord(true)
    await settleCaptures()
    expect(h.session.get().views.get('feed')).toEqual([1300])

    // Crossing below the mount boundary unmounts the whole <Skeleton>.
    disposeCaptured()
    disposeMounted()
    setWidth(390)
    await resize()
    expect(h.session.get().views.get('feed')).toEqual([390, 1300])

    await h.mode.setRecord(false)
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('never marks a plate absent after a NAVIGATION (pathname changed)', async () => {
    install()
    const h = hook()
    assert(h.mounted && h.mode && h.session)
    setWidth(1300)
    const disposeMounted = h.mounted('feed')
    const disposeCaptured = mountSite('feed')
    await h.mode.setRecord(true)
    await settleCaptures()

    // Navigate away: everything unmounts, the buffer survives by design.
    disposeCaptured()
    disposeMounted()
    window.history.pushState({}, '', '/elsewhere')
    setWidth(390)
    await resize()
    // No empty View: unmounted-because-navigation is not absence.
    expect(h.session.get().views.get('feed')).toEqual([1300])
    await h.mode.setRecord(false)
    window.history.pushState({}, '', '/')
  })
})

describe('the observation engine treats loading as mounted, and backfills', () => {
  it('a Skeleton showing its LOADING skeleton (presence, no capture site) is never absent', async () => {
    install()
    const h = hook()
    assert(h.mounted && h.mode && h.session)
    setWidth(1300)
    const disposeMounted = h.mounted('feed')
    const disposeCaptured = mountSite('feed')
    await h.mode.setRecord(true)
    await settleCaptures()
    expect(h.session.get().views.get('feed')).toEqual([1300])

    // Content unmounts (back to loading): the capture boundary goes, presence stays.
    disposeCaptured()
    setWidth(800)
    await resize()
    // Mounted-but-loading is NOT absence — no empty View at 800.
    expect(h.session.get().views.get('feed')).toEqual([1300])

    // The whole Skeleton unmounting IS absence.
    disposeMounted()
    setWidth(390)
    await resize()
    const views = h.session.get().views.get('feed') ?? []
    expect(views).toContain(390)
    // 800 was observed with presence → never backfilled as absent.
    expect(views).not.toContain(800)
    await h.mode.setRecord(false)
  })

  it('backfills earlier observed widths once a late-appearing plate is first captured', async () => {
    install()
    const h = hook()
    assert(h.mode && h.session && h.mounted)
    // Engage at a narrow width where the plate does not exist at all.
    setWidth(390)
    await h.mode.setRecord(true)
    await settleCaptures()
    // Resize up: the plate mounts and captures for the first time.
    setWidth(1300)
    const disposeMounted = h.mounted('feed')
    mountSite('feed')
    await resize()
    // Another resize reconciles: the engage width (observed without the plate)
    // backfills as captured absence.
    disposeMounted()
    setWidth(800)
    await resize()
    const views = [...(h.session.get().views.get('feed') ?? [])].toSorted((a, b) => a - b)
    expect(views).toEqual([390, 800, 1300])
    await h.mode.setRecord(false)
  })
})

describe('extension store', () => {
  it('is absent until a hello, and keys purely on caps — a capless hello announces nothing', () => {
    install()
    const extension = hook().extension
    assert(extension)
    expect(extension.get()).toEqual({ present: false, caps: [] })
    // A hello without caps: present, but no usable capability (the HUD says update).
    helloFromExtension({ version: '0.0.0' })
    expect(extension.get()).toEqual({ present: true, version: '0.0.0', caps: [] })
    helloFromExtension({ version: '0.1.0', caps: ['emulate', 'cdp'] })
    expect(extension.get().caps).toEqual(['emulate', 'cdp'])
  })
})

describe('fixture status', () => {
  it('derives participates / recorded / replaying, including the missing-only rule', async () => {
    install({ replay: 'missing-only', recordFixtureSink: () => {} })
    const fixtures = hook().fixtures
    const replay = hook().replay
    assert(fixtures && replay)
    // Nothing mounted, nothing recorded.
    expect(fixtures.status('hero')).toEqual({
      participates: false,
      recorded: false,
      replaying: false,
    })
    // A render-prop site registers live data → participates.
    const dispose = fixtures.register('hero', { rows: [1] })
    expect(fixtures.status('hero').participates).toBe(true)
    // Recorded + replay on, but live data PRESENT under missing-only → not replaying.
    await fixtures.record('hero')
    replay.set(true)
    expect(fixtures.status('hero')).toEqual({
      participates: true,
      recorded: true,
      replaying: false,
    })
    // Live data nullish → missing-only substitutes.
    dispose()
    const disposeNull = fixtures.register('hero', null)
    expect(fixtures.status('hero').replaying).toBe(true)
    disposeNull()
    expect(fixtures.status('hero').participates).toBe(false)
  })

  it('notifies subscribers on register/dispose and on the replay toggle', () => {
    install({ recordFixtureSink: () => {} })
    const fixtures = hook().fixtures
    const replay = hook().replay
    assert(fixtures && replay)
    const wake = vi.fn()
    fixtures.subscribe(wake)
    const dispose = fixtures.register('hero', { a: 1 })
    dispose()
    replay.set(true)
    expect(wake.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

describe('subscriber isolation', () => {
  it('a throwing subscriber never breaks the action that notified it, nor its siblings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    install()
    const h = hook()
    assert(h.mode && h.session && h.sites)
    // A hostile/broken subscriber on every store the pipeline notifies from.
    h.session.subscribe(() => {
      throw new Error('broken HUD subscriber')
    })
    h.sites.subscribe(() => {
      throw new Error('broken HUD subscriber')
    })
    h.mode.subscribe(() => {
      throw new Error('broken HUD subscriber')
    })
    const wellBehaved = vi.fn()
    h.session.subscribe(wellBehaved)

    // The full engage → capture → stop cycle must survive it.
    mountSite('hero')
    await h.mode.setRecord(true)
    await settleCaptures()
    await h.mode.setRecord(false)
    expect(h.session.get().save).toBe('saved')
    // Siblings behind the thrower still got woken.
    expect(wellBehaved).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('diagnostics store', () => {
  it('replaces per-plate lines on each capture; a clean capture clears them', async () => {
    install()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountSite('hero')
    const mode = hook().mode
    const diagnostics = hook().diagnostics
    assert(mode && diagnostics)
    expect(diagnostics.get('hero')).toEqual([])
    await mode.setRecord(true)
    await settleCaptures()
    // The plain fixture site captures cleanly — still empty, but SET (replaced).
    expect(diagnostics.get('hero')).toEqual([])
    await mode.setRecord(false)
  })
})
