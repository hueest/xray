// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { captureBundle, captureView, distilPlate } from './measure.ts'
import { EMPTY_STYLE, type IRBundle, type IRNode, type PlateIR } from './ir.ts'

// The build phase lifts author CSS onto the IR (capture-pipeline Phase 1.5,
// Stage 2): every node carries the rules targeting it in `decls.author` (lifted
// CSSOM + inline) and `decls.carried` (carried token defs, ADR 0019 §1). These
// assert the fields are genuinely populated by `build`, not dead optionals — the
// substrate classify reads from post-merge (Stage 4). Byte-identity of the flat
// `rules` array is covered by the round-trip + golden tests.

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.innerHTML = ''
})

function style(css: string): void {
  const el = document.createElement('style')
  el.textContent = css
  document.head.append(el)
}

function mount(html: string): Element {
  document.body.innerHTML = `<div id="host">${html}</div>`
  const host = document.getElementById('host')
  if (!host) throw new Error('missing #host')
  const first = host.firstElementChild
  if (!first) throw new Error('missing capture root')
  return first
}

function flatten(root: IRNode): IRNode[] {
  const out = [root]
  for (const kid of root.kids) out.push(...flatten(kid))
  return out
}

/** A childless leaf at a given y, for the `distilPlate` Crop test. */
function leafAt(id: number, kind: IRNode['kind'], y: number): IRNode {
  return {
    id,
    el: null,
    kind,
    kids: [],
    depth: 1,
    decls: { fallback: ['display: block'] },
    style: EMPTY_STYLE,
    box: { x: 0, y, width: 100, height: 40 },
  }
}

/**
 * A bundle with one above-fold node (y=10) and one far-below-fold node (y=5000). Two DISTINCT leaf
 * kinds (box vs media) at non-overlapping y's, so neither Template (needs a similar run) nor
 * Superset (needs containment) fires — Crop is the only pass with anything to do.
 */
function bundleWithBelowFoldNode(): IRBundle {
  return {
    root: {
      id: 0,
      el: null,
      kind: 'root',
      kids: [leafAt(1, 'box', 10), leafAt(2, 'media', 5000)],
      depth: 0,
      decls: { fallback: [] },
      style: EMPTY_STYLE,
      box: { x: 0, y: 0, width: 1000, height: 6000 },
    },
    extraRules: [],
  }
}

describe('build phase: CSS-extract onto the IR (Phase 1.5 Stage 2)', () => {
  it('fills decls.author with the lifted author rules of the node they target', () => {
    style('.card { display: flex; gap: 8px }')
    const bundle = captureBundle([mount('<div class="card"><span>hi</span></div>')])
    const authored = flatten(bundle.root).filter((n) => (n.decls.author?.length ?? 0) > 0)
    expect(authored.length).toBeGreaterThan(0)
    const decls = authored.flatMap((n) => n.decls.author ?? []).flatMap((r) => r.decls)
    expect(decls.join(' ')).toContain('display: flex')
  })

  it('fills decls.carried with the carried token definitions (ADR 0019 §1)', () => {
    // --gap varies across a @media condition, so it is carried: its conditional
    // definitions ride on the IR node they anchor to, not just the flat rules.
    style(
      ':root { --gap: 8px }' +
        '@media (min-width: 700px) { :root { --gap: 16px } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    const bundle = captureBundle([mount('<div class="card"><span>hi</span></div>')])
    const carried = flatten(bundle.root).flatMap((n) => n.decls.carried ?? [])
    expect(carried.length).toBeGreaterThan(0)
    expect(carried.flatMap((r) => r.decls).join(' ')).toContain('--gap')
  })
})

// Measure's per-node snapshot expansion (capture-pipeline Phase 3a; ADR 0022
// invariant 5): Measure resolves and stores everything a future markInk pass reads
// — the WIDENED `LiteStyleDeclaration` set, a populated `paint` snapshot (canvas-
// resolved bg/contrast), and a populated `salience` vector. Purely additive: these
// fields are populated-but-not-yet-read, so the emitted plate stays byte-identical
// (the round-trip + golden tests guard that). These assert the snapshot is genuinely
// resolved-and-stored, not dead optionals.
describe('build phase: Measure snapshot expansion (Phase 3a)', () => {
  it('widens the frozen style snapshot to the classification/Absorb/salience props', () => {
    style('.card { display: flex; padding: 12px; row-gap: 8px; align-items: center }')
    const bundle = captureBundle([mount('<div class="card"><span>hi</span></div>')])
    const card = flatten(bundle.root).find((n) => n.el?.classList.contains('card'))
    if (!card) throw new Error('missing .card node')
    // New props are present and carry the resolved values (the old set still works).
    expect(card.style.display).toBe('flex')
    expect(card.style.paddingTop).toBe('12px')
    expect(card.style.rowGap).toBe('8px')
    expect(card.style.alignItems).toBe('center')
    // The whole set is frozen (no pass can mutate the snapshot).
    expect(Object.isFrozen(card.style)).toBe(true)
    // Every declared prop is a string, never undefined (the always-safe invariant).
    for (const value of Object.values(card.style)) expect(typeof value).toBe('string')
  })

  it('snapshots the border + alignment props the salience scorer reads', () => {
    style(
      '.card { display: flex; justify-content: space-between; font-weight: 700;' +
        ' border: 2px solid rgb(10, 10, 10) }',
    )
    const bundle = captureBundle([mount('<div class="card"><span>hi</span></div>')])
    const card = flatten(bundle.root).find((n) => n.el?.classList.contains('card'))
    if (!card) throw new Error('missing .card node')
    expect(card.style.borderTopWidth).toBe('2px')
    expect(card.style.borderStyle).toBe('solid')
    expect(card.style.borderTopColor).toBe('rgb(10, 10, 10)')
    expect(card.style.fontWeight).toBe('700')
    expect(card.style.justifyContent).toBe('space-between')
  })

  it('populates paint with the canvas-resolved background + contrast for a filled node', () => {
    style('.fill { background-color: rgb(20, 80, 200); border-radius: 6px; padding: 8px }')
    const bundle = captureBundle([mount('<div class="fill"><span>hi</span></div>')])
    const fill = flatten(bundle.root).find((n) => n.paint?.surface === true)
    if (!fill) throw new Error('missing painted node')
    expect(fill.paint?.surface).toBe(true)
    // bg is the resolved colour, single-sourced through toRgb (rgb()/rgba() string).
    expect(fill.paint?.bg).toBe('rgb(20, 80, 200)')
    // A saturated fill on the (white) page contrasts.
    expect(fill.paint?.contrastingFill).toBe(true)
    expect(fill.paint?.radius).toBe('6px')
  })

  it('populates the salience vector (the four axes + blended score) per measured node', () => {
    style('.card { background-color: rgb(20, 80, 200); padding: 16px; font-weight: 700 }')
    const bundle = captureBundle([mount('<div class="card"><span>hi</span></div>')])
    const card = flatten(bundle.root).find((n) => n.el?.classList.contains('card'))
    if (!card) throw new Error('missing .card node')
    const s = card.salience
    if (!s) throw new Error('salience not populated')
    // The full per-axis vector is present (each a finite 0..1 number).
    for (const axis of ['contrast', 'spacing', 'size', 'typeScale', 'score'] as const) {
      expect(typeof s[axis]).toBe('number')
      expect(s[axis]).toBeGreaterThanOrEqual(0)
      expect(s[axis]).toBeLessThanOrEqual(1)
    }
    // The blue fill on the white page registers on the contrast axis.
    expect(s.contrast).toBeGreaterThan(0)
  })

  it('leaves paint/salience undefined for an entry-less node (the synthetic root)', () => {
    // The synthetic root (id 0) has no element and no `cs`, so Measure resolves no
    // paint/salience for it — the entry-less-gets-undefined invariant for this step.
    const bundle = captureBundle([mount('<div><span>hi</span></div>')])
    expect(bundle.root.kind).toBe('root')
    expect(bundle.root.paint).toBeUndefined()
    expect(bundle.root.salience).toBeUndefined()
  })
})

// `captureView` is the framework-agnostic capture core (Phase 3 step 4.2; ADR 0022
// §1,§2): measure one View's subtree and APPEND it to a per-Plate `PlateIR`. With no
// bundle it starts a fresh (unnamed) one; with a bundle it pushes a View, so the
// orchestration threads ONE PlateIR through a Plate's per-View captures in one session.
describe('captureView: the per-Plate bundle core (step 4.2)', () => {
  it('starts a fresh single-View PlateIR when no bundle is passed', () => {
    const plate = captureView([mount('<div class="card"><span>hi</span></div>')])
    expect(plate.views).toHaveLength(1)
    const [view] = plate.views
    expect(view?.width).toBe(window.innerWidth)
    // The View carries the measured bundle (a populated IR), ready for the passes.
    expect(view?.bundle.root.kind).toBe('root')
    expect(view?.bundle.root.kids.length).toBeGreaterThan(0)
    // Naming + the breakpoint union are the orchestration's job (Views are not core).
    expect(plate.name).toBe('')
    expect(plate.breakpoints).toEqual([])
  })

  it('appends a View to the passed-in PlateIR (one bundle per session)', () => {
    const plate: PlateIR = { name: 'p', views: [], breakpoints: [768] }
    const first = captureView([mount('<div class="a"><span>hi</span></div>')], {}, plate)
    const second = captureView([mount('<div class="b"><span>yo</span></div>')], {}, plate)
    // Both calls thread (and return) the SAME bundle, now holding two Views.
    expect(first).toBe(plate)
    expect(second).toBe(plate)
    expect(plate.views).toHaveLength(2)
    // The Plate's name/breakpoints set by the orchestration are preserved.
    expect(plate.name).toBe('p')
    expect(plate.breakpoints).toEqual([768])
  })
})

// `distilPlate` runs the reduction tail (glyph-fold → Flatten → Template →
// Superset → Crop) over every View of a PlateIR via `eachView` (step 4.3; ADR 0022
// §3). Hand-built IR with explicit boxes — the passes are pure `IR → IR` over
// snapshotted geometry (happy-dom has no layout), so real numbers stand in. Crop is
// the pass that reads each View's snapshotted `viewportHeight`, so a far-below-fold
// node proves both the per-View wiring and the height threading.
describe('distilPlate: the reduction tail over a PlateIR (step 4.3)', () => {
  it('runs Crop per View, threading each View’s snapshotted viewportHeight', () => {
    const plate: PlateIR = {
      name: 'p',
      breakpoints: [768],
      views: [
        { width: 390, viewportHeight: 800, bundle: bundleWithBelowFoldNode() },
        { width: 1280, viewportHeight: 800, bundle: bundleWithBelowFoldNode() },
      ],
    }
    distilPlate(plate)
    for (const view of plate.views) {
      const [above, below] = view.bundle.root.kids
      expect(above?.dropped).toBeUndefined() // y=10, above the 800px fold — survives
      expect(below?.dropped?.reason).toBe('cropped') // y=5000, far below the fold — dropped
    }
  })

  it('leaves nothing cropped when the fold (viewportHeight) is unset', () => {
    // No viewportHeight → base-case fold disabled (0); with no clipping ancestor,
    // even the y=5000 node survives (a per-node clip context would still fold).
    const plate: PlateIR = {
      name: 'p',
      breakpoints: [],
      views: [{ width: 390, bundle: bundleWithBelowFoldNode() }],
    }
    distilPlate(plate)
    for (const kid of plate.views[0]?.bundle.root.kids ?? []) expect(kid.dropped).toBeUndefined()
  })
})
