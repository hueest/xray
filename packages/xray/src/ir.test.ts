import { describe, expect, it } from 'vitest'

import {
  eachView,
  emit,
  EMPTY_STYLE,
  indexById,
  irFromTree,
  type IRBundle,
  type IRNode,
  type PlateIR,
  type ViewIR,
} from './ir.ts'
import { type PlateNode, type PlateRule, SPEC_CONTEXT, SPEC_FALLBACK, SPEC_LEAF } from './plate.ts'

// The IR is the per-View output spine (capture-pipeline Phase 1.5): the walk builds
// it DIRECTLY (ADR 0022, Task 2), and `emit` reads it back out into a
// `ViewCapture`'s `{tree, rules}`. The full capture suite exercises the walk's IR
// build on real DOM (serialize.build.test.ts); these pin the read-out contract
// directly — `irFromTree` structure, the rule reconstruction from `decls`, base-rule
// push order, the folded-in context rule + rep bands, and the dedup of a rule shared
// across nodes — over hand-built IR (no DOM).

function el(tag: string): Element {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- a minimal stub; the IR only carries the reference, never reads the DOM.
  return { tagName: tag } as unknown as Element
}

/** A hand-built `IRNode`, defaulting the entry-less fields the walk would stamp. */
function node(over: Partial<IRNode> & Pick<IRNode, 'id' | 'kind'>): IRNode {
  return {
    el: null,
    kids: [],
    depth: 0,
    decls: { fallback: [] },
    style: EMPTY_STYLE,
    ...over,
  }
}

/**
 * A present child, narrowed without an assertion (kids is `IRNode[]` under
 * noUncheckedIndexedAccess).
 */
function kid(n: IRNode, index: number): IRNode {
  const child = n.kids[index]
  if (!child) throw new Error(`missing kid ${index}`)
  return child
}

/** A node looked up by id, narrowed without an assertion. */
function nodeById(bundle: IRBundle, id: number): IRNode {
  const found = indexById(bundle.root).get(id)
  if (!found) throw new Error(`missing node ${id}`)
  return found
}

/** A one-leaf `ViewIR` at a given width, for the `eachView` tests. */
function oneLeafView(width: number, leaf: 'box' | 'text-line'): ViewIR {
  return { width, bundle: irFromTree({ id: 0, kids: [{ id: 1, leaf }] }) }
}

describe('irFromTree (entry-less reconstruction)', () => {
  it('maps structural roles to IRKind and snapshots depth', () => {
    const tree: PlateNode = {
      id: 0,
      kids: [
        { id: 1, kids: [{ id: 2, leaf: 'text-line' }] },
        { id: 3, ref: 'child' },
      ],
    }
    const { root } = irFromTree(tree)
    expect(root.kind).toBe('root')
    expect(root.depth).toBe(0)

    const container = kid(root, 0)
    expect(container.kind).toBe('container')
    expect(container.depth).toBe(1)
    // Entry-less: el null and the shared frozen empty style.
    expect(container.el).toBeNull()
    expect(container.style).toBe(EMPTY_STYLE)

    const leaf = kid(container, 0)
    expect(leaf.kind).toBe('text-line')
    expect(leaf.depth).toBe(2)

    const stitch = kid(root, 1)
    expect(stitch.kind).toBe('stitch')
    expect(stitch.ref).toBe('child')
    expect(stitch.el).toBeNull()
  })

  it('carries the rules as extraRules and no push-order nodes list', () => {
    const band: PlateRule = { ids: [1], decls: ['height: 8px'], spec: SPEC_LEAF, order: 0 }
    const bundle = irFromTree({ id: 0, kids: [{ id: 1, leaf: 'box' }] }, [band])
    expect(bundle.extraRules).toEqual([band])
    expect(bundle.nodes).toBeUndefined()
  })
})

describe('emit', () => {
  it('rebuilds the tree from the IR structure (leaf kinds, stitch, kids only when present)', () => {
    const tree: PlateNode = {
      id: 0,
      kids: [
        { id: 1, kids: [{ id: 2, leaf: 'text-line' }] },
        { id: 3, ref: 'child' },
      ],
    }
    expect(emit(irFromTree(tree)).tree).toEqual(tree)
  })

  it('omits the kids key on an empty node', () => {
    const { tree } = emit(irFromTree({ id: 0 }))
    expect(tree).toEqual({ id: 0 })
    expect('kids' in tree).toBe(false)
  })

  it('synthesizes fallback (SPEC_FALLBACK) + size (SPEC_LEAF) rules from decls, in push order', () => {
    // `bundle.nodes` lists the walk's push order 2,1 — emit orders the synthesized
    // base rules by it, NOT the tree's DFS order.
    const n2 = node({
      id: 2,
      kind: 'box',
      el: el('DIV'),
      decls: { fallback: ['display: flex'], size: ['width: 2px'] },
    })
    const n1 = node({
      id: 1,
      kind: 'box',
      el: el('DIV'),
      decls: { fallback: ['display: grid'], size: ['width: 1px'] },
    })
    const root = node({ id: 0, kind: 'root', kids: [n1, n2] })
    const bundle: IRBundle = { root, nodes: [n2, n1], extraRules: [] }
    expect(emit(bundle).rules).toEqual([
      { ids: [2], decls: ['display: flex'], spec: SPEC_FALLBACK, order: 0 },
      { ids: [2], decls: ['width: 2px'], spec: SPEC_LEAF, order: 1 },
      { ids: [1], decls: ['display: grid'], spec: SPEC_FALLBACK, order: 2 },
      { ids: [1], decls: ['width: 1px'], spec: SPEC_LEAF, order: 3 },
    ])
  })

  it('folds the context rule in first and the rep bands in last', () => {
    const n1 = node({
      id: 1,
      kind: 'text-block',
      el: el('P'),
      decls: { fallback: ['display: block'] },
    })
    const root = node({ id: 0, kind: 'root', kids: [n1] })
    const band: PlateRule = {
      ids: [1],
      decls: ['height: calc(2 * 24px)'],
      container: ['xr (min-width: 200px)'],
      spec: SPEC_LEAF,
      order: 1,
    }
    const context: PlateRule = { ids: [], decls: ['font-size: 16px'], spec: SPEC_CONTEXT, order: 0 }
    const bundle: IRBundle = { root, nodes: [n1], extraRules: [band], contextRule: context }
    const { rules } = emit(bundle)
    expect(rules[0]).toBe(context)
    expect(rules.at(-1)).toBe(band)
    // the synthesized fallback continues the counter after the context rule (order 1).
    expect(rules).toContainEqual({
      ids: [1],
      decls: ['display: block'],
      spec: SPEC_FALLBACK,
      order: 1,
    })
  })

  it('emits a rule shared across nodes once (dedup by identity)', () => {
    const n1 = node({ id: 1, kind: 'box', el: el('DIV') })
    const n2 = node({ id: 2, kind: 'box', el: el('DIV') })
    const root = node({ id: 0, kind: 'root', kids: [n1, n2] })
    const bundle: IRBundle = { root, nodes: [n1, n2], extraRules: [] }
    // The same rule object sits on BOTH nodes' decls.author, as copyRules attaches
    // a shared (multi-id) rule to each node it targets.
    const shared: PlateRule = { ids: [1, 2], decls: ['color: red'], spec: 10, order: 1001 }
    nodeById(bundle, 1).decls.author = [shared]
    nodeById(bundle, 2).decls.author = [shared]
    const { rules } = emit(bundle)
    expect(rules.filter((rule) => rule === shared)).toHaveLength(1)
  })

  it('includes carried token-definition rules', () => {
    const n1 = node({ id: 1, kind: 'box', el: el('DIV') })
    const root = node({ id: 0, kind: 'root', kids: [n1] })
    const bundle: IRBundle = { root, nodes: [n1], extraRules: [] }
    const carried: PlateRule = {
      ids: [],
      decls: ['--gap: 8px'],
      media: ['(min-width: 700px)'],
      layered: false,
      spec: 1,
      order: 0,
    }
    nodeById(bundle, 1).decls.carried = [carried]
    expect(emit(bundle).rules).toContain(carried)
  })
})

// A `PlateIR` holds a Plate's Views side by side (ADR 0022 §2); `eachView`
// sequences a per-View annotate-in-place pass across them. The substrate step 5's
// single Serialize projects; these pin the helper's contract directly (no DOM).
describe('eachView', () => {
  it('runs the pass once per View, in order, over each View bundle', () => {
    const plate: PlateIR = {
      name: 'p',
      breakpoints: [768],
      views: [oneLeafView(390, 'box'), oneLeafView(1280, 'text-line')],
    }
    const widths: number[] = []
    eachView(plate, (v) => widths.push(v.width))
    expect(widths).toEqual([390, 1280])
  })

  it('lets the pass annotate each View bundle in place', () => {
    const plate: PlateIR = {
      name: 'p',
      breakpoints: [],
      views: [oneLeafView(390, 'box'), oneLeafView(1280, 'box')],
    }
    // The pass mutates its View's root leaf — the annotate-in-place contract.
    eachView(plate, (v) => {
      const leaf = v.bundle.root.kids[0]
      if (leaf) leaf.dropped = { reason: 'cropped' }
    })
    for (const v of plate.views) expect(v.bundle.root.kids[0]?.dropped?.reason).toBe('cropped')
  })

  it('is a no-op over an empty bundle list', () => {
    const plate: PlateIR = { name: 'p', breakpoints: [], views: [] }
    let calls = 0
    eachView(plate, () => calls++)
    expect(calls).toBe(0)
  })
})
