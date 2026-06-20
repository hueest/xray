// =============================================================================
// THE DISTIL PASSES (ADR 0022 §3): pure IRNode → IRNode annotate-only passes,
// in their fixed, load-bearing order — markInk → glyph-fold → Flatten → Superset →
// Crop → Template. Each reads ONLY the snapshotted IR + diagnostics; none touches
// the DOM. Split out of measure.ts (the Measure walk) as a leaf module so the
// dependency graph stays measure.ts → distil.ts → {ir, css, diagnostics,
// style-cache} with no back-edges. The walk orchestrates them via distilPlate.
// =============================================================================

import {
  boneBox,
  effectiveDecls,
  effectiveKids,
  effectiveKind,
  type IRBundle,
  type IRNode,
  type IRRect,
  type IRTextInk,
} from './ir.ts'
import { normalizeDisplay } from './css.ts'
import { type DiagnosticsCollector } from './diagnostics.ts'
import { establishesInlineFlow, isInlineish, px, pxValue } from './style-cache.ts'

/**
 * An element at or below this opacity contributes no visible ink: opacity is not inherited, but it
 * composites the element AND its subtree as one group and then multiplies that group to (near)
 * nothing, so every descendant is hidden too. Dropped like `display:none`/`visibility:hidden`. The
 * small epsilon (not a strict `=== 0`) also catches the `opacity: 0.001` visually-hidden idiom
 * while sparing genuinely faint-but-readable content. A missing/invalid value parses to `NaN`,
 * which fails the `<=` and is correctly kept.
 */
const INVISIBLE_OPACITY = 0.01

/**
 * Does this IR node read as ONE single-line text bar a glyph icon can fold into? A bare `text`
 * leaf, or a thin branch whose sole child is a `text` leaf (a `<span>label</span>` blockified in a
 * flex row). A `text-block` (multi-line) or any structured branch does NOT — a glyph hugs one
 * line.
 */
function textLineUnitIR(kid: IRNode): boolean {
  if (kid.kind === 'text-line' && kid.kids.length === 0) return true
  if (kid.kind === 'container' && kid.kids.length === 1) {
    const only = kid.kids[0]
    return only !== undefined && only.kind === 'text-line' && only.kids.length === 0
  }
  return false
}

/** The glyph-fold geometry on snapshotted boxes — `glyphGeometry`, off the IR. */
function boxGlyphGeometry(icon: IRRect, text: IRRect, lineHeight: number): boolean {
  if (lineHeight <= 0) return false
  if (icon.height > lineHeight * 1.5) return false // ≈ text-height, not a box
  const overlap = Math.min(icon.y + icon.height, text.y + text.height) - Math.max(icon.y, text.y)
  if (overlap < Math.min(icon.height, text.height) * 0.5) return false // same row
  const gap =
    icon.x >= text.x + text.width ? icon.x - (text.x + text.width) : text.x - (icon.x + icon.width)
  return gap <= lineHeight * 0.6 // hugs the text like a letter, not a gutter
}

/**
 * Is this text bar a multi-line BLOCK rather than a single LINE? Reads the bar's `ink` snapshot
 * (the clamped run box and the parent's resolved line-height the walk recorded) and applies the
 * `height >= lineHeight × 1.5` threshold (ADR 0021 §4). An unresolved line-height (0) reads as a
 * single line.
 */
function inkIsMultiLine(ink: IRTextInk): boolean {
  const runHeight = ink.lineRects[0]?.height ?? 0
  return ink.lineHeight > 0 && runHeight >= ink.lineHeight * 1.5
}

/**
 * MARK-INK — the classification pass (ADR 0022 invariant 5). It owns BONE-KIND assignment, reading
 * ONLY the IR snapshot (never the live DOM): `isMedia`, `paint`, `ink`, and `style`. The walk
 * builds STRUCTURE + decls + the synthetic text bars and leaves a PROVISIONAL kind; `markInk`
 * finalizes the leaf kinds and folds invisibility into a `dropped: { reason: 'invisible' }`
 * annotation. Runs BEFORE `foldGlyphRowsIR` (which reads `kind: 'media'` / `'text-line'`).
 *
 * Per-node, the rules — UPGRADE-ONLY for the inferred kinds, so an explicit kind the walk set (a
 * `ctx.bone()` bone, the `@container` text-rep's `text-block` bone) is never downgraded:
 *
 * - A DECLARED bone (`markKind`, from `data-xr-bone-kind`; ADR 0018; ADR 0022 §5) → re-stamped a
 *   CHILDLESS bone of that kind: the walk descended normally (measuring the full subtree into the
 *   IR), and here every effective kid is marked `dropped: { reason: 'collapsed' }` and the node
 *   synthesizes its own leaf display+size, so `effectiveKids`/emit lower it to one bone. This
 *   pre-empts the inferred kinds below (a declared kind is authoritative) and shares the Absorb
 *   re-stamp's display/size synthesis;
 * - A text bar (`ink` present) → `text` (one baseline) or `text-block` (≥2);
 * - An empty/childless ELEMENT (`el !== null`, no raw kids) that is `isMedia` → `media`; else a
 *   `container` seed whose `paint.surface` paints → `box` (the empty-element painted-box-vs-spacer
 *   split, off `paint` instead of a live `hasVisibleBackground`); an explicit seed (media/box/text)
 *   is never overwritten, and a non-painted spacer is left as a container.
 *
 * Invisibility (ADR 0022 §4) is annotated `dropped: { reason: 'invisible' }`. The two CSS
 * mechanisms reach differently, and `markInk` models both off the snapshot, threading the inherited
 * context DOWN (Measure DESCENDS both; it skips only `display: none`):
 *
 * - `opacity <= INVISIBLE_OPACITY` composites the element AND its whole subtree as one group and
 *   multiplies it to nothing — every descendant is hidden too and NOTHING below can re-show. The
 *   TOPMOST group-hidden node drops; `effectiveKids` lowers the whole subtree, so the descendants
 *   need no individual drop.
 * - `visibility: hidden|collapse` is INHERITED but an ELEMENT descendant can override it
 *   (`visibility: visible` re-shows). A node is visibility-hidden when its own value hides it OR it
 *   inherits hidden and does not re-show; such a node drops ONLY when it has no surviving effective
 *   kid — a re-shown descendant keeps the bone-free ancestors alive so it survives; a hidden
 *   ancestor can never vanish a re-shown subtree. A synthetic text bar carries no own visibility
 *   (empty snapshot), so it correctly INHERITS its parent's. Idempotent — never overwrites a prior
 *   drop (a glyph-folded icon keeps `folded`).
 *
 * Pure: reads only the IR. Tested with a hand-built IR (markInk.test.ts).
 */
export function markInk(node: IRNode, inherited: InkVisibility = NOT_HIDDEN): void {
  // Resolve this node's effective visibility from the inherited context + own style.
  // `opacity` is not inherited as a value, but its GROUP-hide reaches the subtree and
  // cannot be overridden, so it threads down as `groupHidden`. `visibility` inherits
  // and an element can flip it either way (an empty value — a synthetic bar, or an
  // element with no visibility decl — inherits).
  const groupHidden =
    inherited.groupHidden || Number.parseFloat(node.style.opacity) <= INVISIBLE_OPACITY
  const visHidden =
    node.style.visibility === 'visible'
      ? false
      : node.style.visibility === 'hidden' || node.style.visibility === 'collapse'
        ? true
        : inherited.visHidden
  const childContext: InkVisibility = { groupHidden, visHidden }
  for (const kid of node.kids) markInk(kid, childContext)

  // Invisibility → a `dropped: 'invisible'` annotation. Idempotent.
  if (node.dropped === undefined) {
    if (groupHidden && !inherited.groupHidden) {
      // The topmost node of an opacity group: drop it; the subtree lowers with it.
      node.dropped = { reason: 'invisible' }
    } else if (visHidden && !groupHidden && effectiveKids(node).length === 0) {
      // Visibility-hidden with nothing visible surviving below it.
      node.dropped = { reason: 'invisible' }
    }
  }

  // DECLARED bone (`data-xr-bone-kind`; ADR 0018; ADR 0022 §5). The walk descended
  // normally (the full subtree is measured into the IR) and tagged the element's
  // `markKind`; here `markInk` re-stamps the node into ONE childless bone of that
  // kind, dropping its measured subtree (annotate-then-lower). This pre-empts the
  // inferred classification below — a declared kind is authoritative — and mirrors
  // the Absorb re-stamp (which it shares the leaf-display/size synthesis with). Runs
  // AFTER the invisibility check, so an invisible declared bone stays
  // `dropped:'invisible'` (invisibility wins). Idempotent: the kids already being
  // `dropped:'collapsed'` re-runs cleanly, and the guard skips a node already
  // dropped for any reason. markInk recursed kids first, so `effectiveKids` is
  // settled here, exactly as for Absorb below.
  if (node.markKind !== undefined && node.dropped === undefined) {
    node.kind = node.markKind
    // Keep `isMedia` in step with the declared kind so downstream media handling and
    // `effectiveKind` agree (the empty-element split keys off `isMedia` for `media`).
    if (node.markKind === 'media') node.isMedia = true
    for (const kid of effectiveKids(node)) kid.dropped = { reason: 'collapsed' }
    // The node ships as ONE bone leaf carrying its OWN display + measured size,
    // replacing the container display/line-height the walk's branch path stamped —
    // identical synthesis to the Absorb re-stamp below (`vertical-align: middle`
    // for an inline-ish media bone).
    const fallback: string[] = []
    if (isInlineish(node.style.display)) {
      fallback.push('display: inline-block')
      if (node.markKind === 'media') fallback.push('vertical-align: middle')
    } else {
      const disp = normalizeDisplay(node.style.display)
      if (disp && disp !== 'block') fallback.push(`display: ${disp}`)
    }
    node.decls = {
      ...node.decls,
      fallback,
      ...(node.box
        ? {
            size: [
              'box-sizing: border-box',
              `width: ${px(node.box.width)}`,
              `height: ${px(node.box.height)}`,
            ],
          }
        : {}),
    }
    return
  }

  // A synthetic text bar: finalize line vs block off its `ink` snapshot. The walk
  // seeded `text`; `markInk` is the authority here (`text` for one baseline,
  // `text-block` for ≥2).
  if (node.ink) {
    node.kind = inkIsMultiLine(node.ink) ? 'text-block' : 'text-line'
    return
  }

  // Childless ELEMENT: the empty-element media / painted-box / spacer split, off the
  // snapshot. Upgrade-only — a non-media, non-painted childless element (incl. a
  // `ctx.bone()` box) keeps whatever kind the walk seeded.
  if (node.el !== null && node.kids.length === 0) {
    if (node.isMedia) node.kind = 'media'
    // Upgrade-only: only a `container` seed becomes `box`; an explicit kind set by
    // the walk (a `data-xr-bone-kind` / `ctx.bone()` media or box bone) is never
    // overwritten — otherwise a painted media bone would be downgraded to `box`.
    else if (node.kind === 'container' && node.paint?.surface) node.kind = 'box'
    return
  }

  // ABSORB (ADR 0021 §3). A contrast SURFACE
  // (`surfaceAbsorbs`, off the `paint`/`salience` snapshot) whose effective content
  // reduces to a single label/run (`isLabelContent`, off `effectiveKids`/
  // `effectiveKind`) IS the visual — a button, badge, chip, pill, outlined/lifted
  // card. It renders as ONE box, subsuming the label. Because markInk recurses kids
  // FIRST (bottom-up, above), every kid's effective kind is finalized before this
  // parent test, so `isLabelContent` reads settled leaf kinds. Symmetric with
  // glyph-fold's annotate-only model: re-stamp the surface a childless `box` and mark
  // each effective kid `dropped: { reason: 'absorbed' }`, so `effectiveKids`/emit
  // lower the subtree and every downstream consumer sees a childless box for free.
  // A node already lowered (`dropped`, e.g. invisible) or with no effective kids (a
  // leaf, or one already absorbed below) is not a candidate.
  const effKids = effectiveKids(node)
  if (
    node.dropped === undefined &&
    effKids.length > 0 &&
    surfaceAbsorbs(node) &&
    isLabelContent(node)
  ) {
    node.kind = 'box'
    for (const kid of effKids) kid.dropped = { reason: 'absorbed' }
    // The surface ships as one box leaf, so it carries the box's OWN display +
    // measured size, replacing the container display/line-height the walk's branch
    // path stamped (a leaf, unlike a container, holds no content line box).
    const fallback: string[] = []
    if (isInlineish(node.style.display)) fallback.push('display: inline-block')
    else {
      const disp = normalizeDisplay(node.style.display)
      if (disp && disp !== 'block') fallback.push(`display: ${disp}`)
    }
    node.decls = {
      ...node.decls,
      fallback,
      ...(node.box
        ? {
            size: [
              'box-sizing: border-box',
              `width: ${px(node.box.width)}`,
              `height: ${px(node.box.height)}`,
            ],
          }
        : {}),
    }
  }
}

/**
 * The Salience contrast axis at/above which a NON-fill surface (a contrasting border or a
 * box-shadow) is strong enough to read as one Bone on its own — Absorb's trigger for the cases the
 * contrasting fill never covered. Set so an INTENTIONAL, visible surface clears it and an
 * incidental hairline does not: a box-shadow scores 1; a contrasting border needs ~2px (the
 * contrast axis ramps border width 0→`BORDER_WIDTH_SATURATION`=4px, so 2px → 0.5) AND an opaque,
 * page-contrasting colour. Conservative by design — a 1px same-as-page divider scores ~0 and is
 * left as a container, never over-absorbed. Tunable.
 */
const ABSORB_CONTRAST_MIN = 0.5

/**
 * Does this node's SURFACE absorb its label content into one Bone (ADR 0021 §3)? PURE — reads ONLY
 * the snapshot Measure resolved at build time, never the DOM. Two additive paths, neither weakening
 * the other:
 *
 * - FILL — `paint.contrastingFill`, the resolved `hasContrastingFill` boolean: a filled control
 *   collapses to one Bone.
 * - BORDER / BOX-SHADOW — the resolved Salience contrast axis (graded) at/above
 *   `ABSORB_CONTRAST_MIN`. The axis is the MAX of fill/border/shadow, so this path only ever ADDS
 *   surfaces the fill boolean missed: a card outlined or lifted off the page whose content is
 *   label-only is itself the visual.
 *
 * Conservative: a node with neither a contrasting fill NOR a strong border/shadow surface returns
 * false and keeps its children. An entry-less node (root/stitch/ synthetic bar) has no
 * `paint`/`salience` snapshot, so it never absorbs.
 */
function surfaceAbsorbs(node: IRNode): boolean {
  if (node.paint?.contrastingFill) return true
  return node.salience !== undefined && node.salience.contrast >= ABSORB_CONTRAST_MIN
}

/**
 * Does this node's EFFECTIVE content reduce to a single label/run and nothing else (ADR 0021 §3)?
 * PURE IR predicate over `effectiveKids`/`effectiveKind` — never the DOM. Every effective kid must
 * read as a text label drawing one bone with no independent structure:
 *
 * - A bare text leaf (`text` / `text-block`), incl. a glyph-fold survivor (an effective `text` bar);
 * - A thin wrapper whose sole effective kid is itself a single text leaf (a `<span>label</span>`
 *   blockified in a flex/grid control, or the `@container` text-rep wrapper around one `text-block`
 *   bone). A SECOND distinct shape (a `box`, a non-folded sibling structure), any REPLACED MEDIA
 *   (`media` is never a swallowing surface, ADR 0021 §3), or a Stitch makes the node a
 *   container/frame — draw the parts, keep the surface as a frame.
 */
function isLabelContent(node: IRNode): boolean {
  return effectiveKids(node).every(isLabelUnit)
}

/** A single effective kid that reads as one text label (no media, no distinct shape, no stitch). */
function isLabelUnit(node: IRNode): boolean {
  const kind = effectiveKind(node)
  if (kind === 'text-line' || kind === 'text-block') return true
  if (kind !== 'container') return false // media / box / stitch / root → a distinct shape
  // A THIN text wrapper: exactly one effective kid, itself a single text leaf.
  const kids = effectiveKids(node)
  const only = kids[0]
  if (kids.length !== 1 || only === undefined) return false
  const onlyKind = effectiveKind(only)
  return (onlyKind === 'text-line' || onlyKind === 'text-block') && effectiveKids(only).length === 0
}

/** The inherited invisibility context `markInk` threads down (ADR 0022 §4). */
interface InkVisibility {
  /** An opacity-group ancestor (or self) hides this node's whole subtree, unoverridable. */
  groupHidden: boolean
  /** A `visibility: hidden|collapse` ancestor (or self) hides this node, until re-shown. */
  visHidden: boolean
}

const NOT_HIDDEN: InkVisibility = { groupHidden: false, visHidden: false }

/**
 * Fold a glyph-sized icon Bone into an adjacent single-line text Bone — the geometry-driven group
 * pass (ADR 0021 §2, "row anything"), run over the built IR. For each NON-FLOW parent (flex / grid
 * / table / ruby — normal flow already folds its icon into the run during the walk), a `media` kid
 * that hugs a neighbouring element-backed text-line on the same row (`boxGlyphGeometry` over the
 * snapshotted boxes) folds WITH that neighbour into one text-line bar sized to their union. A
 * bigger or gutter-gapped icon fails the geometry and stays its own Bone.
 *
 * ANNOTATE-ONLY (ADR 0022 §4): the pass NEVER restructures `kids`. For each match it SETS `folded`
 * on the SURVIVING text unit — the effective bone box (their union) and the synthesized
 * inline-block + width/height decls of the bar — and marks the absorbed icon `dropped: { reason:
 * 'folded' }`. The surviving node keeps its `id` and its place in `bundle.nodes`, so `emit`
 * projects one text-bar leaf (icon gone, unit as a `text` leaf sized to the union); every
 * downstream pass reads the union via `boneBox(node)` and the leaf shape via the effective-node
 * accessors (`effectiveKind`/`effectiveKids`).
 *
 * Scan/skip semantics: an icon prefers its LEFT neighbour (`i - 1` before `i + 1`); a dropped
 * (already-folded) icon never folds again; and a folded unit is never re-used as another icon's
 * neighbour.
 */
export function foldGlyphRowsIR(node: IRNode): void {
  for (const kid of node.kids) foldGlyphRowsIR(kid)
  if (establishesInlineFlow(node.style.display)) return
  const kids = node.kids
  if (kids.length <= 1) return
  const lineHeight = pxValue(node.style.lineHeight) ?? (pxValue(node.style.fontSize) ?? 0) * 1.2
  for (let i = 0; i < kids.length; i++) {
    const icon = kids[i]
    if (!icon || icon.kind !== 'media' || icon.el === null || !icon.box || icon.dropped) continue
    for (const j of [i - 1, i + 1]) {
      const unit = kids[j]
      // Element-backed text units only (a synthetic bare-text bar carries no
      // element and is left alone). A unit already folded by an earlier icon is
      // skipped.
      if (!unit || unit.el === null || !unit.box || unit.folded || !textLineUnitIR(unit)) continue
      if (!boxGlyphGeometry(icon.box, unit.box, lineHeight)) continue
      const left = Math.min(icon.box.x, unit.box.x)
      const top = Math.min(icon.box.y, unit.box.y)
      const width = Math.max(icon.box.x + icon.box.width, unit.box.x + unit.box.width) - left
      const height = Math.max(icon.box.y + icon.box.height, unit.box.y + unit.box.height) - top
      unit.folded = {
        box: { x: left, y: top, width, height },
        decls: {
          fallback: ['display: inline-block', 'vertical-align: middle'],
          size: [`width: ${px(width)}`, `height: ${px(height)}`],
        },
      }
      icon.dropped = { reason: 'folded' }
      break
    }
  }
}

/**
 * FLATTEN (ADR 0022, per-View): collapse passthrough wrapper chains. A layout-only container —
 * containers paint no Bone (only leaves carry `xr-leaf`), a single child, its box coincident with
 * that child, no margin or positional offset of its own — contributes nothing the child does not
 * already produce. Promoting the child into a normal-flow grandparent drops the wrapper Bone-free
 * and position-faithful, shrinking the plate.
 *
 * Annotate-only (ADR 0022 §4): the pass NEVER restructures the tree. It SETS `flattened = true` on
 * each passthrough wrapper that should be spliced; Serialize (`emit`, ir.ts) is the sole structural
 * mutation — it omits a `flattened` node and hoists its kids into the parent's slot. The wrapper
 * stays in the IR with its geometry/decls, so later passes and diagnostics still see it.
 *
 * Bottom-up so a chain collapses to a fixpoint (`<div><div><div>x</div></div></div>` → one node:
 * every wrapper in the chain is marked). Only flattens wrappers under a normal-flow parent — a
 * flex/grid item's slot needs the wrapper's flex sizing, which the splice does not transfer — and
 * never crosses a Stitch (opaque, ADR 0006). The conditions in `isPassthroughWrapper` are what keep
 * it position-faithful.
 */
export function flattenIR(node: IRNode): void {
  if (node.kind === 'stitch') return
  for (const kid of node.kids) flattenIR(kid)
  // Only flatten into a normal-flow parent; a flex/grid parent would lay the
  // survivor out by its own (untransferred) flex-item sizing instead of the
  // wrapper's.
  if (establishesInlineFlow(node.style.display)) {
    for (const kid of node.kids) markWrapperChain(kid)
  }
}

/**
 * Mark every passthrough wrapper in the chain rooted at `node` `flattened`, down to the first node
 * that survives. Walks the unmutated chain, so each coincidence check is wrapper-vs-its-own-child;
 * coincidence is transitive within the 1px tolerance, so a whole chain marks consistently. Sets
 * fields only; never touches `kids`.
 */
function markWrapperChain(node: IRNode): void {
  let cursor = node
  while (isPassthroughWrapper(cursor)) {
    cursor.flattened = true
    const only = cursor.kids[0]
    if (!only) break
    cursor = only
  }
}

/**
 * A container the skeleton can drop without moving anything: one child, its box coincident with the
 * child (so no padding/border insetting it and no size of its own), no margin and `position:
 * static` with no `transform` (so no offset the promoted child would lose), and no carried token
 * def anchored to it (a descendant's `var()` reads it). A stitch child has no box, so it is never
 * coincident — stitch wrappers are conservatively kept.
 */
function isPassthroughWrapper(node: IRNode): boolean {
  if (node.kind !== 'container' || node.kids.length !== 1) return false
  if (node.decls.carried && node.decls.carried.length > 0) return false
  const child = node.kids[0]
  if (!child || !boxesCoincide(node.box, child.box)) return false
  if (!marginIsZero(node.style.margin)) return false
  if (node.style.position !== 'static') return false
  if (node.style.transform && node.style.transform !== 'none') return false
  return true
}

/** Two snapshotted boxes occupy the same rect (within sub-pixel rounding). */
function boxesCoincide(a: IRRect | undefined, b: IRRect | undefined): boolean {
  if (!a || !b) return false
  if (a.width <= 0 || a.height <= 0) return false // degenerate (unmeasured / 0×0) — never flatten
  return (
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1
  )
}

/** A margin shorthand that contributes no offset (every side zero). */
function marginIsZero(margin: string | undefined): boolean {
  if (!margin) return false // unknown → keep the wrapper (conservative)
  return margin.split(/\s+/).every((v) => v === '0px' || v === '0')
}

/**
 * SUPERSET (ADR 0022, per-View). When a Bone's box sits wholly inside a SOLID Bone's box, the
 * enclosing Bone _supersets_ it — it paints the same area, so the two render as one and the layered
 * "bone-over-bone" look the inner one would add is barely perceptible. Annotate the inner Bone (the
 * `subset`) `dropped` so `emit` lowers it out, then prune any container the drop leaves empty
 * (`orphaned`).
 *
 * Order / opacity / stacking are IRRELEVANT — it is a set union, so the superset always wins
 * regardless of which paints on top. The subset can be ANY kind (a text line / block on a solid
 * surface is the same redundant bone-over-bone, so it goes too); only the SUPERSET must be SOLID —
 * a gappy `text` Bone or a paint-less branch never supersets, since the union must actually fill
 * the area. Decided by geometry, global within the plate (an overlay nested in one subtree can
 * superset media in another); a stitch has no box, so it neither supersets nor is a subset.
 * Non-destructive — the node stays in the IR (see `IRNode.dropped`). Runs last of the IR passes.
 *
 * WATCH IN QA: a large solid Bone supersets ANY bone inside it — intended for a filled card
 * collapsing its on-surface lines/badges, but a full-bleed background `<img>` would also swallow a
 * button/CTA or headline laid on it. A white/outline card stays a paint-less container, so its
 * content is kept; only a CONTRASTING (bone-producing) surface supersets. If meaningful content
 * vanishes, add a guard.
 */
export function supersetIR(root: IRNode, diagnostics: DiagnosticsCollector): void {
  const leaves: { node: IRNode; rect: Edges }[] = []
  collectLeaves(root, leaves, null)
  const solids = leaves.filter((leaf) => isSolidLeaf(effectiveKind(leaf.node))) // candidate supersets
  for (const a of leaves) {
    if (a.node.dropped) continue
    for (const b of solids) {
      if (b.node === a.node || b.node.dropped) continue
      if (!coversFully(b.rect, a.rect)) continue
      // Coincident (mutual containment): a non-solid (text) coincident with a
      // solid is always dropped (the solid is the union); two coincident SOLIDS
      // keep the lower id, so a stack of identical boxes collapses to one bone.
      if (
        coversFully(a.rect, b.rect) &&
        isSolidLeaf(effectiveKind(a.node)) &&
        b.node.id > a.node.id
      )
        continue
      a.node.dropped = { reason: 'subset', by: b.node.id }
      diagnostics.add('dropped-subset', { count: 1 })
      break
    }
  }
  pruneEmptyBranches(root)
}

interface Edges {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Gather every leaf with its edges (any kind — all are droppable). A leaf without its own box falls
 * back to its nearest box-bearing ancestor's box: a multi-line `text-block` reflow bone is created
 * boxless (it sizes via `@container` bands, not a rect), but its rendered extent IS its ancestor
 * element's box, so without this fallback an overlay caption that wrapped to a `text-block` would
 * never be recognized as contained. A SOLID (`box`/`media`) bone never falls back: it can only be a
 * container if it truly paints that rect, so a boxless solid is omitted.
 */
function collectLeaves(
  node: IRNode,
  out: { node: IRNode; rect: Edges }[],
  inherited: Edges | null,
): void {
  const own = edgesOf(node)
  // Effective kind/kids (ADR 0022 §4): a glyph-fold survivor is a `text` leaf at
  // its union box (never a solid → never a superset container; droppable as a
  // subset), and its raw kids never recurse.
  const kind = effectiveKind(node)
  if (isLeaf(kind)) {
    const rect = own ?? (isSolidLeaf(kind) ? null : inherited)
    if (rect) out.push({ node, rect })
  }
  for (const kid of effectiveKids(node)) collectLeaves(kid, out, own ?? inherited)
}

/** A painted leaf (carries a bone): `box`/`media`/`text`/`text-block`. */
function isLeaf(kind: IRNode['kind']): boolean {
  return kind === 'box' || kind === 'media' || kind === 'text-line' || kind === 'text-block'
}

/** A filled bone that paints its whole rect — `box`/`media`. Only these may be the container. */
function isSolidLeaf(kind: IRNode['kind']): boolean {
  return kind === 'box' || kind === 'media'
}

/**
 * A node's EFFECTIVE bone box as edges, or null if missing/degenerate (0-area). Reads `boneBox`
 * (ADR 0022 invariant 3), so a glyph-fold survivor reports its `folded.box` (the icon+text union)
 * instead of its raw text box.
 */
function edgesOf(node: IRNode): Edges | null {
  const b = boneBox(node)
  if (!b || b.width <= 0 || b.height <= 0) return null
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height }
}

/** `outer` fully contains `inner` within a 1px tolerance (sub-pixel rounding). */
function coversFully(outer: Edges, inner: Edges): boolean {
  return (
    outer.left <= inner.left + 1 &&
    outer.top <= inner.top + 1 &&
    outer.right >= inner.right - 1 &&
    outer.bottom >= inner.bottom - 1
  )
}

/**
 * After Superset, drop any container it emptied — a container whose every child is now dropped
 * paints nothing and adds only dead structure. Bottom-up, so an emptied parent propagates up its
 * chain. Skips originally-empty containers (no kids — other passes own those) and never drops the
 * root.
 */
function pruneEmptyBranches(node: IRNode): void {
  for (const kid of node.kids) pruneEmptyBranches(kid)
  if (node.kind !== 'container' || node.kids.length === 0) return
  if (node.kids.every((kid) => kid.dropped !== undefined)) node.dropped = { reason: 'orphaned' }
}

/**
 * Crop's ONLY knob: a multiplier on a clipping context's visible bottom, so the fold sits a
 * half-context BELOW the visible edge. It covers render-time reflow to a taller viewport/container
 * (ADR 0004) — the captured fold is a width-dependent, render-time line, so this buffer keeps it
 * deliberately conservative. The buffer is applied ONLY at the final per-leaf compare, never
 * accumulated into the clip bottom threaded to children, so it never compounds across nesting
 * levels.
 */
const CROP_BUFFER = 1.5

/**
 * CROP — the past-the-fold drop (ADR 0022, per-View). 2D: drops every Bone whose box sits past the
 * FOLD on EITHER axis — its TOP below the visible BOTTOM, or its LEFT past the visible RIGHT edge,
 * of that Bone's NEAREST CLIPPING CONTEXT (a vertically- OR horizontally-scrolling /
 * overflow-clipping ancestor, or the viewport as the base case) — then orphan-prunes the emptied
 * containers. The horizontal axis closes the off-screen-RIGHT carousel-card case Template cannot
 * dedup (a single long run past its scroller's clip).
 *
 * - **No spacer.** Nothing reserves the dropped extent; the skeleton simply ends at the fold.
 * - **Why no CLS.** A dropped Bone was off-screen (below the viewport fold, or right of it) or inside
 *   a scroll/overflow container past its clip — never visible at capture. When real content lands
 *   it just grows the scroll height/width (or, for `overflow:hidden`/`clip`, is never visible at
 *   all); off-screen / clipped shifts do not score CLS, so the drop is layout-shift-free.
 * - **Reflow caveat (ADR 0004).** The fold is a render-time, width-dependent line (text rewraps at
 *   the render width, not the capture width), so the capture-time fold is conservative via
 *   `CROP_BUFFER`; a viewport / container larger than the one captured briefly shows blank past the
 *   fold until content fills — transient, no shift.
 * - **LTR-first; RTL a known limit.** The horizontal fold drops content past the RIGHT edge (the
 *   off-screen direction in LTR). In an RTL carousel the off-screen cards sit to the LEFT, so the
 *   right-edge fold does not catch them — an accepted known limit (the base-case viewport fold
 *   still drops anything genuinely right of `innerWidth`).
 * - **Per-View.** Views are independent and breakpoint-gated (ADR 0004); each carries its own folds
 *   (`viewportHeight`/`viewportWidth` = that View's `window.innerHeight`/`innerWidth`).
 * - **Coordinate space.** Boxes are raw `getBoundingClientRect` (viewport-relative), so the viewport
 *   folds (`viewportHeight`/`viewportWidth`) and the clip-ancestor bottoms/rights
 *   (`box.bottom`/`box.right`) live in the SAME space — no rebasing.
 * - **Architecture (ADR 0022 invariants 3 & 5).** Measure only snapshots the raw clip inputs
 *   (`overflow-y`/`overflow-x`, `scroll*`/`client*`); THIS pass derives the clip bottom/right. The
 *   walk records numbers, the pure pass owns all derivation.
 *
 * A top-down traversal threading the RAW (un-buffered) clip bottom AND right: a node lives inside
 * its PARENT's clip context, so the folds that judge a node are its parent's clip bottom/right; the
 * node's own clipping constrains its CHILDREN. The buffer is applied only at the leaf compare so it
 * never compounds down nesting. Reuses `isLeaf`/`isSolidLeaf`/`edgesOf` and the boxless-fallback
 * rule from `collectLeaves`, and `pruneEmptyBranches` for the orphan sweep. Non-destructive
 * (`IRNode.dropped`); `emit` lowers it. Order vs Superset is immaterial — both only annotate
 * `dropped`.
 */
export function cropIR(
  root: IRNode,
  viewportHeight: number,
  viewportWidth: number,
  diagnostics: DiagnosticsCollector,
): void {
  cropNode(root, viewportHeight, viewportWidth, null, diagnostics)
  pruneEmptyBranches(root)
}

/**
 * Does this node clip its content vertically — a scroll/overflow context whose visible bottom is a
 * fold for its children? `overflow-y` is one of auto|scroll|hidden|clip AND the content actually
 * overflows the client box (`scrollHeight > clientHeight`, +1 absorbing sub-pixel). When the
 * metrics were not snapshotted (overflow-y was not clipping at measure time), this is correctly
 * false.
 */
function nodeClipsY(node: IRNode): boolean {
  if (!/^(auto|scroll|hidden|clip)$/.test(node.style.overflowY)) {
    return false
  }
  return (
    node.scrollHeight !== undefined &&
    node.clientHeight !== undefined &&
    node.scrollHeight > node.clientHeight + 1
  )
}

/**
 * Does this node clip its content HORIZONTALLY — a scroll/overflow context whose visible right edge
 * is a fold for its children (a carousel)? The horizontal mirror of `nodeClipsY`: `overflow-x` is
 * one of auto|scroll|hidden|clip AND the content actually overflows the client box (`scrollWidth >
 * clientWidth`, +1 absorbing sub-pixel). When the metrics were not snapshotted (overflow-x was not
 * clipping at measure time), this is correctly false — so a `flex-wrap`/grid that merely WRAPS to
 * more rows (`overflow-x: visible`) never tightens the horizontal fold; its wrapped items are
 * judged against the wider ancestor/viewport fold and kept.
 */
function nodeClipsX(node: IRNode): boolean {
  if (!/^(auto|scroll|hidden|clip)$/.test(node.style.overflowX)) {
    return false
  }
  return (
    node.scrollWidth !== undefined &&
    node.clientWidth !== undefined &&
    node.scrollWidth > node.clientWidth + 1
  )
}

/**
 * Recurse top-down threading `(inheritedAncestorBox, clipBottom, clipRight)`.
 * `clipBottom`/`clipRight` are the folds that apply to THIS node (its parent context's visible
 * bottom / right edge); `inheritedAncestorBox` is the nearest box-bearing ancestor's edges, for the
 * boxless-leaf fallback (identical to `collectLeaves`). The clip bottom/right passed to children
 * tightens to this node's box bottom/right when the node itself clips that axis — and ONLY then: a
 * node that merely wraps (overflow:visible) never tightens, so normal in-viewport wrapped content
 * is never over-cropped.
 */
function cropNode(
  node: IRNode,
  clipBottom: number,
  clipRight: number,
  inheritedAncestorBox: Edges | null,
  diagnostics: DiagnosticsCollector,
): void {
  const own = edgesOf(node)
  // Effective kind (ADR 0022 §4): a glyph-fold survivor is a `text` leaf at its
  // union box (`edgesOf` reads `boneBox`), tested against the fold like any leaf;
  // its raw kids never recurse (`effectiveKids` yields [] for it).
  const kind = effectiveKind(node)
  if (isLeaf(kind) && !node.dropped) {
    // A leaf's rect is its own box, or — for a boxless NON-solid (a multi-line
    // text-block reflow bone) — its nearest box-bearing ancestor's box (the EXACT
    // rule + rationale as `collectLeaves`). A boxless solid has no rect (omitted).
    const rect = own ?? (isSolidLeaf(kind) ? null : inheritedAncestorBox)
    // Past the fold on EITHER axis — below the bottom (off-screen-bottom) OR right of
    // the right edge (off-screen-right carousel card). Same buffer + reason for both.
    if (rect && (rect.top >= CROP_BUFFER * clipBottom || rect.left >= CROP_BUFFER * clipRight)) {
      node.dropped = { reason: 'cropped' }
      diagnostics.add('dropped-cropped', { count: 1 })
    }
  }
  // This node's own clipping constrains its CHILDREN (not itself): tighten each fold
  // to the node's box bottom/right when it clips THAT axis. RAW (un-buffered) so it
  // never compounds. Only a genuinely scrolling container (overflow clips AND content
  // overflows) tightens — a wrapping flex/grid (overflow:visible) leaves the fold wide.
  const childClipBottom = nodeClipsY(node) && own ? Math.min(clipBottom, own.bottom) : clipBottom
  const childClipRight = nodeClipsX(node) && own ? Math.min(clipRight, own.right) : clipRight
  for (const kid of effectiveKids(node))
    cropNode(kid, childClipBottom, childClipRight, own ?? inheritedAncestorBox, diagnostics)
}

/**
 * TEMPLATE (per-View, runs last): collapse a run of >= MIN_TEMPLATE_RUN consecutive,
 * structurally-similar sibling cells (a feed/grid) into ONE representative cell carrying `count =
 * N`. The serializer emits the cell's HTML once plus the count and the renderer expands it back to
 * N (chunk.ts / react.core.tsx), so the plate ships one cell instead of N.
 *
 * Template runs LAST of the IR passes (after Superset and Crop), so it compresses ONLY what
 * survives the removal passes — what a viewer would actually see. Crop drops a run's off-screen
 * tail first; Template then groups the on-screen prefix and `count = run.length` renders back to
 * exactly that surviving N. Template is therefore LOSSLESS compression (one cell + a faithful
 * count), so it warns about nothing; the lossy off-screen removal is Crop's job
 * (`dropped-cropped`).
 *
 * Cells need not be pixel-identical — text length varies cell to cell — so the match is STRUCTURAL:
 * a multiset of every descendant's `structuralHash` (kind + author-decls signature, dimensions
 * excluded), compared within a loose tolerance (TEMPLATE_SHAPE_TOLERANCE differing nodes, so a
 * minority FEATURED badge still groups). The template takes the run's MODAL structure (a minority
 * badge normalizes away) and, for each fixed-size bone, the rounded median width/height across the
 * run; text-block bones reflow via `@container`, so their dims are left alone. Only stitch-free,
 * count-free, NON-dropped cells are templated (the cell must flatten to one HTML string; nested
 * templates are out of scope; a dropped cell breaks the run). The dropped cells' `@container` rep
 * bands are pruned from `extraRules` so no dead CSS ships.
 *
 * Loose by design — the tolerance is a single knob; tighten it toward 0 (exact) if false positives
 * surface.
 */
const MIN_TEMPLATE_RUN = 3
const TEMPLATE_SHAPE_TOLERANCE = 1
// A run templates only when its modal shape is a CLEAR MAJORITY — covering at
// least this fraction of the cells exactly. A minority FEATURED badge still
// groups; a ~50/50 split of two distinct kinds has no clear template and is left
// as-is, so a minority cell is never re-rendered with the wrong shape.
const MIN_TEMPLATE_MAJORITY = 2 / 3
// Shape keys join structuralHashes on NUL — a hash holds `|`/`;` but never NUL,
// so it cannot collide. Written as an escape (not a raw byte) to keep the source
// text rather than binary.
const SHAPE_SEP = '\0'

export function templateIR(bundle: IRBundle): void {
  const dropped = new Set<number>()
  collapseTemplateRuns(bundle.root, dropped)
  if (dropped.size > 0) {
    // Drop the rep bands (and any other extraRules) anchored only to collapsed
    // cells, so a templated feed ships no CSS for nodes that no longer exist.
    bundle.extraRules = bundle.extraRules.filter((rule) => !rule.ids.every((id) => dropped.has(id)))
  }
}

/**
 * Recurse bottom-up, then replace each maximal template run among a node's kids with one cell +
 * count.
 */
function collapseTemplateRuns(node: IRNode, dropped: Set<number>): void {
  // A glyph-fold survivor projects as a childless `text` bar (ADR 0022 §4,
  // `effectiveKids(folded) → []`), so it owns no template run — short-circuit before
  // walking its raw subtree, keeping the folded-node-is-a-leaf invariant uniform.
  if (node.folded) return
  // Bottom-up: a nested feed collapses before its parent cell is considered. A
  // cell that gains a `count` then reads as non-static, so it is never itself
  // folded into an outer template — the HTML-string chunk can't carry a nested one.
  for (const kid of node.kids) collapseTemplateRuns(kid, dropped)
  const kids = node.kids
  if (kids.length < MIN_TEMPLATE_RUN) return
  const out: IRNode[] = []
  let i = 0
  while (i < kids.length) {
    const run = templateRun(kids, i)
    if (run.length >= MIN_TEMPLATE_RUN && hasModalMajority(run)) {
      out.push(synthesizeTemplate(run, dropped))
      i += run.length
    } else if (run.length >= MIN_TEMPLATE_RUN) {
      // Long enough but no clear modal majority (e.g. an A/B/A/B alternation):
      // emit the run as-is and skip past it. Advancing by 1 would let a sub-run
      // re-form and normalize its minority cells to the wrong shape, so the scan
      // never re-anchors inside a no-majority run. (A same-kind sub-run buried in
      // it is left un-templated — a missed compaction, never a wrong render.)
      for (const cell of run) out.push(cell)
      i += run.length
    } else {
      const kid = kids[i]
      if (kid) out.push(kid)
      i += 1
    }
  }
  node.kids = out
}

/**
 * Maximal run of consecutive templateable kids from `start` matching a common modal shape within
 * tolerance. A `dropped` cell is non-templatable (`isStaticCell` rejects it), so it breaks the run
 * AND is rejected as a first cell — Template runs LAST, after Crop, so it only ever groups
 * NON-dropped (on-screen surviving) cells. Crop drops a contiguous off-screen tail, so this yields
 * the surviving prefix as the run; the dropped tail flows through `collapseTemplateRuns`'s
 * else-branch unchanged (still `dropped`, `emit` lowers it).
 */
function templateRun(kids: readonly IRNode[], start: number): IRNode[] {
  const first = kids[start]
  if (!first || !isStaticCell(first)) return []
  const run: IRNode[] = [first]
  const shapes: string[][] = [cellShape(first)]
  for (let j = start + 1; j < kids.length; j += 1) {
    const kid = kids[j]
    if (!kid || !isStaticCell(kid)) break
    const shape = cellShape(kid)
    if (shapeDistance(shape, modalShape(shapes)) > TEMPLATE_SHAPE_TOLERANCE) break
    run.push(kid)
    shapes.push(shape)
  }
  return run
}

/**
 * A clear majority of the run matches its modal shape exactly (>= MIN_TEMPLATE_MAJORITY) — else
 * there's no single template.
 */
function hasModalMajority(run: readonly IRNode[]): boolean {
  const shapes = run.map(cellShape)
  const modalKey = modalShape(shapes).join(SHAPE_SEP)
  const exact = shapes.filter((shape) => shape.join(SHAPE_SEP) === modalKey).length
  return exact >= run.length * MIN_TEMPLATE_MAJORITY
}

/**
 * Replace a run with one template cell: modal structure, median fixed-bone dims, and `count =
 * run.length` — the full SURVIVING count. Template runs LAST (after Crop), so the run holds only
 * on-screen cells (Crop already dropped any off-screen tail, and a dropped cell breaks the run in
 * `templateRun`); the count renders back to exactly the N a viewer would see. The median dims are
 * taken over the modal cells.
 */
function synthesizeTemplate(run: readonly IRNode[], dropped: Set<number>): IRNode {
  const modalKey = modalShape(run.map(cellShape)).join(SHAPE_SEP)
  const modalCells = run.filter((cell) => cellShape(cell).join(SHAPE_SEP) === modalKey)
  const template = modalCells[0] ?? run[0]
  if (!template) throw new Error('xray: empty template run')
  applyMedianDims(template, modalCells)
  template.count = run.length
  for (const cell of run) if (cell !== template) collectSubtreeIds(cell, dropped)
  return template
}

/**
 * A cell that can flatten to one HTML string: no stitch and no (nested) template anywhere within.
 * Reads the EFFECTIVE structure (ADR 0022 §3): a `flattened` wrapper contributes nothing of its own
 * and is judged purely by its hoisted kids, so the verdict matches what `emit` projects — mirroring
 * `effectiveKids`.
 *
 * A `dropped` cell is NON-templatable: Template runs LAST (after Crop), so a dropped (off-screen /
 * superseted / etc.) cell must never be grouped — it breaks the run in `templateRun` and is
 * rejected as a first cell, so Template only ever compresses the on-screen survivors.
 * `effectiveKids` already prunes a dropped descendant, so only the cell's OWN drop needs the
 * explicit guard here.
 */
function isStaticCell(node: IRNode): boolean {
  if (node.dropped !== undefined) return false
  if (
    !node.flattened &&
    (node.kind === 'stitch' || node.ref !== undefined || node.count !== undefined)
  )
    return false
  return effectiveKids(node).every(isStaticCell)
}

/**
 * This bone's structural identity for templating: kind + a dimension-free author-decls signature.
 * Memoized.
 */
function structuralHash(node: IRNode): string {
  if (node.structuralHash !== undefined) return node.structuralHash
  // EFFECTIVE kind + decls (ADR 0022 §3/§4): a glyph-fold survivor's identity is
  // the `text` bar `emit` projects (`folded.decls`), not its raw `container`/`text`
  // kind + own author decls — so a templated run of folded icon→text cells matches
  // on the bar shape.
  // Author + capture-time fallback decls only — `decls.size`/`box`/text are
  // excluded, so two cells of one component match regardless of text length.
  const decls = effectiveDecls(node)
  const sig: string[] = [...decls.fallback]
  for (const rule of decls.author ?? []) sig.push(...rule.decls)
  const hash = `${effectiveKind(node)}|${sig.toSorted().join(';')}`
  node.structuralHash = hash
  return hash
}

/**
 * A cell's shape: the sorted multiset of every EFFECTIVE descendant's `structuralHash`. Reads
 * through `flattened` (ADR 0022 §3): a flattened wrapper contributes no hash of its own and its
 * kids are hoisted, so a run of cells templates on the shape `emit` projects — identical whether or
 * not each cell wraps its content in a coincident passthrough wrapper. Mirrors `effectiveKids`.
 */
function cellShape(node: IRNode): string[] {
  const out: string[] = []
  const visit = (n: IRNode): void => {
    if (!n.flattened) out.push(structuralHash(n))
    for (const kid of effectiveKids(n)) visit(kid)
  }
  visit(node)
  return out.toSorted()
}

/** The most common shape among `shapes` (ties keep the earliest), the template target. */
function modalShape(shapes: readonly string[][]): string[] {
  const counts = new Map<string, { shape: string[]; n: number }>()
  for (const shape of shapes) {
    const key = shape.join(SHAPE_SEP)
    const hit = counts.get(key)
    if (hit) hit.n += 1
    else counts.set(key, { shape, n: 1 })
  }
  let best = shapes[0] ?? []
  let bestN = 0
  for (const entry of counts.values()) {
    if (entry.n > bestN) {
      bestN = entry.n
      best = entry.shape
    }
  }
  return best
}

/** Multiset symmetric-difference size of two SORTED shape arrays. */
function shapeDistance(a: readonly string[], b: readonly string[]): number {
  let i = 0
  let j = 0
  let diff = 0
  while (i < a.length && j < b.length) {
    const x = a[i]
    const y = b[j]
    if (x === y) {
      i += 1
      j += 1
    } else if (x !== undefined && (y === undefined || x < y)) {
      diff += 1
      i += 1
    } else {
      diff += 1
      j += 1
    }
  }
  return diff + (a.length - i) + (b.length - j)
}

/**
 * Median (rounded) fixed-size bone dims across the modal cells, written onto the template's bones.
 * Bones are paired by pre-order INDEX across cells; a kind guard skips mismatches, so a same-shape
 * cell whose DOM order differs (flex `order`, `row-reverse`) just drops out of the median rather
 * than contaminating it — uncommon and guarded, not corrected here.
 */
function applyMedianDims(template: IRNode, cells: readonly IRNode[]): void {
  const lists = cells.map(fixedSizeLeaves)
  const target = fixedSizeLeaves(template)
  for (let i = 0; i < target.length; i += 1) {
    const leaf = target[i]
    // EFFECTIVE size + kind (ADR 0022 §4): a folded survivor's size lives in
    // `folded.decls.size` and its kind is `text`, so the guard, the median sources,
    // and the write below all go through the bar's effective decls — mutating the
    // `folded.decls` object the accessor returns by reference moves the projected dims.
    if (!leaf) continue
    const leafDecls = effectiveDecls(leaf)
    if (!leafDecls.size) continue
    const leafKind = effectiveKind(leaf)
    const widths: number[] = []
    const heights: number[] = []
    for (const list of lists) {
      const other = list[i]
      if (!other) continue
      const otherDecls = effectiveDecls(other)
      if (effectiveKind(other) !== leafKind || !otherDecls.size) continue
      const w = sizeDim(otherDecls.size, 'width')
      const h = sizeDim(otherDecls.size, 'height')
      if (w !== null) widths.push(w)
      if (h !== null) heights.push(h)
    }
    const w = medianRounded(widths)
    const h = medianRounded(heights)
    let size = leafDecls.size
    if (w !== null) size = withDim(size, 'width', w)
    if (h !== null) size = withDim(size, 'height', h)
    leafDecls.size = size
  }
}

/**
 * A cell's fixed-size bones (text-line / box / media) in EFFECTIVE pre-order; text-block reflows,
 * so it's excluded. Reads through `flattened` (a passthrough wrapper is a bone-free container
 * anyway, so this matches `cellShape`'s ordering and the structure `emit` projects — ADR 0022 §3,
 * mirroring `effectiveKids`).
 */
function fixedSizeLeaves(node: IRNode): IRNode[] {
  const out: IRNode[] = []
  const visit = (n: IRNode): void => {
    // EFFECTIVE kind + size (ADR 0022 §4): a glyph-fold survivor is a `text` leaf
    // whose size lives in `folded.decls.size` (its raw kind may be a thin
    // `container` with no `decls.size`), so the median-dims pairing collects the
    // bar and the pre-order pairing across cells stays aligned.
    const kind = effectiveKind(n)
    if (
      !n.flattened &&
      (kind === 'text-line' || kind === 'box' || kind === 'media') &&
      effectiveDecls(n).size
    )
      out.push(n)
    for (const kid of effectiveKids(n)) visit(kid)
  }
  visit(node)
  return out
}

/** Read a `prop: <n>px` declaration's pixel value from a size decl list, or null. */
function sizeDim(decls: readonly string[], prop: string): number | null {
  for (const decl of decls) {
    const colon = decl.indexOf(':')
    if (colon > 0 && decl.slice(0, colon).trim() === prop) return pxValue(decl.slice(colon + 1))
  }
  return null
}

/** Rewrite an existing `prop: …px` declaration to `prop: <value>px` (no-op if absent). */
function withDim(decls: readonly string[], prop: string, value: number): string[] {
  return decls.map((decl) => {
    const colon = decl.indexOf(':')
    return colon > 0 && decl.slice(0, colon).trim() === prop ? `${prop}: ${value}px` : decl
  })
}

/** Rounded median of a value list, or null when empty. */
function medianRounded(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lo = sorted[mid - 1]
  const hi = sorted[mid]
  if (hi === undefined) return null
  const median = sorted.length % 2 === 0 && lo !== undefined ? (lo + hi) / 2 : hi
  return Math.round(median)
}

/** Collect a subtree's node ids into `set` (the dropped cells, for rep-band pruning). */
function collectSubtreeIds(node: IRNode, set: Set<number>): void {
  set.add(node.id)
  for (const kid of node.kids) collectSubtreeIds(kid, set)
}
