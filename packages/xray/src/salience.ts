/**
 * The Salience scorer (ADR 0019 §4). Salience is a node's VISUAL RELEVANCE — how much it
 * contributes to the perceived skeleton — scored from FOUR measurable-visual signals and nothing
 * else:
 *
 * Contrast — does the element paint a fill / border / shadow that visibly stands out from what is
 * behind it? spacing — the layout rhythm it contributes (padding / margin / gap / alignment /
 * border-width). size — its rendered area, normalized against the capture root. type-scale — its
 * font-size and font-weight RELATIVE to the page base.
 *
 * HARD INVARIANT (ADR 0019 §4, the reviewer WILL reject a violation): Salience is computed ONLY
 * from the DOM tree, CSSOM, geometry, and resolved colours/fonts the capture already holds. It
 * NEVER reads rasterized pixels, NEVER runs computer vision, and NEVER reads semantic markup or
 * intent — no tag name, no ARIA, no role, no landmark. Salience is markup-agnostic BY DESIGN: two
 * `<button>`s can look opposite, and div-soup is the norm, so the tag tells us nothing about how a
 * node renders. The visual signals are their own non-drop guard; no semantic guard is wanted, and
 * none appears here.
 *
 * This module is the SUBSTRATE: a standalone, pure function. It is intentionally NOT wired into the
 * capture walk. Under ADR 0021 its surviving role is narrow — the glyph-fold test (does an inline
 * icon read as a letter: size + spacing) and surface detection (contrast); its former role as a
 * Fuse/Absorb MERGE WEIGHT is retired with Fuse. (The glyph-fold ships today computing size/spacing
 * inline in measure.ts; this graded scorer is the home those signals can move to.) Keeping it
 * unconsumed but heavily tested keeps this change off the capture hot path.
 *
 * The colour/contrast machinery here MIRRORS serialize.ts (`toRgb`, `FILL_CONTRAST`, the
 * nearest-painted-ancestor walk) and GENERALIZES its boolean `hasContrastingFill` (fill-only today)
 * into a graded score that also counts a contrasting border and box-shadow. It is duplicated rather
 * than imported because serialize.ts is the capture path and this is a standalone substrate; the
 * two contrast helpers can be reconciled into one when surface detection adopts this graded score.
 */

// ---------------------------------------------------------------------------
// Inputs. The scorer is PURE: it reads only the values the walk already has in
// hand — a node's computed style, its rendered rect, and a small context object
// (nearest painted ancestor background, the base/context font-size, the root
// area). Taking these as plain inputs (not an `Element`) is what makes it
// deterministic and unit-testable without a layout engine: a test hands it the
// exact numbers a real browser would have measured.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of a `CSSStyleDeclaration` the scorer reads. A real `getComputedStyle()` result
 * satisfies it directly; a test can hand a plain object with the same shape. Only
 * `getPropertyValue` is strictly needed — the camelCase accessors are declared so the scorer can
 * read the common properties the same ergonomic way serialize.ts does, and a real computed style
 * provides both. Every member is read-only here; the scorer never mutates style.
 */
export interface CssReader {
  getPropertyValue: (property: string) => string
}

/** A rendered box — exactly the `width`/`height` of a `getBoundingClientRect()`. */
export interface SalienceRect {
  width: number
  height: number
}

/**
 * SRGB bytes with straight alpha. Same shape serialize.ts uses; the scorer accepts an
 * already-resolved ancestor background as one of these (or null when nothing behind it paints) so
 * it never has to climb the DOM itself — the walk already found the nearest painted ancestor for
 * `hasContrastingFill`.
 */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * The measured context a node is scored against — everything the scorer needs that is NOT on the
 * node's own style/rect. The walk already computes each of these for other reasons, so passing them
 * in adds no new measurement.
 */
export interface SalienceContext {
  /**
   * The nearest painted-background ancestor's resolved colour, or null when no ancestor paints (the
   * walk treats that as a white page behind the node — `hasContrastingFill` does the same). The
   * contrast axis scores the node's own fill against THIS.
   */
  behind: Rgba | null
  /**
   * The base/context font-size in px the type-scale axis is measured RELATIVE to — the
   * inherited/root font-size for this node's context (typically 16px). A heading at 2× this scores
   * high; body text at 1× scores low. Must be > 0; a non-positive value is treated as the 16px CSS
   * default so the axis never divides by zero.
   */
  baseFontSizePx: number
  /**
   * The reference area (px²) the size axis normalizes against — the capture root's area, or the
   * viewport area. A node covering a large fraction of it scores high; a tiny icon scores near
   * zero. Must be > 0; a non-positive value disables the size axis (scores 0) rather than dividing
   * by zero.
   */
  rootAreaPx: number
}

/**
 * A per-axis Salience result. Each axis is independently normalized to 0..1 (documented per axis
 * below) so a consumer can read the ONE signal it cares about — Absorb reads `contrast`, a
 * sub-threshold drop reads `size` — without a blend hiding it. `score` is a convenience blend for
 * consumers that want a single number (the structural gates); a per-axis reader should ignore it.
 */
export interface Salience {
  /** 0..1 — fill/border/shadow standing out from what is behind it. */
  contrast: number
  /** 0..1 — layout rhythm contributed: padding/margin/gap/alignment/border. */
  spacing: number
  /** 0..1 — rendered area as a fraction of the reference (root/viewport) area. */
  size: number
  /** 0..1 — font-size×weight relative to the context base font-size. */
  typeScale: number
  /** 0..1 — a weighted blend of the four axes (see `WEIGHTS`). */
  score: number
}

// ---------------------------------------------------------------------------
// Colour helpers — a self-contained mirror of serialize.ts's `parseRgb`/`toRgb`.
// Only the `rgb()/rgba()` fast path is inlined here: the scorer is handed
// ALREADY-RESOLVED colours where it can (the ancestor `behind`), and for the
// node's own fill/border it parses the computed value, which browsers serialize
// to `rgb()/rgba()` for the common case. A colour the regex can't read (an
// unresolved `oklch()` in an env with no canvas) is treated as "no paint" —
// conservative, never a crash. The capture path's `toRgb` canvas round-trip can
// be folded in when surface detection reconciles the two contrast helpers.
// ---------------------------------------------------------------------------

function parseRgb(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (!match?.[1]) return null
  const parts = match[1].split(/[,/]/).map((p) => Number.parseFloat(p.trim()))
  const [r, g, b] = parts
  if (r === undefined || g === undefined || b === undefined) return null
  return { r, g, b, a: parts.length > 3 ? (parts[3] ?? 1) : 1 }
}

/** A background-image that actually paints (a url or gradient), not `none`/`initial`. */
function hasPaintedImage(backgroundImage: string): boolean {
  return /url\(|gradient\(/.test(backgroundImage)
}

/** The sum-of-channel distance between two colours — serialize.ts's metric. */
function channelDistance(a: Rgba, b: Rgba): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)
}

// ---------------------------------------------------------------------------
// Tunables. Mirrors serialize.ts's `FILL_CONTRAST = 72` (~24 per channel = the
// boundary where a fill reads as "different"). The scorer turns that boolean
// threshold into a graded ramp: at `FILL_CONTRAST` the contrast axis is ~halfway,
// at `FILL_CONTRAST_MAX` it saturates. The other ceilings cap each raw signal at
// a value past which "more" stops reading as more salient.
// ---------------------------------------------------------------------------

/** The serialize.ts fill threshold (~24/channel): a fill at this distance reads as different. */
const FILL_CONTRAST = 72
/** Channel-distance at which the fill sub-signal saturates (a stark fill on a plain ground). */
const FILL_CONTRAST_MAX = 384
/** A border this thick (px, summed across sides' max) reads as a fully present outline. */
const BORDER_WIDTH_SATURATION = 4
/** Total spacing (px) — padding+margin+gap+border, summed — at which the axis saturates. */
const SPACING_SATURATION = 64
/** Type-scale (size×weight ratio over base) at which the axis saturates — ~a hero heading. */
const TYPE_SCALE_SATURATION = 2.5
/** Font-weight at/above which weight contributes its full bump to type-scale. */
const BOLD_WEIGHT = 700
/** The base (`normal`) font weight type-scale measures a bump against. */
const NORMAL_WEIGHT = 400
/** The CSS default font-size (px) used when the context base is missing/degenerate. */
const DEFAULT_FONT_SIZE = 16

/**
 * Axis weights for the convenience `score` blend. Contrast and size lead — a skeleton bone exists
 * because something PAINTS at some SIZE — with type-scale and spacing as secondary modifiers. They
 * sum to 1 so `score` stays in 0..1. A per-axis consumer ignores this entirely; it exists only so a
 * gate that wants one number has a sensible default. Tunable.
 */
const WEIGHTS = { contrast: 0.35, size: 0.3, typeScale: 0.2, spacing: 0.15 } as const

// ---------------------------------------------------------------------------
// Small numeric utilities.
// ---------------------------------------------------------------------------

/** Clamp to the 0..1 range every axis is normalized into. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** Parse a px length to a number, or 0 for `normal`/`auto`/'' /non-finite — serialize.ts's `pad`. */
function pad(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * A ramp from `lo` to `hi`: 0 at/below `lo`, 1 at/above `hi`, linear between. Every axis funnels
 * its raw measurement through one of these so "more signal" maps monotonically to a higher score
 * and then saturates — past a point, a thicker border or a bigger heading does not read as
 * proportionally more salient.
 */
function ramp(value: number, lo: number, hi: number): number {
  if (hi <= lo) return value > lo ? 1 : 0
  return clamp01((value - lo) / (hi - lo))
}

// ---------------------------------------------------------------------------
// The contrast axis. GENERALIZES serialize.ts's boolean `hasContrastingFill`
// (fill-only) into a graded 0..1 score over THREE painted differentiators a node
// can use to stand out from what is behind it:
//
//   fill   — a background image always reads as a full fill; a background colour
//            scores by its channel-distance from the nearest painted ancestor
//            (the `behind`), ramped through serialize.ts's `FILL_CONTRAST`. A
//            near-transparent fill (alpha < 0.5) is discounted, matching the
//            capture path's `bg.a < 0.5` early-out.
//   border — a visible, opaque, colour-contrasting outline, scored by its width.
//   shadow — any painted box-shadow (a card lifts off the page).
//
// The axis is the MAX of the three sub-signals, not their sum: a node "stands
// out" if ANY one of fill / border / shadow does it strongly. This is exactly
// the Absorb signal — a contrast surface that renders as one Bone.
// ---------------------------------------------------------------------------

function contrastAxis(cs: CssReader, ctx: SalienceContext): number {
  // No painted ancestor → the walk assumes a white page behind the node, the
  // same default `hasContrastingFill` uses.
  const behind = ctx.behind ?? { r: 255, g: 255, b: 255, a: 1 }

  // --- fill ---
  let fill = 0
  if (hasPaintedImage(cs.getPropertyValue('background-image'))) {
    // A gradient or image is a full fill — it always paints something.
    fill = 1
  } else {
    const bg = parseRgb(cs.getPropertyValue('background-color'))
    if (bg && bg.a >= 0.5) {
      // Channel-distance ramped from the serialize.ts threshold to saturation,
      // then scaled by alpha so a semi-transparent fill reads as a weaker
      // surface than a solid one of the same hue.
      fill = ramp(channelDistance(bg, behind), FILL_CONTRAST, FILL_CONTRAST_MAX) * bg.a
    }
  }

  // --- border ---
  // The thickest contrasting, opaque, non-`none` side. A border only reads if it
  // has a paint style, a positive width, and a colour that differs from what is
  // behind it (a 1px border the same colour as the page is invisible).
  let border = 0
  const borderStyle = cs.getPropertyValue('border-style')
  const hasBorderStyle = borderStyle !== '' && borderStyle !== 'none' && borderStyle !== 'hidden'
  if (hasBorderStyle || borderHasVisibleSide(cs)) {
    const width = maxBorderWidth(cs)
    const bc = parseRgb(
      cs.getPropertyValue('border-color') || cs.getPropertyValue('border-top-color'),
    )
    const colorContrasts = bc !== null && bc.a >= 0.5 && channelDistance(bc, behind) > FILL_CONTRAST
    if (width > 0 && colorContrasts) {
      border = ramp(width, 0, BORDER_WIDTH_SATURATION)
    }
  }

  // --- shadow ---
  // Any painted box-shadow lifts the node off the page. `none`/'' is no shadow.
  const boxShadow = cs.getPropertyValue('box-shadow')
  const shadow = boxShadow !== '' && boxShadow !== 'none' ? 1 : 0

  return clamp01(Math.max(fill, border, shadow))
}

/** True when any per-side border has a paint style that isn't `none`/`hidden`. */
function borderHasVisibleSide(cs: CssReader): boolean {
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const style = cs.getPropertyValue(`border-${side}-style`)
    if (style !== '' && style !== 'none' && style !== 'hidden') return true
  }
  return false
}

/** The widest of the four border sides (px) — a thick side on one edge still reads. */
function maxBorderWidth(cs: CssReader): number {
  const shorthand = pad(cs.getPropertyValue('border-width'))
  let max = shorthand
  for (const side of ['top', 'right', 'bottom', 'left']) {
    max = Math.max(max, pad(cs.getPropertyValue(`border-${side}-width`)))
  }
  return max
}

// ---------------------------------------------------------------------------
// The spacing axis. The layout RHYTHM a node contributes: the room it reserves
// around and within itself. A node that pads itself out, sets gaps between its
// children, holds margins, or declares an explicit alignment is structurally
// load-bearing — it shapes how the skeleton reads even when it paints nothing.
// Scored from the SUM of every spacing length it declares, ramped to saturation,
// plus a small flat bump for declaring an explicit flex/grid alignment (which
// reserves no length but still imposes rhythm).
// ---------------------------------------------------------------------------

function spacingAxis(cs: CssReader): number {
  let total = 0
  // Padding and margin, all four sides. Negative margins (pull-ins) still count
  // as rhythm, so take the absolute value.
  for (const box of ['padding', 'margin']) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      total += Math.abs(pad(cs.getPropertyValue(`${box}-${side}`)))
    }
  }
  // Flex/grid gaps — `gap` shorthand resolves to the two longhands in computed
  // style; read both so a one-axis `row-gap` still counts.
  total += Math.abs(pad(cs.getPropertyValue('row-gap')))
  total += Math.abs(pad(cs.getPropertyValue('column-gap')))
  // Border width is rhythm too (it offsets content), counted once at its max side.
  total += maxBorderWidth(cs)

  let score = ramp(total, 0, SPACING_SATURATION)

  // An explicit alignment imposes rhythm without reserving a length — a flex row
  // that `space-between`s its children, a grid that centres them. Give it a small
  // floor so a zero-length-but-aligned container is not scored as flat-nothing.
  // `normal`/`stretch`/'' are the inert defaults and add nothing.
  if (hasExplicitAlignment(cs)) score = Math.max(score, 0.2)

  return clamp01(score)
}

/** True when justify/align-content/items declares a non-default distribution. */
function hasExplicitAlignment(cs: CssReader): boolean {
  const inert = new Set(['', 'normal', 'stretch', 'start', 'flex-start', 'baseline', 'auto'])
  for (const prop of ['justify-content', 'align-content', 'justify-items', 'align-items']) {
    if (!inert.has(cs.getPropertyValue(prop).trim())) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// The size axis. A node's rendered AREA as a fraction of the reference area (the
// capture root, or the viewport) — directly the "how much screen does this take"
// signal. Normalized so a node covering the whole reference scores 1 and a tiny
// icon scores near 0. A `sqrt` shapes the ramp so mid-size content (a card, a
// media block) is not crushed toward 0 by a few huge full-bleed sections — linear
// area would make everything below a hero look negligibly small.
// ---------------------------------------------------------------------------

function sizeAxis(rect: SalienceRect, ctx: SalienceContext): number {
  if (ctx.rootAreaPx <= 0) return 0
  const area = Math.max(0, rect.width) * Math.max(0, rect.height)
  const fraction = clamp01(area / ctx.rootAreaPx)
  // sqrt: a node that is 25% of the root area scores 0.5, not 0.25 — perceptual
  // area reads closer to linear-dimension than to literal-area.
  return clamp01(Math.sqrt(fraction))
}

// ---------------------------------------------------------------------------
// The type-scale axis. Font-size and font-weight RELATIVE to the context base
// font-size — a heading scores high, body low. This is the one axis that is
// inherently relative: 24px is a heading on a 16px page and body on a 24px page,
// so it is always measured as a RATIO over `ctx.baseFontSizePx`. Weight folds in
// as a multiplier so a bold run at body size still out-scores a regular run at the
// same size (bold body copy reads as emphasis). Saturates at ~2.5× base (a hero).
// ---------------------------------------------------------------------------

function typeScaleAxis(cs: CssReader, ctx: SalienceContext): number {
  const base = ctx.baseFontSizePx > 0 ? ctx.baseFontSizePx : DEFAULT_FONT_SIZE
  const sizePx = pad(cs.getPropertyValue('font-size'))
  if (sizePx <= 0) return 0
  const sizeRatio = sizePx / base

  // Weight contributes a bump from 1.0 (at `normal`/400 or below) up to ~1.3 (at
  // `bold`/700+). `bolder`/`lighter`/'' compute to a number in a real browser; a
  // non-numeric value falls back to normal. The bump is bounded so weight nudges
  // the ranking but never dominates the size ratio.
  const weightRaw = Number.parseFloat(cs.getPropertyValue('font-weight'))
  const weight = Number.isFinite(weightRaw) ? weightRaw : NORMAL_WEIGHT
  const weightBump = 1 + 0.3 * clamp01((weight - NORMAL_WEIGHT) / (BOLD_WEIGHT - NORMAL_WEIGHT))

  return ramp(sizeRatio * weightBump, 1, TYPE_SCALE_SATURATION)
}

// ---------------------------------------------------------------------------
// The scorer. Pure: same inputs → same struct, no DOM walk, no measurement, no
// I/O. Each axis is computed independently and clamped to 0..1; `score` is the
// `WEIGHTS` blend. Consumers read the axis they need; the scalar is a default.
// ---------------------------------------------------------------------------

/**
 * Score a node's visual relevance from the four measurable-visual signals (ADR 0019 §4). Returns
 * the per-axis vector plus a convenience blended scalar, each in 0..1.
 *
 * @param cs The node's computed style (any `getPropertyValue` reader)
 * @param rect The node's rendered box (a `getBoundingClientRect`-shaped value)
 * @param ctx The measured context: nearest painted ancestor background, base font-size, and
 *   reference (root/viewport) area
 */
export function salience(cs: CssReader, rect: SalienceRect, ctx: SalienceContext): Salience {
  const contrast = contrastAxis(cs, ctx)
  const spacing = spacingAxis(cs)
  const size = sizeAxis(rect, ctx)
  const typeScale = typeScaleAxis(cs, ctx)
  const score = clamp01(
    contrast * WEIGHTS.contrast +
      size * WEIGHTS.size +
      typeScale * WEIGHTS.typeScale +
      spacing * WEIGHTS.spacing,
  )
  return { contrast, spacing, size, typeScale, score }
}
