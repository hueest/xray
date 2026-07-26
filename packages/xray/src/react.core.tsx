import {
  Fragment,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { escapeStyleText } from './css-escape.ts'
// Deliberately NO BASE_CSS import (ADR 0026): the adapter must not
// reference the ~5 KB constant, or its text ships in every consumer chunk that
// imports the adapter even when styling flows through Vite's CSS pipeline.
// Plugin plates get BASE_CSS via `virtual:xray/base.css`; runtime-captured
// plates get it via the consumer-composed `css` prop (see `composeCss`).
import { type Chunk, type Plate, ROOT_ATTR, ROOT_CLASS, ROOT_INSTANT_ATTR } from './plate.ts'
import type { XrayCaptureWalker } from './measure.ts'

// Shared between the production adapter (`react.tsx`) and the dev adapter
// (`react.dev.tsx`). Render helpers here are hook-free (useSkeletonTiming is the
// exception, shared by both); the adapter decides only how
// stitches resolve (static refs in prod, live store in dev).

/**
 * The live-stitch registry (ADR 0020): a module-level ref-counted set of stitch names that are
 * CURRENTLY rendered as a stitch inside a still-SHOWING parent skeleton. It exists to kill the
 * "stitch flash": when a parent skeleton resolves and its real content mounts a descendant's OWN
 * standalone `<Skeleton>` for the same plate, that standalone is a NEW outermost skeleton — it
 * would re-pay the full `--xr-skeleton-delay` (ADR 0016) from zero and visually disappear for
 * ~250ms even though the child was continuously visible as a stitch. A standalone skeleton
 * replacing such a live stitch must reveal INSTANTLY (no delay, no fade), matching how the stitch
 * inherited its parent's already-revealed channel.
 *
 * Why a loading-keyed registry and not wall-clock time: the parent marks its direct stitch names
 * live in an effect WHILE it shows its skeleton (an earlier commit). When the parent resolves,
 * React renders the content tree — the child's standalone Skeleton first-renders and reads
 * `isStitchLive(child)` BEFORE the parent's unmark cleanup runs (render happens before that
 * commit's effects), so the read deterministically sees `child` still live. The unmark then clears
 * it. "Recently" is defined by React's render-before-effect ordering, not a timer, so it is
 * race-free AND does not over-apply to independent nested skeletons (a tab-hidden skeleton was
 * never marked live by a currently-showing parent → not live → normal delay). It is portal-correct
 * for free: only genuine stitches (names in a parent plate's stitch set) are ever registered, so a
 * portaled child is never a stitch, never live, and reveals on the normal delay (ADR 0020).
 *
 * This ships to PROD: the flash is a production issue too, and the cost is a Map plus a register
 * effect and a read-once `useState` per `<Skeleton>` — a few bytes, consistent with the prod-hooks
 * relaxation ADR 0016 opened.
 */
const liveStitches = new Map<string, number>()

/**
 * Mark a parent skeleton's direct stitch names live (ref-counted, so concurrent showing parents
 * that stitch the same child stack), returning a disposer that decrements each. The adapter calls
 * this in an effect while `showSkeleton` is true and runs the disposer when it stops showing
 * (resolve/unmount). Several marks of the same name increment the count; the count drops to 0
 * (entry removed) only when every showing parent has unmarked it (ADR 0020).
 */
export function markStitchesLive(names: string[]): () => void {
  for (const name of names) liveStitches.set(name, (liveStitches.get(name) ?? 0) + 1)
  return () => {
    // Defer the decrement to a microtask (ADR 0020): a continuation that mounts
    // within the SAME task as the parent resolving (e.g. a child whose `loading`
    // flips in a mount effect a tick later, not in the same commit) still reads
    // the entry as live before it is decremented. Bounded to the current task's
    // microtask queue, NOT a wall-clock window, so it stays deterministic and
    // can never keep a name live into a later macrotask (a tab, a network-paced
    // mount) where it would be a false continuation.
    queueMicrotask(() => {
      for (const name of names) {
        const next = (liveStitches.get(name) ?? 0) - 1
        if (next <= 0) liveStitches.delete(name)
        else liveStitches.set(name, next)
      }
    })
  }
}

/**
 * True while `name` is rendered as a stitch inside a still-showing parent skeleton — i.e. a
 * standalone `<Skeleton>` for it is a continuation, not a fresh skeleton, and must reveal instantly
 * (ADR 0020).
 */
export function isStitchLive(name: string): boolean {
  return (liveStitches.get(name) ?? 0) > 0
}

/**
 * The direct stitch names a plate's chunks reference (ADR 0020): a `{ r: name }` chunk IS a stitch;
 * a `{ c, k }` chunk is a stitch-bearing element kept real, so recurse its `k`. Walks the SHIPPED
 * `chunks` (the render contract), not `plate.refs` (empty in dev, where the live store resolves
 * stitches) nor `collectRefs` (which walks the build-time RenderNode tree, not the shipped chunks).
 * One level of direct stitch names per Skeleton is enough: each level self-registers as it becomes
 * a real `<Skeleton>` (the cascade), so arbitrary nesting is covered without recursing into child
 * plates here.
 */
export function collectStitchNames(chunks: Chunk[] | null): string[] {
  if (!chunks) return []
  const names: string[] = []
  const walk = (cs: Chunk[]): void => {
    for (const chunk of cs) {
      if (typeof chunk === 'string') continue
      // A template chunk's cell is stitch-free by construction — no names within.
      if ('t' in chunk) continue
      if ('r' in chunk) names.push(chunk.r)
      else walk(chunk.k)
    }
  }
  walk(chunks)
  return names
}

/**
 * The additive render-prop children form (ADR 0014). Called only at `loading=false` (null included
 * — `loading` stays the sole readiness axis, ADR 0002), it hands back the typed `data` verbatim
 * plus a `ref` for the manual capture root.
 *
 * `ref` is a CALLBACK ref by contract: in `root="manual"` (dev) it imperatively writes the
 * `data-xr-boundary` marker onto the consumer's own element and registers it as the capture root,
 * so it must run on the real DOM node. In `root="auto"` and in production it is a no-op (omitted),
 * and the existing `display:contents` boundary wrapper does the marking instead.
 *
 * It is typed as a callback ref over the base `Element` rather than a `Ref<T>`. A callback that
 * accepts `Element | null` is, by parameter contravariance, assignable to a more specific `ref`
 * slot (`<section ref={ref}>` wants `(el: HTMLElement | null) => void`), so the consumer spreads it
 * onto any host element without a cast. A `RefObject` would NOT compose this way and is not
 * offered: writing the boundary attribute needs the imperative callback anyway.
 */
export type SkeletonRef = (el: Element | null) => void
export type SkeletonRenderProp<T> = (ctx: { data: T; ref?: SkeletonRef }) => ReactNode

/**
 * The typed-fixtures drift error (ADR 0031). When a Plate's recorded Fixture type `F` (derived from
 * the plate module's `fixture` export via the env file's declare block, ADR 0033/0034) no longer
 * satisfies the `data` prop's type `T`, the `plate` prop's type intersects with this brand and the
 * assignment fails — so a data-type change that outgrows the committed Fixture surfaces at the
 * `<Skeleton>` site in the consumer's own compile, with xray not even running. The fix is almost
 * always to re-record the Fixture.
 */
export interface FixtureOutOfDate<F, T> {
  'xray-fixture-out-of-date': 'the recorded Fixture no longer satisfies this data type: re-record it'
  recorded: F
  expected: T
}

/**
 * The drift check's projection of a recorded type (ADR 0031 §3) — two transforms, both about what a
 * SAMPLE can honestly claim:
 *
 * - Strip `readonly` deep: the plate module's `as const` fixture export infers readonly everywhere;
 *   property readonly-ness never affects assignability, but readonly TUPLES do not extend mutable
 *   `T[]`. Built-ins pass through untouched — mapping over `Date`/`Map`/`Set`/`RegExp` would
 *   dismember their method surfaces.
 * - A recorded `null` becomes `never`: GraphQL data uses null for "absent", while consumer types
 *   spell absence as `?: string` OR `: string | null` — the recording cannot know which, and
 *   `never` satisfies both (dogfooding caught `ctaLink: null` vs `ctaLink?: string` flagging a
 *   fresh recording). The cost, accepted like the undefined-key omission: null-related NARROWING of
 *   a field's type is not caught by the check.
 */
type Recorded<T> = T extends null
  ? never
  : T extends Date | RegExp | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
    ? T
    : T extends object
      ? { -readonly [K in keyof T]: Recorded<T[K]> }
      : T

/**
 * The drift check: `unknown` (a no-op intersection) when compatible, the branded error otherwise.
 * Three gates, in order:
 *
 * - `F` is `unknown` (or `any`): no Fixture type is claimed — the bare-`Plate` wildcard, a plate with
 *   no recorded Fixture, or a cyclic fixture's `as any` fallback. Never error.
 * - `T` is exactly `undefined`: no `data` prop at this site (the generic default), so Replay has
 *   nothing to satisfy. Never error.
 * - Otherwise require `Recorded<F> extends T`: the recorded value must satisfy the declared `data`
 *   type, since Replay substitutes it in front of the render prop. `F` is the fixture export's `as
 *   const` type (ADR 0031 §3) — exact literals and tuples, which extend both widened primitives and
 *   literal-union discriminants, so bare `extends` is sound with no widening policy at all;
 *   `Recorded` only strips the const-assertion readonly and neutralizes recorded nulls.
 */
type FixtureCheck<F, T> = [unknown] extends [F]
  ? unknown
  : [T] extends [undefined]
    ? unknown
    : [Recorded<F>] extends [T]
      ? unknown
      : FixtureOutOfDate<F, T>

/** Fields shared by both `root` variants of `<Skeleton>`. */
interface SkeletonBase<T, F> {
  /**
   * The plate to render while loading, imported from `virtual:xray/plates/<name>`. When a recorded
   * Fixture's declare block in the generated `xray-env.gen.d.ts` types the import as `Plate<F>`,
   * the intersection enforces the typed-fixtures drift check (`FixtureOutOfDate`) against the
   * `data` prop's `T`.
   */
  plate: Plate<F> & FixtureCheck<F, T>
  /**
   * Inline skeleton css for a plate whose styling does NOT flow through the Vite plugin's CSS
   * pipeline — i.e. a runtime-captured plate from `@hueest/xray/core`'s `captureElement` (ADR 0003:
   * the no-Vite path). Pass the composed string (`composeCss(css)` for the standard BASE_CSS +
   * plate rules); it is injected as a `<style>` on the skeleton root. OMIT for plugin-imported
   * plates — their css (base included) is already on the page via `virtual:xray/base.css` +
   * `virtual:xray/plates/<name>.css`, and an inline copy would double-apply and re-fight the
   * cascade. Applies to THIS plate's root only; stitched child plates resolve through refs/the dev
   * store and carry no inline css.
   */
  css?: string
  /**
   * Explicit readiness mode: render the Skeleton while true, then render children and capture them
   * in dev when false.
   */
  loading?: boolean
  /**
   * Suspense mode: make `<Skeleton>` the Suspense boundary and use the Plate as the fallback until
   * children resolve.
   */
  suspense?: boolean
  /** Shown while loading when the plate has no capture yet. */
  fallback?: ReactNode
  /** Override the plugin's settle delay before this site is captured (dev only). */
  delay?: number
  /**
   * Programmable capture walker for this Skeleton's subtree (ADR 0018, dev only). The escape hatch
   * beyond the declarative `data-xr-*` hints: a closure that decides, per element, whether to
   * ignore it, collapse it to one Bone, or defer to the built-in walk. Threaded through the dev
   * adapter into `captureView`; PRODUCTION ignores it entirely (it never captures). On both `root`
   * variants of the union, so a manual root may carry one too.
   */
  captureWalker?: XrayCaptureWalker
  /**
   * Per-Skeleton Collect limits (ADR 0022, dev only): override the plugin's `collect` defaults for
   * THIS boundary's capture. Flat primitives — not a nested object — so they stay referentially
   * stable across renders and never churn the dev capture effect's deps. `maxNodes` caps total
   * surviving nodes, `maxBreadth` the widest level, `maxDepth` the nesting depth; an omitted
   * `maxNodes` derives from the resolved breadth × depth. PRODUCTION ignores them (it never
   * captures).
   */
  maxNodes?: number
  maxBreadth?: number
  maxDepth?: number
}

/**
 * Props accepted by the React `<Skeleton>` component, generic over the optional render-prop `data`
 * payload `T` (ADR 0014). The generic defaults to `undefined` so existing call sites — `<Skeleton
 * plate loading />`, plain children — keep working with zero type arguments; passing `data` infers
 * `T` into the render prop. `data` is a pure pass-through (the consumer owns nullability), never
 * `NonNullable<T>`.
 *
 * The two members discriminate on `root`:
 *
 * - `root="auto"` (default): the existing `display:contents` boundary wrapper marks the capture seam
 *   (ADR 0006); children may be plain `ReactNode` OR a render prop, and the surfaced `ref` is a
 *   no-op.
 * - `root="manual"`: no wrapper; the consumer owns the capture root element. This REQUIRES
 *   render-prop children (the only way to hand back the `ref` that writes the boundary marker), so
 *   plain children + `root="manual"` is a type error.
 *
 * The second generic `F` is the plate's recorded-Fixture type (typed fixtures, ADR 0031), inferred
 * from the `plate` prop; its `unknown` default keeps every un-fixture'd call site unchecked. It is
 * never written explicitly at a call site.
 */
export type SkeletonProps<T = undefined, F = unknown> = SkeletonBase<T, F> &
  (
    | {
        /** Auto capture root (default): xray inserts a `display:contents` boundary wrapper. */
        root?: 'auto'
        /** Render-prop payload, passed back to the children function verbatim as `T`. */
        data?: T
        /**
         * Real content. In dev, these children are also the capture source once ready. Either plain
         * `ReactNode` or a render prop.
         */
        children?: ReactNode | SkeletonRenderProp<T>
      }
    | {
        /**
         * Manual capture root: the consumer's element owns the boundary marker; no wrapper (ADR
         * 0014).
         */
        root: 'manual'
        /** Render-prop payload, passed back to the children function verbatim as `T`. */
        data?: T
        /**
         * Render prop required: spread the supplied `ref` onto your root element so capture does
         * not leak into the parent plate.
         */
        children: SkeletonRenderProp<T>
      }
  )

/** Narrow unknown children to the render-prop form. */
export function isRenderProp<T>(
  children: ReactNode | SkeletonRenderProp<T>,
): children is SkeletonRenderProp<T> {
  return typeof children === 'function'
}

/**
 * Resolve `<Skeleton>` content at the ready (`loading=false`) path: invoke the render prop with the
 * verbatim `data` and the adapter's `ref` (a no-op in prod and in `root="auto"`, the
 * boundary-writing callback in dev `root="manual"`), or pass plain children through untouched.
 * Centralizes the single `data as T` step: `data` is declared `data?: T`, so it reads back as `T |
 * undefined`, but it is the exact value the consumer passed for the render prop's `T` (ADR 0014
 * keeps it a pass-through, not `NonNullable<T>`).
 */
export function resolveContent<T>(
  children: ReactNode | SkeletonRenderProp<T>,
  data: T | undefined,
  ref?: SkeletonRef,
): ReactNode {
  if (!isRenderProp<T>(children)) return children
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- data is the consumer's T pass-through (ADR 0014).
  return children({ data: data as T, ref })
}

/**
 * The token defaults that mirror the BASE_CSS `var(--xr-skeleton-*, …)` fallbacks (ADR 0016). The
 * hook reads the COMPUTED token off the boundary element, but a consumer who never sets it leaves
 * the computed value empty (the tokens are not declared on `.xr-root`, only referenced with these
 * inline fallbacks). So when a read comes back empty/unparseable the hook falls back to these same
 * numbers, keeping the JS hold and the CSS reveal in lockstep on identical defaults.
 */
const DEFAULT_SKELETON_DELAY_MS = 250
const DEFAULT_SKELETON_MIN_DURATION_MS = 600

/**
 * Parse a CSS time token (`getPropertyValue` returns a trimmed string like `"250ms"`, `"0.6s"`, or
 * `""`) to milliseconds, falling back to `fallback` when empty or unparseable. Supports `ms` and
 * `s`; a bare number is treated as ms.
 */
function parseMs(value: string, fallback: number): number {
  const text = value.trim()
  if (text === '') return fallback
  const match = /^(-?[\d.]+)(ms|s)?$/.exec(text)
  if (!match?.[1]) return fallback
  const n = Number.parseFloat(match[1])
  if (!Number.isFinite(n)) return fallback
  return match[2] === 's' ? n * 1000 : n
}

/**
 * The min-duration hold (ADR 0016), shared by the production (`react.tsx`) and dev
 * (`react.dev.tsx`) adapters so both keep identical timing. Returns whether the skeleton should
 * render RIGHT NOW.
 *
 * The reveal DELAY is pure CSS (BASE_CSS `--xr-reveal`, zero JS); this hook is ONLY the part CSS
 * cannot express: keeping the skeleton mounted past `loading=false` for a minimum visible window.
 * The hook returns `loading || holding`: the `loading` term is SYNCHRONOUS, so the skeleton shows
 * on the very render `loading` flips true (no content frame at a false→true restart, and no
 * stale-state lag), and `holding` is state used SOLELY for the post-ready hold.
 *
 * While loading, an effect anchors `t0` (loading start) and pre-arms `holding` true, so that
 * pre-armed value carries into the first `loading=false` render with no content flash at the
 * true→false transition. When `loading` flips false the effect reads the COMPUTED
 * `--xr-skeleton-delay` + `--xr-skeleton-min-duration` off `ref` and holds until `t0 + delay +
 * min-duration`. Three cases skip the hold entirely (swap synchronously, no timer): min-duration
 * resolves to 0; `ref` is null / no `t0` was recorded — meaning no skeleton root was ever shown
 * (e.g. a plate with no capture, just a fallback), so there is nothing to hold and a hold would
 * only keep blank/fallback UI on screen after data is ready; or `loading` resolved inside the grace
 * delay — the skeleton is still in its invisible window (BASE_CSS reveals at `t0 + delay`), so no
 * visible-time floor is owed and the fast load never sees a skeleton (ADR 0016).
 *
 * Reading computed custom props off the skeleton root: the root carries `display:contents`, but
 * custom-property inheritance and resolution are unaffected by `display` —
 * `getComputedStyle(el).getPropertyValue('--xr-…')` returns the inherited token value on a
 * `display:contents` element just as on any other. The tokens are not declared on `.xr-root` (only
 * referenced with inline fallbacks), so a consumer who never themes them yields an empty read;
 * `parseMs` then applies the same defaults the CSS uses, so the hold matches the reveal.
 */
export function useSkeletonTiming(loading: boolean, ref: RefObject<Element | null>): boolean {
  // `holding` covers ONLY the post-ready min-duration window; `loading` is the
  // synchronous show term (see the `loading || holding` return). Initialize to
  // `loading` so SSR/first render matches the synchronous term.
  const [holding, setHolding] = useState(loading)
  // Loading-start timestamp for the current loading episode; null while ready or
  // before a loading episode ran (no skeleton was ever shown → no hold).
  const startRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }

    if (loading) {
      // Loading (re-)started: anchor t0, drop any pending swap timer, and pre-arm
      // `holding` so it carries into the first `loading=false` render — no content
      // frame at the true→false transition. The skeleton is already on screen this
      // render via the synchronous `loading` term, so there is no false→true flash.
      clear()
      if (startRef.current === null) startRef.current = Date.now()
      setHolding(true)
      return clear
    }

    // loading=false: decide whether to swap now or hold to the min-duration floor.
    const start = startRef.current
    startRef.current = null
    const el = ref.current
    // No skeleton was actually shown — no root element, or no loading episode
    // recorded a t0 (e.g. a no-capture plate that only rendered a fallback, or an
    // initial `loading=false` mount). Swap immediately: a hold here would just keep
    // blank/fallback UI on screen ~850ms after the data is already ready.
    if (el === null || start === null) {
      clear()
      setHolding(false)
      return clear
    }
    const style = getComputedStyle(el)
    const delay = parseMs(style.getPropertyValue('--xr-skeleton-delay'), DEFAULT_SKELETON_DELAY_MS)
    const minDuration = parseMs(
      style.getPropertyValue('--xr-skeleton-min-duration'),
      DEFAULT_SKELETON_MIN_DURATION_MS,
    )

    // min-duration 0 → swap synchronously, no timer (zero-cost common path).
    if (minDuration <= 0) {
      clear()
      setHolding(false)
      return clear
    }

    // Resolved inside the grace delay: the skeleton is still invisible (BASE_CSS
    // reveals it at start + delay), so no visible-time floor is owed. Swap now and
    // unmount before the reveal fires — the fast load never shows a skeleton.
    if (Date.now() < start + delay) {
      clear()
      setHolding(false)
      return clear
    }

    // The skeleton becomes visible at start + delay; the floor runs from there.
    const remaining = start + delay + minDuration - Date.now()
    if (remaining <= 0) {
      clear()
      setHolding(false)
      return clear
    }
    clear()
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      setHolding(false)
    }, remaining)
    return clear
  }, [loading, ref])

  // `loading` is synchronous (covers the show-now and false→true cases); `holding`
  // carries the post-ready min-duration window.
  return loading || holding
}

/**
 * Layout-neutral wrapper for an HTML island sitting beside React stitch nodes — its children
 * participate in the grandparent's flow, so grid/flex item counts are unchanged.
 */
const DISPLAY_CONTENTS = { display: 'contents' } as const

/**
 * Render a shipped plate's skeleton. `resolveStitch` turns a child plate name into the node that
 * mounts it (static `refs` in prod, a store-subscribed component in dev). `nested` is true for a
 * stitch-mounted child. Returns null when the plate has no capture yet; the caller renders the
 * fallback.
 *
 * Two-artifact contract (ADR 0026): a `Plate` is tree-only, and this renderer neither reads css off
 * it nor references `BASE_CSS` (keeping the constant out of consumer bundles — Vite-path styling is
 * entirely the CSS pipeline's job: `virtual:xray/base.css` + `virtual:xray/plates/<name>.css`).
 * `css` is the one optional styling input: the consumer-composed inline css for a runtime-captured
 * (`@hueest/xray/core`) plate, threaded from the `<Skeleton css>` prop and injected as a `<style>`
 * on this root. It rides the OUTERMOST root only — the adapters never pass it for a nested stitch
 * (the page-level/base styles are already in scope there, ADR 0007's once-per-page rule by
 * construction).
 *
 * `instant` (ADR 0020) marks this root a stitch continuation: a standalone `<Skeleton>` replacing a
 * stitch a still-showing parent was just rendering. It lands as `data-xr-instant` on the OUTERMOST
 * root only (`instant && !nested`) so BASE_CSS reveals it without the `--xr-skeleton-delay` fade.
 */
export function renderPlate(
  plate: Plate,
  resolveStitch: (name: string) => ReactNode,
  nested: boolean,
  rootRef?: Ref<HTMLDivElement>,
  instant?: boolean,
  css?: string,
): ReactNode {
  if (!plate.chunks) return null
  // The root carries the base root class plus any content classes of its own.
  const className = plate.rootCls ? `${ROOT_CLASS} ${plate.rootCls}` : ROOT_CLASS
  // `rootRef` lands on the rendered skeleton root so `useSkeletonTiming` can read
  // the computed `--xr-skeleton-*` tokens off it (ADR 0016). Only the outermost
  // view gets it (a nested stitch passes none); a nested stitch never receives a
  // ref, so its root div stays untouched.
  const rootAttrs = {
    [ROOT_ATTR]: plate.name,
    className,
    'aria-hidden': true,
    'aria-busy': true,
    ...(rootRef ? { ref: rootRef } : {}),
    // The instant-reveal marker (ADR 0020) rides only the outermost root: a
    // standalone Skeleton replacing a still-live stitch reveals without the
    // `--xr-skeleton-delay` fade. A nested stitch inherits its parent's reveal
    // and has no `@starting-style` of its own, so it never carries the marker.
    ...(instant && !nested ? { [ROOT_INSTANT_ATTR]: '' } : {}),
  }
  const chunks = plate.chunks
  // A stitch-free plate is one string — inject the blob (plus the optional
  // inline css) on the root directly, no wrapper, no React subtree.
  if (chunks.length === 1 && typeof chunks[0] === 'string') {
    if (css === undefined)
      return <div {...rootAttrs} dangerouslySetInnerHTML={{ __html: chunks[0] }} />
    // `css` rides into a raw-text `<style>` STRING fed to dangerouslySetInnerHTML;
    // it is consumer input (untrusted at render time), so neutralize any
    // `</style>`/comment terminators first. A well-formed css string (all the
    // capture path emits, `composeCss` included) is unchanged by the escape.
    const html = `<style>${escapeStyleText(css)}</style>${chunks[0]}`
    return <div {...rootAttrs} dangerouslySetInnerHTML={{ __html: html }} />
  }
  // Stitched: the chunk islands interleaved with stitches, plus a real <style>
  // when inline css was passed. Here `css` is a React text child, which React
  // escapes — no raw-text break-out.
  return (
    <div {...rootAttrs}>
      {css === undefined ? null : <style>{css}</style>}
      {renderChunks(chunks, resolveStitch)}
    </div>
  )
}

/**
 * Each `string` chunk is injected as a display:contents innerHTML island; each `{ r }` stitch
 * resolves through `resolveStitch`; a `{ c, k }` node stays a real element and recurses (it holds a
 * stitch deeper). No per-node tree walk — the strings are already serialized.
 */
function renderChunks(chunks: Chunk[], resolveStitch: (name: string) => ReactNode): ReactNode[] {
  return chunks.map((chunk, i) => {
    if (typeof chunk === 'string') {
      return <div key={i} style={DISPLAY_CONTENTS} dangerouslySetInnerHTML={{ __html: chunk }} />
    }
    // A template chunk (Template, ADR 0022): inject the cell's HTML repeated
    // `n` times as one display:contents island, so the N copies participate in
    // the parent's flex/grid flow exactly as the original cells did.
    if ('t' in chunk) {
      return (
        <div
          key={i}
          style={DISPLAY_CONTENTS}
          dangerouslySetInnerHTML={{ __html: chunk.t.repeat(chunk.n) }}
        />
      )
    }
    if ('r' in chunk) return <Fragment key={i}>{resolveStitch(chunk.r)}</Fragment>
    return (
      <div key={i} className={chunk.c}>
        {renderChunks(chunk.k, resolveStitch)}
      </div>
    )
  })
}

/**
 * A never-settling promise for the loading suspender below. It never needs to resolve: React
 * retries a suspended boundary when its parent re-renders with new props (here, `loading` flipping
 * to false), so the prop change — not the promise — drives recovery.
 */
const SUSPEND_UNTIL_READY: Promise<never> = new Promise(() => {})

/**
 * Suspends while `loading` is true. It exists so a `suspense`-mode `<Skeleton>` can show its plate
 * through the ONE Suspense fallback across BOTH readiness phases — the data-loading phase (this
 * suspender) AND the lazy code-chunk phase (the content itself suspending). Because the plate is
 * the SAME fallback DOM node the whole time, there is no unmount/remount between the two phases and
 * thus no flicker (a top-level `return skeleton` for the data phase followed by a Suspense-fallback
 * skeleton for the chunk phase would sit at different tree positions and remount). While this
 * throws, the content sibling is never committed, preserving "children never render without data"
 * (ADR 0002).
 */
export function SuspendWhileLoading({ loading }: { loading: boolean }): null {
  if (loading) throw SUSPEND_UNTIL_READY
  return null
}
