import type { CaptureDiagnostic } from './diagnostics.ts'
import { type LeafKind, type PlateNode, type PlateRule, SPEC_FALLBACK, SPEC_LEAF } from './plate.ts'
import type { Salience } from './salience.ts'

/**
 * The light-DOM IR (ADR 0021 §1; ADR 0022). One node tree the capture walk (Measure) builds
 * directly: each measured element / synthetic bar becomes an `IRNode` at its build site, linked
 * into its parent's `kids` and pushed to a flat push-order list (`IRBundle.nodes`). A single tree
 * with no parallel entry list leaves the Distil passes no id-reconciliation to do (ADR 0022).
 *
 * `emit` reads the (grouped) IR back out into a per-View `ViewCapture`'s `{tree, rules}`. The
 * output flows from each node's `decls`; the IR is the per-View output spine. `irFromTree`
 * reconstructs an entry-less bundle from a hand-built / on-disk `{tree, rules}` (the golden and
 * projection fixtures replay post-Distil captures, so they need no walk).
 */

/** A leaf's semantic role plus the structural roles (root / container / stitch) the walk emits. */
export type IRKind = LeafKind | 'root' | 'container' | 'stitch'

/**
 * A frozen, plain-object snapshot of the bounded set of computed-style properties the post-walk IR
 * passes read (ADR 0022 invariant 5). Measure (the walk) is the sole DOM stage; it copies these
 * values off the live `CSSStyleDeclaration` once, per node, into this object, so no pass can
 * re-read the DOM. A plain `{ prop: string }` interface, expandable as later passes need more
 * computed props. The set covers every `cs.<prop>` the classification / Absorb / salience paths
 * need; `markInk` reads them from the snapshot, never the DOM. Every prop is a plain `string`: an
 * entry-less node (root, stitch, synthetic bar) gets a frozen all-empty object, so
 * `node.style.display` etc. are always safe to read, never `undefined`.
 */
export interface LiteStyleDeclaration {
  display: string
  lineHeight: string
  fontSize: string
  position: string
  transform: string
  margin: string
  padding: string
  overflowY: string
  overflowX: string
  // ---- classification / Absorb / salience inputs (read by markInk) ----
  visibility: string
  opacity: string
  backgroundColor: string
  backgroundImage: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  borderWidth: string
  borderStyle: string
  borderTopStyle: string
  borderRightStyle: string
  borderBottomStyle: string
  borderLeftStyle: string
  borderColor: string
  borderTopColor: string
  boxShadow: string
  rowGap: string
  columnGap: string
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  marginTop: string
  marginRight: string
  marginBottom: string
  marginLeft: string
  fontWeight: string
  justifyContent: string
  alignContent: string
  justifyItems: string
  alignItems: string
  verticalAlign: string
}

/** A frozen `LiteStyleDeclaration` of empty strings, for entry-less nodes (root/stitch/synthetic). */
export const EMPTY_STYLE: LiteStyleDeclaration = Object.freeze({
  display: '',
  lineHeight: '',
  fontSize: '',
  position: '',
  transform: '',
  margin: '',
  padding: '',
  overflowY: '',
  overflowX: '',
  visibility: '',
  opacity: '',
  backgroundColor: '',
  backgroundImage: '',
  borderTopWidth: '',
  borderRightWidth: '',
  borderBottomWidth: '',
  borderLeftWidth: '',
  borderWidth: '',
  borderStyle: '',
  borderTopStyle: '',
  borderRightStyle: '',
  borderBottomStyle: '',
  borderLeftStyle: '',
  borderColor: '',
  borderTopColor: '',
  boxShadow: '',
  rowGap: '',
  columnGap: '',
  paddingTop: '',
  paddingRight: '',
  paddingBottom: '',
  paddingLeft: '',
  marginTop: '',
  marginRight: '',
  marginBottom: '',
  marginLeft: '',
  fontWeight: '',
  justifyContent: '',
  alignContent: '',
  justifyItems: '',
  alignItems: '',
  verticalAlign: '',
})

/** Capture-time geometry snapshot. Analysis-only, never shipped (ADR 0021). */
export interface IRRect {
  x: number
  y: number
  width: number
  height: number
}

/** Per-line text ink, from the capture-side `pretext`/`Range` oracle. */
export interface IRTextInk {
  lineRects: IRRect[]
  lineCount: number
  maxLineWidth: number
  lineHeight: number
}

/**
 * The `LeafKind` values, as a runtime list (kept local so `ir.ts` has no runtime edge back to
 * `measure.ts`).
 */
const LEAF_KINDS: readonly LeafKind[] = ['text-line', 'text-block', 'media', 'box', 'hidden']

function isLeafKind(kind: IRKind): kind is LeafKind {
  return (LEAF_KINDS as readonly string[]).includes(kind)
}

export interface IRNode {
  /**
   * Plate-local id; rules reference it pre-classify, the same id-space the walk stamps onto each
   * node.
   */
  id: number
  /** The source element. Null for the synthetic root, stitches, and synthetic text bars. */
  el: Element | null
  kind: IRKind
  kids: IRNode[]
  /** Depth from the synthetic root (0). A Depth-LOD input (shelved, ADR 0022), free to snapshot now. */
  depth: number

  // ---- layout declarations lifted into the node ----
  /**
   * `fallback` (capture-time display/vertical-align hints) and `size` (a leaf's measured
   * box-sizing/width/height) are stamped by the walk at the node's build site. `author` (the lifted
   * CSSOM author rules plus any inline-style decls targeting this node) and `carried` (the carried
   * custom-property definition rules anchored here, ADR 0019 §1) are filled by the build phase's
   * CSS-extract. Each is a self-describing `PlateRule` (carrying its own
   * spec/order/media/container), so `emit` rebuilds the flat rule list straight from the IR.
   */
  decls: {
    fallback: string[]
    size?: string[]
    author?: PlateRule[]
    carried?: PlateRule[]
  }
  /**
   * Frozen snapshot of the bounded computed-style set the post-walk passes read (ADR 0022 invariant
   * 5). Measure copies these off the live `CSSStyleDeclaration` once; the live view is NOT stored,
   * so a pass cannot re-read the DOM. Always defined (entry-less nodes get a frozen all-empty
   * object), so `node.style.display` etc. are always a safe `string`. Includes
   * `overflowY`/`overflowX` — the Crop pass's clip inputs (2D) — alongside
   * `scrollHeight`/`clientHeight` and `scrollWidth`/`clientWidth` (geometry, below).
   */
  style: LiteStyleDeclaration

  /**
   * Raw clip metrics for the Crop pass (ADR 0022 invariants 3 & 5), snapshotted up front, one pair
   * per axis. These are GEOMETRY, not style, so they sit beside `style` (which carries the computed
   * `overflow-y`/`overflow-x`). Each axis's pair is snapshotted ONLY when that axis's overflow
   * clips, since reading them can force a layout. From `scrollHeight`/`clientHeight` (plus
   * `style.overflowY`) `cropIR` derives whether this node clips VERTICALLY — and its visible
   * bottom; symmetrically `scrollWidth`/`clientWidth` (plus `style.overflowX`) give the HORIZONTAL
   * clip and its visible right edge — without re-measuring the DOM. Each pair is undefined for a
   * node that does not clip that axis, or a synthetic bar; `nodeClipsY`/`nodeClipsX` each require
   * BOTH of their pair, so they treat the absence (even alongside a clipping `overflow`) as "not a
   * clipping context" on that axis.
   */
  scrollHeight?: number
  clientHeight?: number
  scrollWidth?: number
  clientWidth?: number

  /**
   * Paint snapshot (Absorb / box / markInk inputs), RESOLVED by Measure per element node (ADR 0022
   * invariant 5). Measure runs the canvas-resolving paint helpers ONCE, at measure time, while
   * layout is warm and `toRgb`'s canvas round-trip can resolve `oklch()`/`color()`, and stores the
   * booleans + the resolved background so a later pass reads them off the IR, never the DOM: -
   * `surface` — `hasVisibleBackground` (a painted bg colour or image). - `bg` — the resolved
   * `background-color` (canvas-resolved to `rgb()`), when one paints; undefined for a
   * transparent/image-only fill. - `contrastingFill` — `hasContrastingFill` (a fill visibly
   * differing from the nearest painted ancestor — Absorb's fill trigger). - `radius` — the computed
   * `border-radius` (a box-shape hint). Undefined for an entry-less node (root, stitch, synthetic
   * text bar) — those paint no element. Read by `markInk`/Absorb off the IR (ADR 0022).
   */
  paint?: { surface: boolean; bg?: string; contrastingFill?: boolean; radius?: string }
  /**
   * The resolved Salience vector (ADR 0019 §4), computed by Measure per element node via
   * `salience()` — the four visual axes plus the blended score. Measure resolves the
   * ancestor-climbing context it needs (the nearest painted background `behind` via `toRgb`, the
   * base font-size) and snapshots the result so a later pass reads the vector off the IR rather
   * than re-scoring against the DOM (ADR 0022 invariants 3 & 5). Undefined for an entry-less node.
   */
  salience?: Salience

  // ---- optional per-node snapshots and pass inputs ----
  /** Geometry snapshot, stamped by Measure. Analysis-only; read through `boneBox`. */
  box?: IRRect
  /** Text ink (per-line rects), stamped at measure time; drives line/block, glyph-fold, and the rep. */
  ink?: IRTextInk
  /** `@container` line-count rep bands — deferred; carried as `IRBundle.extraRules`. */
  repBands?: PlateRule[]
  /**
   * Whether this node's element is a replaced-media tag (`MEDIA_TAGS`), snapshotted by Measure (the
   * walk) so `markInk` can classify a `media` leaf WITHOUT reading `el.tagName` (ADR 0022
   * invariants 3 & 5 — a pass reads only the IR). Undefined for an entry-less node (root, stitch,
   * synthetic text bar) and for a non-media element. The walk computes the `MEDIA_TAGS` membership
   * once, at the node's build site, and carries it here.
   */
  isMedia?: boolean
  /**
   * The author-declared `data-xr-bone-kind` Hint (ADR 0018; ADR 0022 §5), snapshotted by the walk
   * onto the element's own node. The walk DESCENDS normally so the full subtree is measured;
   * `markInk` then re-stamps the node into one childless bone of this kind and lowers the measured
   * subtree (annotate-then-lower). Undefined unless the author named a valid kind on this element.
   */
  markKind?: LeafKind
  /** Whether this node establishes an inline formatting context (run/group input) — deferred. */
  isInlineFlow?: boolean
  /** Whether this node is a flex/grid item (Flatten input) — deferred. */
  flexItem?: boolean
  /** Structural-shape memo for Template's uniform-run matching (`distil.ts` caches into it). */
  structuralHash?: string

  // ---- structure + source order ----
  /**
   * A templated uniform run (Template, ADR 0022): this node stands in for `count` identical sibling
   * cells. Set by the Template pass; carried to `PlateNode`/`RenderNode` and emitted as one HTML
   * template + a count the renderer expands.
   */
  count?: number
  /**
   * Marks a node for removal from the shipped Plate. `emit` is the sole lowering point: it omits a
   * `dropped` node AND its subtree from `{tree, rules}`, so no dead bone or CSS ships.
   * Non-destructive — the node stays in the IR with its geometry/decls intact, so later passes and
   * diagnostics still see it (the annotate-then-lower invariant). Reasons: `'subset'` = the
   * Superset pass found this Bone wholly inside a larger solid Bone, which renders the same area
   * (`by` is the superset Bone's id); `'orphaned'` = a container left with no surviving Bone once
   * its children were dropped; `'cropped'` = the Crop pass found this Bone past the capture-time
   * fold on EITHER axis (the visible bottom OR right edge of its nearest clipping context — a
   * scroll/overflow ancestor, or the viewport as the base case; e.g. an off-screen-bottom row or an
   * off-screen-right carousel card); `'folded'` = the glyph-fold pass absorbed this glyph-sized
   * icon into an adjacent text line, which carries their union as its `folded` box (no `by` — the
   * fold is a sibling merge, not a containment); `'invisible'` = the `markInk` pass found this node
   * visually hidden (`visibility: hidden|collapse` or `opacity <= INVISIBLE_OPACITY`) — Measure
   * DESCENDS such a node (a `visibility: visible` descendant that CSS re-shows survives) and
   * `markInk` annotates only the hidden node (`effectiveKids` omits it and any non-re-shown
   * subtree). `'absorbed'` = the `markInk` Absorb branch found this node's parent to be a contrast
   * SURFACE whose content reduces to a single label/run (ADR 0021 §3); the parent is re-stamped a
   * childless `box` and each of its effective kids is marked `absorbed`, so `effectiveKids`/emit
   * lower the subtree and the surface renders as one box. `'collapsed'` = the author/walker
   * declared this element a single bone via `data-xr-bone-kind` (ADR 0018; ADR 0022 §5); the
   * `markInk` re-stamp lowers its measured subtree so it renders as ONE childless bone of the
   * declared kind (annotate-then-lower). `'ignored'` = the capture walker's `ctx.ignore()` dropped
   * this element AND its subtree (ADR 0018; ADR 0022 §5). WALKER-ONLY: the `applyWalker` pass sets
   * it post-measure — the element is measured, then lowered. The declarative `data-xr-ignore` Hint
   * stays walk-time (the element is never built into the IR), so it never produces this reason. The
   * generic field hosts future reasons without a new annotation per pass.
   */
  dropped?: {
    reason:
      | 'subset'
      | 'orphaned'
      | 'cropped'
      | 'folded'
      | 'invisible'
      | 'absorbed'
      | 'collapsed'
      | 'ignored'
    by?: number
  }
  /**
   * A glyph-fold survivor (ADR 0022 §4). The glyph-fold pass absorbed a glyph-sized icon sibling
   * into THIS single-line text node: it records the EFFECTIVE bone box (the union of the icon +
   * this unit) plus the synthesized inline-block + width/height decls of the resulting bar, and
   * marks the icon `dropped: { reason: 'folded' }`. Like `dropped`/`flattened` this is
   * non-destructive — the node stays in the IR with its raw `box`/`decls`/`kids` intact; only its
   * EFFECTIVE projection changes. A folded node renders as ONE synthetic text bar: for `emit` and
   * every downstream geometry/shape pass it is an effective `text` LEAF at `folded.box`, with
   * `folded.decls` (its own author/carried/fallback/size SUPPRESSED) and NO kids. The accessors
   * `boneBox` / `effectiveKind` / `effectiveKids` are the single place this realization lives;
   * consumers read through them, never the raw fields.
   */
  folded?: { box: IRRect; decls: { fallback: string[]; size?: string[] } }
  /**
   * A passthrough wrapper the projection splices out, hoisting its kids into its parent's slot in
   * place (ADR 0022 §4). Set by the Flatten pass on a layout-only container that contributes
   * nothing its single child does not already produce (coincident box, no margin, static, no
   * transform, no carried token). Like `dropped`, this is non-destructive — the node stays in the
   * IR with its geometry and decls; only its EMISSION changes: `emit` omits the node itself (no
   * tree node, no rules — `isPassthroughWrapper` guarantees it carries no tokens, zero margin, and
   * a coincident box, so there is no layout to lose) and hoists its (recursively-resolved,
   * non-dropped) kids into the parent. A whole flattened chain therefore collapses to a fixpoint at
   * projection.
   */
  flattened?: boolean
  /** The stitch target name (mirrors `PlateNode.ref`); present iff `kind === 'stitch'`. */
  ref?: string
}

/**
 * The IR root plus the rules the output needs that are NOT anchored to a single node: the
 * `@container` text-rep bands (`extraRules`, ADR 0019 §2) and the inherited text-context rule
 * (`contextRule`, the parent-font rule the plate renders detached from — `baseRules`' `ids: []`
 * rule). `emit` folds both in.
 */
export interface IRBundle {
  root: IRNode
  /**
   * The flat list of measured nodes in WALK PUSH ORDER: the synthetic root is excluded, every
   * element/synthetic-bar node appears exactly once, parent-before-child (pre-order), siblings
   * left-to-right. `emit` orders the synthesized fallback/size rules by a node's position here, so
   * the lifted rules keep the walk's source order by construction. Undefined for a hand-built
   * bundle (`irFromTree`); there `emit` falls back to the tree's pre-order.
   */
  nodes?: IRNode[]
  extraRules: PlateRule[]
  contextRule?: PlateRule
}

/**
 * One captured View's measured IR plus the breakpoint range it owns (ADR 0022 §2). A `ViewIR` is
 * what one `capture(el, ir?)` call appends to the per-Plate bundle: the `IRBundle` it measured, the
 * viewport `width` it was captured at, and (filled by the orchestration that derives breakpoints)
 * the `[min, max)` range it renders across, so the projection (Serialize, step 5) can gate it
 * without re-deriving. `diagnostics` rides the bundle transiently — logged/posted, never persisted
 * (mirrors `ViewCapture.diagnostics`, plate.ts).
 */
export interface ViewIR {
  width: number
  /**
   * The viewport height this View was captured at — the Crop pass's base-case fold (a Bone below
   * it, with no nearer clipping ancestor, is off-screen). Snapshotted by Measure (`captureView`) so
   * the Distil passes run as a pure `IR → IR` step AFTER the sweep without re-reading
   * `window.innerHeight` (which, post-sweep, sits at the last View's width — ADR 0022 invariant 3).
   * Undefined for a manually-built bundle, where Crop falls back to a per-node clipping ancestor
   * only.
   */
  viewportHeight?: number
  /** Lower bound of the viewport range this View owns (inclusive); undefined until derived. */
  min?: number
  /** Upper bound of the viewport range this View owns (exclusive); undefined for the widest View. */
  max?: number
  bundle: IRBundle
  diagnostics?: CaptureDiagnostic[]
  /**
   * The breakpoint thresholds this View contributes, derived from its RAW (pre-Distil) rules. The
   * manual capture session (client.ts) distils each View as it is captured, so it cannot re-derive
   * breakpoints from the distilled rules later — a dropped node's `@media` boundary would be lost
   * (the same hazard `sendPlate` avoids by deriving pre-Distil). Seeded once at capture; unioned at
   * projection. Unused by the single-shot capture/sweep paths, which derive over the whole bundle.
   */
  bpSeed?: number[]
}

/**
 * The per-Plate IR bundle (ADR 0022 §2): every captured View of one Plate, held SIDE BY SIDE (not
 * merged into corresponding nodes — that cross-View tree-merge is what ADR 0004 found unreliable).
 * The orchestration threads one `PlateIR` through a Plate's per-View `capture(el, ir)` calls in a
 * single session, then the one in-browser `Serialize` (step 5) projects the whole bundle into the
 * shipped Plate. `breakpoints` is the union the Plate covers (`StoredPlate.breakpoints`).
 */
export interface PlateIR {
  name: string
  views: ViewIR[]
  breakpoints: number[]
}

/**
 * Run a per-View pass over every View of a `PlateIR` (ADR 0022 §3). The pass is the
 * annotate-in-place kind — it mutates `view.bundle.root`'s nodes (sets `dropped`/`folded`/`count`/…
 * fields) and returns nothing; `eachView` just sequences it across the bundle's Views. A cross-View
 * pass reads across `plate.views` directly instead (those stay deferred; ADR 0022 §2).
 */
export function eachView(plate: PlateIR, pass: (view: ViewIR) => void): void {
  for (const view of plate.views) pass(view)
}

/**
 * Reconstruct an entry-less `IRBundle` from a hand-built / on-disk `{tree, rules}` capture (the
 * golden + projection fixtures, which replay a POST-Distil capture, so there is nothing to
 * measure). Pure: reads only the passed structures. Every node is entry-less — `el: null`, the
 * shared frozen empty `style`, an empty `decls.fallback` — and the rules ride as the bundle's
 * `extraRules`, so `emit` rebuilds them verbatim. No `nodes` push-order list (these never walked),
 * so `emit` falls back to the tree's pre-order. The live capture path does NOT use this — the walk
 * builds the IR directly (ADR 0022).
 */
export function irFromTree(tree: PlateNode, extraRules: readonly PlateRule[] = []): IRBundle {
  return { root: emptyIRNode(tree, 0), extraRules: [...extraRules] }
}

/** Build one entry-less `IRNode` (and its subtree) from a `PlateNode`, for `irFromTree`. */
function emptyIRNode(node: PlateNode, depth: number): IRNode {
  const kind: IRKind =
    node.ref !== undefined
      ? 'stitch'
      : node.leaf !== undefined
        ? node.leaf
        : node.id === 0
          ? 'root'
          : 'container'
  return {
    id: node.id,
    el: null,
    kind,
    kids: (node.kids ?? []).map((kid) => emptyIRNode(kid, depth + 1)),
    depth,
    decls: { fallback: [] },
    style: EMPTY_STYLE,
    ...(node.ref !== undefined ? { ref: node.ref } : {}),
    ...(node.count !== undefined ? { count: node.count } : {}),
  }
}

/**
 * Copy the bounded computed-style set off the live `CSSStyleDeclaration` into a frozen plain object
 * (ADR 0022 invariant 5). The live view is NEVER stored, so a pass cannot re-read the DOM. Each
 * prop coalesces to `''` so a node whose `cs` carries only a partial set (a test stub, or a
 * UA-default-only element) still reads a safe `string`, never `undefined`. Called by the walk at
 * each node's build site (it already holds the live `cs`) — the snapshot folds into Measure.
 */
export function snapshotStyle(cs: CSSStyleDeclaration): LiteStyleDeclaration {
  return Object.freeze({
    display: cs.display ?? '',
    lineHeight: cs.lineHeight ?? '',
    fontSize: cs.fontSize ?? '',
    position: cs.position ?? '',
    transform: cs.transform ?? '',
    margin: cs.margin ?? '',
    padding: cs.padding ?? '',
    overflowY: cs.overflowY ?? '',
    overflowX: cs.overflowX ?? '',
    visibility: cs.visibility ?? '',
    opacity: cs.opacity ?? '',
    backgroundColor: cs.backgroundColor ?? '',
    backgroundImage: cs.backgroundImage ?? '',
    borderTopWidth: cs.borderTopWidth ?? '',
    borderRightWidth: cs.borderRightWidth ?? '',
    borderBottomWidth: cs.borderBottomWidth ?? '',
    borderLeftWidth: cs.borderLeftWidth ?? '',
    borderWidth: cs.borderWidth ?? '',
    borderStyle: cs.borderStyle ?? '',
    borderTopStyle: cs.borderTopStyle ?? '',
    borderRightStyle: cs.borderRightStyle ?? '',
    borderBottomStyle: cs.borderBottomStyle ?? '',
    borderLeftStyle: cs.borderLeftStyle ?? '',
    borderColor: cs.borderColor ?? '',
    borderTopColor: cs.borderTopColor ?? '',
    boxShadow: cs.boxShadow ?? '',
    rowGap: cs.rowGap ?? '',
    columnGap: cs.columnGap ?? '',
    paddingTop: cs.paddingTop ?? '',
    paddingRight: cs.paddingRight ?? '',
    paddingBottom: cs.paddingBottom ?? '',
    paddingLeft: cs.paddingLeft ?? '',
    marginTop: cs.marginTop ?? '',
    marginRight: cs.marginRight ?? '',
    marginBottom: cs.marginBottom ?? '',
    marginLeft: cs.marginLeft ?? '',
    fontWeight: cs.fontWeight ?? '',
    justifyContent: cs.justifyContent ?? '',
    alignContent: cs.alignContent ?? '',
    justifyItems: cs.justifyItems ?? '',
    alignItems: cs.alignItems ?? '',
    verticalAlign: cs.verticalAlign ?? '',
  })
}

/**
 * Read the (grouped) IR back into a per-View `ViewCapture`'s `{tree, rules}` — the inverse of the
 * walk's IR build. The tree comes from the node structure; the flat rule list is REBUILT from the
 * IR: each node's lifted author + inline rules (`decls.author`), its carried token defs
 * (`decls.carried`), and its synthesized fallback/size rules (`decls.fallback`/`decls.size`), plus
 * the bundle's non-node-anchored rules — the text-context rule and the `@container` rep bands. A
 * rule shared across nodes (its `ids` spanning several) sits on each node's `decls.author` BY
 * REFERENCE, so it is de-duplicated by identity and emitted once. Fallback/size order follows the
 * walk's PUSH order (`bundle.nodes`); author/carried/context/band rules carry their own `(spec,
 * order)`, so their array position is immaterial — classify re-sorts by `(layered, spec, order)`.
 */
export function emit(bundle: IRBundle): { tree: PlateNode; rules: PlateRule[] } {
  const tree = irTree(bundle.root)
  const rules: PlateRule[] = []
  // The text-context rule sorts first (SPEC_CONTEXT, order 0); the synthesized
  // base rules continue the counter, matching the walk's single base-rule sweep.
  if (bundle.contextRule) rules.push(bundle.contextRule)
  const nodes: IRNode[] = []
  collectNodes(bundle.root, nodes)
  // Walk PUSH order keeps the synthesized base rules in the walk's source order.
  // `collectNodes` yields the EFFECTIVE pre-order; re-ordering by each node's push
  // position restores source order. A node missing from the push list (none, in
  // the live path) sorts last. A hand-built bundle (`irFromTree`) carries no push
  // list, so the effective pre-order stands.
  if (bundle.nodes) {
    const pushIndex = new Map<IRNode, number>()
    bundle.nodes.forEach((node, index) => pushIndex.set(node, index))
    nodes.sort((a, b) => (pushIndex.get(a) ?? Infinity) - (pushIndex.get(b) ?? Infinity))
  }
  let order = bundle.contextRule ? 1 : 0
  for (const node of nodes) {
    const decls = effectiveDecls(node)
    if (decls.fallback.length > 0) {
      rules.push({
        ids: [node.id],
        decls: decls.fallback,
        spec: SPEC_FALLBACK,
        order: order++,
      })
    }
    const size = decls.size
    if (size && size.length > 0) {
      rules.push({ ids: [node.id], decls: size, spec: SPEC_LEAF, order: order++ })
    }
  }
  // Lifted author/inline + carried rules: emitted once each (a shared rule sits on
  // several nodes by reference). Each carries its own (spec, order). A folded node
  // emits only its synthesized fallback/size — `effectiveDecls` returns no
  // author/carried for it, so its raw lifted rules are suppressed.
  const seen = new Set<PlateRule>()
  for (const node of nodes) {
    const decls = effectiveDecls(node)
    for (const rule of decls.author ?? []) {
      if (!seen.has(rule)) {
        seen.add(rule)
        rules.push(rule)
      }
    }
    for (const rule of decls.carried ?? []) {
      if (!seen.has(rule)) {
        seen.add(rule)
        rules.push(rule)
      }
    }
  }
  // Non-node-anchored extras (the `@container` text-rep bands) ship only when their
  // bone survives projection. A band anchored ENTIRELY to nodes the passes lowered
  // (an Absorb-dropped text-rep wrapper's bone, a Crop/Superset-dropped block)
  // would emit dead CSS for a bone absent from the tree, so bands are pruned
  // against the surviving (effective) ids just collected.
  const survivingIds = new Set(nodes.map((node) => node.id))
  for (const rule of bundle.extraRules) {
    if (rule.ids.length > 0 && rule.ids.every((id) => !survivingIds.has(id))) continue
    rules.push(rule)
  }
  return { tree, rules }
}

function collectNodes(node: IRNode, out: IRNode[]): void {
  out.push(node)
  for (const kid of effectiveKids(node)) collectNodes(kid, out)
}

function irTree(node: IRNode): PlateNode {
  const out: PlateNode = { id: node.id }
  // A folded survivor projects as a single `text` leaf bar; the effective kind
  // resolves its raw `container`/`text` kind to the leaf the bar renders as.
  // `effectiveKids` already yields [] for it.
  const kind = effectiveKind(node)
  if (isLeafKind(kind)) out.leaf = kind
  if (node.ref !== undefined) out.ref = node.ref
  if (node.count !== undefined) out.count = node.count
  const kids = effectiveKids(node)
  if (kids.length > 0) out.kids = kids.map(irTree)
  return out
}

/**
 * A node's EFFECTIVE kids — the kids `emit` actually projects, after lowering the `dropped` and
 * `flattened` annotations. Used by BOTH `irTree` (tree building) and `collectNodes` (rule
 * collection) so structure and rules stay in lockstep, and by `templateIR`'s structural matching
 * (`distil.ts`) so a run is templated on the shape `emit` will project, not the raw pre-Flatten
 * tree (ADR 0022 §3). A FOLDED node yields NO kids — it projects as one synthetic text-bar leaf, so
 * its raw subtree is suppressed (the glyph-fold survivor model, ADR 0022 §4). For each kid, in
 * order: - `dropped` → omit it AND its whole subtree (a dropped node is never recursed). -
 * `flattened` → splice it out: contribute NEITHER a tree node NOR its rules, and in its slot hoist
 * the kid's OWN effective kids (recurse, so a chain of flattened wrappers collapses to a fixpoint).
 * Dropping the flattened node's rules is safe: `isPassthroughWrapper` guarantees it carries no
 * tokens, zero margin, and a coincident box, so there is no layout to lose. - otherwise → keep it.
 */
export function effectiveKids(node: IRNode): IRNode[] {
  // A folded survivor is an effective text-bar leaf; its raw kids never project.
  if (node.folded) return []
  const out: IRNode[] = []
  for (const kid of node.kids) {
    if (kid.dropped !== undefined) continue
    if (kid.flattened) out.push(...effectiveKids(kid))
    else out.push(kid)
  }
  return out
}

/**
 * A node's EFFECTIVE bone box — the rect downstream geometry passes read (ADR 0022 invariant 3). A
 * glyph-fold survivor reports its `folded.box` (the union of the absorbed icon + the text unit);
 * every other node reports its raw measured `box`. The single place "override ?? raw box" lives, so
 * Superset / Crop never branch on `folded` themselves.
 */
export function boneBox(node: IRNode): IRRect | undefined {
  return node.folded?.box ?? node.box
}

/**
 * A node's EFFECTIVE kind — the kind downstream shape/leaf passes see. A glyph-fold survivor is a
 * `text` leaf bar regardless of its raw `kind` (a text unit or a thin container around one); every
 * other node reports its raw `kind`.
 */
export function effectiveKind(node: IRNode): IRKind {
  return node.folded ? 'text-line' : node.kind
}

/**
 * A node's EFFECTIVE declarations — the decls `emit` projects (ADR 0022 §4). A glyph-fold survivor
 * emits ONLY its synthesized `folded.decls` (inline-block + width/height); its own
 * author/carried/fallback/size are SUPPRESSED, since the bar replaces the original text unit. Every
 * other node emits its raw `decls`.
 */
export function effectiveDecls(node: IRNode): IRNode['decls'] {
  return node.folded ? node.folded.decls : node.decls
}

/**
 * Map every node by its plate-local id. Used by the build phase's CSS-extract to attach each lifted
 * rule to the node(s) it targets. Ids are unique across the tree (`state.nextId++`), so the map is
 * one-to-one.
 */
export function indexById(root: IRNode): Map<number, IRNode> {
  const map = new Map<number, IRNode>()
  const visit = (node: IRNode): void => {
    map.set(node.id, node)
    for (const kid of node.kids) visit(kid)
  }
  visit(root)
  return map
}
