/**
 * SUPERSET — Phase-2 overlapping-bone collapse (capture-pipeline Phase 2).
 *
 * When a Bone's box sits wholly inside a SOLID Bone's box (`box`/`media` — a filled grey rect), the
 * enclosing Bone supersets it: the two render as one, so the inner one (the `subset`) is annotated
 * `dropped` and `emit` lowers it and any branch the drop empties (`orphaned`). Order / opacity /
 * stacking are irrelevant (it is a set union); a `text` Bone is never the superset (it has gaps).
 *
 * Tested directly on a built IR — `supersetIR` is a pure `IRNode` mutation over snapshotted boxes,
 * so no DOM/layout engine is needed (happy-dom has none). The `emit` lowering is checked against a
 * hand-built bundle.
 */
import { describe, expect, it } from 'vitest'

import { supersetIR } from './distil.ts'
import { EMPTY_STYLE, emit, type IRBundle, type IRNode, type IRRect } from './ir.ts'
import { createDiagnostics } from './diagnostics.ts'

function box(x: number, y: number, width: number, height: number): IRRect {
  return { x, y, width, height }
}

function leaf(id: number, kind: IRNode['kind'], b: IRRect, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: null,
    kind,
    kids: [],
    depth: 0,
    decls: { fallback: ['display: block'] },
    style: EMPTY_STYLE,
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
    style: EMPTY_STYLE,
    box: b,
  }
}

function root(kids: IRNode[]): IRNode {
  return {
    id: 0,
    el: null,
    kind: 'root',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: EMPTY_STYLE,
  }
}

function superset(tree: IRNode): number {
  const diagnostics = createDiagnostics()
  supersetIR(tree, diagnostics)
  return diagnostics.list().find((d) => d.code === 'dropped-subset')?.count ?? 0
}

describe('supersetIR — overlapping-bone collapse (Phase 2)', () => {
  it('drops a smaller solid bone wholly inside a larger one (union)', () => {
    const big = leaf(1, 'media', box(0, 0, 100, 100))
    const small = leaf(2, 'box', box(20, 20, 30, 30))
    const tree = root([big, small])
    expect(superset(tree)).toBe(1)
    expect(small.dropped).toEqual({ reason: 'subset', by: 1 })
    expect(big.dropped).toBeUndefined()
  })

  it('ignores DOM order — the superset wins whether it comes first or last', () => {
    const small = leaf(1, 'box', box(20, 20, 30, 30))
    const big = leaf(2, 'media', box(0, 0, 100, 100)) // larger, but later in DOM
    const tree = root([small, big])
    expect(superset(tree)).toBe(1)
    expect(small.dropped?.by).toBe(2)
    expect(big.dropped).toBeUndefined()
  })

  it('drops a text line sitting on a solid surface (the surface is the superset)', () => {
    const card = leaf(1, 'media', box(0, 0, 100, 100))
    const caption = leaf(2, 'text-line', box(10, 80, 80, 16))
    const tree = root([card, caption])
    expect(superset(tree)).toBe(1)
    expect(caption.dropped?.by).toBe(1)
  })

  it('drops a text-block inside a solid surface', () => {
    const card = leaf(1, 'box', box(0, 0, 200, 200))
    const block = leaf(2, 'text-block', box(20, 20, 160, 100))
    const tree = root([card, block])
    expect(superset(tree)).toBe(1)
    expect(block.dropped?.by).toBe(1)
  })

  it('never treats a text bone as the superset (a solid inside text is kept)', () => {
    const textBlock = leaf(1, 'text-block', box(0, 0, 100, 100))
    const icon = leaf(2, 'box', box(40, 40, 20, 20))
    const tree = root([textBlock, icon])
    expect(superset(tree)).toBe(0)
    expect(icon.dropped).toBeUndefined()
  })

  it('drops a boxless text-block via its nearest box-bearing ancestor (overlay caption)', () => {
    // A multi-line text-block reflow bone is created WITHOUT a box (it sizes via
    // @container bands). Its rendered extent is its <p> ancestor's box, which here
    // sits inside the media — so it must still be recognized as a subset.
    const media = leaf(1, 'media', box(0, 0, 200, 120))
    const textBlock: IRNode = {
      id: 4,
      el: null,
      kind: 'text-block',
      kids: [],
      depth: 0,
      decls: { fallback: [] },
      style: EMPTY_STYLE,
    }
    const para = container(3, [textBlock], box(20, 80, 160, 30)) // the <p>, inside the media
    const caption = container(2, [para], box(10, 70, 180, 45)) // the absolute overlay
    const tree = root([media, caption])
    superset(tree)
    expect(textBlock.dropped?.reason).toBe('subset')
    expect(para.dropped?.reason).toBe('orphaned')
    expect(caption.dropped?.reason).toBe('orphaned')
    expect(media.dropped).toBeUndefined()
  })

  it('keeps a bone that only partially overlaps (pokes out by more than 1px)', () => {
    const a = leaf(1, 'media', box(0, 0, 100, 100))
    const b = leaf(2, 'box', box(50, 50, 80, 80)) // extends past a's right/bottom edges
    const tree = root([a, b])
    expect(superset(tree)).toBe(0)
  })

  it('collapses a coincident stack to exactly one bone (lowest id kept)', () => {
    const a = leaf(1, 'box', box(0, 0, 100, 100))
    const b = leaf(2, 'box', box(0, 0, 100, 100))
    const c = leaf(3, 'media', box(0, 0, 100, 100))
    const tree = root([a, b, c])
    expect(superset(tree)).toBe(2)
    expect(a.dropped).toBeUndefined() // lowest id survives
    expect(b.dropped).toBeDefined()
    expect(c.dropped).toBeDefined()
  })

  it('supersets across branches (an overlay nested elsewhere, over media)', () => {
    const media = leaf(1, 'media', box(0, 0, 200, 120))
    const overlayBox = leaf(3, 'box', box(20, 20, 40, 40)) // nested in another subtree, sits over the media
    const overlay = container(2, [overlayBox])
    const tree = root([media, overlay])
    expect(superset(tree)).toBe(1)
    expect(overlayBox.dropped?.by).toBe(1)
  })

  it('prunes the branch a drop empties (orphaned container)', () => {
    const media = leaf(1, 'media', box(0, 0, 200, 120))
    const badgeBox = leaf(3, 'box', box(10, 10, 30, 30))
    const badge = container(2, [badgeBox]) // its only child becomes a subset → orphaned
    const tree = root([media, badge])
    superset(tree)
    expect(badgeBox.dropped).toBeDefined()
    expect(badge.dropped).toEqual({ reason: 'orphaned' })
  })

  it('does not orphan a container that still holds a live bone (one outside the surface)', () => {
    const media = leaf(1, 'media', box(0, 0, 200, 120))
    const inside = leaf(3, 'box', box(10, 10, 30, 30)) // over the media → subset
    const outside = leaf(4, 'text-line', box(400, 400, 40, 16)) // nowhere near a solid → survives
    const badge = container(2, [inside, outside])
    const tree = root([media, badge])
    superset(tree)
    expect(inside.dropped).toBeDefined()
    expect(outside.dropped).toBeUndefined()
    expect(badge.dropped).toBeUndefined() // a live bone remains → branch kept
  })

  it('does not drop a stitch (no box) nor prune a container holding one', () => {
    const media = leaf(1, 'media', box(0, 0, 200, 120))
    const stitch: IRNode = {
      id: 3,
      el: null,
      kind: 'stitch',
      kids: [],
      depth: 0,
      decls: { fallback: [] },
      style: EMPTY_STYLE,
      ref: 'avatar',
    }
    const wrap = container(2, [stitch])
    const tree = root([media, wrap])
    superset(tree)
    expect(stitch.dropped).toBeUndefined()
    expect(wrap.dropped).toBeUndefined()
  })

  it('keeps a bone with no measured box', () => {
    const big = leaf(1, 'media', box(0, 0, 100, 100))
    const ghost = leaf(2, 'box', box(20, 20, 0, 0)) // degenerate
    const tree = root([big, ghost])
    expect(superset(tree)).toBe(0)
    expect(ghost.dropped).toBeUndefined()
  })

  it('supersets a whole nested chain (A ⊂ B ⊂ C → A and B go, C stays)', () => {
    const c = leaf(1, 'media', box(0, 0, 100, 100))
    const b = leaf(2, 'box', box(10, 10, 60, 60))
    const a = leaf(3, 'box', box(20, 20, 20, 20))
    const tree = root([c, b, a])
    expect(superset(tree)).toBe(2)
    expect(a.dropped).toBeDefined()
    expect(b.dropped).toBeDefined()
    expect(c.dropped).toBeUndefined()
  })
})

describe('emit — lowers the dropped annotation', () => {
  it('omits a dropped node and its whole branch from tree and rules', () => {
    const grandchild = leaf(4, 'media', box(0, 0, 10, 10))
    const droppedNode = leaf(2, 'box', box(0, 0, 100, 100), {
      dropped: { reason: 'subset', by: 3 },
      decls: { fallback: ['display: none'] },
      kids: [grandchild],
    })
    const superBone = leaf(3, 'box', box(0, 0, 100, 100))
    const bundle: IRBundle = { root: root([droppedNode, superBone]), extraRules: [] }
    const { tree, rules } = emit(bundle)
    const ids = (tree.kids ?? []).map((k) => k.id)
    expect(ids).toEqual([3]) // dropped (2) and thus its grandchild (4) gone; superset (3) kept
    expect(rules.some((r) => r.ids.includes(2))).toBe(false)
    expect(rules.some((r) => r.ids.includes(4))).toBe(false)
    expect(rules.some((r) => r.ids.includes(3))).toBe(true)
  })
})
