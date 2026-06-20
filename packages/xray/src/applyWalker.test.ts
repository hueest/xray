// @vitest-environment happy-dom

/**
 * APPLY-WALKER — the programmable capture walker as a PASS over the measured IR (ADR 0018; ADR 0022
 * §5). The walker no longer runs DURING the DOM walk; it is offered each element node TOP-DOWN over
 * the built IR and its decision is LOWERED by setting the same `markKind`/`dropped` fields the
 * `data-xr-*` attribute path sets, which `markInk` then realizes.
 *
 * Tested directly on a hand-built IR — `applyWalker` is a pure `IRNode` mutation keyed off `el` +
 * tree shape, so no layout engine is needed (mirrors markInk.test.ts). The capture-path behavior
 * (the pass wired into `build`, then lowered by `markInk`/`emit`) is covered in serialize.test.ts.
 */
import { describe, expect, it } from 'vitest'

import { applyWalker, type XrayCaptureWalker } from './measure.ts'
import { EMPTY_STYLE, type IRNode } from './ir.ts'

/** A tagged element ref — `applyWalker` reads `el.tagName`/`classList` via the walker. */
function el(tag = 'div', cls?: string): Element {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  return e
}

/** An element node (built IR), with optional overrides. */
function node(id: number, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: el(),
    kind: 'container',
    kids: [],
    depth: 1,
    decls: { fallback: [] },
    style: EMPTY_STYLE,
    ...over,
  }
}

/** The synthetic root (entry-less): el === null, kind 'root'. */
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

describe('applyWalker (ADR 0022 §5)', () => {
  it('ctx.ignore() sets dropped:{reason:"ignored"} and does NOT recurse', () => {
    const deep = node(3)
    const dropMe = node(2, { el: el('div', 'drop'), kids: [deep] })
    const tree = root([dropMe])
    const walker: XrayCaptureWalker = {
      element: (ctx) => (ctx.el.classList.contains('drop') ? ctx.ignore() : ctx.keep()),
    }
    applyWalker(tree, walker)
    expect(dropMe.dropped).toEqual({ reason: 'ignored' })
    // The descent stopped: the deep kid was never visited (no dropped, no markKind).
    expect(deep.dropped).toBeUndefined()
    expect(deep.markKind).toBeUndefined()
  })

  it('ctx.bone() sets markKind (inferred box for a non-media tag) and does NOT recurse', () => {
    const deep = node(3)
    const card = node(2, { el: el('div', 'card'), kids: [deep] })
    const tree = root([card])
    const walker: XrayCaptureWalker = {
      element: (ctx) => (ctx.el.classList.contains('card') ? ctx.bone() : ctx.keep()),
    }
    applyWalker(tree, walker)
    expect(card.markKind).toBe('box')
    expect(deep.markKind).toBeUndefined()
    expect(deep.dropped).toBeUndefined()
  })

  it('ctx.bone() infers media for a media tag, and honors an explicit kind', () => {
    const img = node(1, { el: el('img') })
    const txt = node(2, { el: el('div') })
    const tree = root([img, txt])
    const walker: XrayCaptureWalker = {
      element: (ctx) => (ctx.el.tagName === 'IMG' ? ctx.bone() : ctx.bone({ kind: 'text-line' })),
    }
    applyWalker(tree, walker)
    expect(img.markKind).toBe('media')
    expect(txt.markKind).toBe('text-line')
  })

  it('ctx.keep() recurses into the kid (defers; no annotation on the kept node)', () => {
    const inner = node(2, { el: el('span', 'inner') })
    const outer = node(1, { kids: [inner] })
    const tree = root([outer])
    const seen: string[] = []
    const walker: XrayCaptureWalker = {
      element: (ctx) => {
        seen.push(ctx.el.tagName)
        return ctx.keep()
      },
    }
    applyWalker(tree, walker)
    // Both the outer DIV and the inner SPAN are offered; neither is annotated.
    expect(seen).toEqual(['DIV', 'SPAN'])
    expect(outer.markKind).toBeUndefined()
    expect(outer.dropped).toBeUndefined()
  })

  it('skips a stitch node (opaque — ADR 0006) and an entry-less node, but visits their kids', () => {
    const underStitch = node(3)
    const stitch: IRNode = {
      id: 2,
      el: null,
      kind: 'stitch',
      kids: [underStitch],
      depth: 1,
      decls: { fallback: [] },
      style: EMPTY_STYLE,
      ref: 'child',
    }
    const elementNode = node(4)
    const tree = root([stitch, elementNode])
    const seen: string[] = []
    const walker: XrayCaptureWalker = {
      element: (ctx) => {
        seen.push(ctx.el.tagName)
        return ctx.keep()
      },
    }
    applyWalker(tree, walker)
    // The stitch is never offered; the real element sibling is. (A stitch's kids
    // are an artifact of this hand-built IR — a real capture has none under one.)
    expect(seen).toEqual(['DIV', 'DIV'])
  })

  it('a no-op walker with no element hook is a no-op', () => {
    const only = node(1)
    const tree = root([only])
    applyWalker(tree, {})
    expect(only.markKind).toBeUndefined()
    expect(only.dropped).toBeUndefined()
  })
})
