// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { serializePlateIR } from './serialize.ts'
import { captureView, distilPlate } from './measure.ts'
import { captureElement } from './core.ts'
import { serializePlate } from './chunk.ts'
import { irFromTree, type PlateIR } from './ir.ts'
import {
  SPEC_LEAF,
  type Chunk,
  type Plate,
  type PlateNode,
  type PlateRule,
  type RenderNode,
} from './plate.ts'

// Serialize (ADR 0022 §5) projects a per-Plate IR — measured by `captureView` and
// reduced by `distilPlate` — into the STRUCTURED `StoredPlate` (`{ tree, css }` +
// breakpoints), folding emit + the multi-View merge/gate + classify. The
// `serializePlate` lowering to `Plate` chunks stays gen-side, so these tests run it
// explicitly to assert on chunks. The 1-View projection stays structurally equal to
// the live `captureElement` path (`serializePlate(serializePlateIR) === captureElement`).

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

/** Count the nodes in a RenderNode-or-PlateNode-shaped tree (structure parity). */
function countNodes(tree: Plate['chunks']): number {
  // Walk the serialized chunks: a string is one or more flat nodes, a wrapper
  // recurses, a stitch/template is one. Used only for a coarse structure compare,
  // so the count of HTML `<div`s in the flattened strings is the proxy.
  let count = 0
  for (const chunk of tree ?? []) {
    if (typeof chunk === 'string') count += (chunk.match(/<div/g) ?? []).length
    else if ('k' in chunk) count += 1 + countNodes(chunk.k)
    else count += 1
  }
  return count
}

/** A two-View PlateIR built by hand from `PlateNode` trees (no DOM measure). */
function plateOfTrees(narrow: PlateNode, wide: PlateNode, breakpoint: number): PlateIR {
  return {
    name: 'multi',
    breakpoints: [breakpoint],
    views: [
      { width: 390, bundle: irFromTree(narrow) },
      { width: 1280, bundle: irFromTree(wide) },
    ],
  }
}

/** Find the first wrapper chunk (`{ c, k }`) whose own kids contain a stitch (`{ r }`). */
function islandHoldingStitch(chunks: readonly Chunk[]): { c: string; k: Chunk[] } | undefined {
  for (const chunk of chunks) {
    if (typeof chunk === 'string' || !('k' in chunk)) continue
    if (chunk.k.some((inner) => typeof inner === 'object' && 'r' in inner)) return chunk
    const deeper = islandHoldingStitch(chunk.k)
    if (deeper) return deeper
  }
  return undefined
}

/** True if class `c` carries a `display: none !important` rule under `@media`, in `css`. */
function gatedOffRange(c: string, css: string): boolean {
  // The gate class is emitted inside a `@media (...) { [data-xr-root] .c { display: none !important } }`.
  return new RegExp(
    `@media [^{]+\\{ \\[data-xr-root\\] \\.${c}[^}]*\\{ display: none !important \\}`,
  ).test(css)
}

describe('serializePlateIR: the IR projection (Serialize, step 5)', () => {
  it('matches the live captureElement path for a 1-view PlateIR (after gen-side serializePlate)', () => {
    style('.card { display: flex; gap: 8px; padding: 12px } .label { color: #333 }')
    const html =
      '<div class="card"><span class="label">hi</span><span class="label">yo</span></div>'

    // New path: measure into a 1-view PlateIR, run the passes, project to the
    // structured StoredPlate, then lower to chunks the way the gen-side will.
    const plate = captureView([mount(html)])
    plate.name = 'card'
    distilPlate(plate)
    const storedIR = serializePlateIR(plate)
    const viaIR = serializePlate(storedIR)

    // Live path: capture the SAME DOM under the SAME name — the two-artifact
    // contract hands back { plate, css } separately.
    const viaLive = captureElement([mount(html)], { name: 'card' })

    // Both run emit → classify over the same measured+reduced bundle, then the same
    // serializePlate, so BOTH artifacts are identical pairwise.
    expect(viaIR).toEqual(viaLive.plate)
    expect(storedIR.css).toBe(viaLive.css)
  })

  it('matches the live path on a tree with a stitch-free nesting + leaves', () => {
    style('.row { display: flex } .pic { width: 40px; height: 40px }')
    const html =
      '<section class="row"><img class="pic" src="x" alt=""><p>some text here</p></section>'

    const plate = captureView([mount(html)])
    plate.name = 'profile/row'
    distilPlate(plate)
    const storedIR = serializePlateIR(plate)
    const viaIR = serializePlate(storedIR)

    const viaLive = captureElement([mount(html)], { name: 'profile/row' })

    expect(viaIR).toEqual(viaLive.plate)
    expect(storedIR.css).toBe(viaLive.css)
  })

  it('carries breakpoints onto the StoredPlate (the HUD coverage source)', () => {
    const plate = captureView([mount('<div class="card"><span>hi</span></div>')])
    plate.name = 'card'
    plate.breakpoints = [768, 1024]
    distilPlate(plate)
    const stored = serializePlateIR(plate)
    // The structured stored shape carries breakpoints (not on GatedPlate / Plate).
    expect(stored.breakpoints).toEqual([768, 1024])
    expect('chunks' in stored).toBe(false)
  })

  it('produces gated, non-null output for a 2-view PlateIR', () => {
    style('.card { display: flex; padding: 12px }')
    // Two Views at different emulated widths, threaded through one PlateIR (the
    // sweep order is width-ascending). Breakpoints set as the orchestration would.
    const plate: PlateIR = { name: 'multi', views: [], breakpoints: [768] }
    captureView([mount('<div class="card"><span>narrow</span></div>')], {}, plate)
    // Override the appended View's width so the two Views own distinct ranges
    // (happy-dom reports one innerWidth for both captures).
    const narrow = plate.views[0]
    if (narrow) narrow.width = 390
    captureView(
      [mount('<div class="card"><span>wide one</span><span>wide two</span></div>')],
      {},
      plate,
    )
    const wide = plate.views[1]
    if (wide) wide.width = 1280

    distilPlate(plate)
    const stored = serializePlateIR(plate)
    const out = serializePlate(stored)

    // A 2-view plate serializes without error to real chunks, and the stored
    // artifact carries the css string (the tree-only Plate no longer does —
    // two-artifact contract).
    expect(out.name).toBe('multi')
    expect(out.chunks).not.toBeNull()
    expect(countNodes(out.chunks)).toBeGreaterThan(0)
    expect(typeof stored.css).toBe('string')
    // The multi-View merge gates each View's island by breakpoint (display:none
    // !important under a width @media), so the gated structure is present in the css.
    expect(stored.css).toContain('display: none !important')
    expect(stored.css).toMatch(/@media \((?:min|max)-width:/)
  })

  // ── the wrapper-island gate must reach a STITCH ──────────────────────────
  // A multi-View plate whose View has a STITCH top kid used to collapse off-range:
  // mergeViews gated each top kid, but `toChunks` serializes a stitch as a bare
  // `{ r }` (no class slot), so a gate landing on a stitch was silently DROPPED —
  // the off-range View's stitch stayed visible and squeezed the active View's
  // bones. The fix wraps each View's top kids in ONE gated island; the stitch
  // inherits the island's `display:none` off-range.
  it('gates a View whose top kid is a stitch, via the wrapper island', () => {
    // Narrow View: a single STITCH at top level. Wide View: a normal box.
    const narrow: PlateNode = { id: 0, kids: [{ id: 1, ref: 'news-feed' }] }
    const wide: PlateNode = { id: 0, kids: [{ id: 2, kids: [{ id: 3, leaf: 'text-line' }] }] }
    const stored = serializePlateIR(plateOfTrees(narrow, wide, 768))
    const out = serializePlate(stored)

    // The stitch is NOT a bare top-level `{ r }` anymore — it sits INSIDE an island
    // wrapper `{ c, k }` (a real classed <div>), which is what gives the gate a home.
    const topLevelStitch = (out.chunks ?? []).some(
      (chunk) => typeof chunk === 'object' && 'r' in chunk,
    )
    expect(topLevelStitch).toBe(false)

    const island = islandHoldingStitch(out.chunks ?? [])
    expect(island).toBeDefined()
    if (!island) throw new Error('expected an island wrapper around the stitch')
    // The stitch is the island's own kid (so it inherits the island's display).
    expect(island.k).toContainEqual({ r: 'news-feed' })

    // The island's class carries a `display: none !important` gate in the narrow
    // View's OFF range (>= 768px), so the whole subtree — stitch included — hides.
    // (Css lives on the stored artifact — the lowered Plate is tree-only.)
    const gated = island.c.split(' ').some((c) => gatedOffRange(c, stored.css))
    expect(gated).toBe(true)
    // And specifically under the narrow View's upper gate.
    expect(stored.css).toMatch(/@media \(min-width: 768px\)/)
  })

  // ── No-stitch non-regression ──────────────────────────────────────────────────
  // A stitch-free island has no render-time dynamic node, so `toChunks` flattens it
  // (and its whole subtree) into ONE HTML `string` — the island is just a classed
  // <div> in the markup. Both Views are still gated off-range; the ACTIVE View is
  // never hidden (its gate only fires under an @media it does not match in-range).
  it('gates each View off-range without hiding the active View (no stitches)', () => {
    const narrow: PlateNode = { id: 0, kids: [{ id: 1, kids: [{ id: 2, leaf: 'text-line' }] }] }
    const wide: PlateNode = { id: 0, kids: [{ id: 3, kids: [{ id: 4, leaf: 'media' }] }] }
    const stored = serializePlateIR(plateOfTrees(narrow, wide, 768))
    const out = serializePlate(stored)

    // Stitch-free: the whole plate flattens to a single HTML string holding TWO
    // island <div>s side by side (one per View) — no `{ c, k }` wrapper, no `{ r }`.
    expect(out.chunks).toHaveLength(1)
    const html = out.chunks?.[0]
    expect(typeof html).toBe('string')
    if (typeof html !== 'string') throw new Error('expected one flat HTML string')
    expect((html.match(/class="xr-node /g) ?? []).length).toBeGreaterThanOrEqual(2)

    // Both islands carry the layout-neutral `display: contents` (one shared class,
    // classify dedupes it) — so an ACTIVE island generates no box. (Css lives on
    // the stored artifact — the lowered Plate is tree-only.)
    expect(stored.css).toMatch(/\[data-xr-root\] \.[\w-]+ \{ display: contents \}/)

    // Both islands are gated in their OFF range: narrow hides at >=768, wide below.
    expect(stored.css).toMatch(
      /@media \(min-width: 768px\) \{ \[data-xr-root\] \.[\w-]+ \{ display: none !important \}/,
    )
    expect(stored.css).toMatch(
      /@media \(max-width: 767\.98px\) \{ \[data-xr-root\] \.[\w-]+ \{ display: none !important \}/,
    )

    // No `display: none` ever applies WITHOUT a @media guard — the active View, in
    // its own range, is never hidden (every gate is inside an `@media`).
    expect(stored.css.replace(/@media[^{]+\{[^}]*\}\s*\}/g, '')).not.toContain('display: none')
  })

  // ── cross-View id collision via the remap fallback ──────────────────
  // Each View's nodes are re-id'd into ONE shared global id space (`cloneWithIds`).
  // A shared author rule that lists a pass-DROPPED node by id (Superset/Crop/glyph-
  // fold removed it from the tree, but `emit` still carries the id) is the trap: that
  // id is absent from the View's `idMap`, and the old `?? id` fallback kept its OLD
  // per-View number — which is some OTHER View's global id. So one View's box-sizing /
  // flex / container rule got stamped onto another View's island & containers, and
  // those bands rendered crooked (the off-range multi-view collapse).
  it('does not leak one View’s rules onto another via the id-remap fallback', () => {
    // View A (narrow, projected first): three kids -> global ids 1,2,3; island id 4.
    const viewA: PlateNode = { id: 0, kids: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    // View B (wide): one real kid (id 1, keeps the rule alive) + a rule referencing
    // id 2 — NOT in B's tree, standing in for a dropped node a shared rule still lists.
    const viewB: PlateNode = { id: 0, kids: [{ id: 1 }] }
    const contaminant: PlateRule = {
      ids: [1, 2],
      decls: ['outline: 5px solid red'],
      spec: SPEC_LEAF,
      order: 0,
    }
    const plate: PlateIR = {
      name: 'collide',
      breakpoints: [768],
      views: [
        { width: 390, bundle: irFromTree(viewA) },
        { width: 1280, bundle: irFromTree(viewB, [contaminant]) },
      ],
    }
    const { css, tree } = serializePlateIR(plate)
    expect(tree).not.toBeNull()
    const contClass = css.match(/\.([\w-]+) \{ outline: 5px solid red/)?.[1]
    expect(contClass).toBeDefined()
    const carries = (n: RenderNode): boolean =>
      (n.cls?.split(' ').includes(contClass ?? '') ?? false) || (n.kids?.some(carries) ?? false)
    // View A's island subtree (tree.kids[0]) must NOT carry View B's rule.
    const islandA = tree?.kids?.[0]
    expect(islandA ? carries(islandA) : false).toBe(false)
  })
})
