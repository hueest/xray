import { parse as devalueParse, stringify as devalueStringify } from 'devalue'
import { deriveBreakpoints, viewSpanFor } from './breakpoints.ts'
import { serializePlate } from './chunk.ts'
import { blinkCapture } from './blink.ts'
import { createHighlighter } from './highlight.ts'
import type {
  CoverageStore,
  ExtensionStore,
  FixtureStore,
  ModeStore,
  MountedPlate,
  Plate,
  PlateCoverage,
  PlateStore,
  SessionSnapshot,
  SessionStore,
  SitesStore,
  StoredPlate,
  ToggleStore,
  XrayModeState,
} from './plate.ts'
import {
  captureView,
  CaptureTooLargeError,
  type CollectLimits,
  type XrayCaptureWalker,
} from './measure.ts'
import { distilPlate } from './measure.ts'
import { serializePlateIR } from './serialize.ts'
import { emit, irFromTree, type PlateIR, type ViewIR } from './ir.ts'
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
   * Fixtures boot state (ADR 0015). `record` is when to write the live `data` into the plate module
   * (`'manual'` — HUD button only, the default; `'first-ready'`; or `'always'`); `replay` is
   * whether to substitute a recorded Fixture for live `data` (`false`, `'prefer'`, or
   * `'missing-only'`). The HUD overrides the replay toggle per tab. Absent ≡ defaults (`'manual'` /
   * `false`).
   */
  record?: 'manual' | 'first-ready' | 'always'
  replay?: false | 'prefer' | 'missing-only'
  /**
   * Where a recorded Fixture's devalue payload is POSTed (the fixture write endpoint). The client
   * owns the devalue stringify; the server renders the plate module's fixture section from the
   * STRUCTURE, never reviving it (ADR 0033/0034). Resolves once the write is server-confirmed,
   * rejects on a non-2xx so the HUD Record button can surface a failed write. Absent ≡ Record is a
   * no-op (the unit tests inject their own).
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

interface ExtensionHello {
  source: 'xray-ext'
  kind: 'hello'
  version?: unknown
  caps?: unknown
}

function isExtensionHello(value: unknown): value is ExtensionHello {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    value.source === 'xray-ext' &&
    'kind' in value &&
    value.kind === 'hello'
  )
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
 * Push `entry` onto the per-name stack; the disposer removes exactly that entry (by identity), so a
 * disposed instance never lingers and a remaining twin's entry stays. Both directions run
 * `changed`.
 */
function registerStackEntry<E>(
  map: Map<string, E[]>,
  name: string,
  entry: E,
  changed: () => void,
): () => void {
  const stack = map.get(name)
  if (stack) stack.push(entry)
  else map.set(name, [entry])
  changed()
  return () => {
    const current = map.get(name)
    if (!current) return
    const i = current.indexOf(entry)
    if (i !== -1) current.splice(i, 1)
    if (current.length === 0) map.delete(name)
    changed()
  }
}

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

  // True while a sweep is visiting widths. Browse captures are dropped while it
  // runs (the sweep owns the one shared viewport and captures deliberately).
  let sweeping = false
  // Disengaging mid-sweep aborts the remaining widths at the next boundary: the
  // stop already wrote the session, so further forced captures would only strand
  // Views in cleared buffers. Reset still posts in the sweep's finally.
  let sweepAbort = false

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
    // Same listener isolation as createNotifier: plate updates fire from the
    // capture path, and a throwing subscriber must not break it.
    for (const cb of plateListeners.get(name) ?? []) {
      try {
        cb()
      } catch (error) {
        console.error('[xray] a plate subscriber threw (ignored):', error)
      }
    }
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

  // Name-scoped mode state (the ModeStore below). The sticky ToggleStores above stay
  // the GLOBAL-scope source of truth (per-tab persistence, `?xray-*` URL seeds, console
  // flips); these sets carry the per-plate scopes, which are deliberately ephemeral.
  // One action at a time: the ModeStore's setters enforce that engaging record blocks
  // Light Box at every scope and vice versa.
  const recordNames = new Set<string>()
  const lightboxNames = new Set<string>()
  /** Whether the active record mode covers this plate name (browse captures gate on it). */
  const recordingCovers = (name: string): boolean => captureEnabled.get() || recordNames.has(name)

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
    // MOUNTED BUT RENDERING NOTHING (ADR 0029): the boundary is on the page and
    // its content rendered null at this width (a component that returns nothing
    // below its breakpoint). That is an observation, not a failure — record an
    // EMPTY View so the band reads as captured emptiness (the skeleton renders
    // the faithful nothing there) instead of a gap no re-capture can fill. The
    // sweep's captured-absence pass covers the UNMOUNTED case; this covers the
    // mounted-empty one. Every post-settle guard above has already passed.
    if (roots.length === 0) {
      return { width: win.innerWidth, bundle: irFromTree({ id: 0, kids: [] }), bpSeed: [] }
    }
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
        notifySites()
        const refusal = [
          makeDiagnostic(error.code, {
            detail:
              `${error.axis} ${error.size[error.axis]} over the ${error.axis} limit ${error.max} ` +
              `(nodes ${error.size.nodes}, breadth ${error.size.breadth}, depth ${error.size.depth})`,
          }),
        ]
        reportDiagnostics(site.name, refusal)
        setDiagnostics(
          site.name,
          refusal.map((d) => formatDiagnostic(d)),
        )
        return undefined
      }
      console.warn('[xray] capture failed for', site.name, error)
      return undefined
    }
    const view = local.views[0]
    if (!view) return undefined
    // Surface this View's dev-only capture diagnostics to the browser console AND
    // the per-plate diagnostics store (the HUD row notes; empty = clean capture).
    // They ride to the server in the POST envelope's SIBLING `diagnostics` field,
    // never into the StoredPlate — so the committed plate stays byte-identical to
    // a no-diagnostics capture (ADR 0008). The client logs them; it never persists.
    reportDiagnostics(site.name, view.diagnostics)
    setDiagnostics(
      site.name,
      (view.diagnostics ?? []).map((d) => formatDiagnostic(d)),
    )
    // RE-CHECK the generation guard AFTER measuring: `captureView` is synchronous
    // (the only async point was the settle above, already guarded), so this is
    // belt-and-suspenders — but it is the gate that lets a sweep DISCARD a View
    // captured at a now-stale width rather than splice it into the shared bundle.
    if (generation !== captureGeneration || site.disposed) return undefined
    return view
  }

  // ── The recording session (ONE accumulate path) ─────────────────────────────
  // Recording is a SESSION: while engaged, every capture — browse (navigation,
  // resize, interaction) AND the extension sweep's forced emulated-width passes —
  // ACCUMULATES here, keyed by plate NAME so a buffer survives the site unmounting
  // as you navigate, and nothing is written to disk until the session (or one
  // name's slice of it) stops. The sweep is an AMPLIFIER of the same session, not
  // a separate path: with the extension connected, engaging record first sweeps
  // every derived width into these buffers, then keeps accumulating as you browse.
  const sessionBuffers = new Map<string, PlateIR>()

  // The session store's mutable snapshot (the HUD ticker/progress source). Views
  // per name mirror the buffers; `save` tracks the LAST stop's write lifecycle;
  // `sweep` is set per emulated width while a sweep pass runs.
  const sessionNotifier = createNotifier()
  let sessionSnapshot: SessionSnapshot = { views: new Map(), save: 'idle', savedCount: 0 }
  const notifySession = (patch: Partial<SessionSnapshot>): void => {
    const views = new Map<string, readonly number[]>()
    for (const [name, buf] of sessionBuffers) {
      views.set(
        name,
        buf.views.map((v) => v.width).toSorted((a, b) => a - b),
      )
    }
    sessionSnapshot = { ...sessionSnapshot, ...patch, views }
    sessionNotifier.notify()
  }
  const session: SessionStore = {
    get: () => sessionSnapshot,
    subscribe: sessionNotifier.subscribe,
  }

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
  // clear. Replace semantics — the Views you recorded become the plate. `names` narrows
  // the write to one slice of the session (a per-plate record key toggling off); absent
  // writes everything (the global stop). The save lifecycle rides the session store:
  // `writing` while the sink settles, then `saved` or `failed` — a FAILED write
  // re-inserts its buffer so the Views survive in memory for a retry (the next engage,
  // a later stop, or teardown) rather than being lost to a single warn.
  const finalizeSession = async (names?: ReadonlySet<string>): Promise<void> => {
    // Snapshot + remove up front so a straggler capture can't mutate a buffer mid-write.
    const entries = [...sessionBuffers].filter(([name]) => !names || names.has(name))
    if (entries.length === 0) return
    for (const [name] of entries) sessionBuffers.delete(name)
    notifySession({ save: 'writing' })
    let failed = 0
    let saved = 0
    let saveError: string | undefined
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
          saved += 1
        } catch (error) {
          failed += 1
          saveError = error instanceof Error ? error.message : String(error)
          if (!sessionBuffers.has(name)) sessionBuffers.set(name, buf)
          console.warn(
            `[xray] capture-session write failed for "${name}" — kept in memory; retried when you next start a session`,
            error,
          )
        }
      }),
    )
    notifySession({ save: failed > 0 ? 'failed' : 'saved', savedCount: saved, saveError })
  }

  // ONE settle+measure+accumulate for a site — the session's single ingest path.
  // `force` marks a sweep pass: it bypasses the recording-scope gate (the sweep owns
  // what it captures) but lands its View in the SAME name-keyed session buffer a
  // browse capture does. No capture ever POSTs from here; the write happens at stop
  // (`finalizeSession`). Coalescing of overlapping triggers lives in
  // `scheduleCapture`; this runs the actual work and is never invoked twice in
  // parallel for one site.
  const runCapture = async (site: Site, force: boolean) => {
    // During a sweep the sweep OWNS capture: it emulates each width and captures it
    // with a forced, awaited pass. A non-forced (browse) capture here is a stray —
    // almost always one the sweep's own emulated resize spawned via `onResize` — and
    // running it would race the sweep's awaited captures, splicing a duplicate or
    // mid-transition View into the buffer (or churning the generation guard). Drop
    // it; the sweep already covers this site at every width.
    if (
      (!force && (!recordingCovers(site.name) || sweeping)) ||
      site.tooLarge ||
      !isPrimaryForName(site)
    ) {
      return
    }
    // Snapshot the generation BEFORE settling: any width-change/disposal/uninstall
    // that lands during the settle moves it, and the capture is discarded rather
    // than written/spliced under the stale viewport (the generation guard).
    const generation = captureGeneration
    const view = await captureLocalView(site, generation)
    if (!view) return
    // Re-check the scope AFTER the settle — the one invalidation the generation
    // guard does not cover. If the session (or this name's slice) was stopped while
    // this View settled, the buffer was already finalized and cleared; accumulating
    // now would orphan this View in a fresh buffer nothing flushes. Drop it — the
    // sweep's forced captures included: every sweep runs inside an engaged session
    // now, so a forced View arriving after the stop is exactly as orphaned.
    if (!recordingCovers(site.name)) return
    // Seed the breakpoint thresholds from the RAW rules BEFORE distilling (a
    // post-Distil derivation could lose a dropped node's `@media` boundary), then
    // distil this View once so projection stays a pure Serialize (the passes are
    // strictly per-View, so distil-at-capture equals the old distil-at-sweep-end).
    // Dedup by exact width (latest wins); the per-band collapse happens at
    // projection. `previewSession` hot-swaps the in-memory plate so a shown
    // skeleton (Light Box / still-loading site) reflects the View just recorded.
    view.bpSeed = deriveBreakpoints(emit(view.bundle).rules, [])
    distilPlate({ name: site.name, views: [view], breakpoints: [] })
    let buf = sessionBuffers.get(site.name)
    if (!buf) {
      buf = { name: site.name, views: [], breakpoints: [] }
      sessionBuffers.set(site.name, buf)
    }
    buf.views = buf.views.filter((v) => v.width !== view.width)
    buf.views.push(view)
    notifySession({})
    // Blink ONLY when this (re)capture changed the recorded result — feedback that
    // a resize/navigation recorded something NEW, not a no-op re-capture.
    if (previewSession(buf)) blinkCapture(site.el)
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
      // reserved for the sweep's EMULATED width changes (see runSweep).
      if (sweeping) return
      for (const site of sites) void scheduleCapture(site)
      // A browse resize IS a width visit (ADR 0029): observe it through the same
      // engine the sweep uses, so a JS-conditional Skeleton that unmounted on
      // the crossing records the same empty View automation would record.
      if (recordActive()) observeWidth(win.innerWidth, recordingCovers)
    }, RESIZE_DEBOUNCE)
  }
  win.addEventListener('resize', onResize)

  // The global record engage/stop, driven by the sticky Capture toggle (the ModeStore's
  // `setRecord` flips the toggle; a console `capture.set(true)` lands here identically).
  // Engaging starts a fresh session — a prior stop's FAILED buffers get retried first
  // (`finalizeSession` snapshots + clears up front, normally a no-op), every mounted
  // site is captured at the current width, and, when the connected extension can
  // emulate, the sweep fires as part of the engage: recording with the extension IS
  // sweeping. Stopping writes every accumulated plate to disk once. `lastStop` is the
  // in-flight stop write, awaited by `setRecord(false)` so the HUD's save states track
  // the real sink round-trip.
  let sessionOn = captureEnabled.get()
  let lastStop: Promise<void> = Promise.resolve()
  // Bumped on every engage: a sweep's auto-stop callback only fires for the
  // session that started it (a stop→re-engage while the old sweep unwinds must
  // never let the stale callback stop the new session).
  let engageToken = 0
  const unsubscribeCapture = captureEnabled.subscribe(() => {
    const on = captureEnabled.get()
    if (on === sessionOn) return
    sessionOn = on
    if (on) {
      // Global scope absorbs any per-name record scope.
      recordNames.clear()
      lastStop = finalizeSession()
      notifySession({ sweepError: undefined })
      // A fresh session observes from a clean slate (prior pages' evidence is
      // stale), starting with the engage width itself.
      resetObservations()
      observeWidth(win.innerWidth, recordingCovers)
      for (const site of sites) void scheduleCapture(site)
      if (extension.get().caps.includes('emulate')) {
        // FULL AUTOMATION (ADR 0027 §2): automated visits have a knowable end, so
        // on success the automation presses the SAME stop the user would — the
        // write happens through the one write path. Failure never auto-writes:
        // the session stays engaged with the error surfaced, and the user
        // decides (fix and re-engage, or stop and keep the partial).
        const token = ++engageToken
        void runSweep().then(
          () => {
            if (engageToken === token && captureEnabled.get()) captureEnabled.set(false)
          },
          (error: unknown) => {
            notifySession({ sweepError: error instanceof Error ? error.message : String(error) })
          },
        )
      }
    } else {
      if (sweeping) sweepAbort = true
      lastStop = finalizeSession()
    }
    notifyMode()
  })

  // The sweep (ADR 0010): the page is the controller. It drives a thin browser
  // extension over window.postMessage (relayed by the extension's content script)
  // to emulate each target width, captures every mounted site at that width with a
  // real settle, then resets. The extension only runs allowlisted chrome.debugger
  // commands — all orchestration lives here.
  //
  // Presence and capabilities come from the content script's `hello` beacon
  // (answered by our `whois`, and re-announced proactively when the script loads
  // after us). `present` flips once and never back — no timeout, no false negative.
  // The client keys PURELY on `caps`: a hello without them announces no usable
  // capability, and the HUD shows its update warnline.
  const extNotifier = createNotifier()
  let extState: { present: boolean; version?: string; caps: readonly string[] } = {
    present: false,
    caps: [],
  }
  const extension: ExtensionStore = {
    get: () => extState,
    subscribe: extNotifier.subscribe,
  }
  const extAcks = new Map<number, (res: { ok: boolean; error?: string }) => void>()
  let nextExtReqId = 1
  const onExtMessage = (event: MessageEvent) => {
    if (event.source !== win) return
    const data = event.data
    if (isExtensionHello(data)) {
      extState = {
        present: true,
        version: typeof data.version === 'string' ? data.version : undefined,
        caps: Array.isArray(data.caps) ? data.caps.filter((c) => typeof c === 'string') : [],
      }
      extNotifier.notify()
      return
    }
    if (isExtensionAck(data)) {
      extAcks.get(data.id)?.({ ok: data.ok ?? false, error: data.error })
      extAcks.delete(data.id)
    }
  }
  win.addEventListener('message', onExtMessage)
  win.postMessage({ source: 'xray', kind: 'whois' }, '*')
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
  const coverageNotifier = createNotifier()
  const coverage: CoverageStore = {
    get: () => coverageMap,
    set: (name, plateCoverage) => {
      coverageMap.set(name, plateCoverage)
      coverageNotifier.notify()
    },
    subscribe: coverageNotifier.subscribe,
  }

  // Fixtures (ADR 0015). Fixture Sites track mounted render-prop Skeletons;
  // `liveData` tracks their ready render-input `data` (a stack per name, so
  // twins and unmount lifecycle are tracked and Record never reads an
  // unmounted site — last-mounted-wins, while capture primacy stays
  // document-order); `recorded` holds imported or newly recorded Fixture
  // values, which Replay reads. Only the wire carries the devalue STRING; the
  // store holds live values.
  const liveData = new Map<string, { data: unknown }[]>()
  const recorded = new Map<string, { data: unknown }>()
  // Mounted render-prop SITES per name, independent of readiness: participation
  // must survive loading and Light Box (which unmount content and dispose the
  // liveData entries), or the HUD's fixtures section jumps in and out.
  const fixtureSites = new Map<string, number>()
  const fixtureNotifier = createNotifier()
  const notifyFixtures = fixtureNotifier.notify
  const fixtures: FixtureStore = {
    register: (name, data) => registerStackEntry(liveData, name, { data }, notifyFixtures),
    registerSite: (name) => {
      fixtureSites.set(name, (fixtureSites.get(name) ?? 0) + 1)
      notifyFixtures()
      return () => {
        const count = fixtureSites.get(name) ?? 0
        if (count <= 1) fixtureSites.delete(name)
        else fixtureSites.set(name, count - 1)
        notifyFixtures()
      }
    },
    has: (name) => recorded.has(name),
    recordedCount: () => recorded.size,
    status: (name) => {
      // Participation follows mounted Fixture Sites (registerSite, stable
      // across loading and Light Box). Recordability follows live data.
      // Replaying also applies the configured nullish-data rule, so a
      // recorded plate with Replay on can still render live data.
      const live = liveData.get(name)?.at(-1)
      const isRecorded = recorded.has(name)
      const replaying =
        replayEnabled.get() &&
        isRecorded &&
        (replayMode === 'prefer' ? true : live !== undefined && live.data == null)
      return {
        participates: (fixtureSites.get(name) ?? 0) > 0,
        recordable: live !== undefined,
        recorded: isRecorded,
        replaying,
      }
    },
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
    seed: (values, force = false) => {
      let changed = false
      for (const [name, data] of Object.entries(values)) {
        // Do not clobber a Fixture recorded THIS session (it is fresher than
        // disk) — unless this is an HMR re-seed after a plate-module edit,
        // where the disk IS the fresher truth (ADR 0033).
        if (!force && recorded.has(name)) continue
        recorded.set(name, { data })
        changed = true
      }
      // A forced seed is AUTHORITATIVE: a name absent from the fresh disk
      // enumeration lost its Fixture (the export was deleted), so keeping it
      // `recorded` would show a lit key for data that no longer exists. A
      // just-recorded Fixture cannot be swept — its write reached disk before
      // the watcher fired this re-seed.
      if (force) {
        // Map iterators tolerate deletion of the current entry. Object.hasOwn,
        // not `in`: a plate legally named `constructor` or `toString` would
        // match an inherited property and never be swept.
        for (const name of recorded.keys()) {
          if (Object.hasOwn(values, name)) continue
          recorded.delete(name)
          changed = true
        }
      }
      if (changed) notifyFixtures()
    },
    subscribe: fixtureNotifier.subscribe,
  }
  // The Replay toggle is an input to `status(name).replaying`, so a flip must wake
  // the fixture subscribers too (the HUD's ◆ notes re-derive).
  const unsubscribeReplay = replayEnabled.subscribe(notifyFixtures)

  // Target widths for a sweep: the union of the in-scope session buffers' seeded
  // breakpoints plus any JS (matchMedia) thresholds. Visit a mobile-ish anchor
  // inside the first band, then each threshold — one width per band the swept
  // skeletons actually care about.
  const sweepWidths = (scope?: ReadonlySet<string>): number[] => {
    // Width discovery is IN-SESSION, NOT from the disk plate. The breakpoints come
    // from the matchMedia spy (JS thresholds) and each buffered View's `bpSeed` —
    // the author CSS `@media` thresholds derived from the RAW rules at capture,
    // BEFORE Distil dropped nodes (a post-Distil `emit` could lose a boundary a
    // dropped node carried; the seed is a superset, which only ever adds a
    // redundant gate boundary). The session buffer built in ONE session is the
    // source of truth; the disk plate is a derived, geometry-stripped artifact, so
    // reading widths back from it would be stale and backwards. Pass 0 captures
    // the initial width's View, whose seed reveals every band; the fixpoint then
    // visits them (a lazy component mounting at an emulated width can still reveal
    // a NEW breakpoint on a later pass). A CSS-only breakpoint fires no
    // `matchMedia`, so without the captured-rule source the narrower bands would
    // never be swept and only the initial-width View would exist, rendering at
    // EVERY width (the off-range collapse: the widest layout shown below 1200px).
    const set = new Set<number>(deriveBreakpoints([], [...matchMediaQueries]))
    for (const [name, buf] of sessionBuffers) {
      if (scope && !scope.has(name)) continue
      for (const view of buf.views) for (const bp of view.bpSeed ?? []) set.add(bp)
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

  /**
   * The sweep: emulate each target width via the extension and force-capture the in-scope sites at
   * each, every View landing in the SAME session buffers a browse capture fills (ADR 0022 §2 — one
   * multi-View bundle per plate per session). No writes here: the surrounding engage/stop owns the
   * disk. Progress rides the session store per width (the HUD ring). Visits each width once; after
   * a pass, width-gated lazy components may have revealed new thresholds (fresh matchMedia calls,
   * fresh `bpSeed`s), so recompute to a fixpoint.
   */
  const runSweep = async (scope?: ReadonlySet<string>): Promise<void> => {
    const inScope = (site: Site): boolean => !scope || scope.has(site.name)
    const visited = new Set<number>()
    sweeping = true
    sweepAbort = false
    try {
      for (let pass = 0; ; pass++) {
        if (sweepAbort) break
        const pending = sweepWidths(scope).filter((width) => !visited.has(width))
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
        const total = visited.size + pending.length
        for (const width of pending) {
          if (sweepAbort) break
          visited.add(width)
          notifySession({ sweep: { width, index: visited.size, total } })
          // The emulated width is about to change — bump the generation so any
          // capture still settling at the PREVIOUS width DISCARDS its local View
          // (rather than filing one width's geometry under another's island/gate —
          // ADR 0022 §4). The width-change is the canonical invalidation event.
          captureGeneration++
          // Sequential by necessity: one shared viewport — emulate, capture, next.
          // eslint-disable-next-line no-await-in-loop
          await extCommand('emulate', { width, height: 2400, mobile: width < 600 })
          // Force-capture every in-scope site into its session buffer (no
          // per-width POST). scheduleCapture coalesces with any in-flight browse
          // capture and resolves only once the forced follow-up has settled and
          // accumulated its View, so the next emulate never races a settle.
          // eslint-disable-next-line no-await-in-loop
          await Promise.all([...sites].filter(inScope).map((site) => scheduleCapture(site, true)))

          // CAPTURED ABSENCE (ADR 0029): an emulated width is a width visit like
          // any other — run it through the SAME observation engine a manual
          // resize uses. Absence at a width is knowledge, not a skip: unmounted
          // names get empty Views (with backfill for a plate that first appears
          // mid-sweep), the empties fold into one empty gated island, and
          // coverage reads the band as captured rather than as an unfillable gap.
          observeWidth(width, (name) => !scope || scope.has(name))
        }
        // Pull on-disk coverage back into the store BEFORE the next recompute so
        // downstream readers see the latest breakpoints deterministically; the
        // fixpoint itself discovers new widths from this pass's fresh seeds.
        // eslint-disable-next-line no-await-in-loop
        await options.refreshCoverage?.()
      }
    } finally {
      sweeping = false
      notifySession({ sweep: undefined })
      await extCommand('reset').catch(() => undefined)
    }
  }

  // ── The mode store: one action at a time, at one scope ──────────────────────
  // The sticky global toggles stay the global-scope truth (persistence, URL seeds,
  // console flips route through them); the name sets carry per-plate scopes. The
  // setters enforce the exclusivity — engaging record while Light Box is active (or
  // vice versa, at any scope) is a warned no-op — so the machine cannot be wedged
  // from the console, and the HUD merely renders `get()`.
  const modeNotifier = createNotifier()
  const computeMode = (): XrayModeState => {
    if (captureEnabled.get()) return { action: 'record', scope: 'global' }
    if (recordNames.size > 0) return { action: 'record', scope: new Set(recordNames) }
    if (lightbox.get()) return { action: 'lightbox', scope: 'global' }
    if (lightboxNames.size > 0) return { action: 'lightbox', scope: new Set(lightboxNames) }
    return { action: 'idle' }
  }
  // Cached so `get()` returns a STABLE snapshot between changes (useSyncExternalStore
  // and the Solid adapters both require identity stability to not loop).
  let modeSnapshot = computeMode()
  const notifyMode = (): void => {
    modeSnapshot = computeMode()
    modeNotifier.notify()
  }
  const unsubscribeLightbox = lightbox.subscribe(notifyMode)
  const recordActive = (): boolean => captureEnabled.get() || recordNames.size > 0
  const lightboxActive = (): boolean => lightbox.get() || lightboxNames.size > 0
  const mode: ModeStore = {
    get: () => modeSnapshot,
    subscribe: modeNotifier.subscribe,
    setRecord: async (on) => {
      if (on && lightboxActive()) {
        warnBlocked('recording', 'Light Box')
        return
      }
      captureEnabled.set(on)
      // The toggle handler assigned `lastStop`; awaiting it gives the caller the
      // real write round-trip (engage retries a failed stop's buffers too).
      await lastStop
    },
    setLightbox: (on) => {
      if (on && recordActive()) {
        warnBlocked('Light Box', 'recording')
        return
      }
      lightbox.set(on)
    },
    recordName: async (name, on) => {
      if (captureEnabled.get() || lightboxActive()) {
        warnBlocked('per-plate recording', captureEnabled.get() ? 'global recording' : 'Light Box')
        return
      }
      if (!on) {
        if (!recordNames.delete(name)) return
        if (recordNames.size === 0 && sweeping) sweepAbort = true
        notifyMode()
        // Shrinking the scope writes the removed plate's slice of the session now.
        await finalizeSession(new Set([name]))
        return
      }
      if (recordNames.has(name)) return
      if (sweeping) {
        // One shared viewport: a running sweep owns it; join once it finishes.
        warnBlocked('per-plate recording', 'a running sweep')
        return
      }
      // The name joins the recording scope — the SAME lifecycle at every level
      // of automation: captures accumulate until its key (or the whole scope)
      // stops, and stopping writes. A fresh scope observes from a clean slate.
      if (recordNames.size === 0) resetObservations()
      recordNames.add(name)
      notifyMode()
      notifySession({ sweepError: undefined })
      for (const site of sites) if (site.name === name) void scheduleCapture(site)
      observeWidth(win.innerWidth, recordingCovers)
      // FULL AUTOMATION (ADR 0027 §2), same as the global engage: the scoped
      // sweep visits every width, then keys its names off through the same off
      // path a finger would use — each key-off writes that plate's slice.
      // Failure keeps the scope engaged with the error surfaced.
      if (extension.get().caps.includes('emulate')) {
        const swept = new Set(recordNames)
        void runSweep(swept).then(
          async () => {
            for (const sweptName of swept) {
              // eslint-disable-next-line no-await-in-loop -- key-offs are deliberate and sequential: each writes its slice through the one off path, in scope order.
              if (recordNames.has(sweptName)) await mode.recordName(sweptName, false)
            }
          },
          (error: unknown) => {
            notifySession({ sweepError: error instanceof Error ? error.message : String(error) })
          },
        )
      }
    },
    lightboxName: (name, on) => {
      if (recordActive()) {
        warnBlocked('per-plate Light Box', 'recording')
        return
      }
      const changed = on ? lightboxNames.add(name) : lightboxNames.delete(name)
      if (on || changed) notifyMode()
    },
    lightboxed: (name) => lightbox.get() || lightboxNames.has(name),
  }

  // ── Mounted-sites store (the HUD plate list) ────────────────────────────────
  // PRESENCE ∪ capture sites. The adapter registers every mounted `<Skeleton>`'s
  // name via `mounted` regardless of what it shows; capture sites exist only
  // while the capture boundary is mounted — and Light Box unmounts that boundary
  // by design, so a store built from capture sites alone would drop a light-boxed
  // plate from the list along with the control that disengages it. Capture-only
  // callers (tests, direct embedders) still appear through the union's other arm.
  const presence = new Map<string, { el?: () => Element | null }[]>()
  // ── The width-observation engine (ADR 0029) ────────────────────────────────
  // Manual and sweep recording share ONE absence mechanism; the only difference
  // is who visits the widths (your resizes vs the extension's emulation). Every
  // visited width snapshots which names are mounted; reconciliation then gives
  // every covered, buffered, seen-on-this-page name an EMPTY View at each
  // observed width where it was NOT mounted — including backfill for a plate
  // that first appears at a later width. Guards, in order of what they protect:
  // - `seenOnPage` + pathname: session buffers survive navigation by design, so
  //   unmounted-because-navigation must never read as absent-at-width. A page
  //   change resets the observations and re-seeds from what is live NOW.
  // - Mounted = PRESENCE ∪ capture sites: a Skeleton showing its loading
  //   skeleton has presence but no capture boundary — mounted, not absent.
  // - Buffered-only: a name never captured anywhere has no plate to complete.
  const seenOnPage = new Set<string>()
  const widthObservations = new Map<number, ReadonlySet<string>>()
  let seenPath = win.location.pathname
  const resetObservations = (): void => {
    seenOnPage.clear()
    widthObservations.clear()
    seenPath = win.location.pathname
    // Re-seed from the live registries: what is mounted right now has, by
    // definition, been seen on the current page.
    for (const [name, entries] of presence) if (entries.length > 0) seenOnPage.add(name)
    for (const site of sites) {
      if (!site.disposed && site.el.isConnected) seenOnPage.add(site.name)
    }
  }
  /** True when still on the observed page; resets (and re-seeds) on navigation. */
  const samePageOrReset = (): boolean => {
    if (win.location.pathname === seenPath) return true
    resetObservations()
    return false
  }
  const noteSeen = (name: string): void => {
    void samePageOrReset()
    seenOnPage.add(name)
  }
  /** Snapshot the mounted names at `width`, then reconcile every covered buffer. */
  const observeWidth = (width: number, covers: (name: string) => boolean): void => {
    if (!samePageOrReset()) return
    const mounted = new Set<string>()
    for (const [name, entries] of presence) if (entries.length > 0) mounted.add(name)
    for (const site of sites) {
      if (!site.disposed && site.el.isConnected) mounted.add(site.name)
    }
    widthObservations.set(width, mounted)
    let absent = false
    for (const [name, buf] of sessionBuffers) {
      if (!covers(name)) continue
      if (!seenOnPage.has(name)) continue
      for (const [w, mountedAtW] of widthObservations) {
        if (mountedAtW.has(name)) continue
        if (buf.views.some((view) => view.width === w)) continue
        buf.views.push({ width: w, bundle: irFromTree({ id: 0, kids: [] }), bpSeed: [] })
        absent = true
      }
    }
    if (absent) notifySession({})
  }
  // Stitch registrations: one entry per SHOWING stitch-bearing skeleton, carrying
  // its direct stitch names (ADR 0006). Folded into the sites snapshot as
  // stitch-only rows / `stitchedUnder` annotations.
  const stitchEntries = new Set<{ parent: string; names: readonly string[] }>()
  const sitesNotifier = createNotifier()
  let sitesSnapshot: ReadonlyMap<string, MountedPlate> = new Map()
  const notifySites = (): void => {
    const next = new Map<string, MountedPlate>()
    for (const [name, entries] of presence) {
      if (entries.length === 0) continue
      next.set(name, { instances: entries.length, captureRoot: 'auto', tooLarge: false })
    }
    for (const site of sites) {
      if (!site.el.isConnected) continue
      const existing = next.get(site.name)
      if (existing && presence.get(site.name)?.length) {
        // Presence carries the instance count; capture sites contribute the
        // capture-specific facts. tooLarge is sticky if ANY instance tripped the
        // gate; the root model is the first registered instance's (twins share a
        // component in practice).
        next.set(site.name, {
          instances: existing.instances,
          captureRoot: site.mode,
          tooLarge: existing.tooLarge || site.tooLarge,
        })
      } else if (existing) {
        next.set(site.name, {
          instances: existing.instances + 1,
          captureRoot: existing.captureRoot,
          tooLarge: existing.tooLarge || site.tooLarge,
        })
      } else {
        next.set(site.name, { instances: 1, captureRoot: site.mode, tooLarge: site.tooLarge })
      }
    }
    // Fold the stitch registrations in LAST: a stitched name that is also mounted
    // keeps its real entry and gains the `stitchedUnder` hosts; a stitch-only name
    // gets an `instances: 0` row so its on-page bones stay listed.
    const hosts = new Map<string, string[]>()
    for (const entry of stitchEntries) {
      for (const name of entry.names) {
        const list = hosts.get(name)
        if (list) {
          if (!list.includes(entry.parent)) list.push(entry.parent)
        } else {
          hosts.set(name, [entry.parent])
        }
      }
    }
    for (const [name, under] of hosts) {
      const existing = next.get(name)
      if (existing) next.set(name, { ...existing, stitchedUnder: under })
      else {
        next.set(name, { instances: 0, captureRoot: 'auto', tooLarge: false, stitchedUnder: under })
      }
    }
    sitesSnapshot = next
    sitesNotifier.notify()
  }
  const sitesStore: SitesStore = {
    get: () => sitesSnapshot,
    subscribe: sitesNotifier.subscribe,
  }

  // ── Per-plate diagnostics store (the HUD row notes) ─────────────────────────
  // The last capture's formatted diagnostic lines per plate, replaced on every
  // capture (empty = clean). The console keeps its grouped warning; this is the
  // same text made subscribable.
  const diagNotifier = createNotifier()
  const diagLines = new Map<string, readonly string[]>()
  const setDiagnostics = (name: string, lines: readonly string[]): void => {
    diagLines.set(name, lines)
    diagNotifier.notify()
  }
  const diagnosticsStore = {
    get: (name: string) => diagLines.get(name) ?? [],
    subscribe: diagNotifier.subscribe,
  }

  // The boundary highlight resolves a plate name to its WRITING instance's element
  // (the same one a capture reads), re-resolved every frame so writer handoffs and
  // unmounts track.
  const highlighter = createHighlighter((name) => {
    for (const site of sites) {
      if (site.name === name && !site.disposed && site.el.isConnected && isPrimaryForName(site)) {
        return site.el
      }
    }
    // No capture site (the plate is light-boxed, or still loading): fall back to
    // the presence registry's rendered root — the skeleton being shown.
    for (const entry of presence.get(name) ?? []) {
      const el = entry.el?.()
      if (el?.isConnected) return el
    }
    // Stitch-only: the plate's bones render inside a parent's showing skeleton;
    // the stitch root carries the standard root marker (plate names are validated
    // to a safe charset, so direct interpolation is fine).
    return document.querySelector(`[data-xr-root="${name}"]`) ?? undefined
  })

  globalThis.__XRAY__ = {
    lightbox,
    capture: captureEnabled,
    plates,
    updatePlate,
    coverage,
    replay: replayEnabled,
    replayMode,
    recordMode,
    fixtures,
    mode,
    sites: sitesStore,
    session,
    diagnostics: diagnosticsStore,
    extension,
    highlight: highlighter.set,
    mounted: (name, el) => {
      noteSeen(name)
      return registerStackEntry(presence, name, { el }, notifySites)
    },
    stitched: (parent, names) => {
      if (names.length === 0) return () => {}
      const entry = { parent, names }
      stitchEntries.add(entry)
      notifySites()
      return () => {
        stitchEntries.delete(entry)
        notifySites()
      }
    },
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
      noteSeen(name)
      notifySites()
      void scheduleCapture(site)
      return () => {
        site.disposed = true
        sites.delete(site)
        notifySites()
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
    unsubscribeLightbox()
    unsubscribeReplay()
    highlighter.dispose()
    sweepAbort = true
    recordNames.clear()
    lightboxNames.clear()
    presence.clear()
    stitchEntries.clear()
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

/**
 * One listener set, shared by every client store (the TanStack Store lesson, minus the library):
 * `notify` runs each subscriber in ISOLATION — the HUD is effectively a third party to the capture
 * pipeline, and these notifications fire from inside `runCapture`, the sweep loop, and the stop's
 * write path, so a throwing subscriber must never break the capture that happened to wake it.
 */
function createNotifier(): { notify: () => void; subscribe: (cb: () => void) => () => void } {
  const listeners = new Set<() => void>()
  return {
    notify() {
      for (const cb of listeners) {
        try {
          cb()
        } catch (error) {
          console.error('[xray] a store subscriber threw (ignored):', error)
        }
      }
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }
}

/** The mode machine's exclusivity refusal: a warned no-op, never a wedge. */
function warnBlocked(verb: string, blocker: string): void {
  console.warn(`[xray] ${verb} is unavailable while ${blocker} is active — stop it first.`)
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
  const notifier = createNotifier()
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
      notifier.notify()
    },
    subscribe: notifier.subscribe,
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
