/**
 * Vite plugin entry point for xray.
 *
 * Add `xrayVitePlugin()` to a Vite config to resolve committed Plate imports in dev and build. The
 * dev capture client is injected only during `vite serve`, and only when `capture` or the HUD needs
 * it.
 *
 * @module @hueest/xray
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify as devalueStringify } from 'devalue'
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
import { renderEnvFile, renderPlateSourceModule } from './plate-source.ts'
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
   * Directory where plate modules (`<name>.ts`, ADR 0034) are written and read, relative to the
   * Vite root. Default: `src/plates` (ADR 0032) — under `src` so the standard tsconfig `include:
   * ["src"]` picks up the plate modules and the generated `xray-env.gen.d.ts` with no tsconfig
   * edits; plates are committed source artifacts and read as such there. Known edge: with a Vite
   * `root` that is not the package directory, `src/plates` resolves against that ROOT and can land
   * outside the tsconfig `include`, silently disabling the drift check — set `platesDir` and add
   * one `include` entry in that case.
   */
  platesDir?: string
  /**
   * Mount the dev HUD: record and Light Box controls, per-plate Coverage, per-plate keys. Default:
   * `false`.
   */
  hud?: boolean
  /**
   * Whether recording is engaged at boot in dev. Keep this off for normal browsing and let the HUD
   * (or `?xray-capture`) engage recording per tab. Default: `false`.
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
   * Dev-only Fixtures (ADR 0015/0033/0034): record a `<Skeleton>`'s render-input `data` as the
   * `fixture` export of the committed plate module (`src/plates/<name>.ts`) and replay it in place
   * of live data so capture is deterministic. Boot state only — the HUD is per-tab authority, just
   * like `capture`. Entirely dev-only; nothing here ships in production.
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
  /**
   * Opt OUT of TypeScript declaration generation. By default the plugin derives and writes the one
   * generated `src/plates/xray-env.gen.d.ts` (ADR 0032): the wildcard reference plus a declare
   * block per fixture-bearing plate typing its virtual module as `Plate<typeof
   * import('./<name>').fixture>`, so the consumer's own compiler flags a `data`-type change the
   * committed Fixture no longer satisfies (the `FixtureOutOfDate` error at the `<Skeleton>` site);
   * the default `platesDir` sits inside the standard tsconfig `include: ["src"]`, so the check is
   * live with no tsconfig edits (a `files`-only tsconfig or a custom Vite `root` lists the
   * directory itself). Top-level rather than a `fixtures` sub-option because typegen is xray's
   * general TS integration — one switch, one generated file. Set `true` to keep a drift error from
   * blocking a build when re-recording has to wait. The switch stops xray WRITING the file; a
   * previously committed `xray-env.gen.d.ts` stays in the program until deleted from the tree.
   * Default: `false`.
   */
  noTypes?: boolean
}

const RESOLVED_PREFIX = `\0${VIRTUAL_PREFIX}`
const BOOT_ID = 'virtual:xray/client'
const RESOLVED_BOOT_ID = `\0${BOOT_ID}`
/**
 * The dev-only module that imports the `fixture` export of every fixture-bearing plate module under
 * `platesDir` and seeds the fixtures store with the LIVE values (ADR 0033/0034) — replay data rides
 * the module graph, not a devalue wire. Self-accepting, so editing a plate module HMRs straight
 * into a running Replay.
 */
const FIXTURES_ID = 'virtual:xray/fixtures'
const RESOLVED_FIXTURES_ID = `\0${FIXTURES_ID}`
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
  const platesDir = options.platesDir ?? 'src/plates'
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
  const fixtureTypes = !options.noTypes
  let root = process.cwd()

  const dir = () => resolve(root, platesDir)

  // One module per Plate (ADR 0034): the StoredPlate structure as the default
  // export, the recorded Fixture (if any) as `export const fixture`. All
  // generated ambient declarations live in the one env file (`envPath`).
  const platePath = (name: string) => resolve(root, platesDir, `${name}.ts`)
  const envPath = () => resolve(root, platesDir, 'xray-env.gen.d.ts')

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
    async load(id) {
      if (id === BASE_CSS_ID) return BASE_CSS
      if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith('.css')) {
        const name = id.slice(VIRTUAL_PREFIX.length, -'.css'.length)
        if (!isValidPlateName(name)) return ''
        // Deliberately NOT addWatchFile, for the same reason as the JS virtual
        // module below: a capture writes this file, and watching it would make
        // Vite reload the module — an infinite capture loop. Dev updates are
        // pushed instead via `configureServer`'s invalidation below.
        const { plate } = await importPlateSource(platePath(name))
        return plate?.css ?? ''
      }
      if (!id.startsWith(RESOLVED_PREFIX)) return undefined
      const name = id.slice(RESOLVED_PREFIX.length)
      if (!isValidPlateName(name)) return renderPlateModule(emptyPlate(name))
      // Deliberately NOT addWatchFile: a capture writes this file, and watching
      // it would make Vite reload the module — remounting the capture boundary
      // and re-firing the capture, an infinite loop. Live updates are pushed
      // in place over the `xray:plate` HMR event instead; the read here
      // only seeds the committed plate on a fresh load.
      const { plate } = await importPlateSource(platePath(name))
      return renderPlateModule(plate ?? emptyPlate(name), name)
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
      if (id === FIXTURES_ID) return RESOLVED_FIXTURES_ID
      return undefined
    },
    load(id) {
      if (id === RESOLVED_FIXTURES_ID) return fixturesModule(resolve(root, platesDir), platesDir)
      if (id !== RESOLVED_BOOT_ID) return undefined
      return bootstrapCode(delay, settleCap, collect, hud, capture, recordMode, replayMode)
    },
    configureServer(server) {
      // Push the merged plate in place when a plate module changes outside the
      // POST endpoints — a git checkout or a hand edit — so it hot-swaps like a
      // capture does. (Our own POST writes also fire this; the client dedupes
      // identical plates, so the announce duplicate is a no-op, and the
      // repeated invalidation below is idempotent.)
      // The env file (ADR 0032/0034): one generated d.ts whose triple-slash
      // reference wires the `virtual:xray/plates/*` wildcard with zero tsconfig
      // edits and whose per-plate declarations carry each recorded Fixture's
      // type. Fully derived from the directory, so it regenerates on boot and
      // on every plate-module event below. `noTypes` (the one switch over all
      // of xray's declaration generation) stops xray writing or updating it.
      const regenEnv = fixtureTypes
        ? () => regenerateEnvFile(dir(), envPath())
        : () => Promise.resolve()
      void regenEnv()
      server.watcher.add(dir())
      // One watcher handler for the one file kind (ADR 0034 §5). The fixtures
      // virtual module enumerates plate modules at LOAD time and Vite caches
      // the transform forever (a virtual id has no file to watch) — without
      // the invalidation, a Fixture recorded or hand-created after boot stays
      // invisible until a server restart. Files already in the graph
      // hot-update natively through the module's self-accept.
      const onPlateModule = (file: string, removed: boolean) => {
        if (!file.startsWith(dir()) || !file.endsWith('.ts') || file.endsWith('.d.ts')) return
        const name = relative(dir(), file).slice(0, -'.ts'.length)
        if (!isValidPlateName(name)) return
        // A hand edit can land inside the same millisecond as the previous
        // read; the revision component of the import key covers what mtime
        // alone cannot.
        bumpFileRev(file)
        const fixturesMod = server.moduleGraph?.getModuleById(RESOLVED_FIXTURES_ID)
        if (fixturesMod) {
          server.moduleGraph?.invalidateModule(fixturesMod)
          // Invalidation alone only marks the cached transform stale — nothing
          // re-executes it in an OPEN tab, so a Fixture added to a previously
          // fixtureless module (or deleted) would wait for the next page load.
          // The module self-accepts, so the reload re-runs the seed in place.
          void server.reloadModule?.(fixturesMod)
        }
        // Keep the plate's virtual modules in sync with the changed file:
        // without the invalidation, a hand edit / git checkout announces to
        // the live store but leaves Vite's cached transforms stale, so the
        // NEXT page load serves an old tree regardless of what is on disk.
        void invalidatePlateModules(server, name)
        void regenEnv()
        if (removed) {
          // Clear the live store and Coverage: mounted clients must not keep
          // rendering a Plate whose module is gone.
          announcePlate(server.ws, name, null)
          return
        }
        void importPlateSource(file).then(({ plate }) => {
          if (plate) announcePlate(server.ws, name, plate)
        })
      }
      server.watcher.on('add', (file: string) => onPlateModule(file, false))
      server.watcher.on('change', (file: string) => onPlateModule(file, false))
      server.watcher.on('unlink', (file: string) => onPlateModule(file, true))
      server.middlewares.use(ENDPOINT, (req, res) => {
        // GET /__xray/coverage → per-plate breakpoints + captured spans from disk.
        if (req.method === 'GET' && req.url === '/coverage') {
          void readCoverage(dir()).then((coverage) => {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(coverage))
          })
          return
        }
        // Both write paths (Plate capture, Fixture record) put files in the
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
        // POST /__xray/fixture → upsert the Fixture into the plate MODULE
        // (ADR 0034), reusing the capture endpoint's body-reading/validation
        // discipline. The devalue payload is read as STRUCTURE only — value
        // literals in, module text out, nothing revived server-side.
        if (req.url === '/fixture') {
          void handleFixturePost(req, res, platePath)
          return
        }
        void handleCapturePost(req, res, server, platePath)
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
    // POST a recorded Fixture's devalue payload. The client owns the devalue
    // stringify (it has the live `data`); the server reads the payload as
    // structure and renders the fixture module's text, never reviving values
    // (ADR 0033). Rejects on a non-2xx — with the response body, which carries
    // the renderer's refusal reason — so the HUD surfaces WHY a write failed.
    '  recordFixtureSink(payload) {',
    `    return fetch('${ENDPOINT}/fixture', {`,
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json' },",
    '      body: JSON.stringify(payload),',
    '    }).then((response) => {',
    '      if (response.ok) return',
    '      return response.text().then((body) => {',
    "        throw new Error('xray fixture POST failed: ' + response.status + (body ? ' — ' + body : ''))",
    '      })',
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
    // Load recorded Fixtures through the module graph (ADR 0033/0034): the
    // virtual module imports every fixture-bearing plate module and seeds the
    // store with LIVE values.
    // Dynamic (not hoisted) so it runs AFTER installXrayClient; failures stay
    // isolated from boot.
    "void import('virtual:xray/fixtures').catch(() => {})",
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
      // A null announce (a deleted plate module) must CLEAR Coverage: empty
      // spans, not the open all-widths band `spansFromBreakpoints([])` yields.
      spans: stored ? spansFromBreakpoints(breakpoints) : [],
    },
  })
}

/**
 * Per-plate breakpoints + captured coverage bands, read from the committed plate modules. `spans`
 * come from the plate itself (ADR 0029: the bands actually captured); a plate without the field
 * derives complete spans from its `breakpoints` (the historical sweep-only assumption) until a
 * re-capture writes the truth.
 *
 * @internal
 */
export async function readCoverage(
  dir: string,
): Promise<Record<string, { breakpoints: number[]; spans: Span[] }>> {
  const out: Record<string, { breakpoints: number[]; spans: Span[] }> = {}
  for (const [name, { plate }] of await importPlateSources(dir)) {
    if (!plate) continue
    const breakpoints = plate.breakpoints ?? []
    // Stored spans are the CAPTURED bands (ADR 0029) — a partial session reports
    // only what it touched. Plates written before the field existed fall back to
    // the historical complete-coverage assumption until a re-capture.
    out[name] = { breakpoints, spans: plate.spans ?? spansFromBreakpoints(breakpoints) }
  }
  return out
}

/**
 * Every plate module under `dir`, imported (`importPlateSource`) and paired with its plate name, in
 * sorted name order. The `import()` reads are independent, so they run in parallel.
 */
async function importPlateSources(
  dir: string,
): Promise<[string, Awaited<ReturnType<typeof importPlateSource>>][]> {
  const names = plateModuleNames(dir)
  const sources = await Promise.all(
    names.map((name) => importPlateSource(resolve(dir, `${name}.ts`))),
  )
  return names.map((name, i) => [name, sources[i]!])
}

/** The fixture-bearing plate names under `dir`, from the modules' own `fixture` exports. */
async function fixtureBearingNames(dir: string): Promise<string[]> {
  const entries = await importPlateSources(dir)
  return entries.filter(([, source]) => source.hasFixture).map(([name]) => name)
}

/**
 * The plate-module basenames under `dir`, as plate names (ADR 0034). The dot rule does the
 * filtering: every sidecar carries a dotted suffix (`.gen.d.ts`, `.d.ts`), and `isValidPlateName`
 * rejects dotted stems, so a plain `<name>.ts` is a plate module and nothing else is.
 */
function plateModuleNames(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    const rel = entry.replaceAll('\\', '/')
    if (!rel.endsWith('.ts') || rel.endsWith('.d.ts')) continue
    const name = rel.slice(0, -'.ts'.length)
    if (isValidPlateName(name)) names.push(name)
  }
  return names.toSorted()
}

/**
 * The `virtual:xray/fixtures` module (ADR 0033/0034): imports the `fixture` export of every
 * fixture-bearing plate module through the module graph and seeds the fixtures store with the LIVE
 * values — no devalue decode, real `Date`/`Map` objects, and the transform pipeline the rest of the
 * app already uses. Self-accepting so a plate-module edit re-runs the seed with `force` (the disk
 * is the fresher truth on an HMR re-seed); a NEWLY recorded fixture is already live in the store
 * via Record itself, and joins the import list on the next page load. Which modules bear a fixture
 * is known from the server's own `import()` reads. Dev-only: nothing imports this in a production
 * build.
 */
async function fixturesModule(dir: string, platesDir: string): Promise<string> {
  const names = await fixtureBearingNames(dir)
  const imports = names.map(
    (name, i) => `import { fixture as f${i} } from ${JSON.stringify(`/${platesDir}/${name}.ts`)}`,
  )
  const entries = names.map((name, i) => `  ${JSON.stringify(name)}: f${i},`)
  return [
    ...imports,
    'const values = {',
    ...entries,
    '}',
    'globalThis.__XRAY__?.fixtures?.seed?.(values, true)',
    'if (import.meta.hot) import.meta.hot.accept()',
    '',
  ].join('\n')
}

/**
 * Derive and write the env file from the plates directory: scan the plate modules, declare every
 * fixture-bearing one. Skips the write when the rendered content already matches disk, so the
 * watcher (whose handler ignores `.d.ts` files anyway) can call this on every plate-module event
 * without churn.
 */
async function regenerateEnvFile(dir: string, file: string): Promise<void> {
  const text = renderEnvFile(await fixtureBearingNames(dir))
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/**
 * Front door shared by both POST endpoints: method, content type, and declared size are cheap
 * checks that reject anything that is not the JSON POST the dev client makes BEFORE buffering a
 * single byte; the streamed cap catches a lying or absent `content-length`. Resolves to the
 * buffered body, or `null` when a rejection response was already sent. Messages stay generic (ADR
 * 0023).
 */
function readJsonPost(req: CaptureRequest, res: CaptureResponse): Promise<string | null> {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return Promise.resolve(null)
  }
  if (!isJsonContentType(req.headers?.['content-type'])) {
    res.statusCode = 415
    res.end('unsupported media type')
    return Promise.resolve(null)
  }
  const declared = Number(
    Array.isArray(req.headers?.['content-length'])
      ? req.headers['content-length'][0]
      : req.headers?.['content-length'],
  )
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    res.statusCode = 413
    res.end('payload too large')
    return Promise.resolve(null)
  }
  return new Promise((resolvePromise) => {
    let body = ''
    let bytes = 0
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      const text = typeof chunk === 'string' ? chunk : (chunk?.toString() ?? '')
      // Count BYTES, not chars: a multi-byte body must not slip the cap. Once
      // over, stop accumulating and tear the request down so an oversized body
      // is never held in memory even if `content-length` lied or was absent.
      bytes += Buffer.byteLength(text)
      if (bytes > MAX_BODY_BYTES) {
        aborted = true
        res.statusCode = 413
        res.end('payload too large')
        req.destroy?.()
        resolvePromise(null)
        return
      }
      body += text
    })
    req.on('end', () => {
      if (!aborted) resolvePromise(body)
    })
  })
}

/**
 * Per-file promise chains serializing the read-render-write upserts (ADR 0034 §4): a concurrent
 * Capture and Record of the same plate would otherwise both import the old module and the later
 * write would discard the other's half. `fileRevs` is the same-millisecond complement — see
 * `importPlateSource`.
 */
const writeLocks = new Map<string, Promise<void>>()
const fileRevs = new Map<string, number>()

function bumpFileRev(file: string): void {
  fileRevs.set(file, (fileRevs.get(file) ?? 0) + 1)
}

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(file) ?? Promise.resolve()
  const run = prev.then(fn)
  writeLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * Upsert a recorded Fixture into the plate MODULE (ADR 0034). The devalue payload is read as
 * STRUCTURE only — value literals in, module text out, nothing revived — and the plate half is read
 * back through `importPlateSource`, so the whole file re-renders with the plate preserved. The env
 * file regenerates through the watcher event this write fires.
 *
 * @internal
 */
export async function handleFixturePost(
  req: CaptureRequest,
  res: CaptureResponse,
  platePath: (name: string) => string,
): Promise<void> {
  const body = await readJsonPost(req, res)
  if (body === null) return
  try {
    const raw: unknown = JSON.parse(body)
    // The POST envelope is `{ name, data }`: `name` gates through the same
    // isValidPlateName rule as every other path, and `data` is the client's
    // devalue payload — parsed here as plain JSON and rendered to module TEXT,
    // never revived (ADR 0033/0034). A generic 400 on any failure, including
    // payloads the renderer refuses.
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
    // Narrowings on `raw` do not survive into the lock closure; bind them.
    const name = raw.name
    const file = platePath(name)
    const fixturePayload = JSON.parse(raw.data) as unknown
    // The read of the plate half and the write of the whole module must not
    // interleave with a concurrent Capture upsert of the same file (ADR 0034
    // §4): both would import the old module and the later write would discard
    // the other's half. The per-file lock serializes them.
    await withFileLock(file, async () => {
      const { plate } = await importPlateSource(file)
      const moduleText = renderPlateSourceModule({ plate, fixturePayload })
      // Skip an unchanged write so the file's mtime (and the watcher it would
      // wake) stays put — a re-record of identical data is a no-op.
      if (existsSync(file) && readFileSync(file, 'utf8') === moduleText) {
        res.statusCode = 204
        res.end()
        return
      }
      const moduleBytes = Buffer.byteLength(moduleText)
      if (moduleBytes > MAX_PLATE_BYTES) {
        // Shared references inline as duplicates (ADR 0033 §2), so a small
        // payload can render far past its wire size; the module cap applies
        // to this write path the same as to Capture.
        console.warn(
          `[xray] not writing the "${name}" Fixture: ${Math.round(moduleBytes / 1000)}KB exceeds the cap.`,
        )
        res.statusCode = 413
        res.end('fixture too large')
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, moduleText)
      bumpFileRev(file)
      res.statusCode = 204
      res.end()
    })
  } catch (error) {
    // The renderer's refusals are exact ("unsupported fixture value type: …")
    // and the POST is the only place the user learns them — typed arrays, for
    // one, pass the client-side stringify gate. Put the reason in the body.
    res.statusCode = 400
    const reason = error instanceof Error ? error.message : 'invalid fixture payload'
    res.end(`invalid fixture payload: ${reason}`)
  }
}

/**
 * Validate a posted `StoredPlate` envelope, upsert it into the plate MODULE, and hot-swap the plate
 * in place. The dev client posts a finished StoredPlate (the whole Plate already projected in the
 * browser, ADR 0022) inside a `{ plate, diagnostics? }` envelope; there is NO server-side
 * accumulation/merge. `diagnostics` is a SIBLING field the server logs and then drops; it never
 * reaches the stored artifact (ADR 0008). An existing Fixture is read back as a live value and
 * re-serialized into the re-rendered module (ADR 0034 §4) — value edits survive, formatting and
 * comments do not.
 *
 * @internal
 */
export async function handleCapturePost(
  req: CaptureRequest,
  res: CaptureResponse,
  server: CaptureServer,
  platePath: (name: string) => string,
): Promise<void> {
  const body = await readJsonPost(req, res)
  if (body === null) return
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
    // The fixture-half read and the whole-module write serialize against any
    // concurrent Record of the same file — see handleFixturePost.
    await withFileLock(file, async () => {
      const existing = await importPlateSource(file)
      // An EXISTING-but-unreadable committed plate module (a broken import or
      // an invalid plate export) is otherwise silently treated as absent —
      // warn so the dropped coverage is explained. The reason names the file
      // only; never the payload or any CSS/text content.
      if (existing.invalid) {
        reportServerDiagnostics(server, stored.name, [
          makeDiagnostic('invalid-plate-file', { detail: `${stored.name}.ts` }),
        ])
      }
      // Re-render the WHOLE module: the new plate plus the existing Fixture,
      // re-serialized from the live value the import handed back (ADR 0034
      // §4). A hand-edited fixture that devalue cannot serialize refuses the
      // capture loudly rather than silently dropping the Fixture.
      const fixturePayload = existing.hasFixture
        ? (JSON.parse(devalueStringify(existing.fixture)) as unknown)
        : undefined
      const serialized = renderPlateSourceModule({ plate: stored, fixturePayload })
      // Skip an unchanged write so the file's mtime (and the watcher it would
      // wake) stays put.
      if (existsSync(file) && readFileSync(file, 'utf8') === serialized) {
        res.statusCode = 204
        res.end()
        return
      }
      const serializedBytes = Buffer.byteLength(serialized)
      if (serializedBytes > MAX_PLATE_BYTES) {
        // Refuse to commit a monster: a plate this big means the <Skeleton>
        // sits too high. (The per-capture node guard catches most of these.)
        console.warn(
          `[xray] not writing "${stored.name}": ${Math.round(serializedBytes / 1000)}KB exceeds the cap.`,
          'The <Skeleton> likely sits too high in the tree.',
        )
        res.statusCode = 413
        res.end('plate too large')
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, serialized)
      bumpFileRev(file)
      announcePlate(server.ws, stored.name, stored)
      // Drop BOTH of the plate's virtual modules from Vite's transform cache
      // (css reloaded live over CSS-HMR; the JS tree invalidated only, so the
      // NEXT page load re-transforms from disk — see `invalidatePlateModules`
      // for why the policies split and the garbled-skeleton failure a
      // css-only invalidation causes). Fire-and-forget: the response should
      // not wait on a dev-only HMR push, and a failure here has no
      // user-visible failure mode beyond "the next full reload picks up the
      // fresh modules".
      void invalidatePlateModules(server, stored.name)
      res.statusCode = 204
      res.end()
    })
  } catch {
    // A JSON parse failure, an unserializable hand-edited fixture, or any
    // other fault. Stay generic — never reflect the parser's message or the
    // posted body back to the client.
    res.statusCode = 400
    res.end('invalid capture payload')
  }
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
 * Import a committed plate module (ADR 0034 §3) and hand back its two halves, distinguishing "no
 * file" from "file present but unreadable". Node executes the module through its own type stripping
 * — safe because the write path guarantees page scripts author values, never syntax, so the file is
 * the same trust class as `vite.config.ts`. The mtime query defeats Node's permanent ESM cache; the
 * retained stale modules are bounded by edit frequency, a dev-server non-cost.
 *
 * The plate export is untrusted (hand-edited or from git), so it goes through the SAME validator a
 * POST does (`parseStoredPlate`): version, post-classify tree shape, and the `<style>`-breakout
 * guard on the css blob. `invalid` is true ONLY when the file exists but fails to import or its
 * plate fails to validate — a missing file is the normal pre-capture state and is not flagged.
 * `hasFixture` reports the `fixture` export's presence (its value may legitimately be
 * `undefined`).
 */
async function importPlateSource(file: string): Promise<{
  plate: StoredPlate | null
  fixture: unknown
  hasFixture: boolean
  invalid: boolean
}> {
  let mtime: number
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    // No file (or unreadable path) — the expected pre-capture state, not a fault.
    return { plate: null, fixture: undefined, hasFixture: false, invalid: false }
  }
  // The revision component covers what mtime cannot: two writes inside the
  // same millisecond share an mtime, and Node's ESM cache would then serve
  // the first write's module for the second's read. Every server write and
  // every watcher event bumps the file's revision.
  const key = `${mtime}-${fileRevs.get(file) ?? 0}`
  let ns: Record<string, unknown>
  try {
    // @vite-ignore: a runtime file URL for NODE's own loader (type stripping),
    // never for a bundler to resolve — vitest's transform must leave it alone.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a dynamic import's namespace; every member is validated below
    ns = (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?t=${key}`)) as Record<
      string,
      unknown
    >
  } catch {
    return { plate: null, fixture: undefined, hasFixture: false, invalid: true }
  }
  const plate = ns.plate == null ? null : parseStoredPlate(ns.plate)
  return {
    plate,
    fixture: ns.fixture,
    hasFixture: 'fixture' in ns,
    invalid: ns.plate != null && !plate,
  }
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
