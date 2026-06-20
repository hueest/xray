/**
 * CROP — Phase-2 past-the-fold drop (capture-pipeline Phase 2). 2D.
 *
 * Drops every Bone whose box sits past the FOLD on EITHER axis — TOP below the visible BOTTOM, or
 * LEFT past the visible RIGHT edge, of its NEAREST CLIPPING CONTEXT (a vertically- OR
 * horizontally-scrolling / overflow ancestor, or the viewport as the base case) × CROP_BUFFER —
 * then orphan-prunes the emptied containers. Annotate-only (`dropped: { reason: 'cropped' }`);
 * `emit` lowers it.
 *
 * Tested directly on a built IR with EXPLICIT numbers — `cropIR` is a pure `IRNode` mutation over
 * snapshotted boxes + raw clip inputs, so no DOM/layout engine is needed (happy-dom has none, and
 * there every box is 0×0 so cropIR is a no-op — these tests feed real numbers a layout would have
 * produced).
 */
import { describe, expect, it } from 'vitest'

import { cropIR } from './distil.ts'
import {
  emit,
  EMPTY_STYLE,
  type IRBundle,
  type IRNode,
  type IRRect,
  type LiteStyleDeclaration,
} from './ir.ts'
import { createDiagnostics } from './diagnostics.ts'

function box(x: number, y: number, width: number, height: number): IRRect {
  return { x, y, width, height }
}

/** A `LiteStyleDeclaration` from a partial override, the rest empty strings (EMPTY_STYLE). */
function style(over: Partial<LiteStyleDeclaration> = {}): LiteStyleDeclaration {
  return { ...EMPTY_STYLE, ...over }
}

function leaf(id: number, kind: IRNode['kind'], b: IRRect, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: null,
    kind,
    kids: [],
    depth: 0,
    decls: { fallback: ['display: block'] },
    style: style(),
    box: b,
    ...over,
  }
}

function container(id: number, kids: IRNode[], b?: IRRect): IRNode {
  return {
    id,
    el: null,
    kind: 'container',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: style(),
    box: b,
  }
}

/**
 * A vertically-clipping container: carries the raw clip inputs the walk snapshots (computed
 * `overflow-y` + `scrollHeight`/`clientHeight`). cropIR derives whether it actually clips
 * (`scrollHeight > clientHeight + 1`) and uses its box bottom as the fold for its children.
 */
function clipContainer(
  id: number,
  kids: IRNode[],
  b: IRRect,
  clip: { overflowY: string; scrollHeight: number; clientHeight: number },
): IRNode {
  return {
    id,
    el: null,
    kind: 'container',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: style({ overflowY: clip.overflowY }),
    box: b,
    scrollHeight: clip.scrollHeight,
    clientHeight: clip.clientHeight,
  }
}

/**
 * A HORIZONTALLY-clipping container (a carousel): carries the x-axis clip inputs the walk snapshots
 * (computed `overflow-x` + `scrollWidth`/`clientWidth`). cropIR derives whether it actually clips
 * (`scrollWidth > clientWidth + 1`) and uses its box RIGHT edge as the fold for its children. The
 * mirror of `clipContainer`.
 */
function clipContainerX(
  id: number,
  kids: IRNode[],
  b: IRRect,
  clip: { overflowX: string; scrollWidth: number; clientWidth: number },
): IRNode {
  return {
    id,
    el: null,
    kind: 'container',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: style({ overflowX: clip.overflowX }),
    box: b,
    scrollWidth: clip.scrollWidth,
    clientWidth: clip.clientWidth,
  }
}

function root(kids: IRNode[]): IRNode {
  return { id: 0, el: null, kind: 'root', kids, depth: 0, decls: { fallback: [] }, style: style() }
}

/**
 * Run Crop for the VERTICAL axis under test: the horizontal fold is wide (Infinity) so only
 * `viewportHeight` (and the y-clip ancestors) bite — keeping every existing vertical test's
 * behavior identical under the 2D arity.
 */
function crop(tree: IRNode, viewportHeight: number): number {
  const diagnostics = createDiagnostics()
  cropIR(tree, viewportHeight, Number.POSITIVE_INFINITY, diagnostics)
  return diagnostics.list().find((d) => d.code === 'dropped-cropped')?.count ?? 0
}

/**
 * Run Crop for the HORIZONTAL axis under test: the vertical fold is wide (Infinity) so only
 * `viewportWidth` (and the x-clip ancestors) bite.
 */
function cropX(tree: IRNode, viewportWidth: number): number {
  const diagnostics = createDiagnostics()
  cropIR(tree, Number.POSITIVE_INFINITY, viewportWidth, diagnostics)
  return diagnostics.list().find((d) => d.code === 'dropped-cropped')?.count ?? 0
}

describe('cropIR — below-the-fold drop (Phase 2)', () => {
  it('drops a leaf below the buffered window fold, keeps one above it', () => {
    // viewport 1000, buffer 1.5 → fold 1500.
    const below = leaf(1, 'box', box(0, 1600, 100, 40)) // top 1600 > 1500 → dropped
    const above = leaf(2, 'box', box(0, 1400, 100, 40)) // top 1400 < 1500 → kept
    const tree = root([below, above])
    expect(crop(tree, 1000)).toBe(1)
    expect(below.dropped).toEqual({ reason: 'cropped' })
    expect(above.dropped).toBeUndefined()
  })

  it('keeps a leaf straddling the fold (we test TOP, not overlap/bottom)', () => {
    // top 1400 (above the 1500 fold), height 400 → bottom 1800 (below) → KEPT.
    const straddle = leaf(1, 'box', box(0, 1400, 100, 400))
    const tree = root([straddle])
    expect(crop(tree, 1000)).toBe(0)
    expect(straddle.dropped).toBeUndefined()
  })

  it('uses a scroll container fold for its children, the window fold for siblings outside it', () => {
    // The container clips at box.bottom 500 (overflow:auto, scrollHeight 2000 >
    // clientHeight 400). Buffered fold for its child: 1.5 × 500 = 750.
    const inner = leaf(2, 'box', box(0, 800, 100, 40)) // top 800 > 750 → dropped
    const scroller = clipContainer(1, [inner], box(0, 0, 100, 500), {
      overflowY: 'auto',
      scrollHeight: 2000,
      clientHeight: 400,
    })
    // A sibling OUTSIDE the scroller: only the window fold (1.5 × 1000 = 1500)
    // applies, so top 800 is far above it → kept.
    const sibling = leaf(3, 'box', box(0, 800, 100, 40))
    const tree = root([scroller, sibling])
    expect(crop(tree, 1000)).toBe(1)
    expect(inner.dropped).toEqual({ reason: 'cropped' })
    expect(sibling.dropped).toBeUndefined()
    // The scroller orphans (its only live child was cropped).
    expect(scroller.dropped).toEqual({ reason: 'orphaned' })
  })

  it('does not treat a non-overflowing container as a fold', () => {
    // overflow:auto but scrollHeight 300 <= clientHeight 400 → NOT clipping. Its
    // child is judged by the window fold (1500) only, so top 800 is kept.
    const child = leaf(2, 'box', box(0, 800, 100, 40))
    const notScrolling = clipContainer(1, [child], box(0, 0, 100, 500), {
      overflowY: 'auto',
      scrollHeight: 300,
      clientHeight: 400,
    })
    const tree = root([notScrolling])
    expect(crop(tree, 1000)).toBe(0)
    expect(child.dropped).toBeUndefined()
  })

  it('does not treat an overflow:visible container as a fold', () => {
    // No clip inputs snapshotted (overflow:visible at measure → skipped). Child
    // judged by the window fold only; top 800 < 1500 → kept.
    const child = leaf(2, 'box', box(0, 800, 100, 40))
    const visible = container(1, [child], box(0, 0, 100, 500))
    const tree = root([visible])
    expect(crop(tree, 1000)).toBe(0)
    expect(child.dropped).toBeUndefined()
  })

  it('takes the tightest (min) bottom across nested clip contexts', () => {
    // Outer clips at 900, inner clips at 300 — the inner (tighter) bottom wins for
    // the deepest child. Buffered fold for the child: 1.5 × 300 = 450.
    const deep = leaf(3, 'box', box(0, 500, 50, 20)) // top 500 > 450 → dropped
    const inner = clipContainer(2, [deep], box(0, 0, 50, 300), {
      overflowY: 'auto',
      scrollHeight: 1000,
      clientHeight: 200,
    })
    const outer = clipContainer(1, [inner], box(0, 0, 100, 900), {
      overflowY: 'scroll',
      scrollHeight: 3000,
      clientHeight: 800,
    })
    const tree = root([outer])
    expect(crop(tree, 5000)).toBe(1) // window fold huge; the inner clip is what bites
    expect(deep.dropped).toEqual({ reason: 'cropped' })
  })

  it('orphans a container whose only child is cropped', () => {
    const onlyChild = leaf(2, 'box', box(0, 1600, 100, 40)) // below the 1500 fold
    const branch = container(1, [onlyChild], box(0, 1600, 100, 40))
    const tree = root([branch])
    crop(tree, 1000)
    expect(onlyChild.dropped).toEqual({ reason: 'cropped' })
    expect(branch.dropped).toEqual({ reason: 'orphaned' })
  })

  it('keeps a container with one cropped + one surviving child', () => {
    const dropped = leaf(2, 'box', box(0, 1600, 100, 40)) // below fold → cropped
    const survives = leaf(3, 'box', box(0, 200, 100, 40)) // above fold → kept
    const branch = container(1, [dropped, survives], box(0, 0, 100, 100))
    const tree = root([branch])
    crop(tree, 1000)
    expect(dropped.dropped).toEqual({ reason: 'cropped' })
    expect(survives.dropped).toBeUndefined()
    expect(branch.dropped).toBeUndefined() // a live bone remains → branch kept
  })

  it('crops a boxless text-block via its nearest box-bearing ancestor box', () => {
    // A multi-line text-block reflow bone is created WITHOUT a box (it sizes via
    // @container bands). Its rendered extent is its <p> ancestor's box — which here
    // sits below the fold — so it must still be cropped (mirrors the superset case).
    const textBlock: IRNode = {
      id: 3,
      el: null,
      kind: 'text-block',
      kids: [],
      depth: 0,
      decls: { fallback: [] },
      style: style(),
    }
    const para = container(2, [textBlock], box(0, 1700, 160, 60)) // the <p>, below the fold
    const tree = root([para])
    expect(crop(tree, 1000)).toBe(1)
    expect(textBlock.dropped).toEqual({ reason: 'cropped' })
    expect(para.dropped).toEqual({ reason: 'orphaned' })
  })

  it('keeps a degenerate (no measured box) leaf — no rect to test', () => {
    const ghost = leaf(1, 'box', box(0, 9999, 0, 0)) // 0×0 → edgesOf null, no rect
    const tree = root([ghost])
    expect(crop(tree, 1000)).toBe(0)
    expect(ghost.dropped).toBeUndefined()
  })

  it('records the dropped-cropped diagnostic count', () => {
    const a = leaf(1, 'box', box(0, 1600, 100, 40))
    const b = leaf(2, 'box', box(0, 1700, 100, 40))
    const tree = root([a, b])
    expect(crop(tree, 1000)).toBe(2)
  })
})

describe('cropIR — horizontal (off-screen-right) drop (2D, Phase 2)', () => {
  it('drops a carousel card past the buffered right fold, keeps the in-fold ones', () => {
    // A horizontal carousel: overflow-x:auto, scrollWidth 4000 > clientWidth 600, so
    // it clips at its box RIGHT (600). Buffered fold for its cards: 1.5 × 600 = 900.
    const c1 = leaf(2, 'box', box(0, 0, 200, 300)) // left 0 < 900 → kept
    const c2 = leaf(3, 'box', box(300, 0, 200, 300)) // left 300 < 900 → kept
    const c3 = leaf(4, 'box', box(1000, 0, 200, 300)) // left 1000 > 900 → dropped
    const c4 = leaf(5, 'box', box(2000, 0, 200, 300)) // left 2000 > 900 → dropped
    const carousel = clipContainerX(1, [c1, c2, c3, c4], box(0, 0, 600, 300), {
      overflowX: 'auto',
      scrollWidth: 4000,
      clientWidth: 600,
    })
    const tree = root([carousel])
    // Window width huge (5000); the carousel's own right-edge clip is what bites.
    expect(cropX(tree, 5000)).toBe(2)
    expect(c1.dropped).toBeUndefined()
    expect(c2.dropped).toBeUndefined()
    expect(c3.dropped).toEqual({ reason: 'cropped' })
    expect(c4.dropped).toEqual({ reason: 'cropped' })
    // The carousel keeps live cards, so it is not orphaned.
    expect(carousel.dropped).toBeUndefined()
  })

  it('OVER-CROP GUARD: a flex-wrap grid (overflow-x visible) is never horizontally cropped', () => {
    // A wrapping grid: overflow-x is VISIBLE (it grows DOWN, wrapping to more rows),
    // so `nodeClipsX` is false → no horizontal tightening. Its items span the full
    // viewport width but every item's LEFT is < innerWidth, so none is off-screen
    // right. None must be cropped — the base-case viewport fold (innerWidth) must not
    // drop normal in-viewport wrapped content.
    // viewport 1440 → buffered fold 1.5 × 1440 = 2160; every left < that → kept.
    const a = leaf(2, 'box', box(0, 0, 440, 200)) // row 1
    const b = leaf(3, 'box', box(500, 0, 440, 200)) // row 1
    const c = leaf(4, 'box', box(1000, 0, 440, 200)) // row 1, left 1000 < 1440 → kept
    const d = leaf(5, 'box', box(0, 220, 440, 200)) // row 2 (wrapped)
    const e = leaf(6, 'box', box(500, 220, 440, 200)) // row 2 (wrapped)
    // overflow-x:visible → no clip inputs snapshotted, so the container does NOT clip x.
    const grid = container(1, [a, b, c, d, e], box(0, 0, 1440, 420))
    const tree = root([grid])
    expect(cropX(tree, 1440)).toBe(0)
    for (const item of [a, b, c, d, e]) expect(item.dropped).toBeUndefined()
    expect(grid.dropped).toBeUndefined()
  })

  it('drops a leaf right of the viewport innerWidth base case (no clipping ancestor)', () => {
    // No clipping ancestor → the base-case horizontal fold is the viewport innerWidth.
    // viewport 1440 → buffered fold 1.5 × 1440 = 2160.
    const offRight = leaf(1, 'box', box(2500, 0, 200, 100)) // left 2500 > 2160 → dropped
    const inView = leaf(2, 'box', box(1200, 0, 200, 100)) // left 1200 < 2160 → kept
    const tree = root([offRight, inView])
    expect(cropX(tree, 1440)).toBe(1)
    expect(offRight.dropped).toEqual({ reason: 'cropped' })
    expect(inView.dropped).toBeUndefined()
  })

  it('keeps an in-viewport card and crops both axes from one pass', () => {
    // One pass folds BOTH axes: a card off-screen RIGHT and a card off-screen BOTTOM
    // both crop, with the same reason; a card inside both folds survives.
    const offBottom = leaf(1, 'box', box(0, 1600, 100, 40)) // top 1600 > 1.5×1000 → cropped (y)
    const offRight = leaf(2, 'box', box(2500, 0, 100, 40)) // left 2500 > 1.5×1440 → cropped (x)
    const inside = leaf(3, 'box', box(100, 100, 100, 40)) // inside both → kept
    const tree = root([offBottom, offRight, inside])
    const diagnostics = createDiagnostics()
    cropIR(tree, 1000, 1440, diagnostics)
    expect(offBottom.dropped).toEqual({ reason: 'cropped' })
    expect(offRight.dropped).toEqual({ reason: 'cropped' })
    expect(inside.dropped).toBeUndefined()
    expect(diagnostics.list().find((d) => d.code === 'dropped-cropped')?.count).toBe(2)
  })

  it('does not treat a non-overflowing overflow-x:auto container as a fold', () => {
    // overflow-x:auto but scrollWidth 500 <= clientWidth 600 → NOT clipping. Its card
    // is judged by the (huge) window fold only, so left 1000 is kept.
    const card = leaf(2, 'box', box(1000, 0, 200, 300))
    const notScrolling = clipContainerX(1, [card], box(0, 0, 600, 300), {
      overflowX: 'auto',
      scrollWidth: 500,
      clientWidth: 600,
    })
    const tree = root([notScrolling])
    expect(cropX(tree, 5000)).toBe(0)
    expect(card.dropped).toBeUndefined()
  })
})

describe('emit — lowers the cropped annotation', () => {
  it('omits a cropped node and its whole branch from tree and rules', () => {
    const grandchild = leaf(4, 'media', box(0, 1610, 10, 10))
    const cropped = leaf(2, 'box', box(0, 1600, 100, 40), { kids: [grandchild] })
    const kept = leaf(3, 'box', box(0, 100, 100, 40))
    const tree = root([cropped, kept])
    crop(tree, 1000)
    expect(cropped.dropped).toEqual({ reason: 'cropped' })
    const bundle: IRBundle = { root: tree, extraRules: [] }
    const out = emit(bundle)
    const ids = (out.tree.kids ?? []).map((k) => k.id)
    expect(ids).toEqual([3]) // cropped (2) and its grandchild (4) gone; kept (3) stays
    expect(out.rules.some((r) => r.ids.includes(2))).toBe(false)
    expect(out.rules.some((r) => r.ids.includes(4))).toBe(false)
    expect(out.rules.some((r) => r.ids.includes(3))).toBe(true)
  })
})
