// @vitest-environment happy-dom

/**
 * MARK-INK — Phase-3 classification pass (ADR 0022 invariant 5).
 *
 * `markInk` takes over the BONE-KIND assignment the measuring walk used to decide inline, reading
 * ONLY the IR snapshot (`isMedia`, `paint`, `ink`, `style`) — never the live DOM. It also folds
 * invisibility (`visibility:hidden|collapse`, `opacity <= INVISIBLE_OPACITY`) into a `dropped: {
 * reason: 'invisible' }` annotation `emit` lowers.
 *
 * Tested directly on a hand-built IR — `markInk` is a pure `IRNode` mutation over snapshotted
 * fields, so no DOM/layout engine is needed (mirrors serialize.crop.test.ts).
 */
import { describe, expect, it } from 'vitest'

import { effectiveKids, emit } from './ir.ts'
import { markInk } from './distil.ts'
import {
  EMPTY_STYLE,
  type IRBundle,
  type IRNode,
  type IRRect,
  type IRTextInk,
  type LiteStyleDeclaration,
} from './ir.ts'
import type { Salience } from './salience.ts'

function box(x: number, y: number, width: number, height: number): IRRect {
  return { x, y, width, height }
}

/** A `LiteStyleDeclaration` from a partial override, the rest empty strings (EMPTY_STYLE). */
function style(over: Partial<LiteStyleDeclaration> = {}): LiteStyleDeclaration {
  return { ...EMPTY_STYLE, ...over }
}

/** A throwaway element ref — markInk gates element cases on `el !== null` but never reads it. */
function el(): Element {
  return document.createElement('span')
}

/** An element node arriving at markInk with a PROVISIONAL kind (the walk's seed). */
function node(id: number, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: el(),
    kind: 'container',
    kids: [],
    depth: 1,
    decls: { fallback: [] },
    style: style(),
    ...over,
  }
}

/** A synthetic text bar carrying its `ink` — the walk's provisional `text`. */
function textBar(id: number, textInk: IRTextInk, over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: null,
    kind: 'container',
    kids: [],
    depth: 1,
    decls: { fallback: [] },
    style: style(),
    box: box(0, 0, textInk.maxLineWidth, textInk.lineRects[0]?.height ?? 0),
    ink: textInk,
    ...over,
  }
}

function ink(height: number, lineHeight: number): IRTextInk {
  return {
    lineRects: [box(0, 0, 200, height)],
    lineCount: lineHeight > 0 ? Math.max(1, Math.round(height / lineHeight)) : 1,
    maxLineWidth: 200,
    lineHeight,
  }
}

function root(kids: IRNode[]): IRNode {
  return { id: 0, el: null, kind: 'root', kids, depth: 0, decls: { fallback: [] }, style: style() }
}

/** A Salience vector with a chosen contrast axis, the rest zero — the only axis Absorb reads. */
function salience(contrast: number): Salience {
  return { contrast, spacing: 0, size: 0, typeScale: 0, score: 0 }
}

/** A leaf-kind kid the walk seeds explicitly (media / box / a text-block rep bone). */
function leaf(id: number, kind: IRNode['kind'], over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: el(),
    kind,
    kids: [],
    depth: 2,
    decls: { fallback: [] },
    style: style(),
    box: box(0, 0, 40, 40),
    ...over,
  }
}

describe('markInk — bone-kind classification off the snapshot', () => {
  it('classifies a replaced-media element as a `media` leaf via `isMedia`', () => {
    const img = node(1, { isMedia: true, box: box(0, 0, 100, 100) })
    markInk(root([img]))
    expect(img.kind).toBe('media')
  })

  it('classifies an empty PAINTED element as a `box` leaf via `paint.surface`', () => {
    const painted = node(1, { paint: { surface: true }, box: box(0, 0, 40, 40) })
    markInk(root([painted]))
    expect(painted.kind).toBe('box')
  })

  it('leaves an empty UNPAINTED element a container (a spacer)', () => {
    const spacer = node(1, { paint: { surface: false }, box: box(0, 0, 40, 40) })
    markInk(root([spacer]))
    expect(spacer.kind).toBe('container')
  })

  it('does not reclassify a painted element that still has children', () => {
    // The empty-element split only fires on a CHILDLESS element (raw kids === 0),
    // mirroring the walk's `kids.length > 0` guard — a painted card with content
    // stays a container so its children render.
    const childTx = textBar(2, ink(18, 20))
    const card = node(1, { paint: { surface: true }, box: box(0, 0, 200, 100), kids: [childTx] })
    markInk(root([card]))
    expect(card.kind).toBe('container')
  })

  it('finalizes a single-line text bar as `text`', () => {
    const bar = textBar(1, ink(18, 20)) // 18 < 20 × 1.5 → one line
    markInk(root([bar]))
    expect(bar.kind).toBe('text-line')
  })

  it('finalizes a multi-line text bar as `text-block` (height ≥ 1.5 × line-height)', () => {
    const bar = textBar(1, ink(45, 20)) // 45 ≥ 30 → two+ baselines
    markInk(root([bar]))
    expect(bar.kind).toBe('text-block')
  })

  it('reads an unresolved line-height (0) as a single line', () => {
    const bar = textBar(1, ink(45, 0))
    markInk(root([bar]))
    expect(bar.kind).toBe('text-line')
  })

  it('honors a pre-set EXPLICIT kind (upgrade-only): a ctx.bone() box stays a box', () => {
    // An unpainted, non-media childless element the walk stamped `box` (a
    // data-xr-bone-kind / ctx.bone() bone) is NOT downgraded — markInk only upgrades.
    const bone = node(1, { kind: 'box', paint: { surface: false }, box: box(0, 0, 50, 50) })
    markInk(root([bone]))
    expect(bone.kind).toBe('box')
  })

  it('does NOT downgrade a PAINTED explicit media bone to box (the painted-bone case)', () => {
    // A data-xr-bone-kind="media" / ctx.bone({kind:'media'}) element that ALSO paints a
    // background arrives kind `media` (isMedia may be unset on the bone path). The
    // painted-box re-derivation only upgrades a `container` seed, so it must NOT
    // overwrite the explicit `media` — otherwise a painted media bone becomes a box.
    const mediaBone = node(1, { kind: 'media', paint: { surface: true }, box: box(0, 0, 64, 64) })
    markInk(root([mediaBone]))
    expect(mediaBone.kind).toBe('media')
  })

  it('does NOT re-derive a PAINTED explicit box bone (stays box)', () => {
    const boxBone = node(1, { kind: 'box', paint: { surface: true }, box: box(0, 0, 50, 50) })
    markInk(root([boxBone]))
    expect(boxBone.kind).toBe('box')
  })

  it('honors the @container text-rep `text-block` bone (el null, no ink)', () => {
    // The rep emits an explicit `text-block` bone with no element and no `ink`; the
    // ink rule skips it and the element rule requires `el !== null`, so it is left.
    const repBone: IRNode = {
      id: 1,
      el: null,
      kind: 'text-block',
      kids: [],
      depth: 2,
      decls: { fallback: ['display: block', 'width: 100%'] },
      style: style(),
    }
    markInk(root([repBone]))
    expect(repBone.kind).toBe('text-block')
  })
})

describe('markInk — invisibility → dropped:"invisible"', () => {
  it('drops a visibility:hidden leaf', () => {
    const hidden = node(1, { style: style({ visibility: 'hidden' }), box: box(0, 0, 40, 40) })
    markInk(root([hidden]))
    expect(hidden.dropped).toEqual({ reason: 'invisible' })
  })

  it('drops a visibility:collapse leaf', () => {
    const collapsed = node(1, { style: style({ visibility: 'collapse' }), box: box(0, 0, 40, 40) })
    markInk(root([collapsed]))
    expect(collapsed.dropped).toEqual({ reason: 'invisible' })
  })

  it('drops an opacity ≤ epsilon element UNCONDITIONALLY (the whole group hides)', () => {
    // Opacity composites the element AND its subtree to nothing — a child cannot
    // re-show. The visible child stays un-dropped on its own node, but the parent's
    // drop omits the whole subtree at emit (effectiveKids).
    const visibleChild = textBar(2, ink(18, 20))
    const faded = node(1, {
      style: style({ opacity: '0' }),
      box: box(0, 0, 100, 40),
      kids: [visibleChild],
    })
    markInk(root([faded]))
    expect(faded.dropped).toEqual({ reason: 'invisible' })
    // The child node is NOT itself marked invisible (its own opacity is fine) — the
    // group drop on the parent is what hides it.
    expect(visibleChild.dropped).toBeUndefined()
  })

  it('keeps faint-but-visible (opacity above the epsilon)', () => {
    const faint = node(1, { style: style({ opacity: '0.5' }), box: box(0, 0, 40, 40) })
    markInk(root([faint]))
    expect(faint.dropped).toBeUndefined()
  })

  it('does NOT drop a visibility:hidden node with a re-shown (visibility:visible) descendant', () => {
    // The fixed latent bug: a hidden ancestor with a visibility:visible child keeps
    // the bone-free wrapper alive so the re-shown child survives. markInk drops the
    // hidden node ONLY when nothing visible survives below it.
    const shown = textBar(2, ink(18, 20), { style: style({ visibility: 'visible' }) })
    const stillHidden = node(3, { style: style({ visibility: 'hidden' }), box: box(0, 0, 40, 40) })
    const wrapper = node(1, {
      style: style({ visibility: 'hidden' }),
      box: box(0, 0, 200, 40),
      kids: [shown, stillHidden],
    })
    markInk(root([wrapper]))
    // The wrapper survives (it has a surviving kid); the still-hidden leaf drops.
    expect(wrapper.dropped).toBeUndefined()
    expect(stillHidden.dropped).toEqual({ reason: 'invisible' })
    expect(shown.dropped).toBeUndefined()
    expect(shown.kind).toBe('text-line')
  })

  it('drops a visibility:hidden wrapper whose every child is also hidden', () => {
    const hiddenKid = node(2, { style: style({ visibility: 'hidden' }), box: box(0, 0, 40, 40) })
    const wrapper = node(1, {
      style: style({ visibility: 'hidden' }),
      box: box(0, 0, 200, 40),
      kids: [hiddenKid],
    })
    markInk(root([wrapper]))
    expect(hiddenKid.dropped).toEqual({ reason: 'invisible' })
    expect(wrapper.dropped).toEqual({ reason: 'invisible' })
  })

  it('never overwrites a prior drop (a glyph-folded icon keeps `folded`)', () => {
    const folded = node(1, {
      kind: 'media',
      style: style({ visibility: 'hidden' }),
      box: box(0, 0, 18, 18),
      dropped: { reason: 'folded' },
    })
    markInk(root([folded]))
    expect(folded.dropped).toEqual({ reason: 'folded' })
  })
})

describe('markInk — Absorb: a contrast surface whose content is one label → one box', () => {
  it('absorbs a contrasting-FILL surface wrapping a single text leaf', () => {
    // A filled control (button/badge): paint.contrastingFill triggers, the lone text
    // run is label content → the surface becomes a childless box, the label drops.
    const label = textBar(2, ink(18, 20))
    const surface = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 120, 40),
      kids: [label],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('box')
    expect(label.dropped).toEqual({ reason: 'absorbed' })
    expect(effectiveKids(surface)).toHaveLength(0)
  })

  it('absorbs a BORDER/box-shadow surface (salience.contrast ≥ MIN) wrapping a label', () => {
    // No contrasting fill, but the contrast axis clears ABSORB_CONTRAST_MIN (0.5) —
    // an outlined chip / lifted card whose content is label-only.
    const label = textBar(2, ink(18, 20))
    const surface = node(1, {
      paint: { surface: false, contrastingFill: false },
      salience: salience(0.6),
      box: box(0, 0, 90, 32),
      kids: [label],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('box')
    expect(label.dropped).toEqual({ reason: 'absorbed' })
  })

  it('absorbs through a THIN wrapper (a span-wrapped label blockified in a control)', () => {
    // The kid is a container with a single text leaf — still one label, so the
    // surface absorbs the whole thin chain.
    const inner = textBar(3, ink(18, 20))
    const wrapper = node(2, { kids: [inner], box: box(0, 0, 80, 20) })
    const surface = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 96, 36),
      kids: [wrapper],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('box')
    expect(wrapper.dropped).toEqual({ reason: 'absorbed' })
    expect(effectiveKids(surface)).toHaveLength(0)
  })

  it('emits the absorbed surface as ONE box leaf with its measured size, no kids', () => {
    const label = textBar(2, ink(18, 20))
    const surface = node(1, {
      el: el(),
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 120, 40),
      style: style({ display: 'inline-flex' }),
      kids: [label],
    })
    const bundle: IRBundle = { root: root([surface]), extraRules: [] }
    markInk(bundle.root)
    const { tree, rules } = emit(bundle)
    const boxNode = tree.kids?.[0]
    expect(boxNode?.leaf).toBe('box')
    expect(boxNode?.kids).toBeUndefined()
    // The box carries its own inline-block display + measured size (the old walk-side
    // Absorb's fallback/size), and the absorbed label emits no rules.
    const surfaceRules = rules.filter((r) => r.ids.includes(1)).flatMap((r) => r.decls)
    expect(surfaceRules).toContain('display: inline-block')
    expect(surfaceRules).toContain('width: 120px')
    expect(surfaceRules).toContain('height: 40px')
    expect(rules.some((r) => r.ids.includes(2))).toBe(false)
  })

  it('does NOT absorb a surface with REPLACED MEDIA (media is never a swallowing surface)', () => {
    // ADR 0021 §3: a large image with an overlaid title is a media box plus its text
    // bones, never one box — even on a contrasting fill.
    const media = leaf(2, 'media', { isMedia: true, box: box(0, 0, 200, 120) })
    const title = textBar(3, ink(18, 20))
    const surface = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 200, 140),
      kids: [media, title],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('container')
    expect(media.dropped).toBeUndefined()
    expect(title.dropped).toBeUndefined()
    expect(effectiveKids(surface)).toHaveLength(2)
  })

  it('does NOT absorb a surface with TWO distinct shapes (a real card stays a container)', () => {
    // A title text bar plus a painted box child are two distinct shapes — structure,
    // not a single label — so the surface frames them rather than swallowing them.
    const title = textBar(2, ink(18, 20))
    const inner = leaf(3, 'box', { paint: { surface: true }, box: box(0, 0, 60, 60) })
    const surface = node(1, {
      paint: { surface: false, contrastingFill: false },
      salience: salience(0.8),
      box: box(0, 0, 240, 160),
      kids: [title, inner],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('container')
    expect(effectiveKids(surface)).toHaveLength(2)
  })

  it('does NOT absorb a NON-contrasting wrapper (no fill, sub-threshold contrast)', () => {
    // An outline button the same colour as the page / a plain wrapper: neither path
    // triggers, so it keeps its label child.
    const label = textBar(2, ink(18, 20))
    const wrapper = node(1, {
      paint: { surface: false, contrastingFill: false },
      salience: salience(0.2),
      box: box(0, 0, 120, 40),
      kids: [label],
    })
    markInk(root([wrapper]))
    expect(wrapper.kind).toBe('container')
    expect(label.dropped).toBeUndefined()
  })

  it('does NOT absorb a surface whose content is a single text leaf but ALSO holds a stitch', () => {
    // A Stitch is opaque (ADR 0006) — never subsumed. The surface keeps it as a ref.
    const label = textBar(2, ink(18, 20))
    const stitch: IRNode = {
      id: 3,
      el: null,
      kind: 'stitch',
      kids: [],
      depth: 2,
      decls: { fallback: [] },
      style: style(),
      ref: 'nested',
    }
    const surface = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 200, 40),
      kids: [label, stitch],
    })
    markInk(root([surface]))
    expect(surface.kind).toBe('container')
    expect(label.dropped).toBeUndefined()
    expect(stitch.dropped).toBeUndefined()
  })

  it('absorbs a multi-line text-block label (a filled control with a wrapping label)', () => {
    const label = textBar(2, ink(45, 20)) // 45 ≥ 30 → text-block
    const surface = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 200, 60),
      kids: [label],
    })
    markInk(root([surface]))
    expect(label.kind).toBe('text-block')
    expect(surface.kind).toBe('box')
    expect(label.dropped).toEqual({ reason: 'absorbed' })
  })

  it('does NOT absorb a childless contrast surface (no effective kids → not a candidate)', () => {
    // A childless painted box is the empty-element path's job, not Absorb. With no
    // kids there is nothing to subsume — markInk's empty-element split runs instead.
    const empty = node(1, {
      paint: { surface: true, contrastingFill: true },
      box: box(0, 0, 40, 40),
    })
    markInk(root([empty]))
    // The empty-painted split makes it a box, but via the childless path, not Absorb
    // (no kid was dropped).
    expect(empty.kind).toBe('box')
  })

  it('does NOT absorb an already-dropped (invisible) surface', () => {
    const label = textBar(2, ink(18, 20))
    const hidden = node(1, {
      paint: { surface: true, contrastingFill: true },
      style: style({ opacity: '0' }),
      box: box(0, 0, 120, 40),
      kids: [label],
    })
    markInk(root([hidden]))
    expect(hidden.dropped).toEqual({ reason: 'invisible' })
    // The whole subtree lowers with the invisible drop; Absorb never re-stamps it.
    expect(hidden.kind).toBe('container')
    expect(label.dropped).toBeUndefined()
  })
})

describe('markInk — declared bone (data-xr-bone-kind → markKind) re-stamp', () => {
  it('re-stamps a `box` markKind container into one childless box, dropping its kids', () => {
    // The walk DESCENDED (the subtree is measured into the IR); markInk lowers it.
    const a = textBar(2, ink(18, 20))
    const b = leaf(3, 'box', { paint: { surface: true } })
    const declared = node(1, { markKind: 'box', box: box(0, 0, 200, 80), kids: [a, b] })
    markInk(root([declared]))
    expect(declared.kind).toBe('box')
    expect(declared.isMedia).toBeUndefined()
    expect(a.dropped).toEqual({ reason: 'collapsed' })
    expect(b.dropped).toEqual({ reason: 'collapsed' })
    // Lowers to a childless bone — every effective kid is gone.
    expect(effectiveKids(declared)).toHaveLength(0)
    // Carries its own measured size (block display → no display decl).
    expect(declared.decls.size).toEqual(['box-sizing: border-box', 'width: 200px', 'height: 80px'])
    expect(declared.decls.fallback).toEqual([])
  })

  it('re-stamps a `media` markKind: kind media, isMedia true, size from box', () => {
    const a = textBar(2, ink(18, 20))
    const declared = node(1, { markKind: 'media', box: box(0, 0, 100, 100), kids: [a] })
    markInk(root([declared]))
    expect(declared.kind).toBe('media')
    expect(declared.isMedia).toBe(true)
    expect(a.dropped).toEqual({ reason: 'collapsed' })
    expect(effectiveKids(declared)).toHaveLength(0)
    expect(declared.decls.size).toEqual(['box-sizing: border-box', 'width: 100px', 'height: 100px'])
  })

  it('re-stamps a `text` markKind container into one childless text bone', () => {
    const inner = textBar(2, ink(18, 20))
    const declared = node(1, { markKind: 'text-line', box: box(0, 0, 120, 20), kids: [inner] })
    markInk(root([declared]))
    expect(declared.kind).toBe('text-line')
    expect(inner.dropped).toEqual({ reason: 'collapsed' })
    expect(effectiveKids(declared)).toHaveLength(0)
  })

  it('re-stamps a `text-block` markKind container into one childless text-block bone', () => {
    const inner = textBar(2, ink(45, 20))
    const declared = node(1, { markKind: 'text-block', box: box(0, 0, 200, 60), kids: [inner] })
    markInk(root([declared]))
    expect(declared.kind).toBe('text-block')
    expect(inner.dropped).toEqual({ reason: 'collapsed' })
    expect(effectiveKids(declared)).toHaveLength(0)
  })

  it('synthesizes inline-block for an inline-ish declared bone (box)', () => {
    const inner = textBar(2, ink(18, 20))
    const declared = node(1, {
      markKind: 'box',
      style: style({ display: 'inline-flex' }),
      box: box(0, 0, 90, 30),
      kids: [inner],
    })
    markInk(root([declared]))
    expect(declared.decls.fallback).toEqual(['display: inline-block'])
  })

  it('adds vertical-align: middle for an inline-ish declared MEDIA bone (matches boneElement)', () => {
    const inner = textBar(2, ink(18, 20))
    const declared = node(1, {
      markKind: 'media',
      style: style({ display: 'inline' }),
      box: box(0, 0, 64, 64),
      kids: [inner],
    })
    markInk(root([declared]))
    expect(declared.decls.fallback).toEqual(['display: inline-block', 'vertical-align: middle'])
  })

  it('emits a non-block, non-inline display verbatim for a declared bone', () => {
    const inner = textBar(2, ink(18, 20))
    const declared = node(1, {
      markKind: 'box',
      style: style({ display: 'flex' }),
      box: box(0, 0, 80, 40),
      kids: [inner],
    })
    markInk(root([declared]))
    expect(declared.decls.fallback).toEqual(['display: flex'])
  })

  it('preserves author/carried decls through the re-stamp (spread)', () => {
    const inner = textBar(2, ink(18, 20))
    const authorRule = { ids: [1], decls: ['color: red'], spec: 1, order: 0 }
    const declared = node(1, {
      markKind: 'box',
      box: box(0, 0, 50, 50),
      decls: { fallback: ['display: flex'], author: [authorRule] },
      kids: [inner],
    })
    markInk(root([declared]))
    // author survives; fallback is REPLACED with the synthesized leaf display.
    expect(declared.decls.author).toEqual([authorRule])
    expect(declared.decls.fallback).toEqual([])
  })

  it('keeps a declared bone with no box free of a size decl', () => {
    const inner = textBar(2, ink(18, 20))
    const declared = node(1, { markKind: 'box', kids: [inner] }) // no box
    markInk(root([declared]))
    expect(declared.kind).toBe('box')
    expect(declared.decls.size).toBeUndefined()
  })

  it('invisibility WINS over a declared bone (stays dropped:"invisible", not re-stamped)', () => {
    const inner = textBar(2, ink(18, 20))
    const hidden = node(1, {
      markKind: 'box',
      style: style({ opacity: '0' }),
      box: box(0, 0, 120, 40),
      kids: [inner],
    })
    markInk(root([hidden]))
    expect(hidden.dropped).toEqual({ reason: 'invisible' })
    // Not re-stamped: the invisible drop lowers the whole subtree.
    expect(hidden.kind).toBe('container')
    expect(inner.dropped).toBeUndefined()
  })

  it('is idempotent — running markInk twice yields the same result', () => {
    const a = textBar(2, ink(18, 20))
    const b = leaf(3, 'box')
    const declared = node(1, { markKind: 'box', box: box(0, 0, 200, 80), kids: [a, b] })
    const r = root([declared])
    markInk(r)
    const first = {
      kind: declared.kind,
      decls: structuredClone(declared.decls),
      aDropped: a.dropped,
      bDropped: b.dropped,
    }
    markInk(r)
    expect(declared.kind).toBe(first.kind)
    expect(declared.decls).toEqual(first.decls)
    expect(a.dropped).toEqual(first.aDropped)
    expect(b.dropped).toEqual(first.bDropped)
    expect(effectiveKids(declared)).toHaveLength(0)
  })

  it('emits the declared bone as ONE box leaf with measured size, no kids, label rules gone', () => {
    const label = textBar(2, ink(18, 20))
    const declared = node(1, {
      el: el(),
      markKind: 'box',
      style: style({ display: 'inline-flex' }),
      box: box(0, 0, 120, 40),
      kids: [label],
    })
    const bundle: IRBundle = { root: root([declared]), extraRules: [] }
    markInk(bundle.root)
    const { tree, rules } = emit(bundle)
    const boxNode = tree.kids?.[0]
    expect(boxNode?.leaf).toBe('box')
    expect(boxNode?.kids).toBeUndefined()
    const declaredRules = rules.filter((r) => r.ids.includes(1)).flatMap((r) => r.decls)
    expect(declaredRules).toContain('display: inline-block')
    expect(declaredRules).toContain('width: 120px')
    expect(declaredRules).toContain('height: 40px')
    // The collapsed label emits no rules.
    expect(rules.some((r) => r.ids.includes(2))).toBe(false)
  })
})
