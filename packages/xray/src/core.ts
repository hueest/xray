/**
 * The framework-neutral core (ADR 0008) — capture a live DOM subtree into a Plate and the plate
 * primitives, with no Vite plugin and no framework adapter.
 *
 * This is the **public, framework-neutral capture/render utility surface**: the supported home for
 * low-level capture and serialization. Reach `captureElement` and `serializePlate` here, not
 * through any separate `./serialize` subpath. (The per-framework _renderer_ core in
 * `react.core.tsx` stays internal; this surface is what's published.)
 *
 * Use it to capture and render skeletons directly: demos, playgrounds, tests, or a non-React
 * integration. The usual flow is the plugin (browse-time capture into committed `src/plates/`) plus
 * an adapter's `<Skeleton>`; this is the layer beneath both, for when you want to drive capture
 * yourself at runtime.
 *
 * Two-artifact contract (ADR 0026): capture produces the structural TREE (`Plate`) and its scoped
 * CSS string as INDEPENDENT artifacts, and the render side receives them independently — consumers
 * decide how to render either part. The standard composition prepends `BASE_CSS` (exported here) to
 * the plate's css; `composeCss` does exactly that:
 *
 * ```ts
 * const { plate, css } = captureElement([el], { name: 'demo' })
 * host.innerHTML = renderPlateHtml(plate, composeCss(css))
 * // or with the React adapter:
 * // <Skeleton plate={plate} css={composeCss(css)} loading />
 * ```
 *
 * @module @hueest/xray/core
 */
export { CaptureTooLargeError, defineXrayCaptureWalker } from './measure.ts'
export type {
  CaptureOptions,
  CaptureWalkerContext,
  WalkerDecision,
  XrayCaptureWalker,
  CollectLimits,
  CaptureSize,
  CollectAxis,
} from './measure.ts'
export { serializePlate, collectRefs } from './chunk.ts'
export { BASE_CSS, composeCss, emptyPlate } from './plate.ts'
export type { Plate, GatedPlate, ViewCapture, PlateNode, LeafKind } from './plate.ts'

import { captureView, distilPlate, type CaptureOptions } from './measure.ts'
import { serializePlateIR } from './serialize.ts'
import { serializePlate } from './chunk.ts'
import { escapeStyleText } from './css-escape.ts'
import { type Chunk, type Plate, ROOT_ATTR, ROOT_CLASS } from './plate.ts'

/**
 * Capture a live DOM subtree straight to the two renderable artifacts: the structural `plate`
 * (tree, lowered to chunks) and its scoped `css` string — independent parts, per the two-artifact
 * contract. Runs the same uniform pipeline the dev client does for a single View — measure
 * (`captureView`), distil (`distilPlate`), project (`serializePlateIR` → the structured
 * `StoredPlate`), then lower to chunks (`serializePlate`) — in one call. `roots` are the top-level
 * elements to capture (a component's rendered roots). Render however suits: `renderPlateHtml(plate,
 * composeCss(css))`, or `<Skeleton plate={plate} css={composeCss(css)}>` with the React adapter.
 *
 * `options.walker` is the public programmable capture walker (ADR 0018): the same
 * `XrayCaptureWalker` the `<Skeleton captureWalker>` prop threads through in dev, available here
 * for driving capture directly. It is capture-only and never persisted into the returned
 * artifacts.
 */
export function captureElement(
  roots: readonly Element[],
  options: CaptureOptions,
): { plate: Plate; css: string } {
  const plateIR = captureView(roots, {
    collect: options.collect,
    walker: options.walker,
    captureRootIsBoundary: options.captureRootIsBoundary,
  })
  plateIR.name = options.name
  distilPlate(plateIR)
  const stored = serializePlateIR(plateIR)
  return { plate: serializePlate(stored), css: stored.css }
}

/**
 * Render a stitch-free Plate to an HTML string — the framework-neutral equivalent of `<Skeleton
 * plate loading />`, for when you don't want to pull a framework adapter (demos, plain DOM, server
 * strings). Drop it in with `el.innerHTML = renderPlateHtml(plate, composeCss(css))` or React's
 * `dangerouslySetInnerHTML`.
 *
 * `css` is the caller's explicit input (two-artifact contract): pass `composeCss(css)` for the
 * standard BASE_CSS + plate-rules composition (BASE_CSS is what makes bones paint and pulse), the
 * raw capture css if the base rules are already on the page, or your own composition. Stitched
 * plates (a nested `<Skeleton>`) need an adapter to mount their child plates, so they throw here.
 */
export function renderPlateHtml(plate: Plate, css: string): string {
  const chunks = plate.chunks
  if (!chunks) return ''
  const className = plate.rootCls ? `${ROOT_CLASS} ${plate.rootCls}` : ROOT_CLASS
  // The css input is untrusted at render time (it can come from a hand-edited
  // committed file or arrive over git) and lands raw inside a raw-text
  // `<style>` string here, so neutralize any `</style>`/comment terminators
  // before interpolating. A well-formed css string (all the capture path ever
  // emits, and BASE_CSS via composeCss) is unchanged by the escape.
  return `<div ${ROOT_ATTR}="${plate.name}" class="${className}" aria-hidden="true" aria-busy="true"><style>${escapeStyleText(css)}</style>${chunksToHtml(chunks)}</div>`
}

/**
 * Flatten chunks to one HTML string. A `string` concatenates; a template chunk (`{ t, n }`) expands
 * to its cell repeated `n` times (the cell is stitch-free by construction); a stitch-free wrapper
 * (`{ c, k }`) recurses inside a real `<div>`. A stitch (`{ r }`) resolves to a child plate at
 * render and needs a framework adapter to mount, so a stitched plate throws here. Chunk HTML is
 * xray-generated and safe to interpolate raw.
 */
function chunksToHtml(chunks: readonly Chunk[]): string {
  let html = ''
  for (const chunk of chunks) {
    if (typeof chunk === 'string') html += chunk
    else if ('t' in chunk) html += chunk.t.repeat(chunk.n)
    else if ('r' in chunk)
      throw new Error(
        'xray: renderPlateHtml renders stitch-free plates only — use a framework adapter for stitched plates',
      )
    else html += `<div class="${chunk.c}">${chunksToHtml(chunk.k)}</div>`
  }
  return html
}
