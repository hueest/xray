/**
 * React adapter for rendering committed Plates through `<Skeleton>`.
 *
 * In production this adapter renders only committed Plate data (its only hooks are the
 * display-timing and instant-reveal ones). During `vite serve`, `xrayVitePlugin()` aliases this
 * export to the dev adapter so ready children can be captured without shipping the capture client,
 * HUD, or Light Box code in production builds.
 *
 * @module @hueest/xray/react
 */
import { type ReactNode, type Ref, Suspense, useEffect, useRef, useState } from 'react'
import type { Plate } from './plate.ts'
import {
  collectStitchNames,
  isStitchLive,
  markStitchesLive,
  type FixtureOutOfDate,
  renderPlate,
  resolveContent,
  type SkeletonProps,
  SuspendWhileLoading,
  useSkeletonTiming,
} from './react.core.tsx'

export type { FixtureOutOfDate, SkeletonProps }

/**
 * Render a committed Plate while content is loading.
 *
 * Use `loading` when your data source exposes an explicit pending state. Use `suspense` when the
 * child suspends; in that mode `<Skeleton>` is the Suspense boundary and the Plate is the fallback.
 * You can also render a bare Skeleton with no children when another framework or router owns the
 * loading boundary.
 *
 * In dev, the plugin aliases this component to the dev adapter. When children are ready, that
 * adapter marks the capture boundary, waits for the subtree to settle, and sends the rendered DOM
 * to the xray client. Nested `<Skeleton>` boundaries become Stitches so a parent Plate records a
 * child Plate reference instead of serializing the child subtree again.
 *
 * In production this component ships no capture client, HUD, Light Box, store, or subscriptions.
 * Stitches resolve from the statically imported `refs` graph.
 */
export function Skeleton<T = undefined, F = unknown>(props: SkeletonProps<T, F>) {
  // `captureWalker` (ADR 0018) is intentionally NOT destructured: production
  // never captures, so the walker has no effect here. It ships only as a type on
  // the props (erased at build) — no walker/capture code reaches the prod
  // bundle, since this module imports nothing from `measure.ts`. Stripping the
  // prop from the type is deferred.
  const { plate, css, loading = false, suspense = false, fallback, children, data } = props
  // The min-duration hold (ADR 0016): the lone hook the prod adapter ships.
  // The ref points at the rendered skeleton root so the hook reads the computed
  // `--xr-skeleton-*` tokens off it; the reveal DELAY stays pure CSS in BASE_CSS.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const showSkeleton = useSkeletonTiming(loading, rootRef)
  // Instant-reveal continuation (ADR 0020). Read ONCE at first render whether this
  // plate is currently a live stitch under a still-showing parent skeleton. A
  // read-once `useState` initializer (not a live read each render) is the point:
  // the decision is fixed for this Skeleton's lifetime, so there is no re-read, no
  // tearing, and no render-purity concern — and it deterministically sees the live
  // entry because the parent marked it in an effect on an earlier commit and only
  // unmarks AFTER this render (render runs before that commit's effects).
  const [instant] = useState(() => isStitchLive(plate.name))
  // Mark this plate's DIRECT stitch names live WHILE the skeleton is showing, so a
  // descendant standalone Skeleton for one of them (mounted when this resolves)
  // reveals instantly. Keyed on `showSkeleton` (the visible-skeleton state through
  // the min-duration hold, ADR 0016), NOT `loading`: during the hold this skeleton
  // and its stitch are still on screen, and the descendant mounts only when
  // `showSkeleton` flips false — at which point its first-render read still sees
  // the live entry (this disposer runs after that render's commit).
  useEffect(() => {
    if (!showSkeleton) return undefined
    return markStitchesLive(collectStitchNames(plate.chunks))
  }, [showSkeleton, plate.chunks])
  const skeleton = (
    <PlateView plate={plate} css={css} fallback={fallback} rootRef={rootRef} instant={instant} />
  )
  // Readiness composes across two ORTHOGONAL axes (ADR 0002, amended): `loading`
  // gates whether the children MOUNT (data readiness — while loading, the plate shows
  // and the render prop is never called, so children never run without data), and
  // `suspense` catches the MOUNTED children while they resolve (a lazy code
  // chunk, or the content itself once it data-suspends).
  //
  // In `suspense` mode the plate must be the SINGLE Suspense fallback across
  // BOTH phases, or it remounts (flickers) between them. So the component ALWAYS
  // returns the Suspense
  // and drives the data phase through a suspender: while loading, `SuspendWhileLoading`
  // throws so the fallback (the plate) shows and the content sibling stays
  // uncommitted; once `!loading`, content mounts and — if its lazy chunk suspends —
  // the SAME fallback keeps showing. One fallback DOM node, no remount.
  if (suspense)
    return (
      <Suspense fallback={skeleton}>
        <SuspendWhileLoading loading={showSkeleton} />
        {resolveContent<T>(children, data)}
      </Suspense>
    )
  // Non-suspense: `loading` is the sole readiness axis.
  if (showSkeleton) return skeleton
  return <>{resolveContent<T>(children, data)}</>
}

/** Render a plate's skeleton, mounting each stitch's child plate from `refs`. */
function PlateView({
  plate,
  css,
  fallback,
  rootRef,
  instant,
}: {
  plate: Plate
  /**
   * Consumer-composed inline css for a runtime-captured plate (two-artifact contract); rides the
   * outermost root only — see `SkeletonBase.css`.
   */
  css?: string
  fallback?: ReactNode
  rootRef?: Ref<HTMLDivElement>
  /** This outermost root is a stitch continuation; reveal it instantly (ADR 0020). */
  instant?: boolean
}) {
  if (!plate.chunks) return <>{fallback ?? null}</>
  return renderStatic(plate, false, rootRef, instant, css)
}

/**
 * Resolve stitches statically through the import graph (ADR 0006) — pure recursion, no store, no
 * subscription. An unknown child renders nothing. The `instant` flag (ADR 0020) and the inline
 * `css` (two-artifact contract) ride the outermost root only; nested stitches pass neither, so
 * `renderPlate` never marks or styles a nested root.
 */
function renderStatic(
  plate: Plate,
  nested: boolean,
  rootRef?: Ref<HTMLDivElement>,
  instant?: boolean,
  css?: string,
): ReactNode {
  return renderPlate(
    plate,
    (name) => {
      const child = plate.refs?.[name]
      return child ? renderStatic(child, true) : null
    },
    nested,
    rootRef,
    instant,
    css,
  )
}
