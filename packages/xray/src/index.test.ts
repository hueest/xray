import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type GatedPlate, type Plate, PLATE_VERSION } from './plate.ts'
import { serializePlate } from './chunk.ts'
import {
  xrayVitePlugin,
  handleCapturePost,
  handleFixturePost,
  isValidPlateName,
  readCoverage,
  readFixtures,
  renderPlateModule,
} from './index.ts'

interface HookCtx {
  addWatchFile: (file: string) => void
}

function assertCallable<T extends (...args: any[]) => unknown>(
  value: unknown,
  _shape?: T,
): asserts value is T {
  if (typeof value !== 'function') throw new TypeError('expected callable hook')
}

function callable<T extends (...args: any[]) => unknown>(hook: unknown, _shape?: T): T {
  const value = typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : hook
  assertCallable(value, _shape)
  return value
}

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlate(value: unknown): value is Plate {
  // Two-artifact contract: a Plate is tree-only — no css field.
  return (
    isRecord(value) &&
    typeof value.v === 'number' &&
    typeof value.name === 'string' &&
    (value.chunks === null || Array.isArray(value.chunks))
  )
}

/** The on-disk StoredPlate shape the POST writes (ADR 0022). */
function isWrittenStoredPlate(
  value: unknown,
): value is { v: number; name: string; breakpoints: number[]; tree: unknown; css: string } {
  return (
    isRecord(value) &&
    typeof value.v === 'number' &&
    typeof value.name === 'string' &&
    Array.isArray(value.breakpoints) &&
    value.breakpoints.every((breakpoint) => typeof breakpoint === 'number') &&
    (value.tree === null || isRecord(value.tree)) &&
    typeof value.css === 'string'
  )
}

describe('xrayVitePlugin', () => {
  it('returns the data and dev plugins, in order', () => {
    const plugins = xrayVitePlugin()
    expect(plugins.map((p) => p.name)).toEqual(['xray:data', 'xray:dev'])
  })

  it('runs the dev plugin only on serve', () => {
    const [, dev] = xrayVitePlugin()
    expect(dev?.apply).toBe('serve')
  })

  it('aliases @hueest/xray/react to the dev adapter on serve (no self-loop)', () => {
    const [, dev] = xrayVitePlugin()
    const config = callable<() => { resolve: { alias: { find: RegExp; replacement: string }[] } }>(
      dev?.config,
    )
    const alias = config().resolve.alias[0]
    expect(alias).toBeDefined()
    // the consumer's production import is swapped for the dev adapter…
    expect('@hueest/xray/react'.replace(alias!.find, alias!.replacement)).toBe(
      '@hueest/xray/react/dev',
    )
    // …but the dev module itself is left alone, so resolution doesn't loop.
    expect('@hueest/xray/react/dev'.replace(alias!.find, alias!.replacement)).toBe(
      '@hueest/xray/react/dev',
    )
  })

  it('resolves virtual:xray/plates/* ids to a \\0-prefixed id, ignores others', () => {
    const [data] = xrayVitePlugin()
    const resolveId = callable<(id: string) => string | undefined>(data?.resolveId)
    expect(resolveId('virtual:xray/plates/my-banner')).toBe('\0virtual:xray/plates/my-banner')
    expect(resolveId('./real-module.ts')).toBeUndefined()
  })

  describe('load', () => {
    let root: string
    const ctx: HookCtx = { addWatchFile: () => {} }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'xray-'))
    })
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    /**
     * Load a plate's virtual JS module and split it into its two artifacts: the tree-only default
     * export (parsed) and the `export const css` string (parsed). Also asserts the module wiring:
     * both css side-effect imports present (the base import is the round-1 WIRING regression guard
     * — the page silently lost BASE_CSS/`@keyframes xr-pulse` when nothing imported it) and the css
     * named export present (the round-2 two-artifact shape).
     */
    function loadPlate(
      name: string,
      platesDir?: string,
    ): { plate: Plate; css: string } | undefined {
      const [data] = xrayVitePlugin(platesDir ? { platesDir } : {})
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const load = callable<(this: HookCtx, id: string) => string | undefined>(data?.load)
      const code = load.call(ctx, `\0virtual:xray/plates/${name}`)
      if (code === undefined) return undefined
      expect(code).toContain(`import "virtual:xray/base.css"`)
      expect(code).toContain(`import "virtual:xray/plates/${name}.css"`)
      const defaultMarker = 'export default '
      const start = code.indexOf(defaultMarker)
      expect(start).toBeGreaterThanOrEqual(0)
      const defaultEnd = code.indexOf('\n', start)
      const plate: unknown = JSON.parse(
        code.slice(start + defaultMarker.length, defaultEnd === -1 ? undefined : defaultEnd),
      )
      if (!isPlate(plate)) throw new Error('expected plate module payload')
      const cssMarker = 'export const css = '
      const cssStart = code.indexOf(cssMarker)
      expect(cssStart).toBeGreaterThanOrEqual(0)
      const css: unknown = JSON.parse(code.slice(cssStart + cssMarker.length).trimEnd())
      if (typeof css !== 'string') throw new Error('expected string css export')
      return { plate, css }
    }

    it('falls back to an empty plate when nothing is committed yet', () => {
      expect(loadPlate('my-banner')).toEqual({
        plate: { v: PLATE_VERSION, name: 'my-banner', chunks: null },
        css: '',
      })
    })

    it('serializes the committed StoredPlate into the two artifacts, from the configured dir', () => {
      mkdirSync(join(root, 'plates'))
      // The committed file is a StoredPlate (ADR 0022): the whole Plate
      // already projected in the browser — a post-classify RenderNode tree (content
      // classes, no ids) plus the scoped css blob. The loader runs only
      // `serializePlate` (the Bundle seam), lowering the tree to chunks.
      const stored = {
        v: PLATE_VERSION,
        name: 'my-banner',
        breakpoints: [],
        tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
        css: '[data-xr-root] .xr-my-banner-1 { display: flex }',
      }
      writeFileSync(join(root, 'plates', 'my-banner.json'), JSON.stringify(stored))
      const { plate, css } = defined(loadPlate('my-banner', 'plates'), 'plate')
      expect(plate.name).toBe('my-banner')
      // the single leaf node serializes to one stitch-free HTML chunk, leaf-tagged,
      // carrying the stored content class. The tree-only default export carries NO
      // css field; the css string rides the `export const css` named export (and
      // reaches the page through the sibling `.css` virtual module).
      const html = defined(plate.chunks?.[0], 'first chunk')
      if (typeof html !== 'string') throw new Error('expected string chunk')
      expect(html).toBe(`<div class="xr-node xr-leaf xr-leaf-text-line xr-my-banner-1"></div>`)
      expect('css' in plate).toBe(false)
      expect(css).toBe('[data-xr-root] .xr-my-banner-1 { display: flex }')
    })

    it('falls back to an empty plate on a version mismatch', () => {
      mkdirSync(join(root, 'plates'))
      writeFileSync(
        join(root, 'plates', 'my-banner.json'),
        JSON.stringify({
          v: PLATE_VERSION + 1,
          name: 'my-banner',
          breakpoints: [],
          tree: null,
          css: '',
        }),
      )
      expect(loadPlate('my-banner')).toEqual({
        plate: { v: PLATE_VERSION, name: 'my-banner', chunks: null },
        css: '',
      })
    })

    it('ignores non-xray ids', () => {
      expect(loadPlate('../escape')).toBeDefined()
      const [data] = xrayVitePlugin()
      const load = callable<(this: HookCtx, id: string) => string | undefined>(data?.load)
      expect(load.call(ctx, './real-module.ts')).toBeUndefined()
    })
  })

  // Virtual-CSS emission is the only path (maintainer decision, mid-flight):
  // the shared base-css module and each plate's own `.css` module. Both ids
  // are deliberately left UN-`\0`-prefixed (an unprefixed id is tried first,
  // matching the vanilla-extract pattern, since Vite's internal CSS plugins
  // route on the module id).
  describe('virtual css modules', () => {
    let root: string
    const ctx: HookCtx = { addWatchFile: () => {} }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'xray-css-'))
    })
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('resolves and loads virtual:xray/base.css to BASE_CSS', () => {
      const [data] = xrayVitePlugin()
      const resolveId = callable<(id: string) => string | undefined>(data?.resolveId)
      const load = callable<(id: string) => string | undefined>(data?.load)
      expect(resolveId('virtual:xray/base.css')).toBe('virtual:xray/base.css')
      expect(load('virtual:xray/base.css')).toContain('@keyframes xr-pulse')
    })

    it('resolves and loads a plate .css module from the committed StoredPlate, dir-configured', () => {
      mkdirSync(join(root, 'plates'))
      const stored = {
        v: PLATE_VERSION,
        name: 'my-banner',
        breakpoints: [],
        tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
        css: '[data-xr-root] .xr-my-banner-1 { display: flex }',
      }
      writeFileSync(join(root, 'plates', 'my-banner.json'), JSON.stringify(stored))

      const [data] = xrayVitePlugin()
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const resolveId = callable<(id: string) => string | undefined>(data?.resolveId)
      const load = callable<(id: string) => string | undefined>(data?.load)
      const id = resolveId('virtual:xray/plates/my-banner.css')
      expect(id).toBe('virtual:xray/plates/my-banner.css')
      expect(load(id!)).toBe('[data-xr-root] .xr-my-banner-1 { display: flex }')
    })

    it('loads an empty string for an uncaptured plate .css module', () => {
      const [data] = xrayVitePlugin()
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const load = callable<(id: string) => string | undefined>(data?.load)
      expect(load('virtual:xray/plates/never-captured.css')).toBe('')
    })
  })
})

describe('xray:dev', () => {
  it('injects the client bootstrap before the app when capture or the hud is on', () => {
    type Transform = () => Array<{ attrs: Record<string, string>; injectTo: string }> | undefined
    const inject = (opts: Parameters<typeof xrayVitePlugin>[0]) =>
      callable<Transform>(xrayVitePlugin(opts)[1]?.transformIndexHtml)()

    // capture on → injected
    const captureTags = inject({ capture: true })
    expect(captureTags?.[0]?.attrs.src).toBe('/@id/virtual:xray/client')
    expect(captureTags?.[0]?.injectTo).toBe('head-prepend')

    // hud on (capture off, the new default) → still injected, so the HUD's
    // Capture toggle can flip capture on at runtime
    expect(inject({ hud: true })?.[0]?.attrs.src).toBe('/@id/virtual:xray/client')

    // both off (the default) → no client
    expect(inject({})).toBeUndefined()
    expect(inject({ capture: false })).toBeUndefined()
  })

  it('boots the client for a replay-only or auto-record fixture config', () => {
    type Transform = () => Array<{ attrs: Record<string, string>; injectTo: string }> | undefined
    const inject = (opts: Parameters<typeof xrayVitePlugin>[0]) =>
      callable<Transform>(xrayVitePlugin(opts)[1]?.transformIndexHtml)()

    // Replay needs the runtime client to substitute recorded data — boot even with
    // capture and the HUD off.
    expect(inject({ fixtures: { replay: 'prefer' } })?.[0]?.attrs.src).toBe(
      '/@id/virtual:xray/client',
    )
    expect(inject({ fixtures: { replay: 'missing-only' } })?.[0]?.attrs.src).toBe(
      '/@id/virtual:xray/client',
    )
    // Auto-record writes as Skeletons go ready — also needs the booted client.
    expect(inject({ fixtures: { record: 'always' } })?.[0]?.attrs.src).toBe(
      '/@id/virtual:xray/client',
    )
    expect(inject({ fixtures: { record: 'first-ready' } })?.[0]?.attrs.src).toBe(
      '/@id/virtual:xray/client',
    )

    // Manual record + replay off needs nothing the HUD button does not already
    // imply (the button implies `hud`), so it does NOT independently boot.
    expect(inject({ fixtures: { record: 'manual', replay: false } })).toBeUndefined()
  })

  it('serves a bootstrap module wiring delay, sink, and the opt-in hud', () => {
    const [, dev] = xrayVitePlugin({ delay: 350, hud: true })
    const resolveId = callable<(id: string) => string | undefined>(dev?.resolveId)
    const load = callable<(id: string) => string | undefined>(dev?.load)
    const resolved = defined(resolveId('virtual:xray/client'), 'resolved client id')
    expect(resolved).toBe('\0virtual:xray/client')
    const code = load(resolved)
    expect(code).toContain("from '@hueest/xray/internal/client'")
    expect(code).toContain('delay: 350')
    // capture defaults off; the bootstrap wires that initial state to the client
    expect(code).toContain('capture: false')
    expect(code).toContain("fetch('/__xray'")
    // The sink RETURNS the fetch promise and rejects on a non-2xx so capture-all
    // can await a server-confirmed write (capture-all-backpressure plan).
    expect(code).toContain("return fetch('/__xray'")
    expect(code).toContain('if (!response.ok) throw new Error')
    // refreshCoverage re-pulls on-disk coverage between sweep passes.
    expect(code).toContain('refreshCoverage()')
    expect(code).toContain("from '@hueest/xray/internal/hud'")
    expect(code).toContain("import.meta.hot.on('xray:plate'")
    expect(code).toContain('updatePlate')
    // Fixtures (ADR 0015): record defaults to 'manual', replay defaults off, the
    // recordFixtureSink POSTs to /__xray/fixture, and the boot seeds fixtures.
    expect(code).toContain('record: "manual"')
    expect(code).toContain('replay: false')
    expect(code).toContain("fetch('/__xray/fixture'")
    expect(code).toContain("fetch('/__xray/fixtures')")
    expect(code).toContain('fixtures?.seed?.(fixtures)')

    // Non-default fixture modes flow through as boot state.
    const withFixtures = callable<(id: string) => string | undefined>(
      xrayVitePlugin({ fixtures: { record: 'first-ready', replay: 'missing-only' } })[1]?.load,
    )(resolved)
    expect(withFixtures).toContain('record: "first-ready"')
    expect(withFixtures).toContain('replay: "missing-only"')

    const onCapture = callable<(id: string) => string | undefined>(
      xrayVitePlugin({ capture: true })[1]?.load,
    )(resolved)
    expect(onCapture).toContain('capture: true')

    const [, noHud] = xrayVitePlugin()
    const noHudCode = callable<(id: string) => string | undefined>(noHud?.load)(resolved)
    expect(noHudCode).not.toContain('hud')
  })
})

describe('readCoverage', () => {
  it('reads per-plate breakpoints and DERIVES coverage bands from disk, skipping non-json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xray-cov-'))
    try {
      // A committed StoredPlate (ADR 0022): disk carries no per-View spans
      // — the bands derive from `breakpoints` (a StoredPlate sweeps every
      // width in one session, so coverage is complete). [768, 1024] partitions into
      // three covered bands: open-min, the middle pair, open-max.
      writeFileSync(
        join(dir, 'dash.json'),
        JSON.stringify({
          v: PLATE_VERSION,
          name: 'dash',
          breakpoints: [768, 1024],
          tree: { kids: [{ leaf: 'box', cls: 'xr-dash-1' }] },
          css: '',
        }),
      )
      writeFileSync(join(dir, 'notes.txt'), 'ignored')
      expect(readCoverage(dir)).toEqual({
        dash: {
          breakpoints: [768, 1024],
          spans: [{ max: 768 }, { min: 768, max: 1024 }, { min: 1024 }],
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives one open band for a StoredPlate with no breakpoints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xray-cov0-'))
    try {
      writeFileSync(
        join(dir, 'solo.json'),
        JSON.stringify({
          v: PLATE_VERSION,
          name: 'solo',
          breakpoints: [],
          tree: { kids: [{ leaf: 'text-line', cls: 'xr-solo-1' }] },
          css: '',
        }),
      )
      expect(readCoverage(dir)).toEqual({ solo: { breakpoints: [], spans: [{}] } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('handleCapturePost', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xray-post-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  interface SentEvent {
    event: string
    data: { name: string; plate: { chunks: unknown } }
  }
  function post(
    body: unknown,
    opts: { headers?: Record<string, string | undefined>; method?: string } = {},
  ): {
    status: () => number
    events: SentEvent[]
    warnings: string[]
  } {
    const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const req = {
      method: opts.method ?? 'POST',
      // The real capture client always posts application/json; default that here
      // so the front-door content-type check passes unless a test overrides it.
      headers: opts.headers ?? { 'content-type': 'application/json' },
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
        listeners[event] = cb
      },
      destroy() {},
    }
    const res = { statusCode: 0, end: () => {} }
    const events: SentEvent[] = []
    const warnings: string[] = []
    // Supply a Vite-like logger so diagnostics route to it (not console), and
    // we can assert the exact server output text.
    const server = {
      ws: { send: (msg: SentEvent) => events.push(msg) },
      config: { logger: { warn: (message: string) => warnings.push(message) } },
    }
    handleCapturePost(req, res, server, (name) => join(root, `${name}.json`))
    listeners.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    listeners.end?.()
    return { status: () => res.statusCode, events, warnings }
  }

  // The POST envelope (ADR 0022): a finished, in-browser-projected
  // StoredPlate (a post-classify RenderNode tree + scoped css blob + breakpoints)
  // PLUS an optional sibling `diagnostics` array the server logs and drops.
  const stored = {
    v: PLATE_VERSION,
    name: 'my-banner',
    breakpoints: [1200],
    tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
    css: '[data-xr-root] .xr-my-banner-1 { width: 10px }',
  }

  it('writes the StoredPlate as-is and announces the lowered plate over the ws', () => {
    const result = post({ plate: stored })
    expect(result.status()).toBe(204)
    const written: unknown = JSON.parse(readFileSync(join(root, 'my-banner.json'), 'utf8'))
    if (!isWrittenStoredPlate(written)) throw new Error('expected written StoredPlate')
    // Written AS-IS — no server-side merge/accumulation.
    expect(written).toEqual(stored)
    expect(written.breakpoints).toEqual([1200])
    // The event carries the LOWERED plate (serializePlate of the stored tree) — no
    // module invalidation/reload.
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.event).toBe('xray:plate')
    expect(result.events[0]?.data.name).toBe('my-banner')
    expect(result.events[0]?.data.plate.chunks).toBeTruthy()
  })

  it('skips the write when the StoredPlate changes nothing', () => {
    post({ plate: stored })
    const second = post({ plate: stored })
    expect(second.status()).toBe(204)
    expect(second.events).toEqual([])
  })

  // Dev module invalidation: a plate file change must drop BOTH of the
  // plate's virtual modules from Vite's transform cache, each through its own
  // channel — css invalidated AND reloaded (live CSS-HMR push), the JS tree
  // invalidated ONLY (no reload — a live re-import would remount the capture
  // boundary and re-fire capture, the original infinite-loop concern; the
  // next full page load re-transforms from disk instead). QA bug found in the
  // dogfood app: with only the css half wired, a page reload after
  // a capture paired Vite's CACHED old tree (stale content-addressed class
  // names) with fresh css → class names missed the rules → garbled skeletons
  // until a dev-server restart.
  describe('dev module invalidation', () => {
    interface AnnouncedEvent {
      event: string
      data: { name: string; plate: Record<string, unknown> }
    }

    /**
     * Mock module-graph server: both virtual modules resolvable for `my-banner`, recording
     * invalidations and reloads separately.
     */
    function mockGraphServer() {
      const invalidated: unknown[] = []
      const reloaded: unknown[] = []
      const events: AnnouncedEvent[] = []
      const jsMod = { id: '\0virtual:xray/plates/my-banner' }
      const cssMod = { id: 'virtual:xray/plates/my-banner.css' }
      const modules = new Map<string, unknown>([
        [jsMod.id, jsMod],
        [cssMod.id, cssMod],
      ])
      return {
        jsMod,
        cssMod,
        invalidated,
        reloaded,
        events,
        server: {
          ws: { send: (msg: AnnouncedEvent) => events.push(msg) },
          config: { logger: { warn: () => {} } },
          moduleGraph: {
            getModuleById: (id: string) => modules.get(id),
            invalidateModule: (mod: unknown) => {
              invalidated.push(mod)
            },
          },
          reloadModule: (mod: unknown) => {
            reloaded.push(mod)
            return Promise.resolve()
          },
        },
      }
    }

    function postWith(graph: ReturnType<typeof mockGraphServer>, body: unknown): number {
      const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
      const req = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
          listeners[event] = cb
        },
        destroy() {},
      }
      const res = { statusCode: 0, end: () => {} }
      handleCapturePost(req, res, graph.server, (name) => join(root, `${name}.json`))
      listeners.data?.(Buffer.from(JSON.stringify(body)))
      listeners.end?.()
      return res.statusCode
    }

    // Regression lineage (round 1, kept under the round-2 contract): an early
    // version had `announcePlate` push a plate WITH embedded css over the
    // `xray:plate` HMR event. Since the dev adapter's `useLivePlate` prefers
    // the live-store plate over the statically-imported module, this
    // silently reverted EVERY mounted `<Skeleton>` to inline-`<style>`
    // rendering the instant a capture landed — a second `<style>` with
    // BASE_CSS + plate css appeared alongside the `.css` module's own
    // `<style>`, duplicating rules in the page. Under the two-artifact
    // contract the announced plate is TREE-ONLY (no css field at all), which
    // makes that bug class structurally impossible — this test pins it.
    it('announces a tree-only plate (no css field) over the ws event', () => {
      const graph = mockGraphServer()
      expect(postWith(graph, { plate: stored })).toBe(204)
      expect(graph.events).toHaveLength(1)
      const announced = graph.events[0]?.data.plate
      expect(announced).toBeDefined()
      expect('css' in (announced ?? {})).toBe(false)
      expect('cssExternal' in (announced ?? {})).toBe(false)
      expect(announced?.chunks).toBeTruthy()
    })

    it('on a successful write: invalidates the JS tree module (no reload) AND reloads the css module', async () => {
      const graph = mockGraphServer()
      expect(postWith(graph, { plate: stored })).toBe(204)
      // Fire-and-forget: give the microtask a tick to run before asserting.
      await Promise.resolve()
      await Promise.resolve()
      // The JS module is invalidated only — cache-marked for the next full
      // load, never HMR-reloaded (no capture-boundary remount).
      expect(graph.invalidated).toEqual([graph.jsMod])
      expect(graph.reloaded).not.toContain(graph.jsMod)
      // The css module is reloaded (Vite CSS-HMR pushes fresh styles live).
      expect(graph.reloaded).toEqual([graph.cssMod])
    })

    it('does NOT invalidate anything on the unchanged-write no-op path', async () => {
      const graph = mockGraphServer()
      expect(postWith(graph, { plate: stored })).toBe(204)
      await Promise.resolve()
      await Promise.resolve()
      const invalidatedAfterFirst = graph.invalidated.length
      const reloadedAfterFirst = graph.reloaded.length
      // The identical re-post hits the unchanged-write 204 early return —
      // no announce, no invalidation, so an idle open page is never poked.
      expect(postWith(graph, { plate: stored })).toBe(204)
      await Promise.resolve()
      await Promise.resolve()
      expect(graph.events).toHaveLength(1)
      expect(graph.invalidated).toHaveLength(invalidatedAfterFirst)
      expect(graph.reloaded).toHaveLength(reloadedAfterFirst)
    })

    it('is a no-op for a plate whose modules were never resolved (fresh name, no page import yet)', async () => {
      const graph = mockGraphServer()
      const fresh = { ...stored, name: 'never-imported' }
      expect(postWith(graph, { plate: fresh })).toBe(204)
      await Promise.resolve()
      await Promise.resolve()
      // Neither module id exists in the graph (getModuleById → undefined):
      // nothing to invalidate, nothing thrown, the write itself succeeded.
      expect(graph.invalidated).toHaveLength(0)
      expect(graph.reloaded).toHaveLength(0)
    })

    it('the watcher path (hand edit / git checkout) invalidates both modules and announces', async () => {
      // Wire the dev plugin's configureServer the way Vite would, capturing
      // the watcher handler, then simulate a plates-dir file change.
      const graph = mockGraphServer()
      const [data, dev] = xrayVitePlugin()
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      const ctx: HookCtx = { addWatchFile: () => {} }
      configResolved.call(ctx, { root })
      const handlers: Record<string, (file: string) => void> = {}
      const server = {
        ...graph.server,
        watcher: {
          add: () => {},
          on: (event: string, cb: (file: string) => void) => {
            handlers[event] = cb
          },
        },
        middlewares: { use: () => {} },
      }
      const configureServer = callable<(server: unknown) => void>(dev?.configureServer)
      configureServer.call(ctx, server)

      // A committed plate lands on disk outside the POST endpoint.
      mkdirSync(join(root, 'plates'), { recursive: true })
      writeFileSync(join(root, 'plates', 'my-banner.json'), JSON.stringify(stored))
      handlers.change?.(join(root, 'plates', 'my-banner.json'))
      await Promise.resolve()
      await Promise.resolve()
      // Announced to the live store AND both transforms dropped, so the open
      // page hot-swaps now and the next full load is consistent with disk.
      expect(graph.events).toHaveLength(1)
      expect(graph.invalidated).toEqual([graph.jsMod])
      expect(graph.reloaded).toEqual([graph.cssMod])
    })
  })

  it('rejects traversal names and malformed bodies', () => {
    expect(post({ plate: { ...stored, name: '../escape' } }).status()).toBe(400)
    expect(post('not json').status()).toBe(400)
    // A bare StoredPlate (no envelope) is rejected — the `plate` key is required.
    expect(post(stored).status()).toBe(400)
  })

  it('rejects a malformed tree and a css <style> break-out', () => {
    // a `cls` over the bound / a non-record tree node is not something the capture
    // path ever emits — `parseStoredPlate` rejects it.
    expect(post({ plate: { ...stored, tree: { kids: 'nope' } } }).status()).toBe(400)
    // a css blob that tries to break out of the <style> raw text
    expect(
      post({
        plate: { ...stored, css: 'a { width: 1px }</style><script>alert(1)</script>' },
      }).status(),
    ).toBe(400)
  })

  it('rejects a non-POST method (405) and a non-JSON content type (415)', () => {
    expect(post({ plate: stored }, { method: 'GET' }).status()).toBe(405)
    expect(post({ plate: stored }, { headers: { 'content-type': 'text/plain' } }).status()).toBe(
      415,
    )
    // a missing content-type is also rejected
    expect(post({ plate: stored }, { headers: {} }).status()).toBe(415)
  })

  it('rejects an oversized declared content-length up front (413)', () => {
    const result = post(
      { plate: stored },
      { headers: { 'content-type': 'application/json', 'content-length': '9000000' } },
    )
    expect(result.status()).toBe(413)
  })

  it('rejects an oversized streaming body even without content-length (413)', () => {
    // Stream chunks past the cap; the handler must stop buffering and tear down.
    const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
    let destroyed = false
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
        listeners[event] = cb
      },
      destroy() {
        destroyed = true
      },
    }
    const res = { statusCode: 0, end: () => {} }
    const server = {
      ws: { send: () => {} },
      config: { logger: { warn: () => {} } },
    }
    handleCapturePost(req, res, server, (name) => join(root, `${name}.json`))
    // 5 chunks of ~1MB each = ~5MB, over the 4MB cap.
    const oneMb = 'x'.repeat(1_000_000)
    for (let i = 0; i < 5; i++) listeners.data?.(Buffer.from(oneMb))
    listeners.end?.()
    expect(res.statusCode).toBe(413)
    expect(destroyed).toBe(true)
  })

  it('prints the envelope diagnostics to the server output but never persists them', () => {
    const result = post({
      plate: stored,
      diagnostics: [
        {
          code: 'dropped-cropped',
          message:
            'dropped bones below the fold (off-screen at capture, in the viewport or a scroll container); real content fills in below without shifting the visible skeleton',
          count: 15,
        },
      ],
    })
    expect(result.status()).toBe(204)
    // Server output speaks the shared vocabulary.
    expect(result.warnings.join('\n')).toContain('"my-banner"')
    expect(result.warnings.join('\n')).toContain('dropped bones below the fold')
    expect(result.warnings.join('\n')).toContain('(15)')

    // The persisted file is byte-identical to the same StoredPlate posted WITHOUT
    // diagnostics — the sibling envelope field never reaches disk (ADR 0008).
    const withDiagJson = readFileSync(join(root, 'my-banner.json'), 'utf8')
    rmSync(join(root, 'my-banner.json'))
    post({ plate: stored })
    const cleanJson = readFileSync(join(root, 'my-banner.json'), 'utf8')
    expect(withDiagJson).toBe(cleanJson)
    expect(withDiagJson).not.toContain('diagnostics')
  })

  it('warns when an existing committed plate file is unreadable', () => {
    writeFileSync(join(root, 'my-banner.json'), '{ not valid json')
    const result = post({ plate: stored })
    // The capture still lands (invalid file treated as absent), and the dropped
    // file is explained without echoing its contents.
    expect(result.status()).toBe(204)
    expect(result.warnings.join('\n')).toContain('could not be read')
    expect(result.warnings.join('\n')).toContain('my-banner.json')
  })
})

describe('handleFixturePost + readFixtures (ADR 0015)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xray-fixture-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const fixturePath = (name: string) => join(root, `${name}.fixture.json`)

  function post(
    body: unknown,
    opts: { headers?: Record<string, string | undefined>; method?: string } = {},
  ): { status: () => number } {
    const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const req = {
      method: opts.method ?? 'POST',
      headers: opts.headers ?? { 'content-type': 'application/json' },
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
        listeners[event] = cb
      },
      destroy() {},
    }
    const res = { statusCode: 0, end: () => {} }
    handleFixturePost(req, res, fixturePath)
    listeners.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    listeners.end?.()
    return { status: () => res.statusCode }
  }

  it('writes the sidecar with the opaque devalue string and a version, never parsing data', () => {
    // `data` is whatever the client posted — the node side never parses it. Use a
    // string that is intentionally NOT valid JSON-as-data to prove it stays opaque.
    const opaque = '[{"when":1},-9]'
    const result = post({ name: 'banner', data: opaque })
    expect(result.status()).toBe(204)
    const written: unknown = JSON.parse(readFileSync(fixturePath('banner'), 'utf8'))
    expect(written).toMatchObject({ v: 1, name: 'banner', data: opaque })
  })

  it('writes the fixture NEXT TO the plate, never merging into it', () => {
    post({ name: 'banner', data: '[0]' })
    // The plate file is untouched — only the .fixture.json sidecar exists.
    expect(() => readFileSync(join(root, 'banner.json'), 'utf8')).toThrow()
    expect(() => readFileSync(fixturePath('banner'), 'utf8')).not.toThrow()
  })

  it('rejects bad method, content type, traversal names, and non-string data', () => {
    expect(post({ name: 'banner', data: '[0]' }, { method: 'GET' }).status()).toBe(405)
    expect(
      post({ name: 'banner', data: '[0]' }, { headers: { 'content-type': 'text/plain' } }).status(),
    ).toBe(415)
    expect(post({ name: '../escape', data: '[0]' }).status()).toBe(400)
    expect(post({ name: 'banner', data: 123 }).status()).toBe(400)
    expect(post('not json').status()).toBe(400)
  })

  it('readFixtures returns the opaque strings keyed by name and ignores plate files', () => {
    post({ name: 'banner', data: '[{"id":1},7]' })
    post({ name: 'nested/card', data: '[1]' })
    // A real plate file must NOT appear as a fixture (different suffix, dotted name
    // rejected by isValidPlateName).
    writeFileSync(
      join(root, 'banner.json'),
      '{"v":1,"name":"banner","breakpoints":[],"tree":null,"css":""}',
    )
    const fixtures = readFixtures(root)
    expect(fixtures.banner).toBe('[{"id":1},7]')
    expect(fixtures['nested/card']).toBe('[1]')
    expect(Object.keys(fixtures)).not.toContain('banner.fixture')
  })

  it('readFixtures skips a corrupt or version-mismatched sidecar', () => {
    writeFileSync(fixturePath('broken'), '{ not json')
    writeFileSync(fixturePath('wrong-version'), '{"v":99,"name":"wrong-version","data":"[0]"}')
    post({ name: 'good', data: '[0]' })
    const fixtures = readFixtures(root)
    expect(fixtures.good).toBe('[0]')
    expect(fixtures.broken).toBeUndefined()
    expect(fixtures['wrong-version']).toBeUndefined()
  })
})

describe('the /__xray middleware origin gate', () => {
  let root: string
  const ctx: HookCtx = { addWatchFile: () => {} }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xray-origin-'))
    // The gate names the mismatch server-side; keep test output quiet.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  type Middleware = (
    req: {
      method: string
      url: string
      headers: Record<string, string | undefined>
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void): void
      destroy(): void
    },
    res: { statusCode: number; end: (chunk?: string) => void },
  ) => void

  /** Wire the dev plugin's middleware the way Vite would, writing under `root`. */
  function endpoint(): Middleware {
    const [data, dev] = xrayVitePlugin()
    const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
    configResolved.call(ctx, { root })
    let middleware: Middleware | undefined
    const server = {
      watcher: { add: () => {}, on: () => {} },
      middlewares: {
        use: (_route: string, handler: Middleware) => {
          middleware = handler
        },
      },
      ws: { send: () => {} },
      config: { logger: { warn: () => {} } },
    }
    const configureServer = callable<(server: unknown) => void>(dev?.configureServer)
    configureServer.call(ctx, server)
    return defined(middleware, 'middleware')
  }

  function post(
    url: string,
    body: unknown,
    headers: Record<string, string | undefined>,
  ): { status: () => number } {
    const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const req = {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...headers },
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
        listeners[event] = cb
      },
      destroy() {},
    }
    const res = { statusCode: 0, end: () => {} }
    endpoint()(req, res)
    listeners.data?.(Buffer.from(JSON.stringify(body)))
    listeners.end?.()
    return { status: () => res.statusCode }
  }

  // A minimal valid capture envelope, so an ALLOWED post reaches the 204 path
  // and proves the gate (not validation) is what decides.
  const stored = {
    v: PLATE_VERSION,
    name: 'my-banner',
    breakpoints: [],
    tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
    css: '',
  }
  const plateFile = () => join(root, 'plates', 'my-banner.json')

  it('rejects a cross-origin POST with 403 and writes no Plate file', () => {
    const result = post(
      '/',
      { plate: stored },
      { origin: 'http://evil.localhost:9999', host: 'localhost:5173' },
    )
    expect(result.status()).toBe(403)
    expect(() => readFileSync(plateFile(), 'utf8')).toThrow()
  })

  it('allows a same-origin POST (Origin host equals Host, port included)', () => {
    const result = post(
      '/',
      { plate: stored },
      { origin: 'http://localhost:5173', host: 'localhost:5173' },
    )
    expect(result.status()).toBe(204)
    expect(() => readFileSync(plateFile(), 'utf8')).not.toThrow()
  })

  it('allows a POST with no Origin header (curl, a node script)', () => {
    const result = post('/', { plate: stored }, { host: 'localhost:5173' })
    expect(result.status()).toBe(204)
    expect(() => readFileSync(plateFile(), 'utf8')).not.toThrow()
  })

  it('rejects Origin: null with 403', () => {
    const result = post('/', { plate: stored }, { origin: 'null', host: 'localhost:5173' })
    expect(result.status()).toBe(403)
    expect(() => readFileSync(plateFile(), 'utf8')).toThrow()
  })

  it('rejects a cross-origin POST to /fixture and writes no Fixture sidecar', () => {
    const result = post(
      '/fixture',
      { name: 'my-banner', data: '[0]' },
      { origin: 'http://evil.localhost:9999', host: 'localhost:5173' },
    )
    expect(result.status()).toBe(403)
    expect(() => readFileSync(join(root, 'plates', 'my-banner.fixture.json'), 'utf8')).toThrow()
  })
})

// The two-artifact module shape (plan 005 round 2) is the ONLY shape
// `renderPlateModule` produces: two side-effect css imports (the SHARED
// `virtual:xray/base.css`, deduped by module identity, plus the plate's own
// `.css` module), a TREE-ONLY default export (no css field), and an
// `export const css` carrying the css string as data (tree-shaken by Rollup
// when only the default is imported — production adapters never touch it).
// This is a behavior change from the old inline-in-JSON contract; these
// assertions reflect the NEW module shape (not a regression to hide — see the
// plan's Test plan section).
describe('renderPlateModule', () => {
  const stitchless: GatedPlate = {
    v: PLATE_VERSION,
    name: 'news-feed',
    tree: { kids: [{ leaf: 'box' }] },
    css: '',
  }

  // The WIRING regression guard (review round 1): base.css being resolvable
  // and loadable in isolation is worthless if nothing imports it — without
  // this import, the page silently drops BASE_CSS (`@keyframes xr-pulse`, the
  // bone fill, the reveal channel), since the adapter no longer injects any
  // inline css of its own. Every generated module must transitively pull
  // BASE_CSS in.
  it('imports the shared base.css module (BASE_CSS wiring) on every plate module', () => {
    for (const merged of [
      stitchless,
      {
        v: PLATE_VERSION,
        name: 'dashboard',
        tree: { kids: [{ ref: 'news-feed' }] },
        css: '.x { display: block }',
      } satisfies GatedPlate,
    ]) {
      const code = renderPlateModule(merged)
      expect(code).toContain(`import "virtual:xray/base.css"`)
      // Base rides BEFORE the plate's own css module, preserving the old
      // inline `${BASE_CSS}\n${css}` relative order (a plate rule still beats
      // a base rule at equal specificity by source order).
      expect(code.indexOf('virtual:xray/base.css')).toBeLessThan(
        code.indexOf(`virtual:xray/plates/${merged.name}.css`),
      )
    }
  })

  it('emits a tree-only default export for a stitchless plate', () => {
    const code = renderPlateModule(stitchless)
    expect(code).toContain(`import "virtual:xray/base.css"`)
    expect(code).toContain(`import "virtual:xray/plates/news-feed.css"`)
    expect(code).toContain(`export default ${JSON.stringify(serializePlate(stitchless))}`)
    // Tree-only: neither the css payload nor the retired cssExternal hack.
    expect(code).not.toContain('cssExternal')
  })

  it('moves the css payload out of the JSON into the `export const css` named export', () => {
    const withCss: GatedPlate = {
      v: PLATE_VERSION,
      name: 'my-banner',
      tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
      css: '[data-xr-root] .xr-my-banner-1 { display: flex }',
    }
    const code = renderPlateModule(withCss)
    expect(code).toContain(`import "virtual:xray/plates/my-banner.css"`)
    // The default-export JSON (its own line) carries no css.
    const defaultLine = code.split('\n').find((line) => line.startsWith('export default '))
    expect(defaultLine).toBeDefined()
    expect(defaultLine).not.toContain('display: flex')
    const json: unknown = JSON.parse(defaultLine!.slice('export default '.length))
    expect(json).toEqual(serializePlate(withCss))
    // The css string rides the named export, as data.
    expect(code).toContain(
      `export const css = ${JSON.stringify('[data-xr-root] .xr-my-banner-1 { display: flex }')}`,
    )
  })

  it('emits a real import per distinct ref, the css imports, and wires refs into refs', () => {
    const plate: GatedPlate = {
      v: PLATE_VERSION,
      name: 'dashboard',
      tree: {
        kids: [{ ref: 'news-feed' }, { ref: 'content-cards' }, { ref: 'news-feed' }],
      },
      css: '',
    }
    const code = renderPlateModule(plate)
    expect(code).toContain(`import "virtual:xray/base.css"`)
    expect(code).toContain(`import "virtual:xray/plates/dashboard.css"`)
    expect(code).toContain(`import __xr0 from "virtual:xray/plates/news-feed"`)
    expect(code).toContain(`import __xr1 from "virtual:xray/plates/content-cards"`)
    // base + plate css imports + one import per distinct ref
    expect(code.match(/^import /gm)).toHaveLength(4)
    expect(code).toContain('Object.assign(')
    expect(code).toContain(`"news-feed": __xr0`)
    expect(code).toContain(`"content-cards": __xr1`)
    // The ref-bearing shape still ends with the css named export.
    expect(code).toContain('export const css = ')
  })

  it('drops a self-reference (a module cannot import itself) but keeps the css imports', () => {
    const plate: GatedPlate = {
      v: PLATE_VERSION,
      name: 'dashboard',
      tree: { kids: [{ ref: 'dashboard' }] },
      css: '',
    }
    const code = renderPlateModule(plate)
    expect(code).toContain(`import "virtual:xray/base.css"`)
    expect(code).toContain(`import "virtual:xray/plates/dashboard.css"`)
    expect(code.match(/^import /gm)).toHaveLength(2)
    expect(code).toContain('export default')
    expect(code).toContain('export const css = ')
  })
})

describe('isValidPlateName', () => {
  it('accepts single and nested names with single interior hyphens', () => {
    expect(isValidPlateName('my-banner')).toBe(true)
    expect(isValidPlateName('product/card')).toBe(true)
    expect(isValidPlateName('product_card')).toBe(true)
    expect(isValidPlateName('a/b/c')).toBe(true)
    expect(isValidPlateName('a/b_c')).toBe(true)
  })

  it('rejects a literal -- in a segment, so / -> -- cannot collide', () => {
    // The encoder renders `/` as `--`; a literal `--` would make
    // `product--card` and `product/card` share a class prefix (ADR 0007).
    expect(isValidPlateName('product--card')).toBe(false)
    expect(isValidPlateName('a--b/c')).toBe(false)
  })

  it('rejects edge hyphens, so no hyphen ever abuts a / boundary', () => {
    // `a/-b` and `a-/b` would both encode to `a---b` if edge hyphens were
    // allowed; forbidding them keeps the prefix encoding injective.
    expect(isValidPlateName('-lead')).toBe(false)
    expect(isValidPlateName('trail-')).toBe(false)
    expect(isValidPlateName('a/-b')).toBe(false)
    expect(isValidPlateName('a-/b')).toBe(false)
  })

  it('rejects empty, traversal, and non-word characters', () => {
    expect(isValidPlateName('')).toBe(false)
    expect(isValidPlateName('a//b')).toBe(false)
    expect(isValidPlateName('a/')).toBe(false)
    expect(isValidPlateName('a.b')).toBe(false)
  })
})
