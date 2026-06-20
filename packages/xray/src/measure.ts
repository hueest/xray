import { BOUNDARY_ATTR, type PlateRule, type LeafKind, ROOT_ATTR, SPEC_CONTEXT } from './plate.ts'
import {
  eachView,
  effectiveKids,
  EMPTY_STYLE,
  indexById,
  type IRBundle,
  type IRNode,
  type PlateIR,
  snapshotStyle,
  type ViewIR,
} from './ir.ts'
import { normalizeDisplay } from './css.ts'
import { salience, type SalienceContext } from './salience.ts'
import { createDiagnostics, type DiagnosticsCollector } from './diagnostics.ts'
import {
  establishesInlineFlow,
  isInlineish,
  pad,
  px,
  pxValue,
  StyleCache,
  type WalkState,
} from './style-cache.ts'
import { cropIR, flattenIR, foldGlyphRowsIR, markInk, supersetIR, templateIR } from './distil.ts'
import { textBar } from './text-metrics.ts'
import { copyRules } from './css-extract.ts'

/**
 * Browser-side capture: walk a live rendered subtree into a Plate — one node tree plus one
 * self-contained, scoped CSS string (ADR 0003). The CSS is lifted from the author rules that
 * matched each node, rewritten to plate-local selectors — it carries `@media` for free and keeps
 * layout live (the bake-off winner; ADR 0005).
 */

export interface CaptureOptions {
  /** Plate name; comes from the virtual-module specifier. */
  name: string
  /** Collect limits (ADR 0022): refuse a capture whose measured tree exceeds any axis. */
  collect?: CollectLimits
  /**
   * Optional programmable capture walker (ADR 0018). The declarative `data-xr-*` hints cover the
   * 90%; this is the escape hatch for the 10% a markup attribute cannot express. Capture-only: it
   * shapes the resulting `PlateNode` tree but is never persisted into the Plate, and the production
   * adapter never captures so it ignores this entirely.
   */
  walker?: XrayCaptureWalker
  /**
   * Whether the top-level capture roots ARE this plate's own boundary, so the stitch guard must be
   * SKIPPED for them (ADR 0006/0014). True ONLY for a MANUAL root: there `site.el` is the
   * consumer's own element and its `data-xr-boundary` marks the boundary of THIS plate, so the root
   * must be serialized as a real Entry (its box/classes/padding/border) rather than a
   * stitch-to-itself. Defaults to `false` — the auto path, where the top-level roots are the
   * wrapper's CHILDREN and any boundary marker on a direct-child root is a NESTED `<Skeleton>` that
   * MUST stitch (the capture-leak guard).
   */
  captureRootIsBoundary?: boolean
}

/**
 * Capture-only DOM Hints (ADR 0018), read DURING the walk to shape the `PlateNode` tree and NEVER
 * written into the tree, the Plate, or the persisted JSON. They are the declarative 90% of capture
 * customization; the programmable `captureWalker` is the 10% escape hatch.
 *
 * - `data-xr-ignore` drops the element AND its subtree (it contributes no bone).
 * - `data-xr-bone-kind="text-line|text-block|media|box|hidden"` collapses the element's whole subtree
 *   into ONE Bone leaf of the given kind, sized from the element's own box.
 *
 * Both are subordinate to the stitch guard (ADR 0006): a nested `<Skeleton>` boundary always
 * becomes a stitch first, so neither hint can make a boundary leak into the parent plate. See
 * `walk`.
 */
const XR_IGNORE_ATTR = 'data-xr-ignore'
const XR_BONE_KIND_ATTR = 'data-xr-bone-kind'

/** The `LeafKind` values an author may legally name in `data-xr-bone-kind`. */
const LEAF_KINDS: readonly LeafKind[] = ['text-line', 'text-block', 'media', 'box', 'hidden']

/** Narrow an arbitrary `data-xr-bone-kind` string to a `LeafKind`, or null if unknown. */
function asLeafKind(value: string): LeafKind | null {
  return LEAF_KINDS.find((kind) => kind === value) ?? null
}

/**
 * What a capture walker decides for one element (ADR 0018; ADR 0022 §5). The `applyWalker` PASS
 * reads the decision and applies it to the measured IR node — a walker NEVER hand-builds a
 * `PlateNode`, so xray keeps ownership of the Plate format. `ignore` drops the element + its
 * subtree; `bone` collapses it to one Bone leaf (inferring the kind when omitted); `keep` defers to
 * the default classifier (`markInk`).
 */
export type WalkerDecision =
  | { type: 'ignore' }
  | { type: 'bone'; kind?: LeafKind }
  | { type: 'keep' }

/**
 * The context handed to a capture walker's `element` hook (ADR 0018). The helpers are PURE — each
 * returns a `WalkerDecision` the `applyWalker` pass applies; they do NOT mutate. `el` is the
 * element under consideration.
 */
export interface CaptureWalkerContext {
  /** The element currently being classified. */
  el: Element
  /** Drop this element AND its whole subtree (no bone). */
  ignore(): WalkerDecision
  /**
   * Collapse this element's subtree into ONE Bone leaf. `kind` omitted shares the default
   * classifier's kind-inference heuristic (`inferLeafKind`; ADR 0018, Q4 — ONE code path).
   */
  bone(opts?: { kind?: LeafKind }): WalkerDecision
  /** Defer to the default classifier (`markInk`) — recurse into the subtree. */
  keep(): WalkerDecision
}

/**
 * The programmable capture walker (ADR 0018; ADR 0022 §5). `element` is offered each non-boundary
 * element TOP-DOWN over the measured IR (the `applyWalker` pass, NOT the DOM walk) and returns a
 * `WalkerDecision` the pass applies. The declarative `data-xr-*` hints cover the 90%; this is the
 * 10% escape hatch for what a markup attribute cannot express.
 */
export interface XrayCaptureWalker {
  /**
   * Called for every non-boundary element node (a stitch carries no element and is skipped — ADR
   * 0006 — so a boundary never reaches here). Return one of `ctx.ignore()`, `ctx.bone()`, or
   * `ctx.keep()`. An `ignore`/`bone` decision stops the descent (the subtree lowers); `keep`
   * recurses.
   */
  element?(ctx: CaptureWalkerContext): WalkerDecision
}

/**
 * Typed identity wrapper for authoring a capture walker (ADR 0018) — the `defineConfig` pattern. It
 * returns its argument unchanged at runtime; its only job is to infer and check the
 * `XrayCaptureWalker` shape at the call site so an author gets completion and a typo in a hook name
 * is caught.
 */
export function defineXrayCaptureWalker(walker: XrayCaptureWalker): XrayCaptureWalker {
  return walker
}

function isElementNode(node: ChildNode): node is Element {
  return node.nodeType === 1
}

function isTextNode(node: ChildNode): node is Text {
  return node.nodeType === 3
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT', 'TITLE'])

const MEDIA_TAGS = new Set([
  'IMG',
  'SVG',
  'VIDEO',
  'CANVAS',
  'PICTURE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'PROGRESS',
  'METER',
  'AUDIO',
])

/** Replaced media + Stitch/root markers — never folded silently into a text run. */
const RUN_BREAKERS = [...MEDIA_TAGS, `[${BOUNDARY_ATTR}]`, `[${ROOT_ATTR}]`].join(',')

/**
 * A child element whose glyph ink belongs to its parent block's run rather than to a Bone of its
 * own: a pure `display: inline` text wrapper (`<span>`, `<a>`, `<em>`) with no replaced-media or
 * nested-Skeleton descendant. Inline-block and friends are atomic boxes, not text flow, so they are
 * NOT folded.
 */
function isInlineTextElement(el: Element, cs: CSSStyleDeclaration, styles: StyleCache): boolean {
  if (cs.display !== 'inline') return false
  if (MEDIA_TAGS.has(el.tagName.toUpperCase())) return false
  if (el.matches(`[${BOUNDARY_ATTR}],[${ROOT_ATTR}]`)) return false
  if (el.querySelector(RUN_BREAKERS) !== null) return false
  // Fold ONLY a pure-inline wrapper: a block / inline-block / flex descendant is
  // an atomic box (a badge, a chip), not text flow, so its presence makes the
  // wrapper un-foldable — the box becomes its own Bone via the normal walk rather
  // than having its label silently flattened into the run.
  for (const desc of el.querySelectorAll('*')) {
    if (SKIP_TAGS.has(desc.tagName.toUpperCase())) continue
    if (styles.get(desc).display !== 'inline') return false
  }
  return true
}

/**
 * Collect the rendered text nodes under an inline text element into a run, skipping non-rendered
 * tags.
 */
function collectInlineText(el: Element, into: Text[]): void {
  for (const child of Array.from(el.childNodes)) {
    if (isTextNode(child)) into.push(child)
    else if (isElementNode(child) && !SKIP_TAGS.has(child.tagName.toUpperCase()))
      collectInlineText(child, into)
  }
}

/** The bounding rect of a run's text nodes (before the first to after the last), or null. */
function runTextRect(run: readonly Text[]): DOMRect | null {
  const first = run[0]
  const last = run[run.length - 1]
  const doc = first?.ownerDocument
  if (!first || !last || !doc) return null
  const r = doc.createRange()
  r.setStartBefore(first)
  r.setEndAfter(last)
  return r.getBoundingClientRect()
}

/**
 * The rect of the text a leading glyph-media would abut: the immediately following text node or
 * inline text element (e.g. the "4.9" after a "★" icon). Replaced media and absent/blank text yield
 * null — a glyph needs text to hug.
 */
function nextTextRect(nodes: readonly ChildNode[], i: number, styles: StyleCache): DOMRect | null {
  const next = nodes[i + 1]
  if (!next) return null
  if (isTextNode(next)) {
    if ((next.textContent ?? '').trim() === '') return null
    const doc = next.ownerDocument
    if (!doc) return null
    const r = doc.createRange()
    r.selectNode(next)
    return r.getBoundingClientRect()
  }
  // Only an inline TEXT element counts as text the icon can hug. A following
  // block / inline-block / media sibling is NOT text: without this gate a leading
  // icon could "fold" against such a box, get queued in `foldedMedia`, then be
  // dropped when the (still-empty) run flushes — a silent content loss. Folding
  // only against inline text guarantees the run gets that text, so the icon's
  // bone is always emitted.
  if (isElementNode(next) && isInlineTextElement(next, styles.get(next), styles))
    return next.getBoundingClientRect()
  return null
}

/**
 * The pure GEOMETRY of the glyph-fold (ADR 0021 §2): does a media rect read as a GLYPH hugging the
 * text `adj` on the same ROW — emoji-sized (≤ 1.5× line-height), sharing the line (≥ 50% vertical
 * overlap), and abutting within ~a space (gap ≤ 0.6× line-height)? A bigger icon, or one set off by
 * a gutter (a section-heading icon), fails and stays its own Bone. DISPLAY-AGNOSTIC on purpose: the
 * caller decides whether to also require inline-level (`foldsAsGlyph`, the in-flow path) or rely on
 * geometry alone (the flex/grid "row anything" post-pass, `foldGlyphRows`). `adj` is the text it
 * abuts. This size + spacing test is Salience's surviving role.
 */
function glyphGeometry(mediaRect: DOMRect, adj: DOMRect | null, lineHeight: number): boolean {
  if (lineHeight <= 0 || !adj) return false
  if (mediaRect.height > lineHeight * 1.5) return false // ≈ text-height, not a box
  const overlap = Math.min(mediaRect.bottom, adj.bottom) - Math.max(mediaRect.top, adj.top)
  if (overlap < Math.min(mediaRect.height, adj.height) * 0.5) return false // same row
  const gap = mediaRect.left >= adj.right ? mediaRect.left - adj.right : adj.left - mediaRect.right
  return gap <= lineHeight * 0.6 // hugs the text like a letter, not a gutter
}

function foldsAsGlyph(
  mediaCs: CSSStyleDeclaration,
  mediaRect: DOMRect,
  adj: DOMRect | null,
  lineHeight: number,
): boolean {
  // The in-FLOW fold needs the media to be inline-level (an inline-block in flow
  // is an atomic box). The post-pass fold across flex/grid siblings drops this —
  // a flex item is blockified, so display says nothing; there only the geometry
  // (`glyphGeometry`) decides.
  return isInlineish(mediaCs.display) && glyphGeometry(mediaRect, adj, lineHeight)
}

/**
 * APPLY-WALKER — the programmable capture walker as a PASS over the measured IR (ADR 0018; ADR 0022
 * §5). The walker does not run during the DOM walk (the full subtree is always measured); each
 * element is offered TOP-DOWN over the built IR and the decision is LOWERED here by setting the
 * same `markKind`/`dropped` fields the `data-xr-*` hint path sets, so `markInk` (which runs next,
 * in `build`) realizes them uniformly:
 *
 * - `ignore` → `dropped: { reason: 'ignored' }`; the node + subtree lower (NOT recursed — the descent
 *   stops).
 * - `bone` → `markKind = kind ?? inferLeafKind(el)`; `markInk`'s re-stamp lowers it to ONE childless
 *   bone of that kind (NOT recursed).
 * - `keep` (or no `element` hook) → recurse into the kid's kids (defer to the default classifier).
 *
 * Iterates a node's KIDS rather than visiting the node itself, so the synthetic root / synthetic
 * text bars (`el === null`) are never offered — but their kids are still visited. A stitch (`kind:
 * 'stitch'`, no `el`) is skipped (opaque — ADR 0006: a walker can never reach a nested
 * `<Skeleton>`), and a kid the walker ignores/bones is not recursed. Pure on `el` — the `ctx`
 * helpers return a decision; this pass is the only mutator.
 */
export function applyWalker(node: IRNode, walker: XrayCaptureWalker): void {
  if (!walker.element) return
  for (const kid of node.kids) {
    // Skip an entry-less node (synthetic root / text bar: el === null) and a
    // stitch — neither is a real element a walker classifies (ADR 0006). Still
    // recurse so an element nested under a synthetic bar's parent is reached.
    if (kid.el === null || kid.kind === 'stitch') {
      applyWalker(kid, walker)
      continue
    }
    const decision = walker.element({
      el: kid.el,
      ignore: () => ({ type: 'ignore' }),
      bone: (opts) => ({ type: 'bone', ...(opts?.kind ? { kind: opts.kind } : {}) }),
      keep: () => ({ type: 'keep' }),
    })
    if (decision.type === 'ignore') {
      // Drop the element AND its subtree (annotate-then-lower); the descent stops.
      kid.dropped = { reason: 'ignored' }
    } else if (decision.type === 'bone') {
      // Re-stamp to one bone via the `markKind` machinery; `markInk` lowers the
      // measured subtree. The descent stops.
      kid.markKind = decision.kind ?? inferLeafKind(kid.el)
    } else {
      // `keep`: defer to the default classifier — recurse into the kid's kids.
      applyWalker(kid, walker)
    }
  }
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseRgb(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (!match?.[1]) return null
  const parts = match[1].split(/[,/]/).map((p) => Number.parseFloat(p.trim()))
  const [r, g, b] = parts
  if (r === undefined || g === undefined || b === undefined) return null
  return { r, g, b, a: parts.length > 3 ? (parts[3] ?? 1) : 1 }
}

const rgbCache = new Map<string, Rgba | null>()

/**
 * Resolve any computed CSS colour to sRGB bytes. `rgb()/rgba()` parse directly (the cheap path, and
 * the only one a layout-less test env needs); everything else — `oklch()`, `color()`, `hsl()`,
 * named — is painted onto a 1×1 canvas and read back, since browsers serialise a computed colour in
 * the space it was authored in (Chrome returns `oklch(...)` verbatim), which a regex can't read.
 * Without this an oklch-filled control reads as no fill and never becomes a box. Cached by string:
 * the same token recurs across every node of a themed card.
 */
function toRgb(value: string, win: Window): Rgba | null {
  const direct = parseRgb(value)
  if (direct) return direct
  const cached = rgbCache.get(value)
  if (cached !== undefined) return cached
  let result: Rgba | null = null
  try {
    const ctx = win.document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.fillStyle = value // browser parses any CSS colour; invalid leaves it unchanged
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      if (r !== undefined && g !== undefined && b !== undefined) {
        result = { r, g, b, a: (a ?? 255) / 255 }
      }
    }
  } catch {
    result = null // no 2d context (older test env) — fall back to "no fill"
  }
  rgbCache.set(value, result)
  return result
}

/** A background-image that actually paints (a url or gradient), not `none`/`initial`. */
function hasPaintedImage(cs: CSSStyleDeclaration): boolean {
  return /url\(|gradient\(/.test(cs.backgroundImage)
}

function hasVisibleBackground(cs: CSSStyleDeclaration, win: Window): boolean {
  if (hasPaintedImage(cs)) return true
  const bg = toRgb(cs.backgroundColor, win)
  return bg !== null && bg.a > 0
}

/** Fill that visibly contrasts with the nearest painted ancestor — meaning ~24 per channel. */
const FILL_CONTRAST = 72

/**
 * The nearest ancestor that actually paints a background, resolved to sRGB, or null when nothing up
 * the chain paints. Ancestor styles come from the per-capture memo (`StyleCache`): a deep card's
 * parents are climbed once per check but resolved once per capture. This is the `behind` colour
 * both the `hasContrastingFill` boolean and the Salience contrast axis score a node's own
 * fill/border against — extracted so the two read the SAME measured ground (the salience.ts scorer
 * takes `behind` as an input rather than climbing itself).
 */
function nearestPaintedBackground(el: Element, win: Window, styles: StyleCache): Rgba | null {
  for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const candidate = toRgb(styles.get(ancestor).backgroundColor, win)
    if (candidate && candidate.a > 0) return candidate
  }
  return null
}

/**
 * Does this element paint a fill that stands out from what's behind it? A background image always
 * counts; a background color counts only when it's mostly opaque and clearly differs from the
 * nearest ancestor's background (so a white button on a white card doesn't, but a blue one does).
 *
 * This is the fill-ONLY signal Absorb keys on. Measure runs it once and snapshots the result onto
 * `IRNode.paint.contrastingFill`; the pure `markInk`-side `surfaceAbsorbs` reads that snapshot for
 * the fill case and ADDS the Salience contrast axis on top to catch a contrasting BORDER or
 * BOX-SHADOW surface (ADR 0021 §3 — the `hasContrastingFill` branch, generalized).
 */
function hasContrastingFill(
  el: Element,
  cs: CSSStyleDeclaration,
  win: Window,
  styles: StyleCache,
): boolean {
  if (hasPaintedImage(cs)) return true
  const bg = toRgb(cs.backgroundColor, win)
  if (!bg || bg.a < 0.5) return false
  // No painted ancestor → assume a white page behind it (the scorer's default too).
  const base = nearestPaintedBackground(el, win, styles) ?? { r: 255, g: 255, b: 255, a: 1 }
  return Math.abs(bg.r - base.r) + Math.abs(bg.g - base.g) + Math.abs(bg.b - base.b) > FILL_CONTRAST
}

// ---------------------------------------------------------------------------
// Salience consumption (ADR 0019 §4). The scorer in salience.ts is a PURE
// function over a node's computed style, its rendered rect, and a measured
// `SalienceContext`. The walk already holds all three inputs — the node's `cs`,
// the element's `getBoundingClientRect()`, and (for `behind`) the
// nearest-painted-ancestor climb shared with `hasContrastingFill` — so scoring a
// node adds NO new measurement and reads NOTHING the capture does not already
// hold (no tag, no ARIA, no pixels).
// ---------------------------------------------------------------------------

/**
 * The base/context font-size in px the Salience type-scale axis is measured relative to: the
 * inherited font-size of the capture subtree's context (the parent of the first real element),
 * defaulting to the CSS 16px when there is no context or it does not resolve to px. Computed once
 * per capture would be ideal, but the contexts the walk touches are few and the StyleCache makes
 * the parent lookup free, so it is read on demand at each score site.
 */
function contextBaseFontSizePx(el: Element, styles: StyleCache): number {
  const parent = el.parentElement
  if (!parent) return 16
  const sizePx = pxValue(styles.get(parent).fontSize)
  return sizePx !== null && sizePx > 0 ? sizePx : 16
}

/**
 * Score one element's visual relevance by handing salience.ts the three inputs the walk already
 * has: the element's computed style, its rendered box, and the measured context (nearest painted
 * ancestor `behind`, base font-size, the capture root's area for the size axis). `rootArea` is
 * threaded from `walkAll` so every node is normalized against the SAME reference; a non-positive
 * value (a layout-less env, or an unmeasured root) disables the size axis in the scorer rather than
 * dividing by zero. Pure pass-through — the scorer owns the math.
 */
function nodeSalience(
  el: Element,
  cs: CSSStyleDeclaration,
  rect: { width: number; height: number },
  rootArea: number,
  win: Window,
  styles: StyleCache,
): ReturnType<typeof salience> {
  const ctx: SalienceContext = {
    behind: nearestPaintedBackground(el, win, styles),
    baseFontSizePx: contextBaseFontSizePx(el, styles),
    rootAreaPx: rootArea,
  }
  return salience(cs, rect, ctx)
}

/** Serialize a resolved colour back to an `rgb()/rgba()` string for the IR's paint snapshot. */
function rgbaString(c: Rgba): string {
  return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`
}

/**
 * Measure-time paint + salience resolution (ADR 0022 invariants 3 & 5). Runs the canvas-resolving
 * helpers eagerly — once, per element entry, while layout is warm — and snapshots the result onto
 * the node, so `markInk`/Absorb read it off the IR rather than re-touching the DOM.
 *
 * - `paint.surface`/`bg`/`contrastingFill`/`radius` come from the existing `hasVisibleBackground` /
 *   `toRgb` / `hasContrastingFill` helpers and the computed `border-radius`. The `bg` is the
 *   canvas-resolved colour, so a later pass single-sources the colour through `toRgb` (no second
 *   parse path).
 * - `salience` is `nodeSalience`, which resolves the ancestor-climbed `behind` (via `toRgb`) and base
 *   font-size — both legal at measure time — so salience's own colour mirror never has to fall back
 *   on the capture path.
 */
function resolvePaintAndSalience(
  el: Element,
  cs: CSSStyleDeclaration,
  rect: { width: number; height: number },
  state: WalkState,
): { paint: NonNullable<IRNode['paint']>; salience: ReturnType<typeof salience> } {
  const bg = toRgb(cs.backgroundColor, state.win)
  const radius = cs.borderRadius
  return {
    paint: {
      surface: hasVisibleBackground(cs, state.win),
      ...(bg && bg.a > 0 ? { bg: rgbaString(bg) } : {}),
      contrastingFill: hasContrastingFill(el, cs, state.win, state.styles),
      ...(radius && radius !== '0px' ? { radius } : {}),
    },
    salience: nodeSalience(el, cs, rect, state.rootArea, state.win, state.styles),
  }
}

/** The measured size of a capture's surviving tree, one number per Collect axis (ADR 0022). */
export type CaptureSize = { nodes: number; breadth: number; depth: number }

/** Which Collect axis a too-large capture tripped. */
export type CollectAxis = 'nodes' | 'breadth' | 'depth'

/**
 * Thrown when a capture's measured tree exceeds a Collect limit — almost always a `<Skeleton>`
 * sitting too high in the tree. Raised after the cheap walk and before the O(rules × nodes) CSS
 * extraction, so an oversized capture is refused without freezing the main thread on it.
 */
export class CaptureTooLargeError extends Error {
  /** The full measured size of the surviving tree that tripped the gate. */
  readonly size: CaptureSize
  /** Which axis exceeded its cap, and the cap it exceeded. */
  readonly axis: CollectAxis
  readonly max: number
  /** Back-compat alias for `size.nodes` (the sole axis before breadth/depth). */
  readonly nodeCount: number
  /** Folds the oversized-capture warning into the shared diagnostics vocabulary (diagnostics.ts). */
  readonly code = 'too-large' as const
  constructor(size: CaptureSize, axis: CollectAxis, max: number) {
    super(
      `xray: capture ${axis} ${size[axis]} over the limit ${max} ` +
        `(nodes ${size.nodes}, breadth ${size.breadth}, depth ${size.depth})`,
    )
    this.name = 'CaptureTooLargeError'
    this.size = size
    this.axis = axis
    this.max = max
    this.nodeCount = size.nodes
  }
}

/**
 * Collect-stage size limits (ADR 0022): refuse to capture a boundary whose measured tree exceeds
 * any axis. `maxNodes` caps the total surviving-node count; `maxBreadth` the widest level (most
 * nodes at any one depth); `maxDepth` the nesting depth. Each axis is enforced only when its cap is
 * defined. The defaults and the `maxNodes = round(maxBreadth × maxDepth / 4)` derivation live in
 * the client (where the other defaults live); this core only enforces what it is handed.
 */
export type CollectLimits = {
  maxNodes?: number
  maxBreadth?: number
  maxDepth?: number
}

export interface CaptureViewOptions {
  /**
   * Collect limits — refuse (throw `CaptureTooLargeError`) before CSS extraction if the walk
   * exceeds any axis.
   */
  collect?: CollectLimits
  /** Optional programmable capture walker (ADR 0018); capture-only, never persisted. */
  walker?: XrayCaptureWalker
  /**
   * Whether the top-level roots ARE this plate's own boundary, so the stitch guard is skipped for
   * them (ADR 0006/0014). True ONLY for a MANUAL root; defaults to `false`, the auto path where a
   * boundary marker on a direct-child root is a NESTED `<Skeleton>` that MUST stitch. See
   * `walkAll`.
   */
  captureRootIsBoundary?: boolean
}

/**
 * The build phase: the walk builds the light-DOM IR directly (`walkAll` returns `{ root, nodes,
 * extraRules }`); this lifts the author CSS onto it. The CSS-extract (`copyRules`) fills each
 * node's `decls.author` (the lifted CSSOM + inline rules targeting it) and `decls.carried` (the
 * carried token-definition rules anchored to it, ADR 0019 §1), so the IR holds every node's
 * authored CSS — the substrate `emit` reads back out. Gates on the Collect limits BEFORE the
 * O(author rules × nodes) extract.
 *
 * `copyRules` still returns the full flat rule list (its primary job here is the `decls`
 * population); `emit` rebuilds that list from the IR, so the return is dropped — EXCEPT the one
 * rule not anchored to any node: the text-context rule (`ids: []`, the inherited parent font
 * `baseRules` derives), lifted onto the bundle for `emit` to fold back in.
 */
function build(
  walked: { root: IRNode; nodes: IRNode[]; extraRules: PlateRule[] },
  doc: Document,
  win: Window,
  styles: StyleCache,
  diagnostics: DiagnosticsCollector,
  collect?: CollectLimits,
  walker?: XrayCaptureWalker,
): IRBundle {
  // The walk built the IR directly; assemble the bundle around the flat push-order
  // `nodes` list (`emit` orders the synthesized base rules by a node's position in it).
  const bundle: IRBundle = { root: walked.root, nodes: walked.nodes, extraRules: walked.extraRules }
  // The programmable capture walker (ADR 0018; ADR 0022 §5) runs as a PASS over
  // the measured IR — BEFORE `markInk` — so the `markKind`/`dropped` it sets are
  // lowered by `markInk` uniformly with the `data-xr-bone-kind` hint path:
  // `ctx.bone()` sets `markKind` (the re-stamp lowers it to one childless bone),
  // `ctx.ignore()` sets `dropped: 'ignored'` (the subtree lowers). `keep` defers
  // to `markInk`. Skipped entirely with no `element` hook.
  if (walker?.element) applyWalker(bundle.root, walker)
  // Mark-ink (ADR 0022 invariant 5): the classification pass assigns the leaf
  // kinds off the snapshot and folds invisibility into `dropped: 'invisible'`.
  // Runs before the gate (so hidden subtrees, which Measure DESCENDS, do not push
  // a borderline capture over the limit) and before `foldGlyphRowsIR` (which
  // reads `kind: 'media'`/`'text-line'`).
  markInk(bundle.root)
  // Gate on the Collect limits (ADR 0022) BEFORE the extract: copyRules is
  // O(author rules × nodes), so on a huge subtree it pins the main thread; the
  // walk above is linear and cheap. Measure the SURVIVING tree once — `markInk`
  // may have dropped whole hidden subtrees Measure descended, which should not
  // count — and refuse if any axis (total nodes / widest level / depth) exceeds
  // its cap. The caller catches and skips; the error carries the `too-large`
  // code so the client warns via the shared formatter. Each axis is checked only
  // when its cap is defined; the single `measureTree` pass is skipped when none
  // are.
  const gated =
    collect?.maxNodes !== undefined ||
    collect?.maxBreadth !== undefined ||
    collect?.maxDepth !== undefined
  if (gated) {
    const size = measureTree(bundle.root)
    if (collect?.maxNodes !== undefined && size.nodes > collect.maxNodes)
      throw new CaptureTooLargeError(size, 'nodes', collect.maxNodes)
    if (collect?.maxBreadth !== undefined && size.breadth > collect.maxBreadth)
      throw new CaptureTooLargeError(size, 'breadth', collect.maxBreadth)
    if (collect?.maxDepth !== undefined && size.depth > collect.maxDepth)
      throw new CaptureTooLargeError(size, 'depth', collect.maxDepth)
  }
  const flat = copyRules(
    walked.nodes,
    doc,
    win,
    styles,
    diagnostics,
    walked.extraRules,
    indexById(bundle.root),
  )
  const contextRule = flat.find((rule) => rule.spec === SPEC_CONTEXT && rule.ids.length === 0)
  if (contextRule) bundle.contextRule = contextRule
  return bundle
}

/**
 * Run the per-View Distil passes over one measured `IRBundle`, in their fixed, load-bearing order
 * (ADR 0022 §3). Annotate-only — each pass sets fields (`folded`/ `flattened`/`count`/`dropped`);
 * `emit`/Serialize lower them. Kept apart from `build` (the Measure core — `markInk` + the Collect
 * gate + the CSS-extract — where `markInk` must run before the gate) so Distil is a pure `bundle →
 * bundle` step `distilPlate` runs once per View over a whole `PlateIR` after the sweep (reading the
 * snapshotted `ViewIR.viewportHeight`, since `window` has moved on). `diagnostics` collects the
 * Superset/Crop notes.
 *
 * Order: glyph-fold → Flatten → Superset → Crop → Template.
 *
 * - Glyph-fold first: folds glyph-sized icons into adjacent text lines (ADR 0021 §2).
 * - Flatten next: collapses passthrough wrapper chains over the folded tree (ADR 0021 §1). These two
 *   are lossless normalization the removal passes read.
 * - Superset / Crop: the "drop the imperceptible" pair — bone-on-bone (Superset) and off-screen
 *   (Crop) — both only annotate `dropped`, so their relative order is immaterial; Superset stays
 *   before Crop. Crop's base-case folds are `viewportHeight` (vertical) and `viewportWidth`
 *   (horizontal); CROP_BUFFER stays internal to the pass.
 * - Template LAST: compression operates only on what SURVIVES the removal passes — what a viewer
 *   would actually see. Crop drops a run's off-screen tail first; Template then groups the
 *   on-screen prefix and the faithful surviving `count` falls out of the fold (a dropped cell
 *   breaks a template run).
 */
function runPasses(
  bundle: IRBundle,
  viewportHeight: number,
  viewportWidth: number,
  diagnostics: DiagnosticsCollector,
): void {
  foldGlyphRowsIR(bundle.root)
  flattenIR(bundle.root)
  supersetIR(bundle.root, diagnostics)
  cropIR(bundle.root, viewportHeight, viewportWidth, diagnostics)
  templateIR(bundle)
}

/**
 * Run the Distil passes over every View of a `PlateIR` (ADR 0022 §3) — the `PlateIR → PlateIR` pass
 * model, via `eachView`. Each View gets its own diagnostics collector (the passes' Superset/Crop
 * notes), merged onto the View's existing (Measure-time) diagnostics — a dev-only transient
 * (stripped before disk), so the merge order is immaterial. Crop reads the View's snapshotted
 * folds: the vertical base case is `viewportHeight` (an unset one passes `Infinity`, disabling the
 * base-case viewport fold — a fold of 0 would crop EVERYTHING, `top >= 1.5 * 0`, so a
 * manually-built bundle still folds only at a per-node clipping ancestor); the horizontal base case
 * is the View's `width` (its captured `innerWidth`, always set). The orchestration calls this once
 * after building the bundle in one session.
 */
export function distilPlate(plate: PlateIR): void {
  eachView(plate, (view) => {
    const diagnostics = createDiagnostics()
    runPasses(view.bundle, view.viewportHeight ?? Number.POSITIVE_INFINITY, view.width, diagnostics)
    const list = diagnostics.list()
    if (list.length > 0) view.diagnostics = [...(view.diagnostics ?? []), ...list]
  })
}

/**
 * Measure the SURVIVING (non-dropped) tree in one DFS pass: total `nodes`, max nesting `depth`, and
 * `breadth` — the widest level (most nodes at any one depth).
 *
 * Walks via `effectiveKids`, so a `dropped` node (and its non-re-shown subtree) and a `flattened`
 * wrapper are handled exactly as `emit` will lower them — the gate measures the real post-mark
 * output, not every element Measure descended. The synthetic root (id 0, el null) is NOT a measured
 * entry, so it is excluded and `nodes` counts only measured entries.
 *
 * Widest-level `breadth` is the realistic "how wide does this tree get" signal: a DOM tree's total
 * tracks its widest level (~5×), not `breadth × depth` (which assumes every level is maximally wide
 * — a fractal that never occurs). Feeds the Collect gate.
 */
function measureTree(root: IRNode): CaptureSize {
  let nodes = 0
  let depth = 0
  const perLevel: number[] = []
  const visit = (node: IRNode, d: number): void => {
    nodes += 1
    if (d > depth) depth = d
    perLevel[d] = (perLevel[d] ?? 0) + 1
    for (const kid of effectiveKids(node)) visit(kid, d + 1)
  }
  for (const kid of effectiveKids(root)) visit(kid, 1)
  let breadth = 0
  for (let d = 1; d <= depth; d += 1) {
    const w = perLevel[d] ?? 0
    if (w > breadth) breadth = w
  }
  return { nodes, depth, breadth }
}

/**
 * Measure one View's subtree into an `IRBundle` — the Measure stage (ADR 0022 invariant 5): the
 * sole DOM-touching code on the capture path. Sets up the per-capture computed-style memo (built
 * here, discarded when this synchronous capture returns — never outlives the call, so no
 * cross-capture caching of live styles), runs the walk (which builds the light-DOM IR directly),
 * and runs the build phase: lift the author CSS onto each node's `decls`, then run the annotate
 * passes. Returns the bundle alongside the `win` (for the viewport width) and the `diagnostics`
 * collector, so the two callers — `captureBundle` (the raw bundle, for tests) and `captureView` (→
 * a `PlateIR` View) — each shape the result without re-walking. `emit`/Serialize read the IR back
 * out.
 */
function measureBundle(
  roots: readonly Element[],
  options: CaptureViewOptions = {},
): { bundle: IRBundle; win: Window; diagnostics: DiagnosticsCollector } {
  const doc = roots[0]?.ownerDocument
  const win = doc?.defaultView
  if (!doc || !win) throw new Error('xray: capture roots must be attached to a document')
  const diagnostics = createDiagnostics()
  const styles = new StyleCache(win)
  const walked = walkAll(roots, win, styles, diagnostics, options.captureRootIsBoundary ?? false)
  const bundle = build(walked, doc, win, styles, diagnostics, options.collect, options.walker)
  return { bundle, win, diagnostics }
}

/**
 * @internal The IR bundle for a capture, with every node's `decls` populated —
 * the same Measure stage `captureView` runs, exposed for tests. Not re-exported
 * from the package entrypoints.
 */
export function captureBundle(
  roots: readonly Element[],
  options: CaptureViewOptions = {},
): IRBundle {
  return measureBundle(roots, options).bundle
}

/**
 * The framework-agnostic capture core (ADR 0022 §1,§2): measure one View's subtree and APPEND it to
 * a per-Plate `PlateIR` bundle — ADR 0022 §1's `capture(el, ir?) → ir`. The single entry point for
 * capture: the dev client sweeps every View through it, and the framework-neutral `captureElement`
 * (core.ts) runs it once for the single-View case, both then distilling via `distilPlate` and
 * projecting via `serializePlateIR`. Walks the View's `roots` into an `IRBundle` (Measure + build),
 * wraps it as a `ViewIR` at the current viewport width with the capture's transient diagnostics,
 * and appends it to the passed-in `plate` (the orchestration threads ONE bundle through a Plate's
 * per-View calls in one session, ADR 0022 §2). With no `plate` it starts a fresh, as-yet-UNNAMED
 * bundle — naming and the breakpoint union are the orchestration's job (Views are orchestration,
 * not core, §1), so the caller sets `name`/`breakpoints` on the returned `PlateIR`.
 */
export function captureView(
  roots: readonly Element[],
  options: CaptureViewOptions = {},
  plate?: PlateIR,
): PlateIR {
  const { bundle, win, diagnostics } = measureBundle(roots, options)
  const list = diagnostics.list()
  // Snapshot this View's viewport height (Crop's base-case fold) and DEFER the
  // Distil passes to `distilPlate`: the orchestration appends every View in one
  // session, then runs the passes once over the whole bundle — by which point
  // `window` has moved to the last View's width, so each View carries its own fold
  // (ADR 0022 invariant 3). `diagnostics` here is Measure-only; the passes' notes
  // are merged in by `distilPlate`.
  const view: ViewIR = {
    width: win.innerWidth,
    viewportHeight: win.innerHeight,
    bundle,
    ...(list.length > 0 ? { diagnostics: list } : {}),
  }
  if (plate) {
    plate.views.push(view)
    return plate
  }
  return { name: '', views: [view], breakpoints: [] }
}

function walkAll(
  roots: readonly Element[],
  win: Window,
  styles: StyleCache,
  diagnostics: DiagnosticsCollector,
  captureRootIsBoundary = false,
): { root: IRNode; nodes: IRNode[]; extraRules: PlateRule[] } {
  const state: WalkState = {
    nextId: 1,
    nodes: [],
    win,
    styles,
    diagnostics,
    extraRules: [],
    // The Salience size-axis reference (ADR 0019 §4): the union area of the
    // capture roots. Summing each root's rendered area is a cheap upper bound on
    // the captured region — exact for the common single root, and an honest
    // reference for several. 0 in a layout-less env (every rect is 0×0), which
    // the scorer reads as "disable the size axis" rather than dividing by zero.
    rootArea: roots.reduce((sum, root) => {
      const r = root.getBoundingClientRect()
      return sum + Math.max(0, r.width) * Math.max(0, r.height)
    }, 0),
  }
  const kids: IRNode[] = []
  for (const root of roots) {
    // The stitch-guard skip for a TOP-LEVEL root is gated on `captureRootIsBoundary`,
    // and is correct ONLY when true — a MANUAL root (ADR 0014), where
    // `site.el` IS the consumer's own element and its `data-xr-boundary` marks the
    // boundary of THIS plate. Skipping the guard there serializes the root as a real
    // Entry (its own box/classes/padding/border) instead of a stitch-to-itself.
    //
    // It must be FALSE for an AUTO root. The auto roots are the display:contents
    // wrapper's CHILDREN, and a direct-child root CAN carry the boundary marker:
    // the canonical nested pattern renders a child `<Skeleton>`'s boundary element
    // as a direct child of the parent's wrapper. That marker is a NESTED Skeleton,
    // not this plate's own boundary, so the guard MUST run and stitch `{ ref }` —
    // skipping it would leak the child's content inline into the parent plate (ADR
    // 0006, the worst failure mode). Recursion always passes false, so a NESTED
    // `<Skeleton>` deeper inside any root still becomes a stitch too.
    // The root's direct kids sit at depth 1 (the synthetic root is depth 0).
    const node = walk(root, state, 1, captureRootIsBoundary)
    if (node) kids.push(node)
  }
  // The synthetic root IRNode (id 0): entry-less (el null, empty style), the
  // structural parent every other node links under. It is NOT pushed to `nodes`
  // (the flat push-order list holds only measured element / synthetic-bar nodes),
  // so the gate's `measureTree` and `emit`'s ordering exclude it.
  const root: IRNode = {
    id: 0,
    el: null,
    kind: 'root',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: EMPTY_STYLE,
  }
  // Long-run truncation is not a walk step (ADR 0022): Crop drops a run's
  // off-screen tail (past the vertical/horizontal fold), and Template (running
  // LAST, after Crop) losslessly collapses the surviving on-screen prefix into
  // one cell + a faithful `count` that renders back to N. The walk hands back the
  // full measured IR.
  return { root, nodes: state.nodes, extraRules: state.extraRules }
}

function walk(el: Element, state: WalkState, depth: number, isCaptureRoot = false): IRNode | null {
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) {
    // Non-visual tags (script/style/meta/etc.) never paint a bone; aggregate
    // one diagnostic so a captured subtree heavy with them is explained.
    state.diagnostics.add('dropped-tag')
    return null
  }
  // The element's own computed style, resolved through the per-capture memo so
  // copyRules can reuse it without a second getComputedStyle.
  const cs = state.styles.get(el)
  if (cs.display === 'none') {
    // `display: none` has NO box to measure, so it stays the one invisibility skip
    // the walk alone can honor (ADR 0022 invariant 5): there is nothing for a later
    // pass to read. Aggregated under `dropped-tag`.
    state.diagnostics.add('dropped-tag')
    return null
  }
  // `visibility: hidden|collapse` and `opacity <= INVISIBLE_OPACITY` are NOT
  // skipped here (ADR 0022 invariant 5): Measure DESCENDS them and builds IR
  // nodes (geometry/style intact), and the `markInk` pass annotates the hidden
  // node `dropped: { reason: 'invisible' }` — so a `visibility: hidden` ancestor
  // with a `visibility: visible` descendant (CSS re-shows it) keeps the re-shown
  // child; only the hidden node drops. `effectiveKids` lowers it.

  // STITCH GUARD — runs BEFORE the walker and the hints, and is the FIRST
  // step among the classification logic (ADR 0006, ADR 0018 precedence ladder).
  // A nested <Skeleton> is a stitch: every boundary carries `data-xr-boundary`
  // (content mounted), and a boundary mid-loading shows `data-xr-root`. Either
  // way, reference the child plate by name instead of descending into its
  // subtree — which would re-serialize already-loaded content or, worse, the
  // child's own bones. Because this returns before the walker/hint ladder
  // below is reachable, NEITHER a `data-xr-ignore`/`data-xr-bone-kind` nor a
  // `captureWalker` can override a boundary: the worst failure (capture leaking
  // past a nested Skeleton into the parent plate) is structurally impossible.
  //
  // EXCEPT for a TOP-LEVEL MANUAL capture root (`isCaptureRoot`, set by `walkAll`
  // only when `captureRootIsBoundary`): a MANUAL root (ADR 0014) IS the consumer's
  // own element and carries `data-xr-boundary` so a PARENT capture stitches at it —
  // that marker bounds THIS plate, not a nested one, so the root must be serialized
  // as a real Entry (its box/classes/padding/border), not a stitch-to-itself.
  // The skip is gated to the MANUAL case and scoped to the direct
  // roots only; recursion passes false, so a NESTED `<Skeleton>` inside still
  // stitches. For an AUTO root the skip is OFF (`isCaptureRoot` is false): the auto
  // roots are the wrapper's CHILDREN, and a direct-child root CAN carry the marker
  // (a nested `<Skeleton>` rendered as a direct child) — the guard must run there or
  // the child's content leaks inline into the parent plate (ADR 0006, capture leak).
  if (!isCaptureRoot) {
    const refName = el.getAttribute(BOUNDARY_ATTR) ?? el.getAttribute(ROOT_ATTR)
    // A stitch is structural (`el: null`): it goes in the TREE but NOT in the flat
    // `nodes` push-order list. It carries no fallback/size, `copyRules` skips it
    // (no `el`), and `emit` orders it last (absent from the push list).
    if (refName) {
      return {
        id: state.nextId++,
        el: null,
        kind: 'stitch',
        kids: [],
        depth,
        decls: { fallback: [] },
        style: EMPTY_STYLE,
        ref: refName,
      }
    }
  }

  // PRECEDENCE LADDER (ADR 0018): stitch guard (above) -> hints -> default
  // classifier. The programmable `captureWalker` is not a walk-time rung
  // (ADR 0022 §5): it runs as the `applyWalker` PASS over the measured IR, after
  // this walk, so `walk` always descends (measuring the full subtree into the IR)
  // and the walker's `ignore`/`bone` lower post-measure, uniformly with the
  // `data-xr-bone-kind` hint.
  return hintWalk(el, cs, state, depth)
}

/**
 * The built-in Hint rung (ADR 0018), between the stitch guard and the default classifier. It honors
 * the capture-only `data-xr-*` hints and otherwise falls through to the default classifier. The
 * stitch guard already ran in `walk`, so a boundary element never reaches here — a hint can never
 * override a nested `<Skeleton>` (ADR 0006).
 */
function hintWalk(
  el: Element,
  cs: CSSStyleDeclaration,
  state: WalkState,
  depth: number,
): IRNode | null {
  // `data-xr-ignore` drops the element and its whole subtree before any
  // classification. Capture-only: the attribute shapes the tree, never persists.
  if (el.hasAttribute(XR_IGNORE_ATTR)) return ignoreElement(state)
  // `data-xr-bone-kind` declares the element ONE Bone of the named kind. The walk
  // DESCENDS normally (ADR 0022 §5) — the full subtree is measured into the IR —
  // and tags the element's own node with `markKind`; the `markInk` pass re-stamps
  // the node into one childless bone of the declared kind, dropping its measured
  // subtree (annotate-then-lower). An unrecognized value falls through to the
  // default classifier (and is counted) rather than guessing. Capture-only: never
  // written into the tree.
  const kindAttr = el.getAttribute(XR_BONE_KIND_ATTR)
  if (kindAttr !== null) {
    const kind = asLeafKind(kindAttr.trim())
    if (kind !== null) return defaultClassify(el, cs, state, depth, kind)
    state.diagnostics.add('dropped-tag')
  }
  return defaultClassify(el, cs, state, depth)
}

/**
 * `data-xr-ignore`: drop the element and its subtree at WALK TIME. No Entry, no node, no descent —
 * it contributes nothing to the Plate, and never reaches the IR (so it never produces a `dropped:
 * 'ignored'`, which is the walker-only post-measure path; ADR 0022 §5). Aggregated under the
 * existing `dropped-tag` diagnostic (a hidden/non-visual drop is the same fidelity story; do not
 * spam a new code per ignored element).
 */
function ignoreElement(state: WalkState): null {
  state.diagnostics.add('dropped-tag')
  return null
}

/**
 * Snapshot the raw clip inputs onto an IR node for the 2D Crop pass — one pair per axis, each gated
 * on its OWN overflow not being `visible`. The vertical pair (`scrollHeight`/`clientHeight`, gated
 * on `overflow-y`) and the horizontal pair (`scrollWidth`/`clientWidth`, gated on `overflow-x`) are
 * element PROPS, not on the computed-style object and not derivable later, so they must be read at
 * measure time while layout is valid; reading them CAN force a layout, so each gate keeps it off
 * the `overflow: visible` majority for that axis. Layout is already warm here (the caller just read
 * `getBoundingClientRect`). The walk only records; `cropIR` derives the fold.
 */
function snapshotClipInputs(el: Element, cs: CSSStyleDeclaration, node: IRNode): void {
  if (cs.overflowY !== 'visible') {
    node.scrollHeight = el.scrollHeight
    node.clientHeight = el.clientHeight
  }
  if (cs.overflowX !== 'visible') {
    node.scrollWidth = el.scrollWidth
    node.clientWidth = el.clientWidth
  }
}

/**
 * The kind-inference heuristic shared by the walker's `ctx.bone()` without an explicit kind (via
 * the `applyWalker` pass) and the default classifier (ADR 0018, Q4 — ONE code path). A media tag is
 * `media`; anything else collapsed to a single bone reads as a `box`. The default classifier
 * reaches the same outcomes through its own structural branches (MEDIA_TAGS -> media, contrasting
 * fill / painted empty -> box), so keeping this one function is the single source of truth for
 * "what kind is an element that has no children to descend into".
 */
function inferLeafKind(el: Element): LeafKind {
  return MEDIA_TAGS.has(el.tagName.toUpperCase()) ? 'media' : 'box'
}

/**
 * The DEFAULT classifier — the precedence ladder's last rung (ADR 0018). With no walker and no
 * hints this is the only path taken.
 */
function defaultClassify(
  el: Element,
  cs: CSSStyleDeclaration,
  state: WalkState,
  depth: number,
  markKind?: LeafKind,
): IRNode | null {
  const tag = el.tagName.toUpperCase()
  const rect = el.getBoundingClientRect()
  // Resolve + snapshot paint/salience (ADR 0022 invariant 5), carried onto
  // `IRNode.paint`/`.salience` for `markInk`/Absorb.
  const resolved = resolvePaintAndSalience(el, cs, rect, state)
  // Build the element's IRNode DIRECTLY (ADR 0022): snapshot the bounded
  // computed-style set off the live `cs` inline (`snapshotStyle` — the walk holds the
  // live view, so the snapshot folds into Measure), record the box / clip inputs /
  // paint / salience, and seed a PROVISIONAL `container` kind (the branches below
  // upgrade it to `media`/`box`; `markInk` finalizes). Pushed to the flat
  // push-order `nodes` list and linked into its parent's `kids` by the caller.
  const node: IRNode = {
    id: state.nextId++,
    el,
    kind: 'container',
    kids: [],
    depth,
    decls: { fallback: [] },
    style: snapshotStyle(cs),
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    paint: resolved.paint,
    salience: resolved.salience,
  }
  state.nodes.push(node)
  const fallback = node.decls.fallback
  // A valid `data-xr-bone-kind` (ADR 0018; ADR 0022 §5): the walk descends as usual
  // (measuring the full subtree into the IR) but tags THIS element's node, so
  // `markInk` re-stamps it into one childless bone of the declared kind and drops the
  // measured subtree (annotate-then-lower). The node is created above before any
  // branch returns, so `markKind` always rides into the IR.
  if (markKind !== undefined) node.markKind = markKind
  snapshotClipInputs(el, cs, node)

  if (MEDIA_TAGS.has(tag)) {
    // Snapshot the `MEDIA_TAGS` membership so `markInk` assigns the `media` kind
    // off the IR (ADR 0022 invariants 3 & 5), never re-reading `el.tagName`. The
    // walk seeds a PROVISIONAL `kind: 'media'` that `markInk` re-derives (and
    // that Absorb's `isLabelContent` reads as a leaf); `markInk` decides the
    // shipped kind, reading `isMedia`.
    node.isMedia = true
    node.kind = 'media'
    if (isInlineish(cs.display)) {
      fallback.push('display: inline-block', 'vertical-align: middle')
    }
    // Replaced elements with a degenerate layout box usually paint via
    // overflow (e.g. charts whose svg keeps width=0 and draws outside it).
    // When such a leaf is its parent's only element child, the parent's
    // content box is the honest paint area.
    let { width, height } = rect
    const parent = el.parentElement
    if ((width < 8 || height < 8) && parent && parent.childElementCount === 1) {
      const pcs = state.styles.get(parent)
      const prect = parent.getBoundingClientRect()
      const pw = prect.width - pad(pcs.paddingLeft) - pad(pcs.paddingRight)
      const ph = prect.height - pad(pcs.paddingTop) - pad(pcs.paddingBottom)
      if (pw * ph > width * height) {
        width = pw
        height = ph
      }
    }
    node.decls.size = ['box-sizing: border-box', `width: ${px(width)}`, `height: ${px(height)}`]
    return node
  }

  const kids: IRNode[] = []
  // A RUN is the inline ink of one block: consecutive text PLUS pure-inline text
  // elements coalesce into one bar, and only a block-level child breaks it (ADR
  // 0021 §2). So inline siblings read as one line (`★★★★½ (128 reviews)`), while
  // distinct block-level labels (a name over a price) stay separate Bones —
  // markup-agnostic, decided by the formatting context, not nesting depth.
  const flowParent = establishesInlineFlow(cs.display)
  const lineHeight = pxValue(cs.lineHeight) ?? (pxValue(cs.fontSize) ?? 0) * 1.2
  let textRun: Text[] = []
  let foldedMedia: Element[] = []
  let hasTextBar = false
  const flushTextRun = () => {
    if (textRun.length === 0) {
      foldedMedia = []
      return
    }
    const kid = textBar(textRun, foldedMedia, state, depth + 1)
    if (kid) {
      kids.push(kid)
      hasTextBar = true
    }
    textRun = []
    foldedMedia = []
  }
  const childNodes = Array.from(el.childNodes)
  for (let i = 0; i < childNodes.length; i++) {
    const child = childNodes[i]
    if (!child) continue
    if (isElementNode(child)) {
      // A pure-inline text wrapper's glyph ink belongs to this block's run.
      if (flowParent && isInlineTextElement(child, state.styles.get(child), state.styles)) {
        collectInlineText(child, textRun)
        continue
      }
      // An inline icon that reads as a glyph (emoji-sized, hugging the text) folds
      // into the run too, so `★ 4.9` is one bar; a bigger or gutter-gapped icon
      // stays its own media Bone (ADR 0021 §2, the glyph-fold).
      if (flowParent && MEDIA_TAGS.has(child.tagName.toUpperCase())) {
        const adj =
          textRun.length > 0 ? runTextRect(textRun) : nextTextRect(childNodes, i, state.styles)
        if (foldsAsGlyph(state.styles.get(child), child.getBoundingClientRect(), adj, lineHeight)) {
          foldedMedia.push(child)
          continue
        }
      }
      // Anything else — a block/flex child, a non-glyph icon, a Stitch — breaks
      // the run and is walked on its own.
      flushTextRun()
      const kid = walk(child, state, depth + 1)
      if (kid) {
        kids.push(kid)
      }
    } else if (isTextNode(child)) {
      textRun.push(child)
    }
    // Comments and other node types render nothing — they don't break a run.
  }
  flushTextRun()

  if (kids.length > 0) {
    // ABSORB lives in the `markInk` pass (ADR 0021 §3). The walk builds the full
    // container structure, and `markInk` — reading the `paint`/`salience`
    // snapshot and the effective-node accessors — owns the decision, re-stamping
    // the surface a childless `box` and marking its kids `dropped: 'absorbed'`.
    // This branch just emits the container's own decls.
    node.kids = kids
    // Display that comes from UA tag defaults (table parts, list items,
    // inline spans) never appears in author CSS — the rendered <div> needs
    // it spelled out or table rows collapse into stacked blocks. `-webkit-box`
    // (legacy line-clamp) is normalized to block — see `normalizeDisplay`.
    const branchDisplay = normalizeDisplay(cs.display)
    if (branchDisplay && branchDisplay !== 'block') {
      fallback.push(`display: ${branchDisplay}`)
    }
    // A node holding text gets its own line-height. The root context line-height
    // is one resolved px shared by the whole plate, so a row in a smaller font
    // than the context would inherit too tall a line box (e.g. a 13px caption
    // taking a 16px line). Pinning each text row to its measured px keeps the
    // line box font-relative. Only when already resolved to px — a unitless ratio
    // or `normal` is correct as inherited and stays out.
    if (hasTextBar) {
      const lh = pxValue(cs.lineHeight)
      if (lh !== null) fallback.push(`line-height: ${px(lh)}`)
    }
    return node
  }

  // Empty element: painted ones shimmer (a `box` leaf); plain ones stay as
  // invisible spacers (a container). The walk builds the right DECLS for each
  // case from `painted` but does not DECIDE the shipped kind: `markInk`
  // re-derives `box` vs container off `node.paint.surface` (the snapshot of this
  // exact `hasVisibleBackground` value). A PROVISIONAL `kind: 'box'` is kept as
  // `markInk`'s seed (Absorb, inside `markInk`, reads it off the IR).
  const painted = hasVisibleBackground(cs, state.win)
  if (isInlineish(cs.display)) {
    // Plain inline boxes ignore width/height — the measured size needs a
    // formatting context that honors it.
    fallback.push('display: inline-block')
  } else {
    const disp = normalizeDisplay(cs.display)
    if (disp && disp !== 'block') fallback.push(`display: ${disp}`)
  }
  if (painted) {
    // A painted empty box is a leaf — its measured size is authoritative.
    node.kind = 'box'
    node.decls.size = [
      'box-sizing: border-box',
      `width: ${px(rect.width)}`,
      `height: ${px(rect.height)}`,
    ]
  } else {
    // An unpainted empty element is a spacer — a low-precedence size hint
    // the author CSS may legitimately override.
    fallback.push(
      'box-sizing: border-box',
      `min-width: ${px(rect.width)}`,
      `min-height: ${px(rect.height)}`,
    )
  }
  return node
}
