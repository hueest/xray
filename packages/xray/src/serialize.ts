import { viewSpanFor } from './breakpoints.ts'
import {
  type PlateNode,
  type PlateRule,
  PLATE_VERSION,
  SPEC_FALLBACK,
  SPEC_GATE,
  type StoredPlate,
} from './plate.ts'
import { emit, type PlateIR } from './ir.ts'
import { classify } from './classify.ts'

/**
 * SERIALIZE — the single in-browser projection of a per-Plate IR into the shipped `Plate` (ADR 0022
 * §5). The capture session measures every View into one `PlateIR` (`captureView`, measure.ts) and
 * runs the Distil passes over it ONCE (`distilPlate`, measure.ts); Serialize is the step AFTER — it
 * only PROJECTS, it runs no passes. It assumes each `view.bundle` is already measured AND distilled
 * (the annotate-only passes have set their `dropped`/`folded`/ `flattened`/`count` fields), and
 * lowers those annotations into the shipped shape.
 *
 * It FOLDS `emit` (ir.ts) — emit is the per-View projection that reads the IR back out into id-form
 * `{ tree, rules }`, lowering the annotations via `effectiveKids`/
 * `boneBox`/`effectiveKind`/`effectiveDecls`. Serialize calls it once per View, then carries every
 * View whole under ONE id-tree and gates each View by breakpoint in-line (the multi-View gate lives
 * HERE — ADR 0022), and runs `classify` to content-address the rules. It returns a `StoredPlate` —
 * the gated, content-addressed `{ tree, css }` PLUS `breakpoints` — NOT finished chunks: the
 * `serializePlate` (chunk.ts) lowering to `Plate` chunks stays GEN-SIDE at module-load (ADR 0022
 * §5), keeping the Tailwind/Bundle passthrough a clean gen-side seam and the analysis-only geometry
 * off the wire (only this structured projection is posted).
 *
 * The wrapper-island gate (ADR 0022 §2 invariant). A View's breakpoint gate must hide the View's
 * ENTIRE subtree off-range — INCLUDING any stitch — regardless of whether a node has a serializable
 * class slot. Gating each top kid individually silently drops a gate that lands on a stitch,
 * because `toChunks` serializes a stitch as a bare `{ r }` with no class slot (the off-range View
 * collapse: a parent skeleton stitching nested children collapsed off-range). So each View's top
 * kids are wrapped in ONE synthetic CONTAINER "island" that ALWAYS carries a class; the island is
 * gated ONCE and its `display: none !important` inherits to any stitch inside. Active, the island
 * is `display: contents` so it generates no box — layout-neutral (`.xr-node` sets no display,
 * `.xr-root` is itself `display: contents`, so nothing overrides it). This also reduces the gate
 * rules from N-per-View to 1-per-View and is uniform across stitch top-kids, flattened-to-top
 * stitches, and nested stitches alike.
 *
 * Pure data-in/data-out over the (already-distilled) IR — `emit` and everything below read only the
 * passed structures, re-measure nothing.
 */
export function serializePlateIR(plate: PlateIR): StoredPlate {
  // Project each View's already-distilled bundle to id-form `{ tree, rules }`. Sort
  // by width defensively to match the live order (PlateIR.views arrive in
  // width-ascending sweep order, so this is normally a no-op).
  const views = plate.views
    .map((view) => emit(view.bundle))
    .map((projected, i) => ({ width: plate.views[i]?.width ?? 0, ...projected }))
    .toSorted((a, b) => a.width - b.width)

  // SINGLE-View: classify the one View's `{ tree, rules }` with NO gating, so the
  // stored `{ tree, css }` matches what the live `capture` (GatedPlate) produces
  // (serialize.test.ts asserts this). An empty bundle stores a null-tree plate.
  if (views.length <= 1) {
    const only = views[0]
    if (!only)
      return {
        v: PLATE_VERSION,
        name: plate.name,
        breakpoints: plate.breakpoints,
        tree: null,
        css: '',
      }
    const { tree, css } = classify(only.rules, only.tree, plate.name)
    return { v: PLATE_VERSION, name: plate.name, breakpoints: plate.breakpoints, tree, css }
  }

  // MULTI-View: build `root(id:0) → [island_0, island_1, …]`. Each island is a
  // synthetic CONTAINER wrapping View i's fresh-id-remapped top kids; it carries a
  // `display: contents` fallback (layout-neutral when active) and the View's
  // breakpoint gate (`display: none !important` in its off-range). Fresh-id
  // allocation + rule remap live here, in the browser (ADR 0022).
  //
  // Each View owns a contiguous viewport range: from its own lower breakpoint up to
  // the next View's, so coverage is gapless — a width with no captured View falls to
  // the nearest narrower one rather than rendering blank.
  const starts = views.map((view) => viewSpanFor(view.width, plate.breakpoints).min ?? 0)

  let nextId = 1
  const islands: PlateNode[] = []
  const rules: PlateRule[] = []

  views.forEach((view, i) => {
    const idMap = new Map<number, number>()
    const kids = (view.tree.kids ?? []).map((kid) => cloneWithIds(kid, idMap, () => nextId++))
    rules.push(...remapRules(view.rules, idMap))

    // ONE island per View, gated once. A fresh id (above every remapped kid id, so
    // it never collides) anchors the island's own `display: contents` + gate rules.
    const islandId = nextId++
    islands.push({ id: islandId, kids })

    // `display: contents` makes the island layout-neutral when ACTIVE: it generates
    // no box, so its kids participate in the root's flow exactly as they did
    // un-wrapped. Emitted as the island's fallback decl (SPEC_FALLBACK), exactly as
    // a node's fallback rules are emitted — beaten off-range by the gate (SPEC_GATE).
    rules.push({
      ids: [islandId],
      decls: ['display: contents'],
      spec: SPEC_FALLBACK,
      order: islandId,
    })

    // Gate the WHOLE island (and thus any stitch inside it, via inherited
    // display:none) to this View's range: below its `lo` and at/above the next
    // View's start `hi` it is hidden. `display: none !important` (SPEC_GATE)
    // beats the island's `display: contents` off-range.
    const lo = i === 0 ? 0 : (starts[i] ?? 0)
    const hi = i === views.length - 1 ? Number.POSITIVE_INFINITY : (starts[i + 1] ?? 0)
    if (lo > 0) rules.push(gate(islandId, `(max-width: ${lo - 0.02}px)`))
    if (hi !== Number.POSITIVE_INFINITY) rules.push(gate(islandId, `(min-width: ${hi}px)`))
  })

  const { tree, css } = classify(rules, { id: 0, kids: islands }, plate.name)
  return { v: PLATE_VERSION, name: plate.name, breakpoints: plate.breakpoints, tree, css }
}

/** One breakpoint gate: hide this id's subtree (`display:none` inherits) under `condition`. */
function gate(id: number, condition: string): PlateRule {
  return {
    ids: [id],
    decls: ['display: none !important'],
    media: [condition],
    spec: SPEC_GATE,
    order: id,
  }
}

/** Deep-clone a captured subtree into fresh ids, recording the mapping. */
function cloneWithIds(
  node: PlateNode,
  idMap: Map<number, number>,
  allocate: () => number,
): PlateNode {
  const id = allocate()
  idMap.set(node.id, id)
  const kids = node.kids?.map((kid) => cloneWithIds(kid, idMap, allocate))
  return {
    id,
    ...(node.leaf ? { leaf: node.leaf } : {}),
    ...(node.ref !== undefined ? { ref: node.ref } : {}),
    ...(node.count !== undefined ? { count: node.count } : {}),
    ...(kids ? { kids } : {}),
  }
}

/**
 * Remap a View's rule ids onto its fresh-id-remapped nodes. Every View's nodes are re-id'd into one
 * shared global id space here, so a rule id that is NOT in this View's `idMap` must NOT keep its
 * per-View number: that number is some OTHER View's global id, and aliasing onto it
 * cross-contaminates Views (a box-sizing/flex rule from View B landing on View A's island/container
 * — the crooked multi-view layout). An unmapped id is one of two things:
 *
 * - `0` — the per-View synthetic root. Its rules (carried tokens, the context rule) belong on the ONE
 *   shared plate root, also id 0, so map `0 → 0`.
 * - Any other unmapped id — a node a Distil pass DROPPED (Superset/Crop/glyph-fold) that a shared
 *   author rule still lists by id. It has no node in this View's projected tree, so drop the id
 *   (emit already prunes `extraRules` this way; author rules were the gap). A rule left with no ids
 *   is itself dropped — note an originally-rootward rule (`ids: []`) is preserved as-is, since
 *   `classify` resolves an empty `ids` to the root.
 */
function remapRules(rules: readonly PlateRule[], idMap: Map<number, number>): PlateRule[] {
  const out: PlateRule[] = []
  for (const rule of rules) {
    if (rule.ids.length === 0) {
      out.push(rule)
      continue
    }
    const ids: number[] = []
    for (const id of rule.ids) {
      const mapped = idMap.get(id)
      if (mapped !== undefined) ids.push(mapped)
      else if (id === 0) ids.push(0)
    }
    if (ids.length > 0) out.push({ ...rule, ids })
  }
  return out
}
