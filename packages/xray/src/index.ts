/**
 * Vite plugin entry point for xray.
 *
 * Add `xrayVitePlugin()` to a Vite config to resolve committed Plate imports in dev and build. The
 * dev capture client is injected only during `vite serve`, and only when `capture` or the HUD needs
 * it.
 *
 * @module @hueest/xray
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { Plugin } from 'vite'
import {
  BASE_CSS,
  emptyPlate,
  type GatedPlate,
  type Span,
  type StoredPlate,
  VIRTUAL_PREFIX,
} from './plate.ts'
import { collectRefs, serializePlate } from './chunk.ts'
import {
  type CaptureDiagnostic,
  diagnosticsHeader,
  formatDiagnostic,
  makeDiagnostic,
} from './diagnostics.ts'
import { isValidPlateName } from './name.ts'
import { parseStoredPlate } from './validate.ts'

export type { Plate, PlateNode, PlateRule, LeafKind, StoredPlate, ViewCapture } from './plate.ts'
export { collectRefs } from './chunk.ts'
export { isValidPlateName } from './name.ts'

/**
 * Options for `xrayVitePlugin()`.
 *
 * Fixed conventions are intentionally not configurable: Plate names come from
 * `virtual:xray/plates/<name>`, files live under `platesDir`, and responsive breakpoints are
 * derived from captured CSS plus the `matchMedia` queries the page evaluates.
 */
export interface XrayOptions {
  /**
   * Directory where Plate JSON files are written and read, relative to the Vite root. Default:
   * `plates`.
   */
  platesDir?: string
  /** Mount the dev HUD for coverage, Capture, Light Box, and capture-all controls. Default: `false`. */
  hud?: boolean
  /**
   * Initial state of the browse-time Capture toggle in dev. Keep this off for normal browsing and
   * let the HUD, capture-all flow, or `?xray-capture` turn Capture on per tab. Default: `false`.
   */
  capture?: boolean
  /**
   * Settle delay in milliseconds before capturing a ready Skeleton; override one boundary with the
   * `delay` prop. Default: `200`.
   */
  delay?: number
  /**
   * Upper bound in milliseconds on waiting for a busy subtree to go quiet before capturing anyway.
   * Default: `5000`.
   */
  settleCap?: number
  /**
   * Collect-stage limits (ADR 0022): refuse to capture a boundary whose measured tree exceeds any
   * axis — too big means the Skeleton sits too high in the tree. `maxNodes` caps total surviving
   * nodes (default `4096`), `maxBreadth` the widest level (default `512`), `maxDepth` the nesting
   * depth (default `32`). Omit `maxNodes` and it derives as `round(maxBreadth × maxDepth / 4)`.
   * Override one boundary with the flat `maxNodes`/`maxBreadth`/`maxDepth` `<Skeleton>` props.
   */
  collect?: {
    maxNodes?: number
    maxBreadth?: number
    maxDepth?: number
  }
  /**
   * Dev-only Fixtures (ADR 0015): record a `<Skeleton>`'s render-input `data` to a
   * `plates/<name>.fixture.json` sidecar and replay it in place of live data so capture is
   * deterministic. Boot state only — the HUD is per-tab authority, just like `capture`. Entirely
   * dev-only; nothing here ships in production.
   */
  fixtures?: {
    /**
     * When to record the live `data`: `'manual'` (HUD button only — the default, so live app data
     * is never silently committed), `'first-ready'` (record once the first time a Skeleton goes
     * ready with no Fixture yet), or `'always'` (record on every ready render). Default:
     * `'manual'`.
     */
    record?: 'manual' | 'first-ready' | 'always'
    /**
     * Whether to replay a recorded Fixture in place of live `data`: `false` (off, the default),
     * `'prefer'` (always use the Fixture when one exists), or `'missing-only'` (use the Fixture
     * only when live `data` is nullish — `missing ≡ nullish`, so an empty array/object is present
     * and stays capturable). Default: `false`.
     */
    replay?: false | 'prefer' | 'missing-only'
  }
}

const RESOLVED_PREFIX = `\0${VIRTUAL_PREFIX}`
const BOOT_ID = 'virtual:xray/client'
const RESOLVED_BOOT_ID = `\0${BOOT_ID}`
const ENDPOINT = '/__xray'

/**
 * The shared base-css virtual module every plate's `.css` module imports, so Vite dedupes BASE_CSS
 * across plates instead of repeating it per plate. Deliberately NOT `\0`-prefixed: an unprefixed
 * virtual id is tried first (the vanilla-extract pattern) because Vite's CSS plugins match on the
 * module id, and this id must be routed through that pipeline (it ends in `.css`).
 */
const BASE_CSS_ID = 'virtual:xray/base.css'

/**
 * A plate's per-name css virtual module id. Also un-`\0`-prefixed for the same reason as
 * `BASE_CSS_ID` — see above.
 */
const plateCssId = (name: string): string => `${VIRTUAL_PREFIX}${name}.css`

/**
 * Create the Vite plugins that resolve committed Plates and, during dev, capture new Plates from
 * rendered `<Skeleton>` boundaries.
 *
 * Typical setup:
 *
 * ```ts
 * import { xrayVitePlugin } from '@hueest/xray'
 *
 * export default {
 *   plugins: [xrayVitePlugin({ hud: true })],
 * }
 * ```
 *
 * Returns two plugins:
 *
 * - `xray:data` resolves `virtual:xray/plates/<name>` from committed Plate files in dev and build.
 * - `xray:dev` runs only during `vite serve`; it injects the capture client, receives Captures,
 *   writes Plate files, and hot-updates the page.
 */
export function xrayVitePlugin(options: XrayOptions = {}): Plugin[] {
  const platesDir = options.platesDir ?? 'plates'
  const capture = options.capture ?? false
  const delay = options.delay ?? 200
  const settleCap = options.settleCap ?? 5_000
  const collect = options.collect
  const hud = options.hud ?? false
  // Fixtures (ADR 0015): boot state only; the HUD overrides per tab. `record`
  // defaults to 'manual' so live app data is never silently committed; `replay`
  // defaults off.
  const recordMode = options.fixtures?.record ?? 'manual'
  const replayMode = options.fixtures?.replay ?? false
  let root = process.cwd()

  const platePath = (name: string) => resolve(root, platesDir, `${name}.json`)
  // The Fixture sidecar sits NEXT TO the Plate (`<name>.json` ↔
  // `<name>.fixture.json`, 1:1) but is never merged into it: the Plate stays
  // purely structural (ADR 0015).
  const fixturePath = (name: string) => resolve(root, platesDir, `${name}.fixture.json`)

  const data: Plugin = {
    name: 'xray:data',
    configResolved(config) {
      root = config.root
    },
    resolveId(id) {
      // The css virtual ids are deliberately left UN-`\0`-prefixed: Vite's
      // internal CSS plugins route on the module id ending in `.css`, and the
      // vanilla-extract pattern is to try the unprefixed id first. Returning
      // the id unchanged still counts as "resolved" to Rollup/Vite as long as
      // a `load` hook answers for it, which this plugin's `load` does below.
      if (id === BASE_CSS_ID) return id
      if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith('.css')) return id
      if (id.startsWith(VIRTUAL_PREFIX)) return `\0${id}`
      return undefined
    },
    load(id) {
      if (id === BASE_CSS_ID) return BASE_CSS
      if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith('.css')) {
        const name = id.slice(VIRTUAL_PREFIX.length, -'.css'.length)
        if (!isValidPlateName(name)) return ''
        // Deliberately NOT addWatchFile, for the same reason as the JS virtual
        // module below: a capture writes this file, and watching it would make
        // Vite reload the module — an infinite capture loop. Dev updates are
        // pushed instead via `configureServer`'s invalidation below.
        const stored = readStoredPlate(platePath(name))
        return stored?.css ?? ''
      }
      if (!id.startsWith(RESOLVED_PREFIX)) return undefined
      const name = id.slice(RESOLVED_PREFIX.length)
      if (!isValidPlateName(name)) return renderPlateModule(emptyPlate(name))
      // Deliberately NOT addWatchFile: a capture writes this file, and watching
      // it would make Vite reload the module — remounting the capture boundary
      // and re-firing the capture, an infinite loop. Live updates are pushed
      // in place over the `xray:plate` HMR event instead; the read here
      // only seeds the committed plate on a fresh load.
      return renderPlateModule(readStoredPlate(platePath(name)) ?? emptyPlate(name), name)
    },
  }

  const dev: Plugin = {
    name: 'xray:dev',
    apply: 'serve',
    // Dev-only: swap the production adapter for the dev one (live store, Light
    // Box, browse-time capture). Production builds exclude this plugin
    // (apply: 'serve'), so `@hueest/xray/react` resolves to the lean production adapter
    // and none of the dev weight ships (ADR 0008).
    config() {
      return {
        resolve: {
          alias: [{ find: /^@hueest\/xray\/react$/, replacement: '@hueest/xray/react/dev' }],
        },
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        // Boot the client whenever any dev affordance is wanted: capture
        // (even if it starts off — the HUD can flip it on), the HUD (which also
        // carries the light box toggle), OR fixtures that need the runtime client.
        // Replay (`replayMode !== false`) substitutes recorded data
        // at runtime, and auto-record (`recordMode !== 'manual'`) writes it as
        // Skeletons go ready — both require the booted client even with capture and
        // the HUD off. `'manual'` record is reachable only via the HUD button,
        // which already implies `hud`, so it does not independently require booting.
        if (!capture && !hud && replayMode === false && recordMode === 'manual') {
          return undefined
        }
        // head-prepend: the client must boot before the app so the capture
        // hook and the matchMedia interception are in place at first render.
        return [
          {
            tag: 'script',
            attrs: { type: 'module', src: `/@id/${BOOT_ID}` },
            injectTo: 'head-prepend',
          },
        ]
      },
    },
    resolveId(id) {
      if (id === BOOT_ID) return RESOLVED_BOOT_ID
      return undefined
    },
    load(id) {
      if (id !== RESOLVED_BOOT_ID) return undefined
      return bootstrapCode(delay, settleCap, collect, hud, capture, recordMode, replayMode)
    },
    configureServer(server) {
      // Push the merged plate in place when a plate file changes outside the
      // POST endpoint — a git checkout or a hand edit — so it hot-swaps like a
      // capture does. (Our own POST writes also fire this; the client dedupes
      // identical plates, so the announce duplicate is a no-op, and the
      // repeated invalidation below is idempotent.)
      const dir = () => resolve(root, platesDir)
      server.watcher.add(dir())
      const onPlateFile = (file: string) => {
        if (!file.startsWith(dir()) || !file.endsWith('.json')) return
        const name = relative(dir(), file).slice(0, -'.json'.length)
        if (!isValidPlateName(name)) return
        announcePlate(server.ws, name, readStoredPlate(file))
        // Keep BOTH virtual modules in sync with the changed file: without the
        // invalidation, a hand edit / git checkout announces to the live store
        // but leaves Vite's cached transforms stale, so the NEXT page load
        // serves an old tree regardless of what is on disk. Same treatment as
        // the capture POST path.
        void invalidatePlateModules(server, name)
      }
      server.watcher.on('add', onPlateFile)
      server.watcher.on('change', onPlateFile)
      server.middlewares.use(ENDPOINT, (req, res) => {
        // GET /__xray/coverage → per-plate breakpoints + captured spans from disk.
        if (req.method === 'GET' && req.url === '/coverage') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(readCoverage(dir())))
          return
        }
        // GET /__xray/fixtures → all recorded Fixtures as `{ name: devalueString }`
        // (ADR 0015). The node side stores/serves the OPAQUE devalue string and
        // never parses `data` itself; the browser dev client (which has the live
        // runtime) owns the devalue parse. The Fixtures are a dev-only sidecar,
        // separate from the Plate files coverage reads.
        if (req.method === 'GET' && req.url === '/fixtures') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(readFixtures(dir())))
          return
        }
        // Both write paths (Plate capture, Fixture sidecar) put files in the
        // consumer's working tree — refuse a browser POST whose Origin is not
        // this dev server. Non-browser clients (no Origin header) stay allowed.
        if (req.method === 'POST' && !isSameOriginWrite(req)) {
          res.statusCode = 403
          res.end('forbidden')
          // Name the mismatch server-side only, so a proxied dev setup can
          // self-diagnose without the response leaking anything.
          console.warn('[xray] rejected a cross-origin POST to /__xray (origin/host mismatch).')
          return
        }
        // POST /__xray/fixture → write a recorded Fixture sidecar (ADR 0015),
        // reusing the capture endpoint's body-reading/validation discipline but
        // treating the devalue payload as opaque text (never eval/parse it
        // server-side).
        if (req.url === '/fixture') {
          handleFixturePost(req, res, fixturePath)
          return
        }
        handleCapturePost(req, res, server, platePath)
      })
    },
  }

  return [data, dev]
}

/**
 * The injected dev module: boot the client, POST captures back, optionally mount the HUD. The
 * client installs first so the HUD finds the light box store.
 */
function bootstrapCode(
  delay: number,
  settleCap: number,
  collect: XrayOptions['collect'],
  hud: boolean,
  capture: boolean,
  recordMode: 'manual' | 'first-ready' | 'always',
  replayMode: false | 'prefer' | 'missing-only',
): string {
  return [
    `import { installXrayClient } from '@hueest/xray/internal/client'`,
    ...(hud ? [`import { installXrayHud } from '@hueest/xray/internal/hud'`] : []),
    'installXrayClient({',
    `  delay: ${delay},`,
    `  settleCap: ${settleCap},`,
    `  collect: ${JSON.stringify(collect ?? {})},`,
    `  capture: ${capture},`,
    // Fixtures boot state (ADR 0015): the HUD overrides per tab, mirroring how
    // `capture` flows. `record` defaults to 'manual' (no auto-record → no PII
    // commits); `replay` defaults off.
    `  record: ${JSON.stringify(recordMode)},`,
    `  replay: ${JSON.stringify(replayMode)},`,
    // POST a recorded Fixture's OPAQUE devalue string to its sidecar. The client
    // owns the devalue stringify (it has the live `data`); the node side treats
    // the payload as opaque text (ADR 0015). Rejects on a non-2xx so the HUD's
    // Record button surfaces a failed write.
    '  recordFixtureSink(payload) {',
    `    return fetch('${ENDPOINT}/fixture', {`,
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json' },",
    '      body: JSON.stringify(payload),',
    '    }).then((response) => {',
    "      if (!response.ok) throw new Error('xray fixture POST failed: ' + response.status)",
    '    })',
    '  },',
    // POST the `{ plate: StoredPlate, diagnostics? }` envelope (ADR 0022):
    // the client already projected the whole Plate in the browser, so there is no
    // per-View accumulation server-side — `handleCapturePost` writes the StoredPlate
    // as-is and logs the sibling diagnostics. RETURN the fetch promise (not
    // fire-and-forget) and reject on a non-2xx so the capture-all sweep, which awaits
    // this, only advances once the write is server-confirmed and fails loudly on a
    // rejected write. `/__xray` answers 204 on a
    // committed or unchanged write and 4xx/413 on failure, so any 2xx (`response.ok`)
    // is success. Browse-time capture ignores the returned promise (fire-and-forget).
    '  sink(payload) {',
    `    return fetch('${ENDPOINT}', {`,
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json' },",
    '      body: JSON.stringify(payload),',
    '    }).then((response) => {',
    "      if (!response.ok) throw new Error('xray sink POST failed: ' + response.status)",
    '    })',
    '  },',
    // Re-pull on-disk coverage into the store. The capture-all sweep calls this
    // after each pass so its next width recompute sees the breakpoints the pass
    // just wrote, instead of racing the async xray:plate HMR event.
    // Deliberately NOT caught (unlike the initial seed fetch below): a failed
    // refresh mid-sweep should reject the sweep so the HUD shows the failure,
    // rather than silently sweeping stale coverage. Reset still posts in finally.
    '  refreshCoverage() {',
    `    return fetch('${ENDPOINT}/coverage')`,
    '      .then((response) => response.json())',
    '      .then((coverage) => {',
    '        for (const [name, c] of Object.entries(coverage)) globalThis.__XRAY__?.coverage?.set(name, c)',
    '      })',
    '  },',
    '})',
    ...(hud ? ['installXrayHud()'] : []),
    // Seed coverage (per-plate breakpoints + captured spans) from the committed
    // plate files on disk. The HUD's band display and the capture-all sweep both
    // read it, so it reflects what's on disk, not just this session.
    `void fetch('${ENDPOINT}/coverage')`,
    '  .then((response) => response.json())',
    '  .then((coverage) => {',
    '    for (const [name, c] of Object.entries(coverage)) globalThis.__XRAY__?.coverage?.set(name, c)',
    '  })',
    '  .catch(() => {})',
    // Seed recorded Fixtures (ADR 0015) from the committed sidecars on disk: the
    // server returns `{ name: devalueString }` (opaque), and the client parses
    // each with devalue before storing, so Replay and the HUD coverage marker
    // reflect what's on disk, not just this session.
    `void fetch('${ENDPOINT}/fixtures')`,
    '  .then((response) => response.json())',
    '  .then((fixtures) => { globalThis.__XRAY__?.fixtures?.seed?.(fixtures) })',
    '  .catch(() => {})',
    // Hot-swap a plate in place when the plugin announces a new one (rather than
    // reloading the module, which would remount and re-capture), and refresh its
    // coverage from disk so the HUD updates.
    'if (import.meta.hot) {',
    "  import.meta.hot.on('xray:plate', (data) => {",
    '    globalThis.__XRAY__?.updatePlate?.(data.name, data.plate)',
    '    globalThis.__XRAY__?.coverage?.set(data.name, { breakpoints: data.breakpoints, spans: data.spans })',
    '  })',
    '}',
    '',
  ].join('\n')
}

interface CaptureRequest {
  method?: string
  headers?: Record<string, string | string[] | undefined>
  on(event: 'data' | 'end', listener: (chunk?: Buffer | string) => void): unknown
  /** Stop buffering the request body once the byte cap is exceeded. */
  destroy?: () => void
}

interface CaptureResponse {
  statusCode: number
  end(chunk?: string): unknown
}

interface PlateBroadcaster {
  send(payload: unknown): void
}

/** The subset of Vite's logger used here; it preserves the formatted string verbatim. */
interface ServerLogger {
  warn(message: string): void
}

interface CaptureServer {
  ws: PlateBroadcaster
  /**
   * Vite's logger (`server.config.logger`). When present its `warn` prints the diagnostic text to
   * the server output; otherwise `console.warn` is the fallback. Either way the SAME shared
   * formatter (diagnostics.ts) is used, so server output matches the browser console exactly.
   */
  config?: { logger?: ServerLogger }
  /**
   * The subset of Vite's dev server needed to keep BOTH of a plate's virtual modules fresh after a
   * plate file changes (capture POST, hand edit, git checkout). Optional — absent in the unit tests
   * that stub a minimal `server`. `getModuleById`/`invalidateModule`/`reloadModule` mirror
   * `ViteDevServer`'s real shape (a subset, so this module stays free of a hard `vite` import at
   * the type level beyond the `Plugin` type already used elsewhere).
   */
  moduleGraph?: { getModuleById(id: string): unknown; invalidateModule(mod: unknown): void }
  reloadModule?(mod: unknown): Promise<void>
}

/**
 * Drop both of a plate's virtual modules from Vite's dev transform cache after its file changes,
 * each through the channel appropriate to it:
 *
 * - The `.css` module (UN-prefixed id — see `plateCssId`) is invalidated AND reloaded: standard Vite
 *   CSS HMR (`reloadModule` re-transforms and pushes the update over the ws), so fresh styles land
 *   in the open page with no reload. The css module has no capture boundary, so a live reload of it
 *   carries no remount-loop risk.
 * - The JS (tree) module (`\0`-prefixed id) is invalidated ONLY — deliberately NO `reloadModule`/HMR
 *   push. A live re-import would remount the capture boundary and re-fire the capture (the exact
 *   infinite loop the "no addWatchFile" comment in `load` guards against; live tree updates keep
 *   flowing over the `xray:plate` announce into the dev store instead). Bare `invalidateModule` is
 *   server-side cache marking only — nothing reaches the client until the NEXT full page load,
 *   which then re-transforms from disk and serves a tree consistent with the css.
 *
 * WITHOUT the JS half, a page reload after a capture pairs Vite's CACHED stale tree transform
 * (stale content-addressed class names) with the freshly reloaded css — class names no longer match
 * rules and skeletons render garbled until a dev-server restart clears the transform cache. The two
 * modules need distinct invalidation policies; this helper is the single place that keeps them in
 * lockstep.
 *
 * Scope note (stitched plates): a parent's module embeds ONLY its own stored tree; a child's data
 * arrives at runtime through the child module import (`refs: { "<child>": __xr0 }`), never inlined
 * into the parent's transform. So invalidating the re-captured plate's OWN two modules is
 * sufficient — parent modules hold nothing child-derived that could go stale.
 *
 * No-op per module when it was never resolved/imported yet (a fresh plate no page has loaded, or a
 * server stub without the module-graph subset).
 */
async function invalidatePlateModules(server: CaptureServer, name: string): Promise<void> {
  const jsMod = server.moduleGraph?.getModuleById(RESOLVED_PREFIX + name)
  if (jsMod) server.moduleGraph?.invalidateModule(jsMod)
  const cssMod = server.moduleGraph?.getModuleById(plateCssId(name))
  if (cssMod) await server.reloadModule?.(cssMod)
}

/**
 * Print a plate's diagnostics to the Vite server output using the SAME grouped header + shared
 * formatter the browser console uses (diagnostics.ts), so the two can never drift. Prefers Vite's
 * logger (it preserves the formatting); falls back to `console.warn`. No-op when there are no
 * diagnostics.
 */
function reportServerDiagnostics(
  server: CaptureServer,
  name: string,
  diagnostics: readonly CaptureDiagnostic[] | undefined,
): void {
  if (!diagnostics || diagnostics.length === 0) return
  const text = [diagnosticsHeader(name), ...diagnostics.map((d) => formatDiagnostic(d))].join('\n')
  const logger = server.config?.logger
  if (logger) logger.warn(text)
  else console.warn(text)
}

/** A committed plate file past this is almost always a `<Skeleton>` set too high. */
const MAX_PLATE_BYTES = 2_000_000

/**
 * Hard ceiling on the POST body the endpoint will buffer. The posted StoredPlate is the whole
 * projected Plate the `MAX_PLATE_BYTES` cap guards, so this sits above the plate cap with headroom
 * (the JSON envelope + diagnostics add a little) and exists only to stop an oversized or runaway
 * body from being read into memory. Enforced both up front from `content-length` and while
 * streaming, so a lying or absent `content-length` cannot get past it. The dev endpoint is local
 * and unauthenticated, so this is the real backstop, not the header.
 */
const MAX_BODY_BYTES = 4_000_000

/** The only content type the capture client posts; anything else is rejected up front. */
function isJsonContentType(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value
  if (typeof header !== 'string') return false
  // `application/json` optionally with a charset/parameter, case-insensitive.
  return /^application\/json\b/i.test(header.trim())
}

/**
 * Reject cross-origin browser writes. Browsers always attach `Origin` to POSTs; a request from the
 * app's own page carries the dev server's origin, so its host must equal the `Host` the request
 * arrived on. A request with NO Origin header is not from a browser page (curl, a node script) and
 * is allowed — the gate targets drive-by browser writes to Plate and Fixture files, not local
 * tooling.
 */
function isSameOriginWrite(req: CaptureRequest): boolean {
  const origin = Array.isArray(req.headers?.origin) ? req.headers.origin[0] : req.headers?.origin
  if (origin === undefined || origin === 'null') return origin === undefined
  const host = Array.isArray(req.headers?.host) ? req.headers.host[0] : req.headers?.host
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Derive the HUD coverage bands from a StoredPlate's `breakpoints` (ADR 0022). Per-View spans do
 * not exist on disk: a StoredPlate sweeps ALL widths in one session, so coverage is complete
 * per-Plate and the bands are the breakpoint partition — each adjacent breakpoint pair is a covered
 * band, the first band open-min, the last open-max. `breakpoints=[b1,b2]` →
 * `[{max:b1},{min:b1,max:b2},{min:b2}]`; `breakpoints=[]` → one open band `[{}]`. The
 * `xray:plate`/coverage `spans` shape (`{min?, max?}[]`) is unchanged; only the SOURCE is derived.
 */
function spansFromBreakpoints(breakpoints: readonly number[]): Span[] {
  const sorted = [...breakpoints].toSorted((a, b) => a - b)
  if (sorted.length === 0) return [{}]
  const spans: Span[] = [{ max: sorted[0] }]
  for (let i = 0; i < sorted.length - 1; i++) spans.push({ min: sorted[i], max: sorted[i + 1] })
  spans.push({ min: sorted.at(-1) })
  return spans
}

/**
 * Send the stored plate (lowered to chunks) and its derived coverage bands over the HMR event so
 * the client hot-swaps it in place and the HUD updates its band display. The gen-side runs
 * `serializePlate(stored)` (the Bundle seam) here; the `spans` derive from the stored breakpoints.
 *
 * Two-artifact contract (ADR 0026): the event carries the TREE only — `serializePlate` returns a
 * css-less `Plate`, so there is no ws css side-channel by construction. The css half of a capture
 * travels exclusively over Vite's CSS-HMR (`invalidatePlateModules` re-pushes the `.css` virtual
 * module after the write). The live-store plate that outranks the statically-imported module in
 * `useLivePlate` cannot carry inline css, so no push can revert a mounted `<Skeleton>` to
 * inline-`<style>` rendering.
 */
function announcePlate(ws: PlateBroadcaster, name: string, stored: StoredPlate | null): void {
  const breakpoints = stored?.breakpoints ?? []
  const merged = stored
    ? { v: stored.v, name, tree: stored.tree, css: stored.css }
    : emptyPlate(name)
  ws.send({
    type: 'custom',
    event: 'xray:plate',
    data: {
      name,
      plate: serializePlate(merged),
      breakpoints,
      spans: spansFromBreakpoints(breakpoints),
    },
  })
}

/**
 * Per-plate breakpoints + derived coverage bands, read from the committed StoredPlate files. The
 * `spans` derive from each plate's `breakpoints` (ADR 0022: a StoredPlate sweeps all widths in one
 * session, so its coverage is complete).
 *
 * @internal
 */
export function readCoverage(
  dir: string,
): Record<string, { breakpoints: number[]; spans: Span[] }> {
  const out: Record<string, { breakpoints: number[]; spans: Span[] }> = {}
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = entry.replaceAll('\\', '/')
    if (!rel.endsWith('.json')) continue
    const name = rel.slice(0, -'.json'.length)
    if (!isValidPlateName(name)) continue
    const stored = readStoredPlate(resolve(dir, rel))
    if (!stored) continue
    const breakpoints = stored.breakpoints ?? []
    out[name] = { breakpoints, spans: spansFromBreakpoints(breakpoints) }
  }
  return out
}

/**
 * The on-disk Fixture sidecar shape (ADR 0015): version, plate name, and the OPAQUE devalue string.
 * The node side never parses `data` — it is the browser dev client's job (it has the live
 * runtime).
 */
const FIXTURE_VERSION = 1
const FIXTURE_SUFFIX = '.fixture.json'

/**
 * A recorded Fixture sidecar — `data` is the verbatim devalue string, treated as opaque text
 * server-side.
 */
function isFixtureFile(value: unknown): value is { v: number; name: string; data: string } {
  return (
    isRecord(value) &&
    typeof value.v === 'number' &&
    typeof value.name === 'string' &&
    typeof value.data === 'string'
  )
}

/**
 * All recorded Fixtures as `{ <name>: <devalueString> }`, read from the `<name>.fixture.json`
 * sidecars (ADR 0015). The map values are the OPAQUE devalue strings exactly as written — the node
 * side never parses them; the browser dev client owns the devalue decode. The `.fixture.json`
 * suffix keeps these distinct from Plate files (`isValidPlateName` rejects the dotted name, so
 * `readCoverage` never picks them up — Fixtures never leak into Plate coverage).
 *
 * @internal
 */
export function readFixtures(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return out
  }
  for (const entry of entries) {
    const rel = entry.replaceAll('\\', '/')
    if (!rel.endsWith(FIXTURE_SUFFIX)) continue
    const name = rel.slice(0, -FIXTURE_SUFFIX.length)
    if (!isValidPlateName(name)) continue
    let raw: string
    try {
      raw = readFileSync(resolve(dir, rel), 'utf8')
    } catch {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      // The wrapper is JSON the node side parses; the `data` field stays the
      // opaque devalue string. A version mismatch or wrong shape is skipped — a
      // hand-broken sidecar should not break the seed.
      if (isFixtureFile(parsed) && parsed.v === FIXTURE_VERSION) out[name] = parsed.data
    } catch {
      // Corrupt JSON — skip; the developer can re-record.
    }
  }
  return out
}

/**
 * Write a recorded Fixture sidecar (ADR 0015). Reuses the capture endpoint's front-door checks
 * (method, content type, declared/streamed size cap) and the `isValidPlateName` gate, but treats
 * the devalue `data` payload as OPAQUE TEXT: it is validated only as a string and written verbatim,
 * never eval'd or parsed server-side. The sidecar lives NEXT TO the Plate but is never merged into
 * it, so the persisted Plate stays purely structural.
 *
 * @internal
 */
export function handleFixturePost(
  req: CaptureRequest,
  res: CaptureResponse,
  fixturePath: (name: string) => string,
): void {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return
  }
  if (!isJsonContentType(req.headers?.['content-type'])) {
    res.statusCode = 415
    res.end('unsupported media type')
    return
  }
  const declared = Number(
    Array.isArray(req.headers?.['content-length'])
      ? req.headers['content-length'][0]
      : req.headers?.['content-length'],
  )
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.statusCode = 413
    res.end('payload too large')
    return
  }
  let body = ''
  let bytes = 0
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    const text = typeof chunk === 'string' ? chunk : (chunk?.toString() ?? '')
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BODY_BYTES) {
      aborted = true
      res.statusCode = 413
      res.end('payload too large')
      req.destroy?.()
      return
    }
    body += text
  })
  req.on('end', () => {
    if (aborted) return
    try {
      const raw: unknown = JSON.parse(body)
      // The POST envelope is `{ name, data }`: `name` gates through the same
      // isValidPlateName rule as every other path, and `data` is the opaque
      // devalue string (a string is all that is checked — its CONTENT is the client's
      // devalue output, never parsed here). A generic 400 on any failure.
      if (
        !isRecord(raw) ||
        typeof raw.name !== 'string' ||
        !isValidPlateName(raw.name) ||
        typeof raw.data !== 'string'
      ) {
        res.statusCode = 400
        res.end('invalid fixture payload')
        return
      }
      const file = fixturePath(raw.name)
      const sidecar = { v: FIXTURE_VERSION, name: raw.name, data: raw.data }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify(sidecar, null, 1)}\n`)
      res.statusCode = 204
      res.end()
    } catch {
      res.statusCode = 400
      res.end('invalid fixture payload')
    }
  })
}

/**
 * Validate a posted `StoredPlate` envelope, write it AS-IS, and hot-swap the plate in place. The
 * dev client posts a finished StoredPlate (the whole Plate already projected in the browser, ADR
 * 0022) inside a `{ plate, diagnostics? }` envelope; there is NO server-side accumulation/merge.
 * `diagnostics` is a SIBLING field the server logs and then drops; it never reaches the stored
 * artifact (ADR 0008).
 *
 * @internal
 */
export function handleCapturePost(
  req: CaptureRequest,
  res: CaptureResponse,
  server: CaptureServer,
  platePath: (name: string) => string,
): void {
  // Method, content type, and declared size are cheap front-door checks: reject
  // anything that is not the JSON POST the capture client makes BEFORE buffering
  // a single byte. Messages stay generic (ADR 0023).
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return
  }
  if (!isJsonContentType(req.headers?.['content-type'])) {
    res.statusCode = 415
    res.end('unsupported media type')
    return
  }
  const declared = Number(
    Array.isArray(req.headers?.['content-length'])
      ? req.headers['content-length'][0]
      : req.headers?.['content-length'],
  )
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.statusCode = 413
    res.end('payload too large')
    return
  }
  let body = ''
  let bytes = 0
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    const text = typeof chunk === 'string' ? chunk : (chunk?.toString() ?? '')
    // Count BYTES, not chars: a multi-byte body must not slip the cap. Once over,
    // stop accumulating and tear the request down so an oversized body is never
    // held in memory even if `content-length` lied or was absent.
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BODY_BYTES) {
      aborted = true
      res.statusCode = 413
      res.end('payload too large')
      req.destroy?.()
      return
    }
    body += text
  })
  req.on('end', () => {
    if (aborted) return
    try {
      const raw: unknown = JSON.parse(body)
      // The POST envelope is `{ plate: StoredPlate, diagnostics? }`. Validate the
      // `plate` with valibot (validate.ts): plate name, the post-classify
      // RenderNode tree, and the already-classified css blob (guarded for
      // `<style>`-breakout). `null` on any failure → a generic 400 that never
      // echoes the payload or its CSS. `diagnostics` is a sibling field — logged
      // below, never stored (ADR 0008).
      const envelope = isRecord(raw) ? raw : undefined
      const stored = parseStoredPlate(envelope?.plate)
      if (!stored) {
        res.statusCode = 400
        res.end('invalid capture payload')
        return
      }
      // Print the capture's dev-only diagnostics to the server output, the same
      // text the browser logged (diagnostics.ts). They ride in the envelope's
      // sibling `diagnostics` field, NOT in the StoredPlate, so they never reach
      // disk (ADR 0008). Validate them loosely (a known-code array) before logging.
      reportServerDiagnostics(server, stored.name, validEnvelopeDiagnostics(envelope?.diagnostics))
      const file = platePath(stored.name)
      const { stored: existing, invalid } = loadStoredPlate(file)
      // An EXISTING-but-unreadable committed plate (corrupt JSON, wrong shape, or
      // a version mismatch) is otherwise silently treated as absent — warn so the
      // dropped coverage is explained. The reason names the file only; never the
      // payload or any CSS/text content.
      if (invalid) {
        reportServerDiagnostics(server, stored.name, [
          makeDiagnostic('invalid-plate-file', { detail: `${stored.name}.json` }),
        ])
      }
      // Write the StoredPlate AS-IS — the client already projected the whole
      // Plate (no server-side merge/accumulation). Skip an unchanged write so the
      // file's mtime (and the watcher it would wake) stays put.
      const serialized = `${JSON.stringify(stored, null, 1)}\n`
      if (existing !== null && `${JSON.stringify(existing, null, 1)}\n` === serialized) {
        res.statusCode = 204
        res.end()
        return
      }
      if (serialized.length > MAX_PLATE_BYTES) {
        // Refuse to commit a monster: a plate this big means the <Skeleton>
        // sits too high. (The per-capture node guard catches most of these.)
        console.warn(
          `[xray] not writing "${stored.name}": ${Math.round(serialized.length / 1000)}KB exceeds the cap.`,
          'The <Skeleton> likely sits too high in the tree.',
        )
        res.statusCode = 413
        res.end('plate too large')
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, serialized)
      announcePlate(server.ws, stored.name, stored)
      // Drop BOTH of the plate's virtual modules from Vite's transform cache
      // (css reloaded live over CSS-HMR; the JS tree invalidated only, so the
      // NEXT page load re-transforms from disk — see `invalidatePlateModules`
      // for why the policies split and the garbled-skeleton failure a css-only
      // invalidation causes). Fire-and-forget: the response should
      // not wait on a dev-only HMR push, and a failure here has no
      // user-visible failure mode beyond "the next full reload picks up the
      // fresh modules".
      void invalidatePlateModules(server, stored.name)
      res.statusCode = 204
      res.end()
    } catch {
      // A JSON parse failure (or any other fault). Stay generic — never reflect
      // the parser's message or the posted body back to the client.
      res.statusCode = 400
      res.end('invalid capture payload')
    }
  })
}

/**
 * Loosely validate the envelope's SIBLING `diagnostics` (never stored, just logged). The
 * StoredPlate validator does not carry diagnostics — they are a transient dev-only field on the
 * POST envelope — so this filters the array to the known-code shape `reportServerDiagnostics`
 * formats, dropping anything that is not a `{ code, message, ... }` record. A malformed diagnostics
 * field never fails the post (the plate already validated); it just logs nothing.
 */
function validEnvelopeDiagnostics(value: unknown): CaptureDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: CaptureDiagnostic[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== 'string' || typeof item.message !== 'string') {
      continue
    }
    out.push({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- formatted by code; an unknown code prints verbatim
      code: item.code as CaptureDiagnostic['code'],
      message: item.message,
      ...(typeof item.count === 'number' ? { count: item.count } : {}),
      ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Read and validate a committed StoredPlate, distinguishing "no file" from "file present but
 * unreadable". `invalid` is true ONLY when the file exists but is corrupt JSON, the wrong shape, or
 * a version mismatch — a missing file is the normal pre-capture state and is not flagged. Callers
 * use `invalid` to warn (same diagnostics vocabulary) that an existing plate was ignored.
 */
function loadStoredPlate(file: string): { stored: StoredPlate | null; invalid: boolean } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    // No file (or unreadable path) — the expected pre-capture state, not a fault.
    return { stored: null, invalid: false }
  }
  try {
    // Committed plates are untrusted (hand-edited or from git), so they go
    // through the SAME validator a POST does (`parseStoredPlate`): it asserts the
    // version, the post-classify tree shape, and that the css blob cannot break
    // out of the rendered `<style>` raw text.
    const stored = parseStoredPlate(JSON.parse(raw))
    if (!stored) return { stored: null, invalid: true }
    return { stored, invalid: false }
  } catch {
    return { stored: null, invalid: true }
  }
}

function readStoredPlate(file: string): StoredPlate | null {
  return loadStoredPlate(file).stored
}

/**
 * Render a plate as the virtual module's source. Each stitch (`ref` node) becomes a real import of
 * that child's virtual module, wired into a `refs` map on the default export — so the bundler
 * builds the actual reference graph and chunks the transitive closure a page uses, with no runtime
 * registry (ADR 0006). A stitchless plate is just its JSON. Self-references are dropped (a module
 * can't import itself); an unknown child resolves to its own empty plate, never a build break.
 *
 * `name` defaults to the plate's own `name`, but the loader passes the PATH-derived name so a
 * hand-edited StoredPlate whose `name` field drifted from its filename still serializes and
 * self-references under the canonical name (`collectRefs` reads `stored.tree`, a RenderNode).
 *
 * Two-artifact module shape (ADR 0026):
 *
 * ```js
 * import "virtual:xray/base.css"
 * import "virtual:xray/plates/<name>.css"
 * export default { tree-only plate JSON }
 * export const css = "<the plate's scoped css string>"
 * ```
 *
 * The default export is the TREE artifact (`Plate` carries no css field); the page's styling flows
 * through Vite's own CSS pipeline via the two side-effect imports (dev inject + HMR, build
 * extraction into the chunk's `.css` asset). `export const css` is the plate's css as data, for dev
 * tooling / programmatic consumers that want the string itself — production adapters import only
 * the default, so Rollup TREE-SHAKES the unused named export out of built chunks (verified
 * empirically; the side-effect css imports do not pin it).
 *
 * BASE_CSS rides as a JS-level import of the SHARED `virtual:xray/base.css` module (not an
 * `@import` inside each plate's css): Vite dedupes JS module imports by id, so the base rules reach
 * the page exactly once no matter how many plates (nested/stitched included — every plate module
 * emits this import, module identity collapses them) a page mounts, and at build a multi-chunk app
 * gets it hoisted/shared rather than copied per chunk. An `@import` inside each plate's `.css`
 * would instead be INLINED per importer by Vite's postcss-import at build, duplicating BASE_CSS
 * into every plate's asset — the opposite of the dedupe this design locks in. Base rides before the
 * plate's css module so a plate rule still beats a base rule at equal specificity by source order
 * (the `${BASE_CSS}\n${css}` composition order).
 *
 * @internal
 */
export function renderPlateModule(merged: GatedPlate, name: string = merged.name): string {
  const refs = collectRefs(merged.tree).filter((ref) => ref !== name && isValidPlateName(ref))
  const json = JSON.stringify(serializePlate({ ...merged, name }))
  // The css imports ride FIRST (source order: Vite's CSS pipeline does not
  // care, but keeping them first mirrors "styles before structure"
  // convention). Both target un-prefixed `.css` ids (see
  // `plateCssId`/`BASE_CSS_ID`) so Vite's internal CSS plugins — which match
  // on the module id — route them through dev inject/HMR and build extraction
  // rather than treating them as plain modules.
  const cssImports = `import ${JSON.stringify(BASE_CSS_ID)}\nimport ${JSON.stringify(plateCssId(name))}`
  // The css-as-data named export (tree-shaken when unused — see the doc above).
  const cssExport = `export const css = ${JSON.stringify(merged.css)}`
  if (refs.length === 0) return `${cssImports}\nexport default ${json}\n${cssExport}`
  const imports = refs
    .map((ref, i) => `import __xr${i} from ${JSON.stringify(VIRTUAL_PREFIX + ref)}`)
    .join('\n')
  const map = refs.map((ref, i) => `${JSON.stringify(ref)}: __xr${i}`).join(', ')
  return `${[cssImports, imports].join('\n')}\nexport default Object.assign(${json}, { refs: { ${map} } })\n${cssExport}`
}
