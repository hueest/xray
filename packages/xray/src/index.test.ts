import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify as devalueStringify } from 'devalue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type GatedPlate, type Plate, PLATE_VERSION, type StoredPlate } from './plate.ts'
import { serializePlate } from './chunk.ts'
import { renderEnvFile, renderPlateSourceModule } from './plate-source.ts'
import { callable } from './test-helpers.ts'
import {
  xrayVitePlugin,
  handleCapturePost,
  handleFixturePost,
  isValidPlateName,
  readCoverage,
  renderPlateModule,
} from './index.ts'

interface HookCtx {
  addWatchFile: (file: string) => void
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

/** Write a committed plate MODULE (ADR 0034) the way a capture would. */
function writePlateModule(file: string, plate: StoredPlate, fixturePayload?: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderPlateSourceModule({ plate, fixturePayload }))
}

/** A minimal captureless StoredPlate, for tests that only care about the module's presence. */
const platedStored = (name: string): StoredPlate => ({
  v: PLATE_VERSION,
  name,
  breakpoints: [],
  tree: null,
  css: '',
})

/** A mock POST request whose data/end listeners land in `bucket` for manual firing. */
const listenersFor = (bucket: Record<string, (chunk?: Buffer | string) => void>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
    bucket[event] = cb
  },
  destroy() {},
})

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
    async function loadPlate(
      name: string,
      platesDir?: string,
    ): Promise<{ plate: Plate; css: string } | undefined> {
      const [data] = xrayVitePlugin(platesDir ? { platesDir } : {})
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const load = callable<(this: HookCtx, id: string) => Promise<string | undefined>>(data?.load)
      const code = await load.call(ctx, `\0virtual:xray/plates/${name}`)
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

    it('falls back to an empty plate when nothing is committed yet', async () => {
      expect(await loadPlate('my-banner')).toEqual({
        plate: { v: PLATE_VERSION, name: 'my-banner', chunks: null },
        css: '',
      })
    })

    it('serializes the committed StoredPlate into the two artifacts, from the configured dir', async () => {
      // The committed file is a plate MODULE (ADR 0034): the StoredPlate — the
      // whole Plate already projected in the browser (a post-classify RenderNode
      // tree with content classes plus the scoped css blob) — as the default
      // export. The loader runs only `serializePlate` (the Bundle seam),
      // lowering the tree to chunks.
      const stored: StoredPlate = {
        v: PLATE_VERSION,
        name: 'my-banner',
        breakpoints: [],
        tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
        css: '[data-xr-root] .xr-my-banner-1 { display: flex }',
      }
      writePlateModule(join(root, 'plates', 'my-banner.ts'), stored)
      const { plate, css } = defined(await loadPlate('my-banner', 'plates'), 'plate')
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

    it('falls back to an empty plate on a version mismatch', async () => {
      // Written to the DEFAULT platesDir (src/plates, ADR 0032) so the default-config
      // loader reads it.
      writePlateModule(join(root, 'src', 'plates', 'my-banner.ts'), {
        v: PLATE_VERSION + 1,
        name: 'my-banner',
        breakpoints: [],
        tree: null,
        css: '',
      })
      expect(await loadPlate('my-banner')).toEqual({
        plate: { v: PLATE_VERSION, name: 'my-banner', chunks: null },
        css: '',
      })
    })

    it('falls back to an empty plate when the committed module fails to import', async () => {
      mkdirSync(join(root, 'src', 'plates'), { recursive: true })
      writeFileSync(join(root, 'src', 'plates', 'my-banner.ts'), 'export const plate = { not valid')
      expect(await loadPlate('my-banner')).toEqual({
        plate: { v: PLATE_VERSION, name: 'my-banner', chunks: null },
        css: '',
      })
    })

    it('ignores non-xray ids', async () => {
      expect(await loadPlate('../escape')).toBeDefined()
      const [data] = xrayVitePlugin()
      const load = callable<(this: HookCtx, id: string) => Promise<string | undefined>>(data?.load)
      expect(await load.call(ctx, './real-module.ts')).toBeUndefined()
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

    it('resolves and loads virtual:xray/base.css to BASE_CSS', async () => {
      const [data] = xrayVitePlugin()
      const resolveId = callable<(id: string) => string | undefined>(data?.resolveId)
      const load = callable<(id: string) => Promise<string | undefined>>(data?.load)
      expect(resolveId('virtual:xray/base.css')).toBe('virtual:xray/base.css')
      expect(await load('virtual:xray/base.css')).toContain('@keyframes xr-pulse')
    })

    it('resolves and loads a plate .css module from the committed plate module, dir-configured', async () => {
      // The default platesDir is src/plates (ADR 0032).
      const stored: StoredPlate = {
        v: PLATE_VERSION,
        name: 'my-banner',
        breakpoints: [],
        tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
        css: '[data-xr-root] .xr-my-banner-1 { display: flex }',
      }
      writePlateModule(join(root, 'src', 'plates', 'my-banner.ts'), stored)

      const [data] = xrayVitePlugin()
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const resolveId = callable<(id: string) => string | undefined>(data?.resolveId)
      const load = callable<(id: string) => Promise<string | undefined>>(data?.load)
      const id = resolveId('virtual:xray/plates/my-banner.css')
      expect(id).toBe('virtual:xray/plates/my-banner.css')
      expect(await load(id!)).toBe('[data-xr-root] .xr-my-banner-1 { display: flex }')
    })

    it('loads an empty string for an uncaptured plate .css module', async () => {
      const [data] = xrayVitePlugin()
      const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
      configResolved.call(ctx, { root })
      const load = callable<(id: string) => Promise<string | undefined>>(data?.load)
      expect(await load('virtual:xray/plates/never-captured.css')).toBe('')
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
    // ADR 0033: recorded fixtures load through the module graph, not a wire seed.
    expect(code).toContain("import('virtual:xray/fixtures')")

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

describe('the generated env file (ADR 0032 as amended by ADR 0034)', () => {
  let root: string
  const ctx: HookCtx = { addWatchFile: () => {} }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xray-env-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const envFile = () => join(root, 'src', 'plates', 'xray-env.gen.d.ts')
  const platesDir = () => join(root, 'src', 'plates')

  /** Wire configResolved + configureServer the way Vite does on dev-server start. */
  function startDevServer(options?: Parameters<typeof xrayVitePlugin>[0]): {
    handlers: Record<string, (file: string) => void>
  } {
    const [data, dev] = xrayVitePlugin(options)
    const configResolved = callable<(config: { root: string }) => void>(data?.configResolved)
    configResolved.call(ctx, { root })
    const handlers: Record<string, (file: string) => void> = {}
    const server = {
      watcher: {
        add: () => {},
        on: (event: string, cb: (file: string) => void) => {
          handlers[event] = cb
        },
      },
      middlewares: { use: () => {} },
      ws: { send: () => {} },
      config: { logger: { warn: () => {} } },
    }
    const configureServer = callable<(server: unknown) => void>(dev?.configureServer)
    configureServer.call(ctx, server)
    return { handlers }
  }

  it('renderEnvFile([]) renders the directives and no declarations', () => {
    // Assert the load-bearing directives, not the header prose: the lint
    // disable (a consumer's consistent-type-imports rule cannot be satisfied
    // in an ambient block, ADR 0032 §3) and the wildcard reference.
    const text = renderEnvFile([])
    expect(text).toMatch(/^\/\* eslint-disable \*\//)
    expect(text).toContain('/// <reference types="@hueest/xray/virtual" />')
    expect(text).not.toContain('declare module')
  })

  it('renderEnvFile renders one declare block per fixture-bearing plate', () => {
    const text = renderEnvFile(['news-feed', 'nested/card'])
    expect(text).toContain('/// <reference types="@hueest/xray/virtual" />')
    expect(text).toContain(
      [
        "declare module 'virtual:xray/plates/news-feed' {",
        "  import type { Plate } from '@hueest/xray'",
        "  const plate: Plate<typeof import('./news-feed').fixture>",
        '  export default plate',
        '}',
      ].join('\n'),
    )
    expect(text).toContain("declare module 'virtual:xray/plates/nested/card'")
    expect(text).toContain("typeof import('./nested/card').fixture")
  })

  it('derives the env file from the directory: only fixture-bearing plate modules declared', async () => {
    writePlateModule(join(platesDir(), 'banner.ts'), platedStored('banner'), JSON.parse('[7]'))
    writePlateModule(join(platesDir(), 'plain.ts'), platedStored('plain'))
    startDevServer()
    // The regeneration on dev-server start is fire-and-forget async.
    await vi.waitFor(() => {
      expect(readFileSync(envFile(), 'utf8')).toContain(
        "declare module 'virtual:xray/plates/banner'",
      )
    })
    const text = readFileSync(envFile(), 'utf8')
    expect(text).toContain("typeof import('./banner').fixture")
    expect(text).not.toContain('plain')
  })

  it('regenerates the env file without a plate after its module unlinks', async () => {
    writePlateModule(join(platesDir(), 'banner.ts'), platedStored('banner'), JSON.parse('[7]'))
    const { handlers } = startDevServer()
    await vi.waitFor(() => {
      expect(readFileSync(envFile(), 'utf8')).toContain('banner')
    })
    rmSync(join(platesDir(), 'banner.ts'))
    handlers.unlink?.(join(platesDir(), 'banner.ts'))
    await vi.waitFor(() => {
      const text = readFileSync(envFile(), 'utf8')
      expect(text).not.toContain('banner')
      expect(text).toContain('/// <reference types="@hueest/xray/virtual" />')
    })
  })

  it('writes the env file on dev-server start even with no plates yet', async () => {
    startDevServer()
    await vi.waitFor(() => {
      expect(readFileSync(envFile(), 'utf8')).toBe(renderEnvFile([]))
    })
  })

  it('writes nothing with noTypes: true (one switch over all declaration generation)', async () => {
    writePlateModule(join(platesDir(), 'banner.ts'), platedStored('banner'), JSON.parse('[7]'))
    startDevServer({ noTypes: true })
    // Give the would-be async write time to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(existsSync(envFile())).toBe(false)
  })
})

describe('readCoverage', () => {
  it('reads per-plate breakpoints and DERIVES coverage bands from disk, skipping non-modules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xray-cov-'))
    try {
      // A committed StoredPlate (ADR 0022): disk carries no per-View spans
      // — the bands derive from `breakpoints` (a StoredPlate sweeps every
      // width in one session, so coverage is complete). [768, 1024] partitions into
      // three covered bands: open-min, the middle pair, open-max.
      writePlateModule(join(dir, 'dash.ts'), {
        v: PLATE_VERSION,
        name: 'dash',
        breakpoints: [768, 1024],
        tree: { kids: [{ leaf: 'box', cls: 'xr-dash-1' }] },
        css: '',
      })
      writeFileSync(join(dir, 'notes.txt'), 'ignored')
      writeFileSync(join(dir, 'xray-env.gen.d.ts'), 'ignored (the dot rule excludes .d.ts)')
      expect(await readCoverage(dir)).toEqual({
        dash: {
          breakpoints: [768, 1024],
          spans: [{ max: 768 }, { min: 768, max: 1024 }, { min: 1024 }],
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives one open band for a StoredPlate with no breakpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xray-cov0-'))
    try {
      writePlateModule(join(dir, 'solo.ts'), {
        v: PLATE_VERSION,
        name: 'solo',
        breakpoints: [],
        tree: { kids: [{ leaf: 'text-line', cls: 'xr-solo-1' }] },
        css: '',
      })
      expect(await readCoverage(dir)).toEqual({ solo: { breakpoints: [], spans: [{}] } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers STORED spans over the derived complete assumption (ADR 0029)', async () => {
    // A partial browse session captured ONE band of four; the plate says so, and
    // coverage must repeat it instead of assuming every band complete.
    const dir = mkdtempSync(join(tmpdir(), 'xray-covs-'))
    try {
      writePlateModule(join(dir, 'feed.ts'), {
        v: PLATE_VERSION,
        name: 'feed',
        breakpoints: [576, 1200],
        spans: [{ min: 1200 }],
        tree: { kids: [{ leaf: 'box', cls: 'xr-feed-1' }] },
        css: '',
      })
      expect(await readCoverage(dir)).toEqual({
        feed: { breakpoints: [576, 1200], spans: [{ min: 1200 }] },
      })
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
  async function post(
    body: unknown,
    opts: { headers?: Record<string, string | undefined>; method?: string } = {},
  ): Promise<{
    status: () => number
    events: SentEvent[]
    warnings: string[]
  }> {
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
    // The handler attaches its body listeners synchronously before its first
    // await, so firing them right after the call is safe; the response only
    // settles once the returned promise does.
    const done = handleCapturePost(req, res, server, (name) => join(root, `${name}.ts`))
    listeners.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    listeners.end?.()
    await done
    return { status: () => res.statusCode, events, warnings }
  }

  // The POST envelope (ADR 0022): a finished, in-browser-projected
  // StoredPlate (a post-classify RenderNode tree + scoped css blob + breakpoints)
  // PLUS an optional sibling `diagnostics` array the server logs and drops.
  const stored: StoredPlate = {
    v: PLATE_VERSION,
    name: 'my-banner',
    breakpoints: [1200],
    tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
    css: '[data-xr-root] .xr-my-banner-1 { width: 10px }',
  }

  it('writes the plate module as-is and announces the lowered plate over the ws', async () => {
    const result = await post({ plate: stored })
    expect(result.status()).toBe(204)
    const file = join(root, 'my-banner.ts')
    // The committed artifact is a plate MODULE (ADR 0034): the codegen header
    // plus the StoredPlate as the named plate export, no fixture section.
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/^\/\* eslint-disable \*\/\n\/\/ Generated by xray /)
    expect(text).not.toContain('export const fixture')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only import of our own rendered output
    const ns = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { plate: unknown }
    // Written AS-IS — no server-side merge/accumulation.
    expect(ns.plate).toEqual(stored)
    // The event carries the LOWERED plate (serializePlate of the stored tree) — no
    // module invalidation/reload.
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.event).toBe('xray:plate')
    expect(result.events[0]?.data.name).toBe('my-banner')
    expect(result.events[0]?.data.plate.chunks).toBeTruthy()
  })

  it('skips the write when the StoredPlate changes nothing (mtime stays put)', async () => {
    await post({ plate: stored })
    const before = statSync(join(root, 'my-banner.ts')).mtimeMs
    // Two writes inside the same millisecond can share an mtime by accident;
    // the wait keeps the unchanged-mtime assertion meaningful.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await post({ plate: stored })
    expect(second.status()).toBe(204)
    expect(second.events).toEqual([])
    expect(statSync(join(root, 'my-banner.ts')).mtimeMs).toBe(before)
  })

  it('re-renders an existing Fixture into the module, preserving its value (ADR 0034 §4)', async () => {
    // A module with a recorded fixture already committed; the capture re-reads
    // the fixture as a live value, re-serializes it, and re-renders BOTH
    // sections — the fixture survives a re-capture byte-identically.
    const fixturePayload: unknown = JSON.parse(devalueStringify({ n: 1, tag: 'a' }))
    writePlateModule(join(root, 'my-banner.ts'), stored, fixturePayload)
    const recaptured: StoredPlate = {
      ...stored,
      css: '[data-xr-root] .xr-my-banner-1 { width: 20px }',
    }
    const result = await post({ plate: recaptured })
    expect(result.status()).toBe(204)
    const text = readFileSync(join(root, 'my-banner.ts'), 'utf8')
    expect(text).toContain('width: 20px')
    expect(text).toContain('export const fixture = { n: 1, tag: "a" } as const')
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

    async function postWith(
      graph: ReturnType<typeof mockGraphServer>,
      body: unknown,
    ): Promise<number> {
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
      const done = handleCapturePost(req, res, graph.server, (name) => join(root, `${name}.ts`))
      listeners.data?.(Buffer.from(JSON.stringify(body)))
      listeners.end?.()
      await done
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
    it('announces a tree-only plate (no css field) over the ws event', async () => {
      const graph = mockGraphServer()
      expect(await postWith(graph, { plate: stored })).toBe(204)
      expect(graph.events).toHaveLength(1)
      const announced = graph.events[0]?.data.plate
      expect(announced).toBeDefined()
      expect('css' in (announced ?? {})).toBe(false)
      expect('cssExternal' in (announced ?? {})).toBe(false)
      expect(announced?.chunks).toBeTruthy()
    })

    it('on a successful write: invalidates the JS tree module (no reload) AND reloads the css module', async () => {
      const graph = mockGraphServer()
      expect(await postWith(graph, { plate: stored })).toBe(204)
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
      expect(await postWith(graph, { plate: stored })).toBe(204)
      await Promise.resolve()
      await Promise.resolve()
      const invalidatedAfterFirst = graph.invalidated.length
      const reloadedAfterFirst = graph.reloaded.length
      // The identical re-post hits the unchanged-write 204 early return —
      // no announce, no invalidation, so an idle open page is never poked.
      expect(await postWith(graph, { plate: stored })).toBe(204)
      await Promise.resolve()
      await Promise.resolve()
      expect(graph.events).toHaveLength(1)
      expect(graph.invalidated).toHaveLength(invalidatedAfterFirst)
      expect(graph.reloaded).toHaveLength(reloadedAfterFirst)
    })

    it('is a no-op for a plate whose modules were never resolved (fresh name, no page import yet)', async () => {
      const graph = mockGraphServer()
      const fresh = { ...stored, name: 'never-imported' }
      expect(await postWith(graph, { plate: fresh })).toBe(204)
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

      // A committed plate module lands on disk outside the POST endpoint, in the
      // default platesDir (src/plates, ADR 0032).
      writePlateModule(join(root, 'src', 'plates', 'my-banner.ts'), stored)
      handlers.change?.(join(root, 'src', 'plates', 'my-banner.ts'))
      // The handler reads the module back through an async import before it
      // announces; wait for the announce instead of counting ticks.
      await vi.waitFor(() => {
        expect(graph.events).toHaveLength(1)
      })
      // Announced to the live store AND both transforms dropped, so the open
      // page hot-swaps now and the next full load is consistent with disk.
      expect(graph.invalidated).toContain(graph.jsMod)
      expect(graph.reloaded).toEqual([graph.cssMod])
    })
  })

  it('rejects traversal names and malformed bodies', async () => {
    expect((await post({ plate: { ...stored, name: '../escape' } })).status()).toBe(400)
    expect((await post('not json')).status()).toBe(400)
    // A bare StoredPlate (no envelope) is rejected — the `plate` key is required.
    expect((await post(stored)).status()).toBe(400)
  })

  it('rejects a malformed tree and a css <style> break-out', async () => {
    // a `cls` over the bound / a non-record tree node is not something the capture
    // path ever emits — `parseStoredPlate` rejects it.
    expect((await post({ plate: { ...stored, tree: { kids: 'nope' } } })).status()).toBe(400)
    // a css blob that tries to break out of the <style> raw text
    expect(
      (
        await post({
          plate: { ...stored, css: 'a { width: 1px }</style><script>alert(1)</script>' },
        })
      ).status(),
    ).toBe(400)
  })

  it('rejects a non-POST method (405) and a non-JSON content type (415)', async () => {
    expect((await post({ plate: stored }, { method: 'GET' })).status()).toBe(405)
    expect(
      (await post({ plate: stored }, { headers: { 'content-type': 'text/plain' } })).status(),
    ).toBe(415)
    // a missing content-type is also rejected
    expect((await post({ plate: stored }, { headers: {} })).status()).toBe(415)
  })

  it('rejects an oversized declared content-length up front (413)', async () => {
    const result = await post(
      { plate: stored },
      { headers: { 'content-type': 'application/json', 'content-length': '9000000' } },
    )
    expect(result.status()).toBe(413)
  })

  it('rejects an oversized streaming body even without content-length (413)', async () => {
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
    const done = handleCapturePost(req, res, server, (name) => join(root, `${name}.ts`))
    // 5 chunks of ~1MB each = ~5MB, over the 4MB cap.
    const oneMb = 'x'.repeat(1_000_000)
    for (let i = 0; i < 5; i++) listeners.data?.(Buffer.from(oneMb))
    listeners.end?.()
    await done
    expect(res.statusCode).toBe(413)
    expect(destroyed).toBe(true)
  })

  it('prints the envelope diagnostics to the server output but never persists them', async () => {
    const result = await post({
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

    // The persisted module is byte-identical to the same StoredPlate posted WITHOUT
    // diagnostics — the sibling envelope field never reaches disk (ADR 0008).
    const withDiagText = readFileSync(join(root, 'my-banner.ts'), 'utf8')
    rmSync(join(root, 'my-banner.ts'))
    await post({ plate: stored })
    const cleanText = readFileSync(join(root, 'my-banner.ts'), 'utf8')
    expect(withDiagText).toBe(cleanText)
    expect(withDiagText).not.toContain('diagnostics')
  })

  it('warns when an existing committed plate module fails to import', async () => {
    writeFileSync(join(root, 'my-banner.ts'), 'export const plate = { not valid syntax')
    const result = await post({ plate: stored })
    // The capture still lands (invalid file treated as absent), and the dropped
    // file is explained without echoing its contents.
    expect(result.status()).toBe(204)
    expect(result.warnings.join('\n')).toContain('could not be read')
    expect(result.warnings.join('\n')).toContain('my-banner.ts')
  })

  it('warns when the plate export is not a StoredPlate, and still captures over it', async () => {
    writeFileSync(join(root, 'my-banner.ts'), 'export const plate = { nope: true }\n')
    const result = await post({ plate: stored })
    expect(result.status()).toBe(204)
    expect(result.warnings.join('\n')).toContain('could not be read')
    expect(result.warnings.join('\n')).toContain('my-banner.ts')
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only import of our own rendered output
    const ns = (await import(
      /* @vite-ignore */ `${pathToFileURL(join(root, 'my-banner.ts')).href}?t=after`
    )) as { plate: unknown }
    expect(ns.plate).toEqual(stored)
  })
})

describe('handleFixturePost + the fixtures virtual module (ADR 0033/0034)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xray-fixture-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const platePath = (name: string) => join(root, `${name}.ts`)

  async function post(
    body: unknown,
    opts: {
      headers?: Record<string, string | undefined>
      method?: string
    } = {},
  ): Promise<{ status: () => number; body: () => string }> {
    const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const req = {
      method: opts.method ?? 'POST',
      headers: opts.headers ?? { 'content-type': 'application/json' },
      on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
        listeners[event] = cb
      },
      destroy() {},
    }
    let responseBody = ''
    const res = {
      statusCode: 0,
      end: (chunk?: string) => {
        responseBody = chunk ?? ''
      },
    }
    const done = handleFixturePost(req, res, platePath)
    listeners.data?.(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    listeners.end?.()
    await done
    return { status: () => res.statusCode, body: () => responseBody }
  }

  it('renders a fixture-only module when no plate is captured yet', async () => {
    // devalue.stringify of { type: 'news', n: 1 } — the wire form the client posts.
    const result = await post({ name: 'banner', data: '[{"type":1,"n":2},"news",1]' })
    expect(result.status()).toBe(204)
    const text = readFileSync(platePath('banner'), 'utf8')
    expect(text).toMatch(/^\/\* eslint-disable \*\/\n\/\/ Generated by xray /)
    expect(text).toContain('export const fixture = { type: "news", n: 1 } as const')
    // A Fixture recorded before first capture: no plate section to preserve.
    expect(text).not.toContain('export const plate')
  })

  it('upserts the fixture into an EXISTING plate module, preserving the plate export', async () => {
    writePlateModule(platePath('banner'), {
      v: PLATE_VERSION,
      name: 'banner',
      breakpoints: [390],
      tree: { kids: [{ leaf: 'text-line', cls: 'xr-banner-1' }] },
      css: '[data-xr-root] .xr-banner-1 { display: flex }',
    })
    const result = await post({ name: 'banner', data: '[{"type":1,"n":2},"news",1]' })
    expect(result.status()).toBe(204)
    const text = readFileSync(platePath('banner'), 'utf8')
    // Both sections present: the plate structure read back through import(),
    // the new fixture rendered beside it (ADR 0034 §4).
    expect(text).toContain('export const plate = {')
    expect(text).toContain('name: "banner"')
    expect(text).toContain('xr-banner-1')
    expect(text).toContain('export const fixture = { type: "news", n: 1 } as const')
  })

  it('nested names land in the sibling plate module', async () => {
    await post({ name: 'nested/card', data: '[[1],7]' })
    const text = readFileSync(platePath('nested/card'), 'utf8')
    expect(text).toContain('export const fixture = [7] as const')
  })

  it('rejects bad method, content type, traversal names, non-string and unrenderable data', async () => {
    expect((await post({ name: 'banner', data: '[0]' }, { method: 'GET' })).status()).toBe(405)
    expect(
      (
        await post({ name: 'banner', data: '[0]' }, { headers: { 'content-type': 'text/plain' } })
      ).status(),
    ).toBe(415)
    expect((await post({ name: '../escape', data: '[0]' })).status()).toBe(400)
    expect((await post({ name: 'banner', data: 123 })).status()).toBe(400)
    expect((await post('not json')).status()).toBe(400)
    expect((await post({ name: 'banner', data: 'not json [' })).status()).toBe(400)
    // A payload the renderer refuses (typed array) writes nothing, and the 400
    // body carries the renderer's reason — the POST is the only place the user
    // learns it, since typed arrays pass the client-side stringify gate.
    const refused = await post({ name: 'banner', data: '[["Uint8Array","AAA"]]' })
    expect(refused.status()).toBe(400)
    expect(refused.body()).toContain('unsupported fixture value type: Uint8Array')
    expect(existsSync(platePath('banner'))).toBe(false)
  })

  it('plate-module events invalidate AND reload the fixtures virtual module, sidecars do nothing', () => {
    // The virtual id has no file to watch, so Vite caches its transform until
    // told otherwise — and invalidation alone never re-executes the module in
    // an OPEN tab, so the watcher also reloads it (self-accepting, the reload
    // re-runs the seed in place).
    const [dataPlugin, devPlugin] = xrayVitePlugin({ platesDir: 'plates-y' })
    const configure = callable<(config: { root: string }) => void>(dataPlugin?.configResolved)
    configure.call({ addWatchFile: () => {} }, { root })
    const handlers = new Map<string, ((file: string) => void)[]>()
    const invalidated: string[] = []
    const reloaded: string[] = []
    const announced: { event: string; name: string; chunks: unknown; spans: unknown }[] = []
    const server = {
      watcher: {
        add: () => {},
        on: (event: string, cb: (file: string) => void) => {
          const bucket = handlers.get(event) ?? []
          bucket.push(cb)
          handlers.set(event, bucket)
        },
      },
      middlewares: { use: () => {} },
      ws: {
        send: (msg: {
          event: string
          data: { name: string; spans: unknown; plate: { chunks: unknown } }
        }) =>
          announced.push({
            event: msg.event,
            name: msg.data.name,
            chunks: msg.data.plate.chunks,
            spans: msg.data.spans,
          }),
      },
      moduleGraph: {
        getModuleById: (id: string) => ({ id }),
        invalidateModule: (mod: { id: string }) => invalidated.push(mod.id),
      },
      reloadModule: (mod: { id: string }) => {
        reloaded.push(mod.id)
        return Promise.resolve()
      },
    }
    const configureServer = callable<(s: unknown) => void>(devPlugin?.configureServer)
    configureServer.call({ addWatchFile: () => {} }, server)
    const fire = (event: string, file: string) => {
      for (const cb of handlers.get(event) ?? []) cb(file)
    }
    // ONE handler, one file kind (ADR 0034 §5): a plate-module event drops the
    // fixtures module AND the plate's own virtual modules from the cache, and
    // reloads the fixtures module so the change lands without a page load.
    fire('add', join(root, 'plates-y', 'banner.ts'))
    expect(invalidated).toContain('\0virtual:xray/fixtures')
    expect(invalidated).toContain('\0virtual:xray/plates/banner')
    expect(reloaded).toContain('\0virtual:xray/fixtures')
    // Sidecars never touch it: the generated declarations are `.d.ts` (the dot
    // rule excludes them from plate stems), and a stray `.json` is not a plate.
    invalidated.length = 0
    fire('change', join(root, 'plates-y', 'banner.json'))
    fire('add', join(root, 'plates-y', 'banner.plate.d.ts'))
    fire('change', join(root, 'plates-y', 'xray-env.gen.d.ts'))
    expect(invalidated).toHaveLength(0)
    // A deleted plate module invalidates — its fixture import would dangle —
    // AND announces the empty plate so mounted clients stop rendering it.
    announced.length = 0
    fire('unlink', join(root, 'plates-y', 'banner.ts'))
    expect(invalidated).toContain('\0virtual:xray/fixtures')
    expect(announced).toEqual([{ event: 'xray:plate', name: 'banner', chunks: null, spans: [] }])
  })

  it('the fixtures virtual module imports every fixture-bearing plate module and seeds with force', async () => {
    await post({ name: 'banner', data: '[0]' })
    await post({ name: 'nested/card', data: '[1]' })
    // A fixtureless plate module, a stray json file, and a d.ts must not be
    // picked up — only modules with a `fixture` export join the import list.
    writePlateModule(platePath('plain'), {
      v: PLATE_VERSION,
      name: 'plain',
      breakpoints: [],
      tree: null,
      css: '',
    })
    writeFileSync(join(root, 'banner.json'), '{}')
    writeFileSync(join(root, 'banner.plate.d.ts'), 'stray')
    // Point the plugin at OUR temp dir by resolving root/platesDir onto it.
    const [dataPlugin, devPlugin] = xrayVitePlugin({ platesDir: '.' })
    const configure = callable<(config: { root: string }) => void>(dataPlugin?.configResolved)
    configure.call({ addWatchFile: () => {} }, { root })
    const resolveId = callable<(id: string) => string | undefined>(devPlugin?.resolveId)
    expect(resolveId('virtual:xray/fixtures')).toBe('\0virtual:xray/fixtures')
    const load = callable<(id: string) => Promise<string | undefined>>(devPlugin?.load)
    const code = await load.call({ addWatchFile: () => {} }, '\0virtual:xray/fixtures')
    expect(code).toContain('import { fixture as f0 } from "/./banner.ts"')
    expect(code).toContain('import { fixture as f1 } from "/./nested/card.ts"')
    expect(code).toContain('"banner": f0')
    expect(code).toContain('"nested/card": f1')
    expect(code).toContain('seed?.(values, true)')
    expect(code).toContain('import.meta.hot.accept()')
    expect(code).not.toContain('plain')
    expect(code).not.toContain('.json')
  })

  /** Post a capture envelope through handleCapturePost into this describe's tmpdir. */
  async function postCapture(envelope: unknown): Promise<number> {
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
    const done = handleCapturePost(req, res, { ws: { send: () => {} } }, platePath)
    listeners.data?.(Buffer.from(JSON.stringify(envelope)))
    listeners.end?.()
    await done
    return res.statusCode
  }

  it('a concurrent Capture and Record of the same plate preserve both halves', async () => {
    // Without the per-file lock both upserts import the OLD module and the
    // later write discards the other's half — the first-ready + capture-on
    // combination fires exactly this pair on one ready render (ADR 0034 §4).
    const captureListeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const recordListeners: Record<string, (chunk?: Buffer | string) => void> = {}
    const captureRes = { statusCode: 0, end: () => {} }
    const recordRes = { statusCode: 0, end: () => {} }
    const captureDone = handleCapturePost(
      listenersFor(captureListeners),
      captureRes,
      { ws: { send: () => {} } },
      platePath,
    )
    const recordDone = handleFixturePost(listenersFor(recordListeners), recordRes, platePath)
    // Both bodies land before either upsert is awaited, so the two
    // read-render-write sequences genuinely overlap.
    captureListeners.data?.(Buffer.from(JSON.stringify({ plate: platedStored('banner') })))
    captureListeners.end?.()
    recordListeners.data?.(Buffer.from(JSON.stringify({ name: 'banner', data: '[7]' })))
    recordListeners.end?.()
    await Promise.all([captureDone, recordDone])
    expect(captureRes.statusCode).toBe(204)
    expect(recordRes.statusCode).toBe(204)
    const text = readFileSync(platePath('banner'), 'utf8')
    expect(text).toContain('export const plate =')
    expect(text).toContain('export const fixture = 7 as const')
  })

  it('rapid alternating upserts never resurrect a stale half', async () => {
    // Same-millisecond writes share an mtime; the per-file revision in the
    // import key keeps every read fresh (ADR 0034 §3). No sleeps here on
    // purpose — the loop lands several writes inside one millisecond.
    for (let round = 0; round < 3; round++) {
      // eslint-disable-next-line no-await-in-loop -- the SEQUENCE is the case under test
      expect((await post({ name: 'banner', data: `[${round}]` })).status()).toBe(204)
      // eslint-disable-next-line no-await-in-loop -- the SEQUENCE is the case under test
      const captured = await postCapture({
        plate: { ...platedStored('banner'), breakpoints: [round] },
      })
      expect(captured).toBe(204)
    }
    const text = readFileSync(platePath('banner'), 'utf8')
    expect(text).toContain('breakpoints: [2]')
    expect(text).toContain('export const fixture = 2 as const')
  })

  it('a same-mtime rewrite is still read fresh (the revision half of the import key)', async () => {
    // Deterministic staleness setup: after the capture merges plate + fixture,
    // force the merged file's mtime BACK to the fixture-only write's value.
    // Without the per-file revision the next upsert would import the CACHED
    // fixture-only module (same mtime key) and write the plate half away.
    expect((await post({ name: 'banner', data: '[1]' })).status()).toBe(204)
    const t1 = statSync(platePath('banner')).mtime
    expect(await postCapture({ plate: platedStored('banner') })).toBe(204)
    utimesSync(platePath('banner'), t1, t1)
    expect((await post({ name: 'banner', data: '[2]' })).status()).toBe(204)
    const text = readFileSync(platePath('banner'), 'utf8')
    expect(text).toContain('export const plate =')
    expect(text).toContain('export const fixture = 2 as const')
  })

  it('refuses a Fixture whose rendered module exceeds the size cap, writing nothing', async () => {
    // Shared references inline as duplicates, so a small wire payload can
    // render far past MAX_PLATE_BYTES — the cap applies to the RENDERED text.
    const big = 'x'.repeat(4000)
    const refs = Array.from({ length: 1000 }, () => 1)
    const payload = JSON.stringify([refs, big])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await post({ name: 'banner', data: payload })
      expect(result.status()).toBe(413)
      expect(existsSync(platePath('banner'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('skips the write when a re-record renders the identical module', async () => {
    expect((await post({ name: 'banner', data: '[5]' })).status()).toBe(204)
    const before = statSync(platePath('banner')).mtimeMs
    // Wait past the mtime granularity so an actual rewrite WOULD move it.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await post({ name: 'banner', data: '[5]' })).status()).toBe(204)
    expect(statSync(platePath('banner')).mtimeMs).toBe(before)
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
  ): { statusCode: number; end: (chunk?: string) => void } {
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
    return res
  }

  // A minimal valid capture envelope, so an ALLOWED post reaches the 204 path
  // and proves the gate (not validation) is what decides.
  const stored: StoredPlate = {
    v: PLATE_VERSION,
    name: 'my-banner',
    breakpoints: [],
    tree: { kids: [{ leaf: 'text-line', cls: 'xr-my-banner-1' }] },
    css: '',
  }
  // The middleware writes into the default platesDir (src/plates, ADR 0032);
  // both write paths target the one plate MODULE (ADR 0034).
  const plateFile = () => join(root, 'src', 'plates', 'my-banner.ts')

  it('rejects a cross-origin POST with 403 and writes no plate module', async () => {
    const res = post(
      '/',
      { plate: stored },
      { origin: 'http://evil.localhost:9999', host: 'localhost:5173' },
    )
    // The gate answers synchronously, before any handler runs.
    expect(res.statusCode).toBe(403)
    // Give a would-be async write time to land before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(plateFile())).toBe(false)
  })

  it('allows a same-origin POST (Origin host equals Host, port included)', async () => {
    const res = post(
      '/',
      { plate: stored },
      { origin: 'http://localhost:5173', host: 'localhost:5173' },
    )
    // The middleware fires the async handler and returns; the response and the
    // write land once the handler's promise settles.
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(204)
    })
    expect(existsSync(plateFile())).toBe(true)
  })

  it('allows a POST with no Origin header (curl, a node script)', async () => {
    const res = post('/', { plate: stored }, { host: 'localhost:5173' })
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(204)
    })
    expect(existsSync(plateFile())).toBe(true)
  })

  it('rejects Origin: null with 403', async () => {
    const res = post('/', { plate: stored }, { origin: 'null', host: 'localhost:5173' })
    expect(res.statusCode).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(plateFile())).toBe(false)
  })

  it('rejects a cross-origin POST to /fixture and writes no plate module', async () => {
    const res = post(
      '/fixture',
      { name: 'my-banner', data: '[0]' },
      { origin: 'http://evil.localhost:9999', host: 'localhost:5173' },
    )
    expect(res.statusCode).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(plateFile())).toBe(false)
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
