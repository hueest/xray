import { parse as devalueParse, stringify as devalueStringify } from 'devalue'
import { deriveBreakpoints, viewSpanFor } from './breakpoints.ts'
import { serializePlate } from './chunk.ts'
import { blinkCapture } from './blink.ts'
import type {
  CoverageStore,
  FixtureStore,
  Plate,
  PlateCoverage,
  PlateStore,
  StoredPlate,
  ToggleStore,
} from './plate.ts'
import {
  captureView,
  CaptureTooLargeError,
  type CollectLimits,
  type XrayCaptureWalker,
} from './measure.ts'
import { distilPlate } from './measure.ts'
import { serializePlateIR } from './serialize.ts'
import { emit, type PlateIR, type ViewIR } from './ir.ts'
import {
  type CaptureDiagnostic,
  diagnosticsHeader,
  formatDiagnostic,
  makeDiagnostic,
} from './diagnostics.ts'

/**
 * The dev capture client. Runs in the browser during dev only: installs the `__XRAY__` hook
 * `<Skeleton>` calls when content becomes ready, settles, measures the subtree into a per-Plate
 * `PlateIR`, projects it to the structured `StoredPlate` in the browser (the ADR 0022 in-browser
 * Serialize), and hands the envelope to the sink (the plugin's POST endpoint). Re-captures when the
 * viewport crosses into another view while a site is still mounted.
 *
 * Two paths produce a Plate. BROWSE-TIME is a CAPTURE SESSION (the Capture toggle): while on, each
 * capture accumulates a View into a name-keyed `PlateIR` buffer (deduped per breakpoint band) and
 * live-previews it in-memory; toggling off writes each accumulated Plate to the sink ONCE. The
 * capture-all SWEEP threads ONE `PlateIR` through every emulated width (one View each) and posts
 * the projected StoredPlate once.
 */

/**
 * The `/__xray` POST envelope (ADR 0022). `plate` is the finished, in-browser-projected
 * `StoredPlate` written to disk as-is; `diagnostics` is a SIBLING dev-only field the server logs
 * and drops — it NEVER reaches the stored artifact (ADR 0008).
 */
export interface CaptureEnvelope {
  plate: StoredPlate
  diagnostics?: CaptureDiagnostic[]
}

export interface ClientOptions {
  /** Settle delay (ms) once the subtree goes quiet. Default 200. */
  delay?: number
  /**
   * Upper bound (ms) on waiting for quiet before capturing anyway. Raise it for pages that stream
   * content for a long time. Default 5000.
   */
  settleCap?: number
  /**
   * Collect limits (ADR 0022): refuse a capture whose measured tree exceeds any axis — that big
   * means the Skeleton sits too high in the component tree. `maxNodes` caps total surviving nodes
   * (default 4096), `maxBreadth` the widest level (default 512), `maxDepth` the nesting depth
   * (default 32). When `maxNodes` is omitted it derives as `round(maxBreadth × maxDepth / 4)`.
   */
  collect?: CollectLimits
  /**
   * Initial state of the capture toggle: whether the capture session is active at boot. A per-tab
   * override (sessionStorage / `?xray-capture`) wins over it. Defaults to `false` — capturing is
   * explicit opt-in (turn it on, browse/resize to accumulate Views, turn it off to write), so
   * normal browsing never accumulates and an HMR/close can't drop an unsaved session. The plugin
   * passes the same off-by-default policy; a direct caller can pass `true` to capture on boot.
   */
  capture?: boolean
  /**
   * Where finished captures go. May be synchronous (fire-and-forget) or return a promise that
   * resolves once the write is server-confirmed. Browse-time capture ignores the return value; the
   * capture-all sweep awaits it so it does not advance to the next emulated width until the current
   * writes have been accepted by the dev server (backpressure).
   */
  sink: (envelope: CaptureEnvelope) => void | Promise<void>
  /**
   * Re-pull the on-disk per-plate coverage and feed it into the coverage store. The capture-all
   * sweep calls this after each pass so the next `sweepWidths()` sees the breakpoints just written
   * by that pass, rather than racing the async `xray:plate` HMR event. Optional: browse-time
   * capture never needs it, and the unit tests drive coverage directly through the store.
   */
  refreshCoverage?: () => void | Promise<void>
  /**
   * Fixtures boot state (ADR 0015). `record` is when to write the live `data` to a sidecar
   * (`'manual'` — HUD button only, the default; `'first-ready'`; or `'always'`); `replay` is
   * whether to substitute a recorded Fixture for live `data` (`false`, `'prefer'`, or
   * `'missing-only'`). The HUD overrides the replay toggle per tab. Absent ≡ defaults (`'manual'` /
   * `false`).
   */
  record?: 'manual' | 'first-ready' | 'always'
  replay?: false | 'prefer' | 'missing-only'
  /**
   * Where a recorded Fixture's OPAQUE devalue string is POSTed (the sidecar write endpoint). The
   * client owns the devalue stringify; this only ships the bytes. Resolves once the write is
   * server-confirmed, rejects on a non-2xx so the HUD Record button can surface a failed write.
   * Absent ≡ Record is a no-op (the unit tests inject their own).
   */
  recordFixtureSink?: (payload: { name: string; data: string }) => void | Promise<void>
}

interface Site {
  name: string
  el: Element
  delay: number
  /**
   * The capture-root model (ADR 0014). `'auto'` (the default): `el` is the `display:contents`
   * wrapper, so the roots are its CHILDREN. `'manual'`: `el` is the consumer's OWN styled element,
   * so the root is `el` ITSELF — its box/classes/padding/border are captured rather than dropped as
   * if it were a layout-neutral wrapper. `rootsFor` centralizes the difference.
   */
  mode: 'auto' | 'manual'
  /**
   * The per-site programmable capture walker (ADR 0018), a closure forwarded by `<Skeleton
   * captureWalker>` through `captured`. Passed straight into `captureView` on every (re)capture for
   * this site; capture-only, never persisted. Undefined for the common case (no walker).
   */
  walker?: XrayCaptureWalker
  /**
   * The per-site Collect limits (ADR 0022), forwarded by the flat `<Skeleton>`
   * `maxNodes`/`maxBreadth`/`maxDepth` props through `captured`. Merged over the plugin defaults
   * per capture by `resolveCollect`; capture-only. Undefined when the site sets none, so the plugin
   * defaults apply.
   */
  collect?: CollectLimits
  /**
   * The serialized `StoredPlate` last sent for this site — a per-PLATE dedupe (the client posts one
   * finished StoredPlate per browse/sweep). An identical re-projection skips the POST; a failed
   * send clears it so a retry re-sends. Undefined until the first send.
   */
  lastSent?: string
  /**
   * The per-session, per-site `PlateIR` the capture-all sweep accumulates Views into (ADR 0022 §2):
   * one bundle threaded through every emulated width, projected to ONE StoredPlate at the end of
   * the sweep. Undefined outside a sweep (browse captures build a fresh local 1-View IR each time).
   * Reset at the start of every sweep so a prior sweep's Views never leak into a new one.
   */
  sessionPlate?: PlateIR
  disposed: boolean
  /** Set once a capture came back over the node limit — stop re-attempting it. */
  tooLarge: boolean
  /**
   * In-flight capture coalescing (ADR 0025). The hot path is `settle -> walk -> getComputedStyle ->
   * index -> match -> post`, and mount/resize/toggle/capture-all can all fire for one site while a
   * capture is still settling. Rather than run a second parallel settle+walk, the site is marked
   * `dirty` and AT MOST ONE follow-up runs once the in-flight one finishes, using the latest
   * DOM/viewport state. `inflight` is that running capture's promise (so a caller can await the
   * site going quiescent); `dirty` means a trigger arrived mid-capture; `dirtyForce` carries the
   * STRONGEST requirement requested while dirty (a forced capture-all trigger must not be
   * downgraded to a non-forced browse follow-up — see the scheduler below).
   */
  inflight?: Promise<void>
  dirty: boolean
  dirtyForce: boolean
}

interface ExtensionAck {
  source: 'xray-ext'
  kind: 'ack'
  id: number
  ok?: boolean
  error?: string
}

function isExtensionAck(value: unknown): value is ExtensionAck {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    value.source === 'xray-ext' &&
    'kind' in value &&
    value.kind === 'ack' &&
    'id' in value &&
    typeof value.id === 'number' &&
    (!('ok' in value) || typeof value.ok === 'boolean') &&
    (!('error' in value) || typeof value.error === 'string')
  )
}

const DEFAULT_SETTLE_CAP = 5_000
// Collect-limit defaults (ADR 0022). `breadth` = widest level, `depth` = nesting.
// A real DOM tree fills only ~¼ of its breadth×depth box (measured ~0.28), so
// `maxNodes` derives from the two rather than their full (fractal) product.
const DEFAULT_MAX_DEPTH = 32
const DEFAULT_MAX_BREADTH = 512
const deriveMaxNodes = (maxBreadth: number, maxDepth: number): number =>
  Math.round((maxBreadth * maxDepth) / 4)
const RESIZE_DEBOUNCE = 300

/**
 * The capture roots for a site, the ONE place the auto/manual root models diverge (ADR 0014).
 *
 * - AUTO: `site.el` is the `display:contents` wrapper, a layout-neutral box, so the content is its
 *   CHILDREN — the synthetic root (id 0) stands in for the wrapper and the children become the
 *   plate's top level. `<STYLE>` children are dropped (a stitched-in scoped sheet, never content).
 * - MANUAL: `site.el` is the consumer's OWN styled element, so the element ITSELF is the root.
 *   Capturing its children would drop its box, classes, padding, border, background, and radius —
 *   so the element is the single root and its own box is serialized.
 */
function rootsFor(site: Site): Element[] {
  if (site.mode === 'manual') return [site.el]
  return Array.from(site.el.children).filter((child) => child.tagName !== 'STYLE')
}

export function installXrayClient(options: ClientOptions): () => void {
  const win = window
  const defaultDelay = options.delay ?? 200
  const settleCap = options.settleCap ?? DEFAULT_SETTLE_CAP
  // Plugin-level Collect limits (may be partial / all undefined).
  const baseCollect = options.collect ?? {}
  // Resolve the effective limits for one capture: a site's per-Skeleton limits
  // override the plugin's, which override the hardcoded defaults; `maxNodes` derives
  // from the resolved breadth × depth (¼ fill) unless set explicitly at either level.
  // An explicit `maxNodes` is never re-derived, so raise it too if you widen breadth
  // past the derived cap (else the wider capture still trips the `nodes` axis).
  const resolveCollect = (site?: CollectLimits): Required<CollectLimits> => {
    const maxDepth = site?.maxDepth ?? baseCollect.maxDepth ?? DEFAULT_MAX_DEPTH
    const maxBreadth = site?.maxBreadth ?? baseCollect.maxBreadth ?? DEFAULT_MAX_BREADTH
    const maxNodes = site?.maxNodes ?? baseCollect.maxNodes ?? deriveMaxNodes(maxBreadth, maxDepth)
    return { maxNodes, maxBreadth, maxDepth }
  }
  const sites = new Set<Site>()
  const matchMediaQueries = new Set<string>()

  // Stale-capture generation guard (ADR 0025; ADR 0022 §4). A capture reads the
  // live viewport (innerWidth, computed styles) AFTER its
  // settle delay. If the emulated width changed, the client was uninstalled, or
  // the site was disposed WHILE that capture was settling, its data is now stale
  // and must NOT be used: it would file one width's geometry under another
  // width's View, or write after teardown. The token bumps on each of those
  // events; a capture snapshots it before settling, measures into a LOCAL 1-View
  // IR, and re-checks the token — discarding the View (never splicing it into the
  // shared session bundle, which would corrupt the whole Plate's projection)
  // when the token moved underneath it (`captureLocalView`). Site disposal already
  // has `site.disposed`; this adds the width/uninstall cases.
  let captureGeneration = 0

  // True while a capture-all sweep is collecting Views. A FORCED capture during a
  // sweep splices its (guarded) View into the site's per-session `PlateIR` instead
  // of posting immediately; the whole bundle posts ONCE at the end of the sweep.
  let sweeping = false

  // Freshest plate per name, hot-swapped in place when a capture lands (the
  // plugin sends it over a custom HMR event). `<Skeleton>` reads through this
  // store so the site re-renders without remounting — the alternative,
  // reloading the plate module, remounts the capture boundary and re-fires the
  // capture, an infinite capture→reload loop.
  const livePlates = new Map<string, Plate>()
  const plateSerialized = new Map<string, string>()
  const plateListeners = new Map<string, Set<() => void>>()
  const plates: PlateStore = {
    get: (name) => livePlates.get(name),
    subscribe: (name, onChange) => {
      let set = plateListeners.get(name)
      if (!set) {
        set = new Set()
        plateListeners.set(name, set)
      }
      set.add(onChange)
      return () => set.delete(onChange)
    },
    // Seed an imported child plate (from a parent's ref graph) if unseen, so a
    // stitch resolves before the child is re-captured and survives a parent
    // hot-swap (which pushes a refs-less plate). No notify and no overwrite: the
    // seeded value equals what subscribers already read as their fallback, and
    // a real capture must always win.
    seed: (name, plate) => {
      if (livePlates.has(name)) return
      livePlates.set(name, plate)
      plateSerialized.set(name, JSON.stringify(plate))
    },
  }
  const updatePlate = (name: string, plate: Plate): boolean => {
    // Dedupe identical updates: the POST handler and the plates-dir watcher
    // both announce a write, and an unchanged plate shouldn't re-render anyone.
    // Returns whether the plate actually CHANGED — the Blink rides this so
    // it fires only when a (re)capture replaces the stored result with a different one.
    const json = JSON.stringify(plate)
    if (plateSerialized.get(name) === json) return false
    plateSerialized.set(name, json)
    livePlates.set(name, plate)
    for (const cb of plateListeners.get(name) ?? []) cb()
    return true
  }

  // Record every media query the app evaluates — JS breakpoints the CSSOM
  // can't reveal (ADR 0004). Installed before the app boots (plugin-injected).
  const nativeMatchMedia = win.matchMedia.bind(win)
  win.matchMedia = (query: string) => {
    matchMediaQueries.add(query)
    return nativeMatchMedia(query)
  }

  // Sticky per-tab toggles. `lightbox` flips every <Skeleton> to its
  // skeleton; `captureEnabled` gates whether browsing re-captures plates at all;
  // `replayEnabled` (ADR 0015) flips Fixture substitution in front of the render
  // prop. The replay BOOT state is `options.replay !== false`, but the per-mode
  // policy (`prefer` vs `missing-only`) is carried in `replayMode` below — the
  // toggle is the coarse on/off the HUD owns per tab, mirroring `capture`.
  const lightbox = createToggleStore(win, LIGHTBOX_KEY, LIGHTBOX_PARAM, false)
  // Default OFF: capturing is explicit opt-in (the HUD/`?xray-capture` turns it on),
  // so normal browsing never accumulates and an HMR/close can't drop an unsaved
  // session. Matches the plugin's own `capture ?? false` default; a direct caller
  // that wants capture-on-boot passes `capture: true`.
  const captureEnabled = createToggleStore(
    win,
    CAPTURE_KEY,
    CAPTURE_PARAM,
    options.capture ?? false,
  )
  // Replay is on at boot only when a non-false mode was configured; absent or
  // `false` defaults the toggle off (the HUD flips it on per tab).
  const replayBoot = options.replay === 'prefer' || options.replay === 'missing-only'
  const replayEnabled = createToggleStore(win, REPLAY_KEY, REPLAY_PARAM, replayBoot)
  // The replay POLICY: `missing-only` falls back to the Fixture only when live
  // `data` is nullish (`missing ≡ nullish`, ADR 0015), otherwise `prefer` (always
  // use the Fixture). Boot `replay === false` disables substitution via the
  // toggle above, so the mode here only matters once the toggle is on; default to
  // `prefer` in that case.
  const replayMode: 'prefer' | 'missing-only' =
    options.replay === 'missing-only' ? 'missing-only' : 'prefer'
  const recordMode = options.record ?? 'manual'

  // Several <Skeleton> of the same plate can be mounted at once (e.g. one
  // ContentCards per offering). Only one may WRITE the plate or they race and
  // overwrite each other's file, last-settled winning non-deterministically.
  // The writer is the first in document order — deterministic across reloads,
  // and usually the above-the-fold, most-representative instance. The rest
  // still render the plate; they just don't capture it.
  const isPrimaryForName = (site: Site): boolean => {
    for (const other of sites) {
      if (other === site || other.disposed || other.name !== site.name || !other.el.isConnected) {
        continue
      }
      // eslint-disable-next-line no-bitwise -- compareDocumentPosition is a bitmask
      if ((site.el.compareDocumentPosition(other.el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0) {
        return false // `other` precedes this site in the document — it's the writer
      }
    }
    return true
  }

  /**
   * Measure one View into a LOCAL, fresh 1-View `PlateIR` (no shared bundle) and return it only if
   * the generation guard still holds AFTER the settle (the generation guard, ADR 0025; ADR 0022
   * §4). Because `captureView(roots, plate)` MUTATES the passed bundle in place
   * (`plate.views.push`), a stale capture appended to a SHARED session PlateIR would corrupt the
   * whole Plate's projection (one width's geometry under another's island/gate), and post-hoc
   * rollback is impossible. So the capture goes into a local bundle FIRST, the guard is re-checked,
   * and only the caller splices the survivor into the session bundle. Returns the local View on
   * success, or `undefined` when the guard moved / the capture was refused / the site was torn down
   * — the caller then DISCARDS it (never appends).
   *
   * `generation` is the token snapshotted by the caller BEFORE the settle; a
   * width-change/disposal/uninstall mid-settle moves `captureGeneration` and this returns
   * undefined. A `CaptureTooLargeError` marks the site and warns. Any other failure warns and
   * returns undefined.
   */
  const captureLocalView = async (site: Site, generation: number): Promise<ViewIR | undefined> => {
    await settle(site.el, site.delay, settleCap, site.mode)
    // Re-check primacy AND the stale-guard: during the settle delay an earlier-in-DOM
    // twin may have become the writer, or the emulated width may have changed.
    if (
      generation !== captureGeneration ||
      site.disposed ||
      site.tooLarge ||
      !site.el.isConnected ||
      !isPrimaryForName(site)
    ) {
      return undefined
    }
    const roots = rootsFor(site)
    if (roots.length === 0) return undefined
    let local: PlateIR
    try {
      // A MANUAL root IS this plate's own boundary, so the stitch guard is skipped
      // for it (it captures its own box rather than stitching to itself). An AUTO
      // root is a wrapper child whose boundary marker, if any, is a NESTED
      // `<Skeleton>` that MUST stitch — so the guard runs (ADR 0006/0014).
      // No `plate` arg → a FRESH local 1-View IR; the splice into a session bundle
      // (if any) is the caller's, gated on the re-check below.
      local = captureView(roots, {
        collect: resolveCollect(site.collect),
        walker: site.walker,
        captureRootIsBoundary: site.mode === 'manual',
      })
    } catch (error) {
      if (error instanceof CaptureTooLargeError) {
        // Give up on this site and stop re-attempting on resize/re-settle —
        // re-walking a huge subtree every time is itself the perf problem. The
        // oversized warning is the same vocabulary as the in-band diagnostics:
        // build a `too-large` diagnostic from the error's code and let the
        // shared formatter render it (diagnostics.ts), so browser and server
        // text never drift.
        site.tooLarge = true
        reportDiagnostics(site.name, [
          makeDiagnostic(error.code, {
            detail:
              `${error.axis} ${error.size[error.axis]} over the ${error.axis} limit ${error.max} ` +
              `(nodes ${error.size.nodes}, breadth ${error.size.breadth}, depth ${error.size.depth})`,
          }),
        ])
        return undefined
      }
      console.warn('[xray] capture failed for', site.name, error)
      return undefined
    }
    const view = local.views[0]
    if (!view) return undefined
    // Surface this View's dev-only capture diagnostics to the browser console.
    // They ride to the server in the POST envelope's SIBLING `diagnostics` field,
    // never into the StoredPlate — so the committed plate stays byte-identical to
    // a no-diagnostics capture (ADR 0008). The client logs them; it never persists.
    reportDiagnostics(site.name, view.diagnostics)
    // RE-CHECK the generation guard AFTER measuring: `captureView` is synchronous
    // (the only async point was the settle above, already guarded), so this is
    // belt-and-suspenders — but it is the gate that lets a sweep DISCARD a View
    // captured at a now-stale width rather than splice it into the shared bundle.
    if (generation !== captureGeneration || site.disposed) return undefined
    return view
  }

  // ── Manual capture session (the Capture toggle) ──────────────────────────────
  // The Capture toggle is a SESSION switch: while ON, browse captures (navigation,
  // resize, interaction) ACCUMULATE here — keyed by plate NAME so a buffer survives the
  // site unmounting as you navigate — and nothing is written to disk until you toggle
  // OFF (`finalizeSession`). The extension capture-all sweep is a separate path (it
  // owns `site.sessionPlate` and posts at `finalizeSessionPlate`).
  const sessionBuffers = new Map<string, PlateIR>()

  // Breakpoints for a session buffer: each View's pre-Distil seed unioned with the
  // JS matchMedia thresholds (derived RAW so a distilled View never loses a boundary).
  const sessionBreakpoints = (buf: PlateIR): number[] =>
    [
      ...new Set([
        ...buf.views.flatMap((v) => v.bpSeed ?? []),
        ...deriveBreakpoints([], [...matchMediaQueries]),
      ]),
    ].toSorted((a, b) => a - b)

  // Project a session buffer to a StoredPlate: collapse to one View per breakpoint
  // band (the chosen dedup granularity — the latest capture in a band wins), then run
  // the in-browser Serialize. The buffered bundles are ALREADY distilled (once, at
  // capture), so this only projects; it never re-runs the passes.
  const projectSessionBuffer = (buf: PlateIR): StoredPlate | undefined => {
    if (buf.views.length === 0) return undefined
    const breakpoints = sessionBreakpoints(buf)
    const perBand = new Map<number, ViewIR>()
    for (const view of buf.views) perBand.set(viewSpanFor(view.width, breakpoints).min ?? 0, view)
    const views = [...perBand.values()].toSorted((a, b) => a.width - b.width)
    return serializePlateIR({ name: buf.name, views, breakpoints })
  }

  // Live preview: hot-swap the in-memory plate so a shown skeleton (Light Box, or a
  // still-loading site) reflects the View just recorded. No POST — disk waits for stop.
  // Returns whether the projection CHANGED, so the caller can fire the Blink
  // only when this (re)capture actually replaced the stored result with a different one.
  //
  // Two-artifact contract (ADR 0026): `serializePlate` returns the
  // TREE only, so this preview cannot carry inline css into the live store by
  // construction — a store plate with embedded css reverting a mounted
  // `<Skeleton>` to inline-`<style>` rendering alongside the page's `.css`
  // module is structurally impossible.
  // KNOWN LIMITATION, mid-session only: the page's `.css` virtual
  // module still serves the last COMMITTED css until the session stops
  // (stop → POST → write → CSS-HMR invalidate), so a preview pairs the fresh
  // tree with the stale committed rules until then; BASE_CSS keeps the bones
  // painted either way, and stop reconciles both artifacts.
  const previewSession = (buf: PlateIR): boolean => {
    const stored = projectSessionBuffer(buf)
    if (!stored) return false
    return updatePlate(buf.name, serializePlate(stored))
  }

  // Stop: write each recorded plate to disk ONCE (the session's only disk write), then
  // clear. Replace semantics — the Views you recorded become the plate.
  const finalizeSession = async (): Promise<void> => {
    // Snapshot + clear up front so a straggler capture can't mutate a buffer mid-write;
    // a FAILED write re-inserts its buffer so the buffered captures survive in memory for a
    // retry (a later stop, or teardown) rather than being lost to a single warn.
    const entries = [...sessionBuffers]
    sessionBuffers.clear()
    await Promise.all(
      entries.map(async ([name, buf]) => {
        const stored = projectSessionBuffer(buf)
        if (!stored) return
        const diagnostics = buf.views.flatMap((v) => v.diagnostics ?? [])
        const envelope: CaptureEnvelope = {
          plate: stored,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        }
        try {
          await options.sink(envelope)
        } catch (error) {
          if (!sessionBuffers.has(name)) sessionBuffers.set(name, buf)
          console.warn(
            `[xray] capture-session write failed for "${name}" — kept in memory; retried when you next start a session`,
            error,
          )
        }
      }),
    )
  }

  // ONE settle+measure+(splice|accumulate) for a site. `force` bypasses the browse-time
  // capture toggle (used by the sweep, which captures regardless of the toggle). The
  // sweep accumulates Views into `site.sessionPlate` here (no POST) and the single
  // per-session POST is awaited in `finalizeSessionPlate`; a browse capture accumulates
  // into the session buffer (no POST) and is written at stop in `finalizeSession`.
  // Coalescing of overlapping triggers lives in `scheduleCapture`; this runs the actual
  // work and is never invoked twice in parallel for one site.
  const runCapture = async (site: Site, force: boolean) => {
    // During a capture-all sweep the sweep OWNS capture: it emulates each width and
    // captures it with a forced, awaited pass. A non-forced (browse) capture here is
    // a stray — almost always one the sweep's own emulated resize spawned via
    // `onResize` — and running it would race the sweep's awaited captures, splicing a
    // duplicate or mid-transition View into the session bundle (or churning the
    // generation guard). Drop it; the sweep already covers this site at every width.
    if ((!force && (!captureEnabled.get() || sweeping)) || site.tooLarge || !isPrimaryForName(site))
      return
    // Snapshot the generation BEFORE settling: any width-change/disposal/uninstall
    // that lands during the settle moves it, and the capture is discarded rather
    // than written/spliced under the stale viewport (the generation guard).
    const generation = captureGeneration
    const view = await captureLocalView(site, generation)
    if (!view) return
    // SWEEP accumulation: while a capture-all sweep is collecting, a FORCED capture
    // splices the survivor into the per-session shared bundle (lazily created so a
    // site mounted mid-sweep still accumulates). ONLY reached when the guard still
    // held in `captureLocalView`, so a stale (width-changed/disposed) View was
    // already discarded and never corrupts the bundle. No POST here — the whole
    // bundle posts once in `finalizeSessionPlate` at the end of the sweep.
    if (sweeping && force) {
      const session = (site.sessionPlate ??= { name: site.name, views: [], breakpoints: [] })
      session.views.push(view)
      return
    }
    // SESSION: the Capture toggle is a capture SESSION, not a per-capture overwrite.
    // Accumulate this View into the name-keyed buffer (name-keyed so it survives the
    // site unmounting as you navigate), and DEFER the disk write to stop (toggle off →
    // `finalizeSession`). Seed the breakpoint thresholds from the RAW rules BEFORE
    // distilling (a post-Distil derivation could lose a dropped node's `@media`
    // boundary), then distil this View once so projection stays a pure Serialize.
    // Dedup by exact width here (latest wins); the per-band collapse happens at
    // projection. `previewSession` hot-swaps the in-memory plate so a shown skeleton
    // (Light Box / still-loading site) reflects the View just recorded — no POST.
    // Re-check the toggle AFTER the settle — the one invalidation the generation guard
    // does not cover. If the session was stopped while this View settled, the session was
    // already finalized and the buffer cleared; accumulating now would orphan this View
    // in a fresh buffer nothing flushes. Drop it (toggling on starts a new session).
    if (!captureEnabled.get()) return
    view.bpSeed = deriveBreakpoints(emit(view.bundle).rules, [])
    distilPlate({ name: site.name, views: [view], breakpoints: [] })
    let buf = sessionBuffers.get(site.name)
    if (!buf) {
      buf = { name: site.name, views: [], breakpoints: [] }
      sessionBuffers.set(site.name, buf)
    }
    buf.views = buf.views.filter((v) => v.width !== view.width)
    buf.views.push(view)
    // Blink ONLY when this (re)capture changed the recorded result — feedback that
    // a resize/navigation recorded something NEW, not a no-op re-capture.
    if (previewSession(buf)) blinkCapture(site.el)
  }

  /**
   * Project a per-site `PlateIR` to the structured `StoredPlate` IN THE BROWSER (the ADR 0022
   * Serialize) and hand the envelope to the sink. Derives the breakpoint union ONCE over every
   * View's rules + the recorded matchMedia queries, runs the Distil passes once over the whole
   * bundle, then `serializePlateIR`. Dedupes per-PLATE by the serialized StoredPlate string. ALWAYS
   * catches so neither mode leaks an unhandled rejection; on failure it clears the dedupe so a
   * retry re-sends and, ONLY when `awaitSink`, rethrows so capture-all still fails loudly. The
   * Blink runs only AFTER a successful send.
   */
  const sendPlate = async (site: Site, plate: PlateIR, awaitSink: boolean): Promise<void> => {
    if (plate.views.length === 0) return
    plate.name = site.name
    // Breakpoint union over EVERY View's rules + matchMedia, once per session (a
    // multi-View sweep covers all widths in one bundle, so the union is the whole
    // Plate's breakpoint set).
    // Must run BEFORE `serializePlateIR`: its multi-View gate ranges each island via
    // `viewSpanFor(width, plate.breakpoints)`. Derive from the UN-distilled bundle on
    // purpose: the Distil passes (Crop/Superset/glyph-fold) `dropped` nodes, and
    // `emit` skips a dropped node's rules — so a post-Distil derivation could LOSE
    // a breakpoint a surviving sibling still needs. Pre-Distil is a superset (a
    // threshold from a dropped node's `@media` may linger), which only ever adds a
    // redundant — never a missing — gate boundary; the gate stays gapless either way.
    const rules = plate.views.flatMap((v) => emit(v.bundle).rules)
    plate.breakpoints = deriveBreakpoints(rules, [...matchMediaQueries])
    distilPlate(plate)
    const stored = serializePlateIR(plate)
    // Gather the transient per-View diagnostics for the server to log (never stored).
    const diagnostics = plate.views.flatMap((v) => v.diagnostics ?? [])
    const envelope: CaptureEnvelope = {
      plate: stored,
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    }
    const body = JSON.stringify(envelope)
    // Per-PLATE dedupe: an identical re-projection skips the POST.
    if (site.lastSent === body) return
    site.lastSent = body
    try {
      // Capture-all awaits the sink (a 2xx from `/__xray`, not merely dispatched)
      // for backpressure; browse-time does not await but is still wrapped so a
      // rejection is handled here rather than escaping unhandled.
      await options.sink(envelope)
    } catch (error) {
      // Clear the dedupe so a later capture re-sends the same StoredPlate (rather
      // than being deduped away as already sent).
      site.lastSent = undefined
      if (awaitSink) throw error
      console.warn('[xray] capture send failed for', site.name, error)
      return
    }
    // The Blink over the just-captured element.
    blinkCapture(site.el)
  }

  /**
   * Finalize a site's accumulated sweep `PlateIR` and POST it ONCE (awaited, the backpressure
   * point). Clears `site.sessionPlate` first so any straggler capture for the site falls back to
   * the browse path rather than mutating the bundle mid-flight. A session that captured no
   * surviving View posts nothing.
   */
  const finalizeSessionPlate = async (site: Site): Promise<void> => {
    const session = site.sessionPlate
    site.sessionPlate = undefined
    if (!session || session.views.length === 0) return
    await sendPlate(site, session, true)
  }

  // Coalescing scheduler (ADR 0025). At most one capture
  // settles/runs per site at a time. A trigger arriving while one is in flight
  // does NOT start a parallel settle+walk; it marks the site dirty and merges in
  // the STRONGEST requested flags, so exactly one follow-up runs afterward with
  // the latest DOM/viewport state. The returned promise resolves once the site is
  // quiescent (the in-flight capture AND any follow-up it spawns have finished), so an
  // awaiting caller (capture-all) keeps full backpressure: its await does not resolve
  // until the forced follow-up has actually settled and been spliced into the session
  // bundle. (The sink-awaited write happens once, later, in `finalizeSessionPlate`.)
  const scheduleCapture = (site: Site, force = false): Promise<void> => {
    if (site.inflight) {
      // A capture is already running for this site — coalesce. Keep the strongest
      // requirement so a forced capture-all trigger is never downgraded by an
      // overlapping browse trigger.
      site.dirty = true
      site.dirtyForce = site.dirtyForce || force
      return site.inflight
    }
    // Run the requested capture, then DRAIN any triggers that coalesced while it
    // ran — to a fixpoint. The drain loop owns the `inflight` slot: it clears the
    // slot ONLY when no `dirty` request remains, re-reading `dirty` SYNCHRONOUSLY
    // right after the clear (no await between, so no coalescing trigger can
    // interleave there). See the stop-check below for the race this closes.
    const loop = async (initialForce: boolean): Promise<void> => {
      let wantForce = initialForce
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- captures are sequential per site by design
        await runCapture(site, wantForce)
        // Decide to stop draining AND clear `inflight` in the SAME synchronous turn
        // as the `dirty` check (no await between), so a trigger coalescing against
        // `inflight` lands in exactly one of two safe places: BEFORE this check (it
        // set `dirty`, so the loop iterates again with the merged flags) or AFTER
        // the clear (it sees a falsy slot, so `scheduleCapture` starts a fresh loop).
        // That atomicity closes the `.finally` microtask-gap race a deferred clear
        // opens — where a trigger coalesces against an `inflight` whose loop has
        // already stopped draining, silently dropping the follow-up (e.g. a
        // capture-all width's forced trigger no-oping into a just-finished browse
        // pass, posting an empty session bundle).
        if (!site.dirty) {
          site.inflight = undefined
          return
        }
        // A trigger coalesced while the capture ran — consume the STRONGEST merged
        // flag and run exactly one more pass, keeping the same `inflight` promise
        // for any awaiting caller.
        site.dirty = false
        wantForce = site.dirtyForce
        site.dirtyForce = false
      }
    }
    const promise: Promise<void> = loop(force)
    site.inflight = promise
    return promise
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    // Ignore resizes the capture-all sweep causes: it emulates each width (firing
    // this handler) and captures it deliberately, so a browse capture here would
    // only race the sweep. `runCapture` also drops a stray browse capture while
    // sweeping (belt), but bailing here avoids even scheduling the no-op churn —
    // and cancels a pending debounce that would otherwise fire mid-sweep.
    if (sweeping) {
      clearTimeout(resizeTimer)
      return
    }
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      // A genuine viewport resize (not the sweep's emulation). Stacked resizes
      // coalesce in the scheduler (one follow-up at the latest width), so no
      // generation bump is needed: a browse capture settling at the old width simply
      // re-dedupes or is superseded by the follow-up. The generation guard is
      // reserved for the sweep's EMULATED width changes (see captureAllViews).
      if (sweeping) return
      for (const site of sites) void scheduleCapture(site)
    }, RESIZE_DEBOUNCE)
  }
  win.addEventListener('resize', onResize)

  // The Capture toggle is the session switch. Turning it ON starts a fresh session
  // (clear any prior buffer) and captures everything currently mounted — flip it on and
  // the on-screen skeletons start filling in, no reload. Turning it OFF STOPS the
  // session and writes every accumulated plate to disk once (`finalizeSession`).
  // While on, captures accumulate + live-preview (runCapture's record branch); nothing
  // hits disk until you stop.
  let sessionOn = captureEnabled.get()
  const unsubscribeCapture = captureEnabled.subscribe(() => {
    const on = captureEnabled.get()
    if (on === sessionOn) return
    sessionOn = on
    if (on) {
      // Start a fresh session. `finalizeSession` snapshots + clears the map up front,
      // so this also RETRIES any buffer a prior stop left behind on a failed write
      // (normally the map is empty here, making it a no-op); fresh captures then
      // populate the cleared map.
      void finalizeSession()
      for (const site of sites) void scheduleCapture(site)
    } else {
      void finalizeSession()
    }
  })

  // Capture-all-views (ADR 0010): the page is the controller. It drives a thin
  // browser extension over window.postMessage (relayed by the extension's content
  // script) to emulate each target width, captures every mounted site at that
  // width with a real settle, then resets. The extension only runs
  // chrome.debugger emulate/reset — all orchestration lives here.
  const extAcks = new Map<number, (res: { ok: boolean; error?: string }) => void>()
  let nextExtReqId = 1
  const onExtMessage = (event: MessageEvent) => {
    if (event.source !== win) return
    const data = event.data
    if (isExtensionAck(data)) {
      extAcks.get(data.id)?.({ ok: data.ok ?? false, error: data.error })
      extAcks.delete(data.id)
    }
  }
  win.addEventListener('message', onExtMessage)
  const extCommand = (
    kind: 'emulate' | 'reset',
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const id = nextExtReqId++
    return new Promise((resolve, reject) => {
      extAcks.set(id, (res) =>
        res.ok ? resolve() : reject(new Error(res.error ?? 'xray extension error')),
      )
      win.postMessage({ source: 'xray', kind, id, ...extra }, '*')
      setTimeout(() => {
        if (extAcks.delete(id)) {
          reject(
            new Error('xray extension did not respond (installed? DevTools closed on this tab?)'),
          )
        }
      }, 10_000)
    })
  }
  // Per-plate coverage from the committed plate files (not the session), fed by
  // the bootstrap: an initial fetch plus each xray:plate event. Drives the HUD's
  // band display and the capture-all width derivation.
  const coverageMap = new Map<string, PlateCoverage>()
  const coverageListeners = new Set<() => void>()
  const coverage: CoverageStore = {
    get: () => coverageMap,
    set: (name, plateCoverage) => {
      coverageMap.set(name, plateCoverage)
      for (const cb of coverageListeners) cb()
    },
    subscribe: (cb) => {
      coverageListeners.add(cb)
      return () => coverageListeners.delete(cb)
    },
  }

  // Fixtures (ADR 0015). Two registries keyed by plate name:
  // - `liveData`: the live render-INPUT `data` of the MOUNTED Skeletons for a name
  //   (`register`), held as a stack of entries so duplicates (several Skeletons of
  //   the same plate) and unmount lifecycle are tracked. Record reads
  //   the LAST still-mounted entry, so an unmounted instance never shadows a
  //   mounted one and `recordAll`/`record` never read an unmounted site. `register`
  //   returns a disposer the dev adapter runs on unmount, which removes exactly
  //   that instance's entry. The store keys are document-order-agnostic
  //   (last-mounted-wins) — capture PRIMACY is document-order (`isPrimaryForName`),
  //   so the recorded instance can differ from the capture writer when twins carry
  //   different `data`; see the note on `record` (the guaranteed property is "no
  //   stale unmounted data", which the disposer gives). Only render-prop Skeletons
  //   have `data`; plain-children Skeletons never `register`.
  // - `recorded`: the DECODED Fixture `data` for a plate — seeded from disk
  //   (devalue-parsed) and updated on a successful Record. Replay reads from here;
  //   `has`/`read` report it; the HUD coverage marker keys off `has`.
  // The on-disk sidecar and the wire carry the opaque devalue STRING; only this
  // store holds decoded values, and devalue is invoked only here (dev-only).
  const liveData = new Map<string, { data: unknown }[]>()
  const recorded = new Map<string, { data: unknown }>()
  const fixtureListeners = new Set<() => void>()
  const notifyFixtures = () => {
    for (const cb of fixtureListeners) cb()
  }
  const fixtures: FixtureStore = {
    register: (name, data) => {
      // Push this instance's entry; the disposer removes exactly this entry (by
      // identity) on unmount, so an unmounted Skeleton's `data` never lingers and a
      // remaining mounted twin's entry stays. Last entry = most-recently-mounted.
      const entry = { data }
      const stack = liveData.get(name)
      if (stack) stack.push(entry)
      else liveData.set(name, [entry])
      return () => {
        const current = liveData.get(name)
        if (!current) return
        const i = current.indexOf(entry)
        if (i !== -1) current.splice(i, 1)
        if (current.length === 0) liveData.delete(name)
      }
    },
    has: (name) => recorded.has(name),
    read: (name) => recorded.get(name),
    record: async (name) => {
      const stack = liveData.get(name)
      // Read the LAST still-mounted entry. An unmounted instance has removed its
      // own entry via the disposer, so this never records stale/unmounted data. An
      // empty/absent stack means no live `data` is registered: a plain-children
      // <Skeleton> has none, every instance unmounted, or the site never reached
      // `loading=false`. Fail loudly (ADR 0015).
      const live = stack?.at(-1)
      if (!live) {
        throw new Error(
          `[xray] cannot record fixture for "${name}": no render-prop \`data\` is in scope. ` +
            'Only render-prop <Skeleton data={…}> sites participate in fixtures.',
        )
      }
      // devalue throws loudly on the genuinely unrecordable (functions, class
      // instances, Promises, DOM nodes); let it propagate so Record fails loudly.
      const encoded = devalueStringify(live.data)
      await options.recordFixtureSink?.({ name, data: encoded })
      // Confirmed written: decode our own freshly-encoded string so `recorded`
      // holds exactly what a reload would replay (round-trips Map/Set/Date/etc.).
      recorded.set(name, { data: devalueParse(encoded) })
      notifyFixtures()
    },
    recordAll: async () => {
      // Record every plate name with a still-mounted render-prop Skeleton in one
      // click — only names whose stack is non-empty, so an unmounted site can never
      // be recorded. A single rejected write (unrecordable data, a failed POST)
      // propagates so the HUD surfaces it; the others that already resolved stay
      // recorded.
      await Promise.all([...liveData.keys()].map((name) => fixtures.record(name)))
    },
    seed: (encoded) => {
      let changed = false
      for (const [name, str] of Object.entries(encoded)) {
        // Do not clobber a Fixture recorded THIS session (it is fresher than disk).
        if (recorded.has(name)) continue
        try {
          recorded.set(name, { data: devalueParse(str) })
          changed = true
        } catch {
          // A hand-broken sidecar — skip it rather than break the seed.
        }
      }
      if (changed) notifyFixtures()
    },
    subscribe: (cb) => {
      fixtureListeners.add(cb)
      return () => fixtureListeners.delete(cb)
    },
  }

  // Target widths for a sweep: the union of the mounted plates' detected
  // breakpoints (from coverage) plus any JS (matchMedia) thresholds. Visit a
  // mobile-ish anchor inside the first band, then each threshold — one width per
  // band the mounted skeletons actually care about.
  const sweepWidths = (): number[] => {
    // Width discovery is IN-SESSION, NOT from the disk plate. The breakpoints
    // come from the matchMedia spy (JS thresholds) and the author CSS `@media`
    // thresholds carried in the Views captured SO FAR this sweep. The per-Plate
    // MULTI-VIEW bundle built in ONE session is the source of truth; the disk
    // plate is a derived, geometry-stripped artifact written only at the end, so
    // reading widths back from it would be stale and backwards. Pass 0 captures
    // the initial width's View, whose lifted `@media` rules reveal every band; the
    // fixpoint then visits them (a lazy component mounting at an emulated width
    // can still reveal a NEW breakpoint on a later pass). A CSS-only breakpoint
    // fires no `matchMedia`, so without the captured-rule source the narrower
    // bands would never be swept and only the initial-width View would exist,
    // rendering at EVERY width (the off-range collapse: the widest
    // layout shown below 1200px).
    const set = new Set<number>(deriveBreakpoints([], [...matchMediaQueries]))
    for (const site of sites) {
      for (const view of site.sessionPlate?.views ?? []) {
        for (const bp of deriveBreakpoints(emit(view.bundle).rules, [...matchMediaQueries])) {
          set.add(bp)
        }
      }
    }
    const breakpoints = [...set].toSorted((a, b) => a - b)
    const min = breakpoints[0]
    const first = min === undefined ? 390 : Math.max(1, Math.min(390, min - 1))
    return [...new Set([first, ...breakpoints])].toSorted((a, b) => a - b)
  }

  // Upper bound on sweep passes. The fixpoint normally terminates in one or two
  // passes (a second pass only happens when a width-gated lazy component mounts
  // at an emulated width and reveals a NEW breakpoint). This guard exists only so
  // a pathological app that keeps producing fresh breakpoints — a bug, or a
  // resize-driven media query that never settles — fails loudly to the HUD
  // instead of looping forever.
  const MAX_SWEEP_PASSES = 8

  const captureAllViews = async (): Promise<void> => {
    // Build ONE PlateIR per mounted site across the whole sweep (ADR 0022 §2): each
    // emulated width appends a guarded View to the site's session bundle, and after
    // every width is visited each site's bundle is projected to ONE StoredPlate and
    // posted once (awaited — the backpressure point). Visit each target width once.
    // After a pass, width-gated lazy components that just mounted may have run new
    // matchMedia() calls (the spy records them) or had new breakpoints surfaced into
    // the coverage store by refreshCoverage, so the next sweepWidths() can yield MORE
    // widths. Repeat to a fixpoint: keep going while a pass discovers an unvisited
    // width, stop once a full recompute adds nothing new.
    const visited = new Set<number>()
    sweeping = true
    // Start each currently-mounted site with a fresh session bundle so a prior
    // sweep's Views never leak in (a site mounted mid-sweep gets one lazily).
    for (const site of sites) site.sessionPlate = { name: site.name, views: [], breakpoints: [] }
    try {
      for (let pass = 0; ; pass++) {
        const pending = sweepWidths().filter((width) => !visited.has(width))
        if (pending.length === 0) break
        if (pass >= MAX_SWEEP_PASSES) {
          // Fail loudly rather than hang or silently truncate: the sweep keeps
          // turning up new widths, which means the page never reaches a stable
          // set of breakpoints. The HUD surfaces this rejection as a failure.
          throw new Error(
            `xray capture-all did not converge after ${MAX_SWEEP_PASSES} passes ` +
              `(still discovering widths: ${pending.join(', ')})`,
          )
        }
        for (const width of pending) {
          visited.add(width)
          // The emulated width is about to change — bump the generation so any
          // capture still settling at the PREVIOUS width DISCARDS its local View
          // (rather than splicing one width's geometry into the shared bundle under
          // another's island/gate — ADR 0022 §4). The width-change is the canonical
          // invalidation event.
          captureGeneration++
          // Sequential by necessity: one shared viewport — emulate, capture, next.
          // eslint-disable-next-line no-await-in-loop
          await extCommand('emulate', { width, height: 2400, mobile: width < 600 })
          // Force-capture every site into its session bundle (no per-width POST).
          // scheduleCapture coalesces with any in-flight browse capture and resolves
          // only once the forced follow-up has settled and spliced its View, so the
          // next emulate never races an in-flight settle.
          // eslint-disable-next-line no-await-in-loop
          await Promise.all([...sites].map((site) => scheduleCapture(site, true)))
        }
        // Pull on-disk coverage back into the store BEFORE the next recompute so
        // sweepWidths() sees the latest breakpoints deterministically. NOTE the
        // write happens at the END of the sweep, so a fixpoint discovers new
        // widths chiefly from this pass's captured matchMedia queries;
        // refreshCoverage stays as the disk-truth re-pull.
        // eslint-disable-next-line no-await-in-loop
        await options.refreshCoverage?.()
      }
      // Sweep visited every width: project each site's accumulated bundle to ONE
      // StoredPlate and POST it once, awaited. This single awaited write per site
      // IS the backpressure — a non-2xx rejects the whole sweep.
      sweeping = false
      await Promise.all([...sites].map((site) => finalizeSessionPlate(site)))
    } finally {
      // Clear any straggler session bundles (e.g. on an early throw) so a later
      // browse capture for the site falls back to the immediate-POST path.
      sweeping = false
      for (const site of sites) site.sessionPlate = undefined
      await extCommand('reset').catch(() => undefined)
    }
  }

  globalThis.__XRAY__ = {
    lightbox,
    capture: captureEnabled,
    plates,
    updatePlate,
    captureAllViews,
    coverage,
    replay: replayEnabled,
    replayMode,
    recordMode,
    fixtures,
    captured: (name, el, opts) => {
      const site: Site = {
        name,
        el,
        delay: opts?.delay ?? defaultDelay,
        // Default 'auto' so an adapter (or test) that omits mode keeps the
        // wrapper-children behavior; the dev adapter passes it explicitly.
        mode: opts?.mode ?? 'auto',
        // The walker rides in on `opts` typed as `unknown` (plate.ts keeps the
        // CaptureHook free of a measure.ts import); narrow it here to the
        // client's `XrayCaptureWalker` for the `captureView` call (ADR 0018).
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the dev adapter only ever passes an XrayCaptureWalker closure here.
        walker: opts?.walker as XrayCaptureWalker | undefined,
        collect: opts?.collect,
        disposed: false,
        tooLarge: false,
        dirty: false,
        dirtyForce: false,
      }
      sites.add(site)
      void scheduleCapture(site)
      return () => {
        site.disposed = true
        sites.delete(site)
        // A capture in-flight for THIS site is stale (the writer is gone):
        // bump the generation so it bails before its sink. The site's
        // own `disposed` flag also stops it, but the bump keeps the disposal in
        // the same invalidation vocabulary as width-change/uninstall.
        captureGeneration++
        // If this site was the writer for its name, the next one in document
        // order takes over — re-attempt its twins (non-primary ones bail at
        // once, before settling).
        for (const other of sites) if (other.name === site.name) void scheduleCapture(other)
      }
    },
  }

  return () => {
    win.matchMedia = nativeMatchMedia
    win.removeEventListener('resize', onResize)
    win.removeEventListener('message', onExtMessage)
    clearTimeout(resizeTimer)
    unsubscribeCapture()
    globalThis.__XRAY__ = undefined
    // Uninstall invalidates every in-flight capture: bump the generation so one
    // still settling bails before its sink, in addition to the
    // `disposed` flag below. Both stop it; the bump unifies the teardown case
    // with the width-change/disposal invalidation story.
    captureGeneration++
    // Mark every site disposed BEFORE clearing the set: a capture already
    // awaiting settle() holds its own site reference, so clearing the set alone
    // wouldn't stop it — it would still pass the post-settle guard and fire the
    // sink/Blink after teardown. The disposed flag makes that guard bail.
    for (const site of sites) site.disposed = true
    sites.clear()
  }
}

/**
 * Surface a capture's dev-only diagnostics as ONE grouped `console.warn` keyed by plate name: a
 * header line, then one formatted line per diagnostic via the shared formatter (diagnostics.ts) —
 * the same text the Vite server prints, so the two never drift. `console.group` collapses the lines
 * under the header, falling back to a single multi-line warn where unavailable. No-op when there
 * are no diagnostics, so a clean capture is silent.
 */
function reportDiagnostics(
  name: string,
  diagnostics: readonly CaptureDiagnostic[] | undefined,
): void {
  if (!diagnostics || diagnostics.length === 0) return
  const header = diagnosticsHeader(name)
  const lines = diagnostics.map((d) => formatDiagnostic(d))
  if (typeof console.group === 'function' && typeof console.groupEnd === 'function') {
    console.group(header)
    for (const line of lines) console.warn(line)
    console.groupEnd()
    return
  }
  console.warn([header, ...lines].join('\n'))
}

const LIGHTBOX_KEY = 'xray:lightbox'
const LIGHTBOX_PARAM = 'xray-lightbox'
const CAPTURE_KEY = 'xray:capture'
const CAPTURE_PARAM = 'xray-capture'
const REPLAY_KEY = 'xray:replay'
const REPLAY_PARAM = 'xray-replay'

/**
 * A sticky boolean toggle: per-tab in sessionStorage, seedable to `true` via `?<param>` in the URL,
 * flipped from the HUD or the console (`__XRAY__.lightbox.set(true)`). A stored value wins over
 * `initial`; the URL param forces `true`.
 */
function createToggleStore(win: Window, key: string, param: string, initial: boolean): ToggleStore {
  let value = initial
  try {
    const stored = win.sessionStorage.getItem(key)
    if (stored !== null) value = stored === '1'
  } catch {
    // storage can be unavailable (sandboxed iframes) — stay in-memory
  }
  if (new URL(win.location.href).searchParams.has(param)) value = true
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      try {
        win.sessionStorage.setItem(key, next ? '1' : '0')
      } catch {
        // in-memory only
      }
      for (const listener of listeners) listener()
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

/**
 * Resolve once the subtree has been quiet (no mutations, no child resizes) for `delay` ms — fonts
 * loaded first. Charts, lazy images and late embeds made single-shot capture non-deterministic in
 * the M1 harness; this is the cure. Hard-capped so a perpetually-animating subtree still captures.
 */
/**
 * Force lazy images in the subtree to load and await their decode, so the walk measures their real
 * boxes. A `loading="lazy"` image below the fold never enters the viewport during capture, so its
 * IntersectionObserver never fires — flip it to eager to trigger the load. Capped: a slow or broken
 * image resolves the race via the timeout instead of blocking the capture.
 */
function awaitImages(root: Element, cap: number): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'))
  if (imgs.length === 0) return Promise.resolve()
  const decoded = imgs.map((img) => {
    if (img.loading === 'lazy') img.loading = 'eager'
    if (typeof img.decode !== 'function') return Promise.resolve()
    // `decode()` resolves once the image is loaded AND decoded; reject (broken
    // src, abort) is benign here — just stop waiting on that one.
    return img.decode().then(
      () => undefined,
      () => undefined,
    )
  })
  return Promise.race([
    Promise.all(decoded).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, cap)
    }),
  ])
}

function settle(
  el: Element,
  delay: number,
  cap: number,
  mode: 'auto' | 'manual' = 'auto',
): Promise<void> {
  const doc = el.ownerDocument
  const fonts = doc.fonts ? doc.fonts.ready : Promise.resolve()
  // Wait for fonts AND images. A lazy or not-yet-decoded image has no honest box
  // until it loads, so the walk measures it wrong and a bone laid over it sees no
  // superset to collapse into (Superset then keeps the overlay instead of dropping
  // it). Bounded by `cap` so a slow/broken image can never stall capture.
  return Promise.all([fonts, awaitImages(el, cap)]).then(
    () =>
      new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        let capTimer: ReturnType<typeof setTimeout>
        const observer = new MutationObserver(bump)
        const resizeObserver =
          typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(bump)

        function done() {
          observer.disconnect()
          resizeObserver?.disconnect()
          clearTimeout(timer)
          clearTimeout(capTimer)
          resolve()
        }
        function bump() {
          clearTimeout(timer)
          timer = setTimeout(done, delay)
        }

        // Watch structure and text arriving, not attributes: JS-driven
        // animations (carousels, count-ups, charts) rewrite style/transform
        // every frame, which both floods this callback and keeps the subtree
        // from ever going quiet. Layout-affecting changes are caught by the
        // ResizeObserver instead.
        observer.observe(el, { subtree: true, childList: true, characterData: true })
        // AUTO: the wrapper is display:contents (no box of its own), so its size
        // is meaningless — watch its kids instead. MANUAL: `el` is the consumer's
        // OWN styled element and IS the captured root, so its own box is what a
        // re-capture must track; observe it directly.
        if (resizeObserver) {
          if (mode === 'manual') resizeObserver.observe(el)
          else for (const child of Array.from(el.children)) resizeObserver.observe(child)
        }
        timer = setTimeout(done, delay)
        capTimer = setTimeout(done, cap)
      }),
  )
}
