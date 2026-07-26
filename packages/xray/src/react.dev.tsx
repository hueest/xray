import {
  type ReactNode,
  type Ref,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { BOUNDARY_ATTR, type Plate } from './plate.ts'
import {
  collectStitchNames,
  type FixtureOutOfDate,
  isRenderProp,
  isStitchLive,
  markStitchesLive,
  renderPlate,
  resolveContent,
  type SkeletonProps,
  type SkeletonRenderProp,
  SuspendWhileLoading,
  useSkeletonTiming,
} from './react.core.tsx'
import type { XrayCaptureWalker } from './measure.ts'

export type { FixtureOutOfDate, SkeletonProps }

// Stable no-op store fallbacks: with no dev client installed (capture + HUD both
// off, or SSR) the subscriptions are inert and the snapshots are constants, so
// the dev adapter degrades to production behavior.
const noSubscribe = () => () => {}
const alwaysFalse = () => false

/**
 * True while THIS plate is light-boxed: the global toggle, or the plate's name in a per-plate Light
 * Box scope (the HUD's per-row play key). Reads through the mode store when the hook carries one;
 * the bare global toggle covers partial hooks (every CaptureHook field is optional — tests and
 * direct embedders install exactly the slices they use).
 */
function useLightBox(name: string): boolean {
  const mode = globalThis.__XRAY__?.mode
  const lightbox = globalThis.__XRAY__?.lightbox
  const subscribe = useCallback(
    (onChange: () => void) =>
      mode?.subscribe(onChange) ?? lightbox?.subscribe(onChange) ?? noSubscribe(),
    [mode, lightbox],
  )
  return useSyncExternalStore(
    subscribe,
    () => (mode ? mode.lightboxed(name) : (lightbox?.get() ?? false)),
    alwaysFalse,
  )
}

/** True while the HUD/console "Replay" toggle is on (ADR 0015). */
function useReplayOn(): boolean {
  const replay = globalThis.__XRAY__?.replay
  return useSyncExternalStore(
    replay?.subscribe ?? noSubscribe,
    replay?.get ?? alwaysFalse,
    alwaysFalse,
  )
}

/**
 * The Fixtures (ADR 0015) seam, applied at the ready (`loading=false`) path right before
 * `resolveContent`. It is the ONE place Record reads `data` and Replay substitutes it — the
 * render-prop `data` argument is in scope here.
 *
 * Replay: when the toggle is on and a Fixture exists, the recorded `data` is substituted for the
 * live `data` according to `replayMode` — `'prefer'` always uses the Fixture; `'missing-only'` uses
 * it only when live `data` is NULLISH (`missing ≡ nullish`, so an empty array/object is present and
 * stays capturable). The substituted value is returned synchronously so it feeds `resolveContent`
 * for THIS render; the capture-all sweep only re-renders at each width and reads the SAME Fixture
 * from the store (which the sweep never changes per width), so every View is captured from one
 * width-independent Fixture with no new capture trigger (capture follows whatever renders, ADR
 * 0002).
 *
 * Record: the live `data` is registered (in an effect, so render stays pure) so the HUD button and
 * the auto modes always have the current input in scope. The auto modes (`'first-ready'`,
 * `'always'`) fire from the same effect; `'manual'` (the default) records nothing automatically.
 * Register and auto-record the LIVE `data`, never the replayed value, so Replay and Record never
 * feed each other.
 *
 * Only the render-prop children form is the `data` seam (ADR 0014/0015), so Fixtures apply to it
 * alone: `renderProp` gates participation. A plain-children Skeleton has no `data` input, so it
 * must NOT register, auto-record, or replay — the hook is a pass-through for it, which keeps a
 * never-registered plain name out of `recordAll` and lets `record(name)` throw loudly (no
 * render-prop data) as the store contract documents. A render-prop Skeleton passed
 * `data={undefined}` is still a render prop and participates exactly as any other.
 */
function useFixtureData<T>(name: string, data: T | undefined, renderProp: boolean): T | undefined {
  const replayOn = useReplayOn()
  // Subscribe to the fixtures store so a Record/seed re-renders any replaying
  // site. The snapshot is the recorded entry (or undefined) for this plate.
  const fixturesStore = globalThis.__XRAY__?.fixtures
  const subscribe = useCallback(
    (onChange: () => void) => fixturesStore?.subscribe(onChange) ?? noSubscribe(),
    [fixturesStore],
  )
  const recordedFixture = useSyncExternalStore(
    subscribe,
    () => fixturesStore?.read(name),
    () => undefined,
  )

  // Register the live `data` and run the auto-record policy AFTER render (effects
  // never run during the render pass, so capture is never re-triggered by the
  // act of recording — capture observes the rendered DOM as always, ADR 0002).
  // The effect returns `register`'s disposer as cleanup so an unmounted
  // Skeleton's `data` never lingers in the store: `liveData` accumulates no
  // stale entries, and `recordAll`/`record` never read an unmounted site.
  useEffect(() => {
    // Plain children are not the `data` seam: never register or auto-record them,
    // so they stay out of `recordAll` and `record(name)` keeps throwing loudly.
    if (!renderProp) return undefined
    const fx = globalThis.__XRAY__?.fixtures
    if (!fx) return undefined
    const dispose = fx.register(name, data)
    const mode = globalThis.__XRAY__?.recordMode ?? 'manual'
    if (mode === 'always' || (mode === 'first-ready' && !fx.has(name))) {
      void fx.record(name).catch((error: unknown) => {
        console.error(`[xray] fixture record failed for "${name}":`, error)
      })
    }
    return dispose
  }, [name, data, renderProp])

  if (!renderProp) return data
  // Replay substitution: only when the toggle is on AND a Fixture exists. In
  // `missing-only`, fall back ONLY when live `data` is nullish.
  if (!replayOn || !recordedFixture) return data
  const mode = globalThis.__XRAY__?.replayMode ?? 'prefer'
  if (mode === 'missing-only' && data != null) return data
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the Fixture stores the same shape the consumer recorded for T (ADR 0015).
  return recordedFixture.data as T
}

/**
 * The plate to render: the freshest capture from the client store (hot-swapped in place, no
 * remount) when present, else the imported prop.
 */
function useLivePlate(plate: Plate): Plate {
  const store = globalThis.__XRAY__?.plates
  const subscribe = useCallback(
    (onChange: () => void) => store?.subscribe(plate.name, onChange) ?? noSubscribe(),
    [store, plate.name],
  )
  const getSnapshot = () => store?.get(plate.name) ?? plate
  return useSyncExternalStore(subscribe, getSnapshot, () => plate)
}

/**
 * Dev `<Skeleton>`: production behavior plus the Light Box override, the live-store hot-swap, and
 * browse-time capture. The xray plugin aliases `@hueest/xray/react` to this module in `serve`;
 * production gets the lean `react.tsx`.
 */
export function Skeleton<T = undefined, F = unknown>(props: SkeletonProps<T, F>) {
  const {
    plate,
    css,
    loading = false,
    suspense = false,
    fallback,
    delay,
    children,
    data,
    captureWalker,
    maxNodes,
    maxBreadth,
    maxDepth,
  } = props
  // `root` is only present on the union, defaulting to 'auto'. Manual root drops
  // the wrapper and hands the boundary marker to the consumer's element via the
  // render prop's `ref` (ADR 0014).
  const manual = props.root === 'manual'
  const lightBoxOn = useLightBox(plate.name)
  const livePlate = useLivePlate(plate)
  // The min-duration hold (ADR 0016), shared with prod. The ref points at the
  // rendered skeleton root so the hook reads the computed `--xr-skeleton-*`
  // tokens off it; the reveal delay stays pure CSS. This is the capture boundary
  // ref's sibling, not its replacement — the capture ref still lives on the
  // Content wrapper below, so capture is untouched.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const showSkeleton = useSkeletonTiming(loading, rootRef)
  // Presence registration: this `<Skeleton>` is on the page, whatever it shows.
  // The capture boundary below registers only while CONTENT is mounted — and
  // Light Box unmounts it by design — so the HUD's plate list keys off presence,
  // or a light-boxed plate would vanish along with its disengage control. The
  // ref resolver hands the highlight the rendered skeleton root as its fallback
  // while no capture site exists.
  useEffect(() => globalThis.__XRAY__?.mounted?.(plate.name, () => rootRef.current), [plate.name])
  // Fixture-site registration (ADR 0015): participation lasts the Skeleton
  // lifetime; live `data` (useFixtureData, inside the ready-only boundary)
  // registers only while content is mounted. The split keeps the HUD stable
  // when Light Box unmounts content: `recordable` drops, participation does not.
  const renderProp = isRenderProp<T>(children)
  useEffect(() => {
    if (!renderProp) return undefined
    return globalThis.__XRAY__?.fixtures?.registerSite?.(plate.name)
  }, [renderProp, plate.name])
  // Instant-reveal continuation (ADR 0020), identical to prod: read ONCE at first
  // render whether this plate is a live stitch under a still-showing parent, and
  // mark this plate's direct stitch names live WHILE the skeleton shows (keyed on
  // `showSkeleton`, through the min-duration hold). The disposer runs after the
  // descendant's first-render read, so the read deterministically sees the entry.
  // Mark from `livePlate` (what is actually rendered) so a hot-swapped capture's
  // stitches register; read by stable `plate.name`.
  const [instant] = useState(() => isStitchLive(plate.name))
  useEffect(() => {
    if (!showSkeleton) return undefined
    return markStitchesLive(collectStitchNames(livePlate.chunks))
  }, [showSkeleton, livePlate.chunks])
  // Stitch presence for the HUD, SEPARATE from the ADR 0020 continuation marks
  // above: those are keyed on the loading path alone (their contract is the
  // loading→standalone handoff), while the stitched plates' bones are on the
  // page whenever this skeleton shows for ANY reason — loading or Light Box.
  // Reporting keeps the stitched names listed (as stitch-only rows) even though
  // no component of theirs is mounted.
  useEffect(() => {
    if (!showSkeleton && !lightBoxOn) return undefined
    return globalThis.__XRAY__?.stitched?.(plate.name, collectStitchNames(livePlate.chunks))
  }, [showSkeleton, lightBoxOn, livePlate.chunks, plate.name])
  const skeleton = (
    <PlateView
      plate={livePlate}
      css={css}
      fallback={fallback}
      rootRef={rootRef}
      instant={instant}
    />
  )
  if (lightBoxOn) return skeleton
  const content = (
    <Content<T>
      plate={plate}
      delay={delay}
      manual={manual}
      data={data}
      captureWalker={captureWalker}
      maxNodes={maxNodes}
      maxBreadth={maxBreadth}
      maxDepth={maxDepth}
    >
      {children}
    </Content>
  )
  // Readiness composes across two ORTHOGONAL axes (ADR 0002, amended): `loading`
  // gates MOUNT (while loading, the plate shows and the capture boundary never
  // mounts, so nothing runs/captures without data), and `suspense` catches the
  // mounted children while they resolve (a lazy code chunk, or the content
  // itself once it data-suspends).
  //
  // In `suspense` mode the plate must be the SINGLE Suspense fallback across
  // BOTH phases, or it remounts (flickers) between them. So the component ALWAYS
  // returns the Suspense
  // and drives the data phase through a suspender: while loading, `SuspendWhileLoading`
  // throws so the fallback (the plate) shows and the content sibling (capture
  // boundary) stays uncommitted; once `!loading`, content mounts and — if its lazy
  // chunk suspends — the SAME fallback keeps showing. One fallback DOM node, no
  // remount.
  if (suspense)
    return (
      <Suspense fallback={skeleton}>
        <SuspendWhileLoading loading={showSkeleton} />
        {content}
      </Suspense>
    )
  // Non-suspense: `loading` is the sole readiness axis.
  if (showSkeleton) return skeleton
  return content
}

interface ContentProps<T> {
  plate: Plate
  delay?: number
  manual: boolean
  data?: T
  /** The per-site programmable capture walker (ADR 0018); forwarded into `captured`. */
  captureWalker?: XrayCaptureWalker
  /**
   * Per-site Collect limits (ADR 0022), flat so they stay stable across renders; forwarded into
   * `captured`.
   */
  maxNodes?: number
  maxBreadth?: number
  maxDepth?: number
  children?: ReactNode | SkeletonRenderProp<T>
}

function Content<T>(props: ContentProps<T>) {
  const { children, data } = props
  // Constant per page load: the dev client installs the hook before the app
  // boots. With no client (capture + HUD both off) there is nothing to capture,
  // so the boundary/ref machinery is inert — call a render prop with a no-op ref
  // and render its result bare, exactly as production would.
  if (globalThis.__XRAY__ === undefined) {
    return <>{resolveContent<T>(children, data)}</>
  }
  if (props.manual) return <ManualBoundary {...props} />
  return <CaptureBoundary {...props} />
}

/**
 * Assemble the per-site Collect limits (ADR 0022) from the flat `<Skeleton>` props into the nested
 * shape `captured` expects, or `undefined` when none are set (so the client's plugin defaults
 * apply). Called inside the capture effect, keyed on the flat primitives, so it never builds an
 * object during render.
 */
function collectLimits(
  maxNodes?: number,
  maxBreadth?: number,
  maxDepth?: number,
): { maxNodes?: number; maxBreadth?: number; maxDepth?: number } | undefined {
  if (maxNodes === undefined && maxBreadth === undefined && maxDepth === undefined) return undefined
  return { maxNodes, maxBreadth, maxDepth }
}

/**
 * `root="auto"` (default): the existing `display:contents` boundary wrapper marks the capture seam
 * so a parent capture stops here and references this plate by name rather than re-serializing the
 * content (ADR 0006). A render prop is called with the verbatim `data` and a no-op `ref` (the
 * wrapper, not the consumer's element, carries the marker); its result renders inside the wrapper
 * exactly as plain children do.
 */
function CaptureBoundary<T>({
  plate,
  delay,
  children,
  data,
  captureWalker,
  maxNodes,
  maxBreadth,
  maxDepth,
}: ContentProps<T>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    // The walker is a closure on the consumer's `<Skeleton>`, forwarded per call
    // into the dev capture entry (`__XRAY__.captured`) and on into `captureView`
    // (ADR 0018). Capture-only, never persisted. The flat limit props assemble
    // into `collect` here (ADR 0022), keyed on the primitives so the effect only
    // re-registers when a real value changes.
    return globalThis.__XRAY__?.captured(plate.name, el, {
      delay,
      walker: captureWalker,
      mode: 'auto',
      collect: collectLimits(maxNodes, maxBreadth, maxDepth),
    })
  }, [plate.name, delay, captureWalker, maxNodes, maxBreadth, maxDepth])
  // Fixtures (ADR 0015): record the live `data` / replay a recorded Fixture in its
  // place, BEFORE resolveContent, so the render prop (and thus capture) sees the
  // effective input. Plain children are not the `data` seam, so the hook no-ops
  // for them (no register/record/replay) — gate on the render-prop form.
  const effective = useFixtureData<T>(plate.name, data, isRenderProp<T>(children))
  const attrs = { [BOUNDARY_ATTR]: plate.name, style: { display: 'contents' } as const }
  return (
    <div {...attrs} ref={ref}>
      {resolveContent<T>(children, effective)}
    </div>
  )
}

/**
 * `root="manual"` (ADR 0014): no wrapper. The render prop is handed a CALLBACK ref that, when
 * spread onto the consumer's root element, writes the existing `data-xr-boundary` marker onto it
 * and registers it as the capture root, so a parent capture reads the identical marker
 * (`measure.ts` does `BOUNDARY_ATTR ?? ROOT_ATTR`) and cannot tell a manual root from an auto one.
 *
 * If the consumer forgets to spread the ref, the marker never lands and the parent capture descends
 * into and silently swallows this subtree's DOM: the exact stitch-isolation breakage ADR 0006
 * prevents, and the worst failure xray can produce. A dev-time effect asserts the ref fired and
 * loudly `console.error`s when it did not.
 */
function ManualBoundary<T>({
  plate,
  delay,
  children,
  data,
  captureWalker,
  maxNodes,
  maxBreadth,
  maxDepth,
}: ContentProps<T>) {
  // Mirror CaptureBoundary's registration semantics, but driven by the consumer's
  // own element rather than a wrapper. The disposer from a previous element is
  // run before re-registering so a swapped host cleans up its prior observation.
  const disposeRef = useRef<(() => void) | undefined>(undefined)
  const attachedRef = useRef(false)
  const ref = useCallback<(el: Element | null) => void>(
    (el) => {
      disposeRef.current?.()
      disposeRef.current = undefined
      if (!el) return
      el.setAttribute(BOUNDARY_ATTR, plate.name)
      attachedRef.current = true
      // Same per-site walker forwarding as CaptureBoundary (ADR 0018).
      disposeRef.current = globalThis.__XRAY__?.captured(plate.name, el, {
        delay,
        walker: captureWalker,
        // The consumer's element IS the capture root (ADR 0014): the client
        // captures the element itself, not its children, so its box/classes/
        // padding/border survive into the plate.
        mode: 'manual',
        collect: collectLimits(maxNodes, maxBreadth, maxDepth),
      })
    },
    [plate.name, delay, captureWalker, maxNodes, maxBreadth, maxDepth],
  )
  useEffect(() => () => disposeRef.current?.(), [])
  useEffect(() => {
    if (!attachedRef.current) {
      console.error(
        `[xray] <Skeleton root="manual" plate="${plate.name}"> never received its \`ref\`: ` +
          'spread it onto your root element, or capture leaks into the parent plate (ADR 0006).',
      )
    }
  }, [plate.name])
  // Fixtures (ADR 0015): same record/replay seam as CaptureBoundary, in front of
  // resolveContent. Gate on the render-prop form so plain JS children (which the
  // type forbids here but the untyped adapter still accepts) never participate.
  const effective = useFixtureData<T>(plate.name, data, isRenderProp<T>(children))
  // root="manual" requires render-prop children (enforced by the type), but the
  // adapter is shared with untyped JS callers, so fall back to bare children
  // rather than throw.
  return <>{resolveContent<T>(children, effective, ref)}</>
}

/**
 * Render a plate's skeleton, seeding the live store from its resolved refs so a stitch resolves
 * before its child is re-captured and survives a parent hot-swap (which pushes a refs-less plate).
 * Never overwrites a live capture.
 */
function PlateView({
  plate,
  css,
  fallback,
  nested = false,
  rootRef,
  instant,
}: {
  plate: Plate
  /**
   * Consumer-composed inline css for a runtime-captured plate (two-artifact contract); only the
   * top-level Skeleton passes it — a nested stitch never carries inline css (base/page styles are
   * already in scope).
   */
  css?: string
  fallback?: ReactNode
  nested?: boolean
  rootRef?: Ref<HTMLDivElement>
  /**
   * This outermost root is a stitch continuation; reveal it instantly (ADR 0020). Only passed by
   * the top-level Skeleton; a nested stitch passes none.
   */
  instant?: boolean
}) {
  useEffect(() => {
    const store = globalThis.__XRAY__?.plates
    if (!store || !plate.refs) return
    for (const [name, child] of Object.entries(plate.refs)) store.seed(name, child)
  }, [plate.refs])
  if (!plate.chunks) return <>{fallback ?? null}</>
  return renderPlate(
    plate,
    (name) => <RefNode name={name} staticRefs={plate.refs} />,
    nested,
    rootRef,
    instant,
    css,
  )
}

/**
 * A stitch in dev: resolve the child plate from the live store (so re-capturing it hot-swaps it
 * inside every parent), falling back to the parent's statically imported `refs` until the first
 * capture lands.
 */
function RefNode({ name, staticRefs }: { name: string; staticRefs?: Record<string, Plate> }) {
  const store = globalThis.__XRAY__?.plates
  const subscribe = useCallback(
    (onChange: () => void) => store?.subscribe(name, onChange) ?? noSubscribe(),
    [store, name],
  )
  const fallback = staticRefs?.[name]
  const child = useSyncExternalStore(
    subscribe,
    () => store?.get(name) ?? fallback,
    () => fallback,
  )
  if (!child) return null
  return <PlateView plate={child} nested />
}
