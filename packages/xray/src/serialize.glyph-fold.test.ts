// @vitest-environment happy-dom

/**
 * GLYPH-FOLD — Phase-3 annotate-only icon-into-text fold (ADR 0022 §4).
 *
 * The geometry-driven group pass (ADR 0021 §2, "row anything"): a glyph-sized `media` icon that
 * hugs an adjacent single-line text Bone on the same row folds WITH it into one text-line bar. Per
 * ADR 0022 §4 this is now ANNOTATE-ONLY — `foldGlyphRowsIR` never restructures `kids`; it SETS
 * `folded = { box, decls }` on the surviving text unit (the icon+text union box + the synthesized
 * inline-block + width/height decls the old destructive merge baked into its synthetic bar) and
 * marks the icon `dropped: { reason: 'folded' }`. The survivor keeps its id, so `emit` projects the
 * SAME single text-bar leaf (icon gone, unit a `text` leaf at the union) the old merge produced,
 * and every downstream pass reads the union via `boneBox` and the leaf shape via the effective-node
 * accessors.
 *
 * Tested directly on a built IR — `foldGlyphRowsIR` is a pure `IRNode` mutation over snapshotted
 * boxes. happy-dom supplies the element refs the fold gates on (`el !== null`), but no layout:
 * every box is fed explicitly.
 */
import { describe, expect, it } from 'vitest'

import { cropIR, foldGlyphRowsIR, supersetIR, templateIR } from './distil.ts'
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

/** A throwaway element ref — the fold gates on `el !== null` but never reads it. */
function el(): Element {
  return document.createElement('span')
}

function icon(id: number, b: IRRect, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: el(),
    kind: 'media',
    kids: [],
    depth: 1,
    decls: { fallback: ['display: block'] },
    style: style(),
    box: b,
    ...over,
  }
}

/** A single-line element-backed text unit (a `text` leaf) the fold can absorb. */
function textUnit(id: number, b: IRRect, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: el(),
    kind: 'text-line',
    kids: [],
    depth: 1,
    decls: { fallback: ['display: block'], author: [] },
    style: style(),
    box: b,
    ...over,
  }
}

/** A non-flow (flex) parent — the post-walk fold only runs under a non-inline-flow parent. */
function flexRow(id: number, kids: IRNode[]): IRNode {
  return {
    id,
    el: el(),
    kind: 'container',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: style({ display: 'flex', lineHeight: '20px', fontSize: '16px' }),
    box: box(0, 0, 240, 20),
  }
}

function root(kids: IRNode[]): IRNode {
  return { id: 0, el: null, kind: 'root', kids, depth: 0, decls: { fallback: [] }, style: style() }
}

// An emoji-sized icon (18×18) hugging a label (left 22, so a 4px gap) on the same
// 20px row — the dogfood "⬇ Download …" flex case. lineHeight 20 ⇒ icon ≤ 30 and
// gap ≤ 12 both pass.
const ICON_RECT = box(0, 0, 18, 18)
const TEXT_RECT = box(22, 0, 200, 18)
const UNION = box(0, 0, 222, 18)

describe('foldGlyphRowsIR — annotate-only icon→text fold (ADR 0022 §4)', () => {
  it('annotates the survivor `folded` and drops the icon, leaving `kids` intact', () => {
    const ic = icon(1, ICON_RECT)
    const tx = textUnit(2, TEXT_RECT)
    const tree = root([flexRow(3, [ic, tx])])
    foldGlyphRowsIR(tree)

    // Tree structurally untouched: the row still holds BOTH kids.
    expect(tree.kids[0]?.kids).toHaveLength(2)
    // The icon is dropped with the new `folded` reason; the text unit survives.
    expect(ic.dropped).toEqual({ reason: 'folded' })
    expect(tx.dropped).toBeUndefined()
    // The survivor carries the union box + the synthesized bar decls.
    expect(tx.folded).toEqual({
      box: UNION,
      decls: {
        fallback: ['display: inline-block', 'vertical-align: middle'],
        size: ['width: 222px', 'height: 18px'],
      },
    })
    // Raw fields are preserved (non-destructive) — only the EFFECTIVE projection changes.
    expect(tx.box).toEqual(TEXT_RECT)
    expect(tx.kind).toBe('text-line')
  })

  it('projects ONE text-bar leaf — icon gone, survivor sized to the union (no own decls)', () => {
    const ic = icon(1, ICON_RECT)
    const tx = textUnit(2, TEXT_RECT, {
      decls: {
        fallback: ['display: block'],
        author: [{ ids: [2], decls: ['color: red'], spec: 1, order: 9 }],
      },
    })
    const row = flexRow(3, [ic, tx])
    const tree = root([row])
    foldGlyphRowsIR(tree)

    const bundle: IRBundle = { root: tree, extraRules: [] }
    const { tree: plate, rules } = emit(bundle)

    // The row projects a single leaf — the icon is omitted entirely.
    const rowNode = plate.kids?.[0]
    expect(rowNode?.kids).toHaveLength(1)
    const bar = rowNode?.kids?.[0]
    expect(bar?.id).toBe(2)
    expect(bar?.leaf).toBe('text-line')
    expect(bar?.kids).toBeUndefined()

    // The bar emits ONLY the synthesized fallback + size — its own author rule
    // (`color: red`) and original `display: block` fallback are SUPPRESSED, and the
    // icon contributes no rule at all.
    const forBar = rules.filter((r) => r.ids.length === 1 && r.ids[0] === 2)
    expect(forBar.map((r) => r.decls)).toEqual([
      ['display: inline-block', 'vertical-align: middle'],
      ['width: 222px', 'height: 18px'],
    ])
    expect(rules.some((r) => r.decls.includes('color: red'))).toBe(false)
    expect(rules.some((r) => r.ids.includes(1))).toBe(false)
  })

  it('prefers the LEFT neighbour and folds each icon into at most one unit', () => {
    // [unit0, icon1, unit2]: icon1 folds LEFT into unit0 (i-1 before i+1); unit2 is
    // untouched — mirroring the old destructive pass's lo/hi splice + advance.
    const u0 = textUnit(1, box(0, 0, 80, 18))
    const ic = icon(2, box(82, 0, 18, 18))
    const u2 = textUnit(3, box(104, 0, 80, 18))
    const tree = root([flexRow(4, [u0, ic, u2])])
    foldGlyphRowsIR(tree)

    expect(u0.folded?.box).toEqual(box(0, 0, 100, 18)) // union of u0 + icon
    expect(ic.dropped).toEqual({ reason: 'folded' })
    expect(u2.folded).toBeUndefined() // the right unit is never pulled in
  })

  it('does not re-use a folded unit as a second icon neighbour', () => {
    // [icon0, unit1, icon2]: icon0 folds RIGHT into unit1; icon2 then finds unit1
    // already folded (skipped) and stays its own bone.
    const i0 = icon(1, box(0, 0, 18, 18))
    const u1 = textUnit(2, box(22, 0, 60, 18))
    const i2 = icon(3, box(84, 0, 18, 18))
    const tree = root([flexRow(4, [i0, u1, i2])])
    foldGlyphRowsIR(tree)

    expect(i0.dropped).toEqual({ reason: 'folded' })
    expect(u1.folded?.box).toEqual(box(0, 0, 82, 18)) // icon0 + unit1 union only
    expect(i2.dropped).toBeUndefined() // icon2 never folds into the already-folded unit
  })
})

describe('a folded node is an effective text LEAF for Superset / Crop (ADR 0022 §3–4)', () => {
  it('Superset reads the folded survivor at its UNION box (boneBox), not its raw text box', () => {
    // A solid card spans x 50→300. The RAW text box (62→182) sits inside it, but the
    // fold's UNION box reaches LEFT to x=40 (the icon), so it pokes outside the card.
    // Reading `boneBox` (the union) ⇒ NOT a subset; reading the raw text box would
    // (wrongly) drop it. So this asserts Superset uses the effective box.
    const ic = icon(1, box(40, 40, 18, 18))
    const tx = textUnit(2, box(62, 40, 120, 18))
    const card = {
      id: 3,
      el: el(),
      kind: 'box' as const,
      kids: [ic, tx],
      depth: 1,
      decls: { fallback: [] },
      style: style({ display: 'flex', lineHeight: '20px', fontSize: '16px' }),
      box: box(50, 0, 250, 300),
    } satisfies IRNode
    const tree = root([card])
    foldGlyphRowsIR(tree)
    expect(tx.folded?.box).toEqual(box(40, 40, 142, 18)) // union pokes left of the card

    const diagnostics = createDiagnostics()
    supersetIR(tree, diagnostics)
    // The union is NOT fully inside the card (its left 40 < card left 50), so the
    // folded bar survives — Superset judged it by `boneBox`, not the raw text box.
    expect(diagnostics.list().find((d) => d.code === 'dropped-subset')?.count ?? 0).toBe(0)
    expect(tx.dropped).toBeUndefined()
  })

  it('Superset drops a folded bar wholly inside a solid card, and never the dropped icon', () => {
    // The complementary case: the whole union sits inside the card, so the folded
    // bar IS a subset (a `text` bar is never a solid superset). The dropped icon is
    // never collected as a leaf.
    const ic = icon(1, box(60, 40, 18, 18))
    const tx = textUnit(2, box(82, 40, 120, 18))
    const card = {
      id: 3,
      el: el(),
      kind: 'box' as const,
      kids: [ic, tx],
      depth: 1,
      decls: { fallback: [] },
      style: style({ display: 'flex', lineHeight: '20px', fontSize: '16px' }),
      box: box(0, 0, 300, 300),
    } satisfies IRNode
    const tree = root([card])
    foldGlyphRowsIR(tree)
    expect(tx.folded?.box).toEqual(box(60, 40, 142, 18)) // union wholly inside the card

    const diagnostics = createDiagnostics()
    supersetIR(tree, diagnostics)
    expect(diagnostics.list().find((d) => d.code === 'dropped-subset')?.count).toBe(1)
    expect(tx.dropped).toEqual({ reason: 'subset', by: 3 })
    expect(ic.dropped).toEqual({ reason: 'folded' }) // still just folded, not double-counted
  })

  it('Crop tests the folded survivor by its union box top, never its raw text box', () => {
    // The icon's union pushes the effective top to y=900 (below an 800 fold), while
    // the raw text box top is the same here — the point is Crop reads `boneBox`
    // (the union), and never separately crops the dropped icon or the raw subtree.
    const ic = icon(1, box(0, 900, 18, 18))
    const tx = textUnit(2, box(22, 900, 200, 18))
    const tree = root([flexRow(3, [ic, tx])])
    // The flex row itself sits below the fold-free area but is a container (not a
    // leaf); only the folded bar leaf is cropped. Give the row a tall box so it is
    // not the thing under test.
    const row = tree.kids[0]
    if (row) row.box = box(0, 0, 240, 920)
    foldGlyphRowsIR(tree)
    expect(tx.folded?.box).toEqual(box(0, 900, 222, 18))

    const diagnostics = createDiagnostics()
    // Fold at viewport 500 ⇒ CROP_BUFFER(1.5)×500 = 750; the bar's union top (900) is
    // below it, so the folded bar crops. (Its raw text box top is also 900 here — the
    // point is Crop reads the union via `boneBox`, not that the two differ.) The
    // horizontal fold is wide (Infinity) so only the VERTICAL axis bites here.
    cropIR(tree, 500, Number.POSITIVE_INFINITY, diagnostics)
    expect(tx.dropped).toEqual({ reason: 'cropped' })
    // The icon was already folded-dropped, not separately cropped.
    expect(ic.dropped).toEqual({ reason: 'folded' })
  })
})

describe('a folded node is an effective text LEAF for Template cell-shape / median dims (ADR 0022 §3–4)', () => {
  // A thin `<span><text/></span>` label unit (`textLineUnitIR` admits a `container`
  // with one `text` kid) — its RAW kind is `container`, but the fold makes its
  // EFFECTIVE projection a `text` bar. This is the exact raw-vs-effective case the
  // Template family must read through: structuralHash / cellShape / fixedSizeLeaves
  // must see the bar `emit` projects, not the raw container.
  function labelUnit(id: number, textId: number, b: IRRect): IRNode {
    return {
      id,
      el: el(),
      kind: 'container',
      kids: [
        {
          id: textId,
          el: el(),
          kind: 'text-line',
          kids: [],
          depth: 2,
          decls: { fallback: ['display: block'], author: [] },
          style: style(),
          box: b,
        },
      ],
      depth: 1,
      // A raw author decl on the container — under the OLD raw read this would leak
      // into the structural identity; under the effective read it is suppressed (the
      // bar emits only its synthesized fallback).
      decls: { fallback: [], author: [{ ids: [id], decls: ['gap: 4px'], spec: 1, order: 1 }] },
      style: style(),
      box: b,
    }
  }

  // One feed cell: a flex row [icon, labelUnit]. After the fold the icon is dropped
  // and the labelUnit (a `container`!) carries the union as a `text` bar. `unionW`
  // varies per cell so the median width is observable.
  function cell(
    cellId: number,
    iconId: number,
    unitId: number,
    textId: number,
    unionW: number,
  ): IRNode {
    const ic = icon(iconId, box(0, 0, 18, 18))
    // text box runs from x=22 to x=unionW; the icon at x=0..18 makes the union 0..unionW.
    const unit = labelUnit(unitId, textId, box(22, 0, unionW - 22, 18))
    return flexRow(cellId, [ic, unit])
  }

  it('templates a run of folded container-survivor cells on the bar shape, with median union dims', () => {
    // Three structurally identical cells whose folded-bar union widths differ
    // (200 / 220 / 240). The RAW survivor kind is `container` and each carries a
    // `gap: 4px` author decl, so a raw structuralHash would (a) tag the cells as
    // `container|gap:4px` and (b) never collect the survivor in fixedSizeLeaves
    // (a container has no own `decls.size`). The effective read tags them as the
    // `text` bar and pairs their `folded.decls.size` for the median.
    const c0 = cell(10, 11, 12, 13, 200)
    const c1 = cell(20, 21, 22, 23, 220)
    const c2 = cell(30, 31, 32, 33, 240)
    const tree = root([c0, c1, c2])
    foldGlyphRowsIR(tree)

    // Sanity: each cell's label unit folded with its own union width; raw kind stays container.
    expect(c0.kids[1]?.folded?.box).toEqual(box(0, 0, 200, 18))
    expect(c0.kids[1]?.kind).toBe('container')

    const bundle: IRBundle = { root: tree, extraRules: [] }
    templateIR(bundle)

    // The three cells collapsed into ONE template cell with count 3 — only possible
    // if their EFFECTIVE shapes matched (folded bar + flex row), not their raw
    // container identities (which still match here, but the bar is what emit projects).
    expect(tree.kids).toHaveLength(1)
    const template = tree.kids[0]
    expect(template?.count).toBe(3)

    // The surviving template cell's folded bar carries the MEDIAN union width (220)
    // — proving fixedSizeLeaves collected the folded survivor (effective kind/size)
    // and applyMedianDims wrote into `folded.decls.size` (effective write). Under the
    // old raw read the container has no `decls.size`, so no median would be written
    // and the bar would keep its own pre-template width.
    const bar = template?.kids[1]
    expect(bar?.folded?.decls.size).toEqual(['width: 220px', 'height: 18px'])
  })
})
