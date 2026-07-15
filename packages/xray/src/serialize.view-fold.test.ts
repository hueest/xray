// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { serializePlateIR } from './serialize.ts'
import type { PlateNode } from './plate.ts'
import { irFromTree, type PlateIR } from './ir.ts'

/**
 * The identical-View fold (ADR 0029). Breakpoints arrive as the page's union (the matchMedia spy is
 * page-global), so a plate that does not change across neighboring bands would ship byte-identical
 * islands. Serialize folds runs of identical adjacent Views into one island and prunes the stored
 * breakpoints to the survivors' starts — the thresholds where the plate OBSERVABLY changes, which
 * is also exactly what coverage reads back out.
 */

const leaf = (id: number): PlateNode => ({ id, leaf: 'box' })
/** A wrapper ROOT whose kids are the content (matching emit's root shape). */
const one = (id: number): PlateNode => ({ id, kids: [leaf(id + 1)] })
const empty = (id: number): PlateNode => ({ id, kids: [] })
const two = (id: number): PlateNode => ({ id, kids: [leaf(id + 1), leaf(id + 2)] })

function plateOf(views: { width: number; tree: PlateNode }[], breakpoints: number[]): PlateIR {
  return {
    name: 'fold',
    breakpoints,
    views: views.map(({ width, tree }) => ({ width, bundle: irFromTree(tree) })),
  }
}

const gateCount = (css: string): number => css.split('display: none !important').length - 1

describe('identical adjacent Views fold', () => {
  it('all-identical Views collapse to one ungated View with no breakpoints', () => {
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: one(1) },
          { width: 800, tree: one(1) },
          { width: 1300, tree: one(1) },
        ],
        [576, 1200],
      ),
    )
    expect(stored.breakpoints).toEqual([])
    expect(stored.spans).toEqual([{}])
    expect(gateCount(stored.css)).toBe(0)
    // Single-view shape: the one View's root, no islands.
    expect(stored.tree?.kids).toHaveLength(1)
    expect(stored.tree?.kids?.[0]?.leaf).toBe('box')
  })

  it('folds only the identical run and prunes the breakpoints between them', () => {
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: two(1) }, // band [0, 576): differs
          { width: 800, tree: one(1) }, // band [576, 1200)
          { width: 1300, tree: one(1) }, // band [1200, ∞): identical to 800 → folds
        ],
        [576, 1200],
      ),
    )
    // 1200 no longer separates anything; 576 still does.
    expect(stored.breakpoints).toEqual([576])
    expect(stored.spans).toEqual([{ max: 576 }, { min: 576 }])
    // Two islands, one gate each (first hidden above, second hidden below).
    expect(stored.tree?.kids).toHaveLength(2)
    expect(gateCount(stored.css)).toBe(2)
  })

  it('keeps every View and breakpoint when neighbors differ', () => {
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: one(1) },
          { width: 800, tree: two(1) },
          { width: 1300, tree: one(1) },
        ],
        [576, 1200],
      ),
    )
    expect(stored.breakpoints).toEqual([576, 1200])
    expect(stored.spans).toEqual([{ max: 576 }, { min: 576, max: 1200 }, { min: 1200 }])
    expect(stored.tree?.kids).toHaveLength(3)
    // Middle island carries both gates; outer islands one each.
    expect(gateCount(stored.css)).toBe(4)
  })

  it('a genuinely single-View capture keeps its detected breakpoints (unswept, not proven identical)', () => {
    const stored = serializePlateIR(plateOf([{ width: 1300, tree: one(1) }], [576, 1200]))
    expect(stored.breakpoints).toEqual([576, 1200])
    // ONE captured band; the rest are unswept gaps, not claimed.
    expect(stored.spans).toEqual([{ min: 1200 }])
    expect(gateCount(stored.css)).toBe(0)
  })

  it('id numbering does not defeat the fold (same structure, different capture ids)', () => {
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: two(10) },
          { width: 1300, tree: two(700) },
        ],
        [1200],
      ),
    )
    expect(stored.breakpoints).toEqual([])
    expect(stored.spans).toEqual([{}])
    expect(gateCount(stored.css)).toBe(0)
  })

  it('does NOT fold identical Views across an unswept band (adjacency required)', () => {
    // Bands [0,576) and [1200,∞) captured identically; [576,1200) never visited.
    // Identity across the hole is unproven — both Views survive, every breakpoint
    // stays, and the spans record the hole.
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: two(1) },
          { width: 1300, tree: two(1) },
        ],
        [576, 1200],
      ),
    )
    expect(stored.breakpoints).toEqual([576, 1200])
    expect(stored.spans).toEqual([{ max: 576 }, { min: 1200 }])
    expect(stored.tree?.kids).toHaveLength(2)
    expect(gateCount(stored.css)).toBe(2)
  })

  it('folds captured absence: empty Views merge into one empty gated island', () => {
    // The sweep records a component observed UNMOUNTED at narrow widths as empty
    // Views (client runSweep). They fold into a single empty island gated to the
    // absent range; the content island keeps the mount boundary; coverage is
    // complete.
    const stored = serializePlateIR(
      plateOf(
        [
          { width: 390, tree: empty(1) },
          { width: 600, tree: empty(1) },
          { width: 1000, tree: empty(1) },
          { width: 1300, tree: two(1) },
        ],
        [576, 992, 1200],
      ),
    )
    expect(stored.breakpoints).toEqual([1200])
    expect(stored.spans).toEqual([{ max: 1200 }, { min: 1200 }])
    expect(stored.tree?.kids).toHaveLength(2)
    // The empty island has no kids and hides at/above the mount boundary; the
    // content island hides below it.
    expect(stored.tree?.kids?.[0]?.kids ?? []).toEqual([])
    expect(gateCount(stored.css)).toBe(2)
  })
})
