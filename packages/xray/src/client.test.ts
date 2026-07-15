// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CaptureEnvelope } from './client.ts'
import { installXrayClient } from './client.ts'
import { blinkCapture } from './blink.ts'
import type { RenderNode } from './plate.ts'

// The capture flash is a visual side-effect (no-op without layout, so unobservable in
// happy-dom); mock it to assert WHEN it fires — only on a capture that changed the result.
vi.mock('./blink.ts', () => ({ blinkCapture: vi.fn() }))

let uninstall: (() => void) | undefined

function requireElement<T extends Element>(element: T | null, label: string): T {
  if (!element) throw new Error(`missing ${label}`)
  return element
}

/** Count the nodes in a posted StoredPlate's RenderNode tree (a coarse size proxy). */
function countNodes(tree: RenderNode | null | undefined): number {
  if (!tree) return 0
  return 1 + (tree.kids ?? []).reduce((sum, kid) => sum + countNodes(kid), 0)
}

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  // The Capture toggle is sticky per-tab (sessionStorage); a test that stops a
  // recording leaves `xray:capture=false`, which would seed the next install OFF.
  // Clear it so each test starts from its own `capture` option / default.
  window.sessionStorage.clear()
})

function mountSite(): HTMLElement {
  document.body.innerHTML =
    '<div id="site" style="display: contents"><div class="content"><p>Hello</p></div></div>'
  return requireElement(document.getElementById('site'), '#site')
}

/**
 * The Capture toggle is a RECORDING session (it accumulates Views and live-previews them in-memory;
 * nothing is written to disk until you STOP). These helpers drive that lifecycle in tests: wait for
 * a capture to land (the live preview populates the plate store), then stop the recording so the
 * accumulated plate is written through the sink.
 */
async function waitForRecorded(name: string): Promise<void> {
  await vi.waitFor(() => expect(globalThis.__XRAY__?.plates?.get(name)).toBeDefined())
}
function stopRecording(): void {
  // Toggle Capture off → finalizeRecording writes every accumulated plate once.
  globalThis.__XRAY__?.capture?.set(false)
}
/** Force `window.innerWidth` (the View width the capture reads) in happy-dom. */
function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
}

describe('installXrayClient', () => {
  it('installs the capture hook and uninstalls cleanly', () => {
    expect(globalThis.__XRAY__).toBeUndefined()
    uninstall = installXrayClient({ sink: () => {} })
    expect(globalThis.__XRAY__).toBeDefined()
    uninstall()
    uninstall = undefined
    expect(globalThis.__XRAY__).toBeUndefined()
  })

  it('captures a ready site after settle and writes ONE StoredPlate envelope on stop', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    const el = mountSite()
    const dispose = globalThis.__XRAY__?.captured('my-site', el)
    // Recording accumulates + live-previews; the disk write happens once, on stop.
    await waitForRecorded('my-site')
    expect(sink).not.toHaveBeenCalled()
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    const envelope = sink.mock.calls[0]?.[0]
    // The client now posts a finished, in-browser-projected StoredPlate (ADR 0022).
    expect(envelope?.plate.name).toBe('my-site')
    expect(envelope?.plate.v).toBeTypeOf('number')
    // The stored tree is post-classify: content classes, no ids.
    expect(envelope?.plate.tree?.kids).toHaveLength(1)
    expect(JSON.stringify(envelope?.plate.tree)).not.toContain('"id"')
    expect(typeof envelope?.plate.css).toBe('string')
    dispose?.()
  })

  it('manual mode captures the site element ITSELF as the root, not its children', async () => {
    // AUTO captures the wrapper's children; MANUAL (ADR 0014) captures
    // the consumer's own element, so its box/classes survive. Mount a styled
    // element carrying the boundary marker (as ManualBoundary's ref writes it) and
    // capture it with mode:'manual'.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    document.body.innerHTML =
      '<section class="panel" data-xr-boundary="my-panel" style="padding: 16px">' +
      '<p>Hello</p></section>'
    const el = requireElement(document.querySelector('section'), 'section')
    globalThis.__XRAY__?.captured('my-panel', el, { mode: 'manual' })
    await waitForRecorded('my-panel')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    const tree = sink.mock.calls[0]?.[0]?.plate.tree
    // ONE top-level node: the section itself (not its <p> children promoted up).
    expect(tree?.kids).toHaveLength(1)
    const panel = tree?.kids?.[0]
    // The section is a real node, NOT a stitch-to-itself.
    expect(panel?.ref).toBeUndefined()
    // Its own subtree (the <p>) is captured beneath it.
    expect(panel?.kids?.length).toBeGreaterThan(0)
  })

  it('waits out mutations before capturing', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 30, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    // keep mutating for a while; capture must not fire mid-churn
    const content = requireElement(el.querySelector('.content'), '.content')
    const mutate = async () => {
      await new Promise((r) => setTimeout(r, 15))
      content.append(document.createElement('span'))
      expect(sink).not.toHaveBeenCalled()
    }
    await mutate()
    await mutate()
    await mutate()
    // Settle completes after the churn → the recording captures once (live preview).
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    // the late spans made it into the capture
    const tree = sink.mock.calls[0]?.[0]?.plate.tree
    expect(countNodes(tree)).toBeGreaterThan(2)
  })

  it('records matchMedia queries for breakpoint derivation', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    window.matchMedia('(min-width: 768px)')
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalled()
    })
    // The matchMedia threshold is folded into the StoredPlate's breakpoints.
    expect(sink.mock.calls[0]?.[0]?.plate.breakpoints).toContain(768)
  })

  it('accumulates browse captures and writes once on stop (no per-capture POST)', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    // A capture lands (live preview) but nothing is written to disk while recording.
    await waitForRecorded('my-site')
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 200))
    expect(sink).not.toHaveBeenCalled()
    // Stopping the recording writes the accumulated plate exactly once.
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('does not fire the sink for a capture still settling when the client is disposed', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 50, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    // Tear down mid-settle: the in-flight capture holds a site reference, so the
    // disposed flag (not the cleared set) is what must stop it.
    uninstall()
    uninstall = undefined
    // Wait well past the settle delay; the guard must have bailed.
    await new Promise((r) => setTimeout(r, 200))
    expect(sink).not.toHaveBeenCalled()
  })

  it('a failed write on stop is caught, warned, and retained for retry (no unhandled rejection)', async () => {
    // The recording finalize (stop → write) is wrapped: a rejected sink must NOT surface
    // as an unhandled rejection; it is caught, warned, and the buffer is RETAINED so the
    // recording survives a transient write failure rather than being lost to one warn.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let down = true
    const sink = vi.fn<(envelope: CaptureEnvelope) => Promise<void>>(async () => {
      if (down) throw new Error('server down')
    })
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    // Give a microtask/macrotask window for any unhandled rejection to fire.
    await new Promise((r) => setTimeout(r, 0))
    expect(unhandled).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('capture-session write failed for "my-site"'),
      expect.any(Error),
    )

    // The retained buffer retries when a new recording starts (server recovered).
    down = false
    globalThis.__XRAY__?.capture?.set(true)
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(2)
    })
    expect(sink.mock.calls[1]?.[0]?.plate.name).toBe('my-site')
    warn.mockRestore()
    process.off('unhandledRejection', unhandled)
  })

  it('only the first site in document order writes a plate shared by several', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    // Two <Skeleton plate="dup"> on the page; the first has one paragraph, the
    // second has two — so the captured tree tells us which one won.
    document.body.innerHTML =
      '<div id="a" style="display: contents"><div><p>one</p></div></div>' +
      '<div id="b" style="display: contents"><div><p>one</p><p>two</p></div></div>'
    const a = requireElement(document.getElementById('a'), '#a')
    const b = requireElement(document.getElementById('b'), '#b')
    // Register the later-in-DOM one first, to prove order — not registration — decides.
    globalThis.__XRAY__?.captured('dup', b)
    globalThis.__XRAY__?.captured('dup', a)
    await waitForRecorded('dup')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    await new Promise((r) => setTimeout(r, 40))
    // One write for the shared name, and it's the first site (its content div has one child).
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.plate.tree?.kids?.[0]?.kids).toHaveLength(1)
  })
})

describe('capture coalescing (scheduling)', () => {
  // capture performance plan, pieces 1/3. Overlapping triggers (mount, resize) for ONE
  // site must not start parallel settle+walk passes: the scheduler coalesces them into
  // the in-flight capture plus AT MOST one follow-up for the latest state. The recording
  // session is the write boundary now (the Capture toggle), so the observable is "ONE
  // write on stop" rather than "one POST per capture"; the scheduler itself is unchanged.

  it('collapses a mount+resize burst into a single capture', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 30, capture: true })
    const el = mountSite()
    // Mount registers the site (one schedule). Stack resizes while that first capture is
    // still settling — they coalesce into the in-flight capture + at most one follow-up.
    globalThis.__XRAY__?.captured('my-site', el)
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    // Let any stray follow-up settle and assert nothing else fired: the burst produced
    // exactly one recorded plate, never a parallel second settle.
    await new Promise((r) => setTimeout(r, 120))
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('records the final DOM state after a mid-recording change (one follow-up)', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 20, capture: true })
    const el = mountSite()
    const content = requireElement(el.querySelector('.content'), '.content')
    globalThis.__XRAY__?.captured('my-site', el)
    // First capture lands. THEN mutate the DOM and fire several resizes in a burst:
    // those coalesce into one follow-up capturing the new DOM, which (same width)
    // REPLACES the buffered View — so the plate written on stop includes the added nodes.
    await waitForRecorded('my-site')
    content.append(document.createElement('span'))
    content.append(document.createElement('span'))
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 150))
    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    const tree = sink.mock.calls[0]?.[0]?.plate.tree
    // The follow-up captured the larger DOM (more than the initial <p> alone).
    expect(countNodes(tree)).toBeGreaterThan(3)
  })

  it('does not start a second settle while a capture is in flight (single write under a duplicate-resize storm)', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 40, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    // Fire a storm of resizes all within the first capture's settle window. A
    // non-coalescing client would launch a settle per debounced batch; the scheduler
    // keeps it to one in-flight capture + one follow-up — one recorded plate.
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('resize'))
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5))
    }
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 150))
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

describe('collect limits guard', () => {
  it('refuses an oversized capture before CSS extraction and stops re-attempting', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    uninstall = installXrayClient({ sink, delay: 10, collect: { maxNodes: 3 }, capture: true })
    document.body.innerHTML =
      '<div id="site" style="display: contents"><div><span>a</span><span>b</span><span>c</span><span>d</span></div></div>'
    const el = requireElement(document.getElementById('site'), '#site')
    globalThis.__XRAY__?.captured('big', el)
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled()
    })
    expect(sink).not.toHaveBeenCalled()
    // The oversized warning now speaks the shared diagnostics vocabulary
    // (diagnostics.ts): the `too-large` message plus which Collect axis tripped.
    expect(warn.mock.calls[0]?.[0]).toContain('exceeded a Collect limit')
    expect(warn.mock.calls[0]?.[0]).toContain('nodes 9 over the nodes limit 3')
    // a resize must not re-attempt the given-up site
    warn.mockClear()
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 400))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refuses a capture wider than maxBreadth (widest level)', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    uninstall = installXrayClient({ sink, delay: 10, collect: { maxBreadth: 2 }, capture: true })
    // One level of 4 siblings — widest level > maxBreadth 2. Node count (under the
    // derived 2×32/4 = 16) and depth pass, so breadth is the axis that trips.
    document.body.innerHTML =
      '<div id="site" style="display: contents"><div><span>a</span><span>b</span><span>c</span><span>d</span></div></div>'
    const el = requireElement(document.getElementById('site'), '#site')
    globalThis.__XRAY__?.captured('wide', el)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(sink).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]?.[0]).toContain('over the breadth limit 2')
    warn.mockRestore()
  })

  it('refuses a capture deeper than maxDepth', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    uninstall = installXrayClient({ sink, delay: 10, collect: { maxDepth: 2 }, capture: true })
    // Nesting deeper than maxDepth 2. Breadth 1 and the derived node cap
    // (512×2/4 = 256) pass, so depth is the axis that trips.
    document.body.innerHTML =
      '<div id="site" style="display: contents"><div><div><div><span>x</span></div></div></div></div>'
    const el = requireElement(document.getElementById('site'), '#site')
    globalThis.__XRAY__?.captured('deep', el)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(sink).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]?.[0]).toContain('over the depth limit 2')
    warn.mockRestore()
  })
})

describe('lightbox store', () => {
  it('installs a persistent lightbox toggle that notifies subscribers', () => {
    uninstall = installXrayClient({ sink: () => {} })
    const lightbox = globalThis.__XRAY__?.lightbox
    expect(lightbox?.get()).toBe(false)
    const onChange = vi.fn()
    const unsubscribe = lightbox?.subscribe(onChange)
    lightbox?.set(true)
    expect(lightbox?.get()).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem('xray:lightbox')).toBe('1')
    lightbox?.set(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    unsubscribe?.()
    lightbox?.set(false)
    expect(onChange).toHaveBeenCalledTimes(1)
    window.sessionStorage.removeItem('xray:lightbox')
  })

  it('survives reinstall via sessionStorage', () => {
    uninstall = installXrayClient({ sink: () => {} })
    globalThis.__XRAY__?.lightbox?.set(true)
    uninstall()
    uninstall = installXrayClient({ sink: () => {} })
    expect(globalThis.__XRAY__?.lightbox?.get()).toBe(true)
    globalThis.__XRAY__?.lightbox?.set(false)
    window.sessionStorage.removeItem('xray:lightbox')
  })
})

describe('fixtures store (ADR 0015)', () => {
  afterEach(() => {
    window.sessionStorage.removeItem('xray:replay')
  })

  it('records the registered live data through the sink and round-trips it', async () => {
    const recordFixtureSink = vi.fn<(p: { name: string; data: string }) => Promise<void>>(
      async () => {},
    )
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink })
    const fixtures = globalThis.__XRAY__?.fixtures
    if (!fixtures) throw new Error('fixtures store missing')
    // devalue round-trips Map/Date that JSON can't.
    const data = { when: new Date(0), tags: new Map([['a', 1]]) }
    fixtures.register('banner', data)
    expect(fixtures.has('banner')).toBe(false)
    await fixtures.record('banner')
    expect(recordFixtureSink).toHaveBeenCalledTimes(1)
    const sent = recordFixtureSink.mock.calls[0]?.[0]
    expect(sent?.name).toBe('banner')
    expect(typeof sent?.data).toBe('string')
    expect(fixtures.has('banner')).toBe(true)
    const entry = fixtures.read('banner')
    if (!entry) throw new Error('expected a recorded fixture')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the store holds the same shape we recorded.
    const read = entry.data as typeof data
    expect(read.when).toBeInstanceOf(Date)
    expect(read.when.getTime()).toBe(0)
    expect(read.tags).toBeInstanceOf(Map)
    expect(read.tags.get('a')).toBe(1)
  })

  it('throws loudly when recording a plate with no registered live data', async () => {
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink: async () => {} })
    const fixtures = globalThis.__XRAY__?.fixtures
    await expect(fixtures?.record('never-registered')).rejects.toThrow(/no render-prop `data`/)
  })

  it('throws loudly on unrecordable data (devalue contract)', async () => {
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink: async () => {} })
    const fixtures = globalThis.__XRAY__?.fixtures
    fixtures?.register('fn-data', () => 1)
    await expect(fixtures?.record('fn-data')).rejects.toThrow()
  })

  it('seeds recorded fixtures from opaque devalue strings without clobbering this session', () => {
    const recordFixtureSink = vi.fn(async () => {})
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink })
    const fixtures = globalThis.__XRAY__?.fixtures
    if (!fixtures) throw new Error('fixtures store missing')
    const onChange = vi.fn()
    fixtures.subscribe(onChange)
    // devalue.stringify of { id: 7 } — seed it as the opaque on-disk form.
    fixtures.seed({ seeded: JSON.stringify([{ id: 1 }, 7]) })
    expect(fixtures.has('seeded')).toBe(true)
    const seeded = fixtures.read('seeded')
    if (!seeded) throw new Error('expected a seeded fixture')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- devalue round-trips the seeded shape.
    expect((seeded.data as { id: number }).id).toBe(7)
    expect(onChange).toHaveBeenCalled()
    // A broken sidecar string is skipped, not thrown.
    expect(() => fixtures.seed({ broken: 'not-devalue{' })).not.toThrow()
    expect(fixtures.has('broken')).toBe(false)
  })

  it('register returns a disposer so unmounted data never lingers or is recorded', async () => {
    const recordFixtureSink = vi.fn<(p: { name: string; data: string }) => Promise<void>>(
      async () => {},
    )
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink })
    const fixtures = globalThis.__XRAY__?.fixtures
    if (!fixtures) throw new Error('fixtures store missing')

    // One Skeleton mounts, then unmounts (runs its disposer). Its data must be gone.
    const dispose = fixtures.register('solo', { id: 1 })
    dispose()
    // No live data left → record fails loudly, and recordAll skips the name.
    await expect(fixtures.record('solo')).rejects.toThrow(/no render-prop `data`/)
    await fixtures.recordAll()
    expect(recordFixtureSink).not.toHaveBeenCalled()
    expect(fixtures.has('solo')).toBe(false)
  })

  it('an unmounted duplicate never shadows a still-mounted instance', async () => {
    const recordFixtureSink = vi.fn<(p: { name: string; data: string }) => Promise<void>>(
      async () => {},
    )
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink })
    const fixtures = globalThis.__XRAY__?.fixtures
    if (!fixtures) throw new Error('fixtures store missing')

    // Two Skeletons of the same plate mount with different data; the SECOND (last
    // mounted) then unmounts. Recording must read the remaining mounted instance,
    // never the unmounted one.
    const disposeFirst = fixtures.register('dup', { which: 'first' })
    const disposeSecond = fixtures.register('dup', { which: 'second' })
    disposeSecond()
    await fixtures.record('dup')
    const entry = fixtures.read('dup')
    if (!entry) throw new Error('expected a recorded fixture')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the store holds the same shape we recorded.
    expect((entry.data as { which: string }).which).toBe('first')
    disposeFirst()
  })

  it('recordAll records every plate that has registered live data', async () => {
    const recordFixtureSink = vi.fn<(p: { name: string; data: string }) => Promise<void>>(
      async () => {},
    )
    uninstall = installXrayClient({ sink: () => {}, recordFixtureSink })
    const fixtures = globalThis.__XRAY__?.fixtures
    if (!fixtures) throw new Error('fixtures store missing')
    fixtures.register('a', { id: 1 })
    fixtures.register('b', { id: 2 })
    await fixtures.recordAll()
    expect(recordFixtureSink).toHaveBeenCalledTimes(2)
    expect(fixtures.has('a')).toBe(true)
    expect(fixtures.has('b')).toBe(true)
  })
})

describe('replay toggle (ADR 0015)', () => {
  afterEach(() => {
    window.sessionStorage.removeItem('xray:replay')
  })

  it('defaults off and exposes the replay mode', () => {
    uninstall = installXrayClient({ sink: () => {} })
    expect(globalThis.__XRAY__?.replay?.get()).toBe(false)
    uninstall()
    uninstall = installXrayClient({ sink: () => {}, replay: 'missing-only' })
    expect(globalThis.__XRAY__?.replay?.get()).toBe(true)
    expect(globalThis.__XRAY__?.replayMode).toBe('missing-only')
  })

  it('carries the prefer mode and a manual record default', () => {
    uninstall = installXrayClient({ sink: () => {}, replay: 'prefer' })
    expect(globalThis.__XRAY__?.replayMode).toBe('prefer')
    expect(globalThis.__XRAY__?.recordMode).toBe('manual')
  })
})

describe('capture toggle', () => {
  it('defaults OFF — recording is explicit opt-in', () => {
    uninstall = installXrayClient({ sink: () => {} })
    expect(globalThis.__XRAY__?.capture?.get()).toBe(false)
  })

  it('honors capture: true for a direct caller that wants capture-on-boot', () => {
    uninstall = installXrayClient({ sink: () => {}, capture: true })
    expect(globalThis.__XRAY__?.capture?.get()).toBe(true)
  })

  it('skips capture while off, then captures mounted sites when flipped on', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: false })
    const capture = globalThis.__XRAY__?.capture
    expect(capture?.get()).toBe(false)

    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    // Nothing fires while capture is off — the site is registered, not walked.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(globalThis.__XRAY__?.plates?.get('my-site')).toBeUndefined()
    expect(sink).not.toHaveBeenCalled()

    // Flipping it on STARTS a recording and captures everything already mounted, no
    // reload — the live preview populates the plate store; stopping writes it once.
    capture?.set(true)
    await waitForRecorded('my-site')
    stopRecording()
    await vi.waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1)
    })
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('my-site')
  })
})

describe('recording session (the Capture toggle)', () => {
  // The Capture toggle is a recording session: while ON it ACCUMULATES Views across
  // navigation/resize/interaction (deduped per breakpoint band) and writes nothing to
  // disk; toggling OFF writes each accumulated plate ONCE. Before the fix the toggle
  // re-captured and overwrote the file per capture, so only the LAST View survived.

  it('accumulates Views across widths into ONE multi-View plate, written on stop', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    // A JS breakpoint so the two widths land in DIFFERENT bands (not deduped together).
    // Must be AFTER install — the client wraps matchMedia to record the query.
    window.matchMedia('(min-width: 768px)')
    setWidth(390)
    const el = mountSite()
    // A JS-responsive subtree: the wide layout renders an extra node, so the two
    // Views differ structurally (identical Views fold at Serialize — ADR 0029).
    window.addEventListener('resize', () => {
      const host = el.querySelector('div')
      if (!host) return
      const extra = host.querySelector('.wide')
      if (window.innerWidth >= 768 && !extra)
        host.insertAdjacentHTML('beforeend', '<p class="wide">w</p>')
      else if (window.innerWidth < 768 && extra) extra.remove()
    })
    globalThis.__XRAY__?.captured('my-site', el)
    await waitForRecorded('my-site')
    // Resize into the wider band; wait out the resize debounce (300ms) + settle so the
    // recording captures the second View.
    setWidth(1024)
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 450))
    // Nothing written yet — still recording.
    expect(sink).not.toHaveBeenCalled()

    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    const plate = sink.mock.calls[0]?.[0]?.plate
    expect(plate?.name).toBe('my-site')
    // Multi-View: two breakpoint bands → two gated islands (not just the last capture).
    expect(plate?.breakpoints).toContain(768)
    expect(plate?.tree?.kids).toHaveLength(2)
    expect(plate?.css).toContain('display: none !important')
  })

  it('dedups repeated captures in the SAME band to one View', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    window.matchMedia('(min-width: 768px)')
    setWidth(1000)
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    await waitForRecorded('my-site')
    // Resize WITHIN the same (>=768) band — each capture replaces the band's View.
    setWidth(1300)
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 450))
    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    // All captures fell in the one band → a single-View plate (no per-View islands).
    const plate = sink.mock.calls[0]?.[0]?.plate
    expect(plate?.tree?.kids).toHaveLength(1)
  })

  it('flashes only when a capture changes the recorded result', async () => {
    const flash = vi.mocked(blinkCapture)
    flash.mockClear()
    uninstall = installXrayClient({ sink: () => {}, delay: 10, capture: true })
    const el = mountSite()
    const content = requireElement(el.querySelector('.content'), '.content')
    globalThis.__XRAY__?.captured('my-site', el)
    // First capture changes the plate (nothing → plate) → one flash.
    await waitForRecorded('my-site')
    expect(flash).toHaveBeenCalledTimes(1)
    // Identical re-capture (same DOM + width) → no change → NO new flash.
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 450))
    expect(flash).toHaveBeenCalledTimes(1)
    // A real DOM change → the re-capture differs → it flashes again.
    content.append(document.createElement('span'))
    window.dispatchEvent(new Event('resize'))
    await new Promise((r) => setTimeout(r, 450))
    expect(flash).toHaveBeenCalledTimes(2)
  })

  it('keeps a separate buffer per plate name → one write each on stop', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    document.body.innerHTML =
      '<div id="a" style="display: contents"><div><p>A</p></div></div>' +
      '<div id="b" style="display: contents"><div><p>B</p></div></div>'
    globalThis.__XRAY__?.captured('plate-a', requireElement(document.getElementById('a'), '#a'))
    globalThis.__XRAY__?.captured('plate-b', requireElement(document.getElementById('b'), '#b'))
    await waitForRecorded('plate-a')
    await waitForRecorded('plate-b')
    expect(sink).not.toHaveBeenCalled()

    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(2))
    const names = sink.mock.calls.map((c) => c[0]?.plate.name).toSorted()
    expect(names).toEqual(['plate-a', 'plate-b'])
  })

  it('accumulates across a remount (the buffer is name-keyed, surviving unmount)', async () => {
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    uninstall = installXrayClient({ sink, delay: 10, capture: true })
    window.matchMedia('(min-width: 768px)')
    // Capture the narrow View, then UNMOUNT (navigate away) — the site disposes.
    setWidth(390)
    const dispose = globalThis.__XRAY__?.captured(
      'my-site',
      (() => {
        document.body.innerHTML = '<div id="s1" style="display:contents"><div><p>x</p></div></div>'
        return requireElement(document.getElementById('s1'), '#s1')
      })(),
    )
    await waitForRecorded('my-site')
    dispose?.()
    document.body.innerHTML = ''
    // Re-mount the SAME plate at a wider width (as if navigating back at a new size).
    setWidth(1024)
    document.body.innerHTML =
      '<div id="s2" style="display:contents"><div><p>x</p><p>wide</p></div></div>'
    globalThis.__XRAY__?.captured('my-site', requireElement(document.getElementById('s2'), '#s2'))
    await new Promise((r) => setTimeout(r, 120))

    stopRecording()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    // Both Views survived the unmount → a multi-View plate, not just the remount.
    expect(sink.mock.calls[0]?.[0]?.plate.tree?.kids).toHaveLength(2)
  })

  // Regression lineage (round 1, kept under the round-2 two-artifact
  // contract): found via the scratch consumer app's Light Box. The live
  // preview (`previewRecording`, fed into the SAME store `useLivePlate`
  // reads over a statically-imported module) once pushed a plate WITH
  // embedded css — so while a recording was live, Light Box (or a
  // still-loading site) reverted to inline-`<style>` rendering, duplicating
  // BASE_CSS + plate rules alongside the page's `.css` virtual module. Under
  // the two-artifact contract a store plate is TREE-ONLY by construction —
  // this pins that no css-shaped field ever rides the preview again.
  it('previews a recording in the live store as a tree-only plate (no css field)', async () => {
    uninstall = installXrayClient({ sink: () => {}, delay: 10, capture: true })
    const el = mountSite()
    globalThis.__XRAY__?.captured('my-site', el)
    await waitForRecorded('my-site')
    const previewed = globalThis.__XRAY__?.plates?.get('my-site')
    expect(previewed).toBeDefined()
    expect(previewed?.chunks).toBeTruthy()
    expect('css' in (previewed ?? {})).toBe(false)
    expect('cssExternal' in (previewed ?? {})).toBe(false)
  })
})
