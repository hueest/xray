import { describe, expect, it } from 'vitest'

import { toChunks } from './chunk.ts'
import { EMPTY_STYLE, type IRBundle, type IRKind, type IRNode } from './ir.ts'
import type { RenderNode } from './plate.ts'
import { templateIR } from './distil.ts'

// Focused tests for the Phase-2 Template pass (collapse uniform sibling runs into
// one cell + `count`) and its chunk serialization. The pass runs over a built IR,
// so these construct IRNodes directly — no browser geometry needed; the capture-
// path integration is covered in serialize.test.ts.

let nextId = 1
function ir(
  kind: IRKind,
  opts: {
    size?: string[]
    author?: string[]
    kids?: IRNode[]
    ref?: string
    dropped?: IRNode['dropped']
  } = {},
): IRNode {
  return {
    id: nextId++,
    el: null,
    kind,
    kids: opts.kids ?? [],
    depth: 0,
    decls: {
      fallback: [],
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.author ? { author: [{ ids: [], decls: opts.author, spec: 0, order: 0 }] } : {}),
    },
    style: EMPTY_STYLE,
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    ...(opts.dropped !== undefined ? { dropped: opts.dropped } : {}),
  }
}

/** A feed cell: a container holding one text-line bone of the given width. */
function cell(width: number): IRNode {
  return ir('container', {
    kids: [ir('text-line', { size: [`width: ${width}px`, 'height: 16px'] })],
  })
}

function root(kids: IRNode[]): IRBundle {
  return { root: ir('root', { kids }), extraRules: [] }
}

/**
 * Run `templateIR` over a bundle. Template runs LAST (after Crop), so it is lossless — no
 * diagnostics.
 */
function tmpl(bundle: IRBundle): void {
  templateIR(bundle)
}

describe('templateIR', () => {
  it('collapses a run of >=3 uniform cells into one cell with count', () => {
    const bundle = root([cell(20), cell(20), cell(20), cell(20)])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(1)
    expect(bundle.root.kids[0]?.count).toBe(4)
  })

  it('sizes the template bone to the rounded median across the run (text length varies)', () => {
    const bundle = root([cell(10), cell(20), cell(30)])
    tmpl(bundle)
    const bone = bundle.root.kids[0]?.kids[0]
    expect(bone?.decls.size).toContain('width: 20px') // median(10,20,30)
    expect(bundle.root.kids[0]?.count).toBe(3)
  })

  it('tolerates a minority FEATURED badge: the run still groups, the badge normalizes away', () => {
    const plain = () =>
      ir('container', { kids: [ir('text-line', { size: ['width: 20px', 'height: 16px'] })] })
    const badged = ir('container', {
      kids: [
        ir('text-line', { size: ['width: 20px', 'height: 16px'] }),
        ir('box', { size: ['width: 8px', 'height: 8px'] }),
      ],
    })
    const bundle = root([plain(), plain(), plain(), badged])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(1)
    expect(bundle.root.kids[0]?.count).toBe(4)
    // The template is the modal (no-badge) cell: one bone, not two.
    expect(bundle.root.kids[0]?.kids).toHaveLength(1)
  })

  it('leaves a run shorter than 3 intact', () => {
    const bundle = root([cell(20), cell(20)])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(2)
    expect(bundle.root.kids[0]?.count).toBeUndefined()
  })

  it('does not group structurally dissimilar siblings', () => {
    const bundle = root([
      ir('container', { kids: [ir('text-line', { size: ['width: 20px', 'height: 16px'] })] }),
      ir('container', { kids: [ir('media', { size: ['width: 40px', 'height: 40px'] })] }),
      ir('container', { kids: [ir('box', { size: ['width: 8px', 'height: 8px'] })] }),
    ])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(3)
  })

  it('does not template an A/B/A/B alternation — no clear majority, no wrong-shape normalization', () => {
    // card = container[text, media]; row = container[text] — one bone apart (within
    // tolerance), but neither is a 2/3 majority, so the run is left as-is rather
    // than rendering half the cells with the wrong shape.
    const card = (): IRNode =>
      ir('container', {
        kids: [
          ir('text-line', { size: ['width: 20px', 'height: 16px'] }),
          ir('media', { size: ['width: 40px', 'height: 40px'] }),
        ],
      })
    const row = (): IRNode =>
      ir('container', { kids: [ir('text-line', { size: ['width: 20px', 'height: 16px'] })] })

    const abab = root([card(), row(), card(), row()])
    tmpl(abab)
    expect(abab.root.kids).toHaveLength(4)
    expect(abab.root.kids.every((k) => k.count === undefined)).toBe(true)

    const aabb = root([card(), card(), row(), row()])
    tmpl(aabb)
    expect(aabb.root.kids).toHaveLength(4)
  })

  it('reads through a `flattened` wrapper: a cell wrapping its bone templates identically with or without the wrapper', () => {
    // A passthrough wrapper marked `flattened` (ADR 0022 §3) contributes no shape of
    // its own and its kids hoist — so a cell whose bone sits inside a coincident
    // wrapper must match the SAME modal shape `emit` projects. Mixing wrapped and
    // unwrapped cells in one run proves the match reads the EFFECTIVE structure: pre
    // the flatten-aware fix the wrapper's hash made the wrapped cells a distinct
    // shape and the run never collapsed to one template.
    const wrapped = (): IRNode => {
      const wrapper = ir('container', {
        kids: [ir('text-line', { size: ['width: 20px', 'height: 16px'] })],
      })
      wrapper.flattened = true
      return ir('container', { kids: [wrapper] })
    }
    const plain = (): IRNode =>
      ir('container', { kids: [ir('text-line', { size: ['width: 20px', 'height: 16px'] })] })

    const bundle = root([wrapped(), plain(), wrapped(), plain()])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(1)
    expect(bundle.root.kids[0]?.count).toBe(4)
  })

  it('never templates a run whose cells contain a stitch', () => {
    const stitched = () => ir('container', { kids: [ir('stitch', { ref: 'child' })] })
    const bundle = root([stitched(), stitched(), stitched()])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(3)
  })

  it('templates a long run to its FULL surviving count (no cap, lossless)', () => {
    // Template runs LAST (after Crop), so there is no RUN_CAP: a run of N survivors
    // collapses to ONE cell carrying count === N, which renders back to exactly N.
    // With no Crop in this hand-built bundle, every cell survives, so N is the full
    // run length. Crop is what drops the off-screen extent — Template never truncates.
    const bundle = root(Array.from({ length: 25 }, () => cell(20)))
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(1)
    expect(bundle.root.kids[0]?.count).toBe(25)
  })

  it('does not template across a `dropped` cell: the run is the surviving prefix, count === survivors', () => {
    // Crop drops a contiguous off-screen TAIL of a run before Template runs. A dropped
    // cell is non-templatable, so it BREAKS the run: Template groups only the on-screen
    // prefix and the count is the number of survivors (the rendered N a human sees). The
    // dropped tail flows through unchanged — still in the tree, still `dropped`, `emit`
    // lowers it out.
    const survivors = [cell(20), cell(20), cell(20), cell(20)]
    const tail = [cell(20), cell(20), cell(20)]
    for (const c of tail) c.dropped = { reason: 'cropped' }
    const bundle = root([...survivors, ...tail])
    tmpl(bundle)
    // One template cell (the 4 survivors) + the 3 still-dropped tail cells left as-is.
    expect(bundle.root.kids).toHaveLength(4)
    const template = bundle.root.kids[0]
    expect(template?.count).toBe(4)
    expect(bundle.root.kids.slice(1).every((k) => k.dropped?.reason === 'cropped')).toBe(true)
    expect(bundle.root.kids.slice(1).every((k) => k.count === undefined)).toBe(true)
  })

  it('rejects a dropped FIRST cell: a run beginning with a dropped cell never templates', () => {
    // The first-cell guard rejects a dropped cell, so a dropped HEAD does not anchor a
    // run; only the surviving tail (still >= MIN_TEMPLATE_RUN) templates.
    const head = cell(20)
    head.dropped = { reason: 'cropped' }
    const survivors = [cell(20), cell(20), cell(20)]
    const bundle = root([head, ...survivors])
    tmpl(bundle)
    expect(bundle.root.kids).toHaveLength(2)
    expect(bundle.root.kids[0]?.dropped?.reason).toBe('cropped')
    expect(bundle.root.kids[1]?.count).toBe(3)
  })
})

describe('toChunks (template chunk)', () => {
  it('serializes a count node to a { t, n } chunk carrying the cell HTML once', () => {
    const node: RenderNode = {
      count: 5,
      cls: 'xr-x-1',
      kids: [{ leaf: 'text-line', cls: 'xr-x-2' }],
    }
    const chunks = toChunks([node])
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]
    if (chunk === undefined || typeof chunk === 'string' || !('t' in chunk)) {
      throw new Error('expected a template chunk')
    }
    expect(chunk.n).toBe(5)
    // The HTML appears once (the adapter repeats it); the leaf bone is inside it.
    expect(chunk.t).toContain('xr-leaf-text-line')
    expect(chunk.t.match(/xr-leaf-text-line/g)).toHaveLength(1)
  })
})
