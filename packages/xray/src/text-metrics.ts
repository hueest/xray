// =============================================================================
// DOM TEXT MEASUREMENT — the part of the Measure walk that measures rendered text
// (ADR 0019 §2, ADR 0022 invariant 5). `textBar` builds a run's synthetic text bar;
// the line-count cluster computes the `@container` reflow rep via pretext (the
// capture-side text oracle). DOM-touching, so it lives in the Measure layer — split
// out of serialize.ts but threaded the same `WalkState`. Dependency direction:
// serialize.ts → text-metrics.ts → {ir, plate, style-cache, @chenglou/pretext}.
// =============================================================================

import { SPEC_LEAF } from './plate.ts'
import { EMPTY_STYLE, type IRNode } from './ir.ts'
import { isInlineish, pad, px, pxValue, type StyleCache, type WalkState } from './style-cache.ts'
import {
  measureLineStats,
  prepareWithSegments,
  layout,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'

// `@chenglou/pretext` is the CAPTURE-SIDE text oracle (ADR 0019 §2): a build/dev
// dependency imported ONLY here in `text-metrics.ts`, the capture path. It computes
// a wrapping run's line-count step function offline so a text bone can reflow by
// CSS `@container` alone, with zero render JS. It NEVER ships in a Plate and is
// kept out of the production react adapter, which imports the capture core for TYPES
// only (verified at build: `react.js` carries no pretext symbols). Using it at
// render time is banned by the ADR; it appears nowhere but the capture walk.

/** A run of adjacent text nodes becomes one synthetic inline bar sized to its rendered box. */
export function textBar(
  run: readonly Text[],
  foldedMedia: readonly Element[],
  state: WalkState,
  depth: number,
): IRNode | null {
  const first = run[0]
  const last = run[run.length - 1]
  const doc = first?.ownerDocument
  if (!first || !last || !doc) return null
  if (run.every((node) => (node.textContent ?? '').trim() === '')) return null
  const range = doc.createRange()
  range.setStartBefore(first)
  range.setEndAfter(last)
  const rect = range.getBoundingClientRect()
  // A folded glyph-media's box widens the bar so a single bar spans the icon AND
  // the text (the `★ 4.9` case); the text Range alone would miss the icon.
  let rectW = rect.width
  let rectH = rect.height
  if (foldedMedia.length > 0) {
    let left = rect.left
    let top = rect.top
    let right = rect.right
    let bottom = rect.bottom
    for (const m of foldedMedia) {
      const mr = m.getBoundingClientRect()
      left = Math.min(left, mr.left)
      top = Math.min(top, mr.top)
      right = Math.max(right, mr.right)
      bottom = Math.max(bottom, mr.bottom)
    }
    rectW = right - left
    rectH = bottom - top
  }
  // Ancestor clipping/line-height lookups go through the per-capture memo:
  // a ClippingWindow adapter lets the exported clampToClipping keep
  // its narrow public signature while still reading memoized ancestor styles.
  const clipWin: ClippingWindow = { getComputedStyle: (el) => state.styles.get(el) }
  const { width, height } = clampToClipping(rectW, rectH, first.parentElement, clipWin)
  // PREFER the @container line-count rep for a genuinely multi-line wrapping run
  // (ADR 0019 §2): a leaf-scoped query container around a full-width text bone
  // whose height steps by CSS at the exact widths the real text rewraps, with no
  // frozen height and zero render JS. `textLineCountRep` returns the wrapper node
  // (and emits the bone entry + band rules) when every precondition holds, or
  // null to fall through to the measured pill bar below — the EXISTING behavior,
  // byte-identical, which is also what every no-canvas environment (happy-dom in
  // tests) takes. The rep is the exception that earns its keep on real prose;
  // everything it can't safely model degrades here, not in the rep.
  const rep = textLineCountRep(run, range, height, first.parentElement, state, depth)
  if (rep) return rep
  // PROVISIONAL kind: a text bar is a `text` leaf. The text-LINE-vs-text-BLOCK
  // decision (a run taller than ~1.5 line-heights reads as a multi-line BLOCK, a
  // single line as a LINE — ADR 0021 §4) has MOVED to the `markInk` pass (ADR 0022
  // invariant 5): this bar carries its `ink` (the clamped run box + the parent's
  // resolved line-height) and `markInk` reads that snapshot to finalize the kind.
  // A `text` here is that provisional seed: Absorb's `isLabelContent` (distil.ts)
  // only needs a leaf, not its text/block flavor — `markInk` settles the flavor.
  const parentLineHeight = first.parentElement
    ? (pxValue(state.styles.get(first.parentElement).lineHeight) ?? 0)
    : 0
  // A synthetic text bar comes from text nodes, not an element, so it is entry-less:
  // `el: null` and the shared frozen EMPTY_STYLE (its `ink`, not its style, is what
  // `markInk` reads). Built directly as an `IRNode` and pushed to `state.nodes`.
  const node: IRNode = {
    id: state.nextId++,
    el: null,
    kind: 'text-line',
    kids: [],
    depth,
    decls: { fallback: ['display: inline-block', 'vertical-align: middle'] },
    style: EMPTY_STYLE,
    // The text ink `markInk` reads to pick line vs block: one rect = the run's
    // CLAMPED box (the same `height` `isMultiLineRun` judged), plus the parent's
    // resolved line-height. `lineCount`/`maxLineWidth` round it out for diagnostics.
    ink: {
      lineRects: [{ x: rect.x, y: rect.y, width, height }],
      lineCount: parentLineHeight > 0 ? Math.max(1, Math.round(height / parentLineHeight)) : 1,
      maxLineWidth: width,
      lineHeight: parentLineHeight,
    },
    box: { x: rect.x, y: rect.y, width: rectW, height: rectH },
  }
  if (width > 0 && height > 0) {
    node.decls.size = [
      `width: ${px(width)}`,
      `height: ${px(snapToLines(height, first.parentElement, state.styles))}`,
    ]
  }
  state.nodes.push(node)
  return node
}

// ---------------------------------------------------------------------------
// The @container line-count text rep (ADR 0019 §2). A multi-line wrapping run
// replaces its frozen
// text rect with a width-faithful PROFILE the browser re-wraps: pretext computes
// the line-count step function at capture (the widths where the run gains/loses a
// line), emitted as a leaf-scoped, name-qualified `@container` wrapper carrying
// `container-type: inline-size` around a full-width text bone whose height is a
// stack of `@container <name> (min-width: …) { height: calc(N × lh) }` bands. The
// bone fills the container width and reflows by CSS alone — measured pixel-exact
// against the browser's real wrapping for ordinary prose.
// ---------------------------------------------------------------------------

/**
 * CSS generic font-family keywords — none names a concrete face, so pretext's canvas `measureText`
 * can't agree with what the browser actually resolved (pretext's own README flags `system-ui` as
 * unsafe on macOS). A run whose first family token is one of these has no capture-matched named
 * font, so the rep falls back. The list is the CSS generic set plus the `ui-*` system aliases.
 */
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
])

/**
 * The first font-family token, unquoted and lowercased, or null when the list is empty.
 * `getComputedStyle().fontFamily` serializes the resolved list (the first entry is the face the
 * browser used for this run), comma-separated with quoted multi-word names — `"Helvetica Neue",
 * Arial, sans-serif` → `helvetica neue`.
 */
function firstFontFamily(fontFamily: string): string | null {
  const first = splitTopLevelComma(fontFamily)[0]
  if (first === undefined) return null
  const trimmed = first.trim().replace(/^['"]|['"]$/g, '')
  return trimmed === '' ? null : trimmed.toLowerCase()
}

/** Split on top-level commas only (a quoted family name may itself contain a comma). */
function splitTopLevelComma(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = ''
      cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * Build the canvas `font` shorthand pretext wants — `<style> <weight> <size>px <family-list>` —
 * from the run's resolved computed style, mirroring CSS exactly (the families pass through
 * verbatim, quotes and all, so the canvas resolves the SAME face). Returns null when the size is
 * not a usable px length. Order follows the canvas/CSS `font` shorthand: style, then weight, then
 * size, then family.
 */
function canvasFontShorthand(cs: CSSStyleDeclaration): string | null {
  const sizePx = pxValue(cs.fontSize)
  if (sizePx === null || sizePx <= 0) return null
  const parts: string[] = []
  if (cs.fontStyle && cs.fontStyle !== 'normal') parts.push(cs.fontStyle)
  if (cs.fontWeight && cs.fontWeight !== 'normal' && cs.fontWeight !== '400')
    parts.push(cs.fontWeight)
  parts.push(`${sizePx}px`)
  parts.push(cs.fontFamily)
  return parts.join(' ')
}

/**
 * Does this environment have real canvas text metrics (the feature gate for the whole rep)? pretext
 * relies on Canvas 2D `measureText` AND `Intl.Segmenter` (its documented runtime requirement); a
 * layout-less env (happy-dom in tests, older runtimes) has neither, so `prepare()`/`layout()`
 * cannot compute there. Probe once per capture: a 2d context whose `measureText` returns a positive
 * width for a known glyph, plus a present `Intl.Segmenter`. When this is false the rep is skipped
 * entirely and the run takes the pill-bar fallback.
 */
function hasUsableTextMetrics(win: Window): boolean {
  // `Intl.Segmenter` is pretext's documented hard requirement. It is a realm
  // global; `'Segmenter' in Intl` probes it without asserting a narrowed shape.
  if (!('Intl' in win) || !('Segmenter' in Intl)) return false
  try {
    const ctx = win.document.createElement('canvas').getContext('2d')
    if (!ctx || typeof ctx.measureText !== 'function') return false
    const w = ctx.measureText('xray').width
    return typeof w === 'number' && Number.isFinite(w) && w > 0
  } catch {
    return false
  }
}

/**
 * The nearest block-level ancestor that establishes the run's wrapping width, starting from the
 * text's parent. Inline wrappers (`<b>`, `<span>`) don't bound wrapping; the first non-inline
 * ancestor's content box is the available width the injected `container-type: inline-size` wrapper
 * will assume (it fills its slot). Returns the parent itself when it is already block-level.
 */
function wrappingBlock(parent: Element | null, styles: StyleCache): Element | null {
  for (let host = parent; host; host = host.parentElement) {
    if (!isInlineish(styles.get(host).display)) return host
  }
  return parent
}

/** The content-box inner width of an element — border-box minus padding and border. */
function innerContentWidth(el: Element, styles: StyleCache): number {
  const cs = styles.get(el)
  return (
    el.getBoundingClientRect().width -
    pad(cs.paddingLeft) -
    pad(cs.paddingRight) -
    pad(cs.borderLeftWidth) -
    pad(cs.borderRightWidth)
  )
}

/**
 * Count the run's rendered lines from its `Range` rects: `getClientRects()` yields one rect per
 * line fragment, so distinct `top` values (collapsed within 1px) are the line count. The
 * capture-time AGREEMENT check: if pretext's predicted line count at the capture width disagrees
 * with what the browser actually rendered, the rep would be wrong for this run, so it falls back.
 */
function renderedLineCount(range: Range): number {
  const rects = Array.from(range.getClientRects())
  const tops: number[] = []
  for (const r of rects) {
    if (r.width === 0 && r.height === 0) continue
    if (!tops.some((t) => Math.abs(t - r.top) < 1)) tops.push(r.top)
  }
  return Math.max(1, tops.length)
}

/**
 * The active `-webkit-line-clamp` line cap governing the run, or null. The clamp idiom (`display:
 * -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: N; overflow: hidden`) clips text
 * to N lines, so a clamped run NEVER shows more than N no matter how narrow the container gets.
 * pretext measures the UNCLAMPED wrap, and a `Range`'s rects ignore the clip too
 * (`renderedLineCount`), so the agreement check passes on the full count while the run actually
 * renders at most N — without this the rep would emit bands TALLER than the clamp ever shows.
 * Capping the band sweep at N makes a clamped block exact and bounds its stack to ≤N. Walks
 * ancestors (the clamp may sit a few wrappers above the text node) and returns the nearest ACTIVE
 * clamp — a positive integer `-webkit-line-clamp` on a vertical `-webkit-box-orient` (the idiom). A
 * clamp value without the vertical orientation has no effect and is ignored, matching the browser.
 *
 * Detection keys on the line-clamp + box-orient PAIR, deliberately NOT on computed `display`:
 * Chrome normalizes an active `display: -webkit-box` clamp to `display: flow-root` in computed
 * style (verified), so a `display === -webkit-box` guard silently never matched in Chrome — the bug
 * this comment guards against. `-webkit-box-orient` and `-webkit-line-clamp` ARE exposed in
 * computed style, so the pair is the reliable cross-engine signal.
 */
function activeLineClamp(parent: Element | null, styles: StyleCache): number | null {
  for (let el = parent; el; el = el.parentElement) {
    const cs = styles.get(el)
    const clamp = Number.parseInt(cs.getPropertyValue('-webkit-line-clamp'), 10)
    if (!Number.isFinite(clamp) || clamp <= 0) continue
    const orient = cs.getPropertyValue('-webkit-box-orient')
    if (orient === 'vertical' || orient === 'block-axis') return clamp
  }
  return null
}

/** A px-rounded `min-width` band: at widths ≥ `minWidth`, the run is `lines` tall. */
interface LineBand {
  minWidth: number
  lines: number
}

/**
 * The line-count step function across the width range, swept at 1px so each band threshold lands on
 * the exact width the run changes line count (measured to coincide with the browser's real wrap
 * points to the pixel). Walks widths ascending and records every transition; the first entry is the
 * baseline (most lines, narrowest), each later entry a `min-width` step. `maxWidth` caps the sweep
 * at the largest realistic container width (the run may fit on one line before reaching it).
 * `lines` is clamped to `maxLines` (the caller passes `MAX_REP_LINES`, or a smaller
 * `-webkit-line-clamp` cap), so the band stack is bounded no matter how many lines the run wraps to
 * at the narrow end.
 */
/**
 * Cap on the line-count bands per run. A run that wraps to more lines than this at the narrow end
 * clamps here (a tall block reads as "tall" — a line or two off at an extreme-narrow width is
 * imperceptible on swap), so the band stack can never explode — an unbounded sweep produced 40–70
 * bands per run on real content. Kept above realistic mobile paragraph line counts so it does not
 * clip genuine content. Tunable.
 */
const MAX_REP_LINES = 16

function lineCountStepFunction(
  prepared: PreparedTextWithSegments,
  lh: number,
  minWidth: number,
  maxWidth: number,
  maxLines: number,
): LineBand[] {
  const bands: LineBand[] = []
  let prev = -1
  for (let w = minWidth; w <= maxWidth; w++) {
    const lines = Math.min(maxLines, Math.max(1, layout(prepared, w, lh).lineCount))
    if (lines !== prev) {
      bands.push({ minWidth: w, lines })
      prev = lines
    }
    // Once the run no longer wraps (one line), no wider band exists — the run is
    // a single line at every greater width — so stop. The last band emitted is
    // the `min-width` at which it first fits on one line.
    if (lines === 1) break
  }
  return bands
}

/**
 * The minimum container width to sweep from. The bone never renders narrower than one line-height
 * tall, and sweeping below a few px is wasted work; a small floor keeps the sweep bounded for a
 * pathologically long run. Real containers are far wider, so this only caps the bottom of the band
 * stack.
 */
const REP_MIN_WIDTH = 16

/**
 * Cap on the sweep's upper width: the largest realistic container width. The rep runs during the
 * walk, before per-plate breakpoints are derived, so it cannot read the actual biggest breakpoint —
 * this fixed bound stands in for it. Beyond it (a text run spanning a full ultra-wide viewport), a
 * height mismatch on swap is imperceptible against that much space, so sweeping out to the run's
 * single-line width would only emit wasted bands. Tunable; ≈ the largest common breakpoint.
 */
const REP_MAX_WIDTH = 1920

/**
 * Attempt the `@container` line-count rep for a wrapping text run (ADR 0019 §2). Returns the
 * leaf-scoped wrapper `IRNode` (a branch with one full-width text bone child, both pushed to
 * `state.nodes`) and emits its reflow band rules onto `state`, OR returns null to signal the caller
 * to keep the existing measured pill bar. Null is returned for everything the rep can't safely
 * cover, so a fallback is always graceful and never a regression:
 *
 * - No usable canvas text metrics (every test env; older runtimes) — feature gate;
 * - No resolved parent / no named capture-matched font / no px line-height;
 * - A single-line or short run (stays the thin pill bar — a fat block misreads);
 * - An out-of-model wrap mode pretext doesn't model: `text-align: justify`, `hyphens: auto`,
 *   `word-break: break-all`, `white-space` ≠ normal/pre-wrap;
 * - An unbreakable token wider than the container (the browser overflows it on one line, pretext
 *   wraps it — they diverge);
 * - Pretext's predicted line count disagreeing with the browser's actual wrap at the capture width (a
 *   self-check that also catches font substitution).
 *
 * On success the wrapper carries `container-type: inline-size` + a plate-local unique
 * `container-name`, and the bone gets `@container <name> (min-width: …) { height: calc(N × lh) }`
 * bands — reflowing by CSS alone, no frozen height, no render JS. v1 ALWAYS injects a fresh named
 * container; reusing an immediate author container (ADR 0019 §2) is a deferred optimization.
 */
function textLineCountRep(
  run: readonly Text[],
  range: Range,
  height: number,
  parent: Element | null,
  state: WalkState,
  depth: number,
): IRNode | null {
  if (!parent) return null
  // Feature gate: probe usable canvas metrics once per capture and memoize on the
  // state. A no-canvas env (happy-dom) fails this and takes the pill-bar fallback,
  // keeping that path byte-identical to before — the constraint the tests rely on.
  if (state.canvasMetrics === undefined) state.canvasMetrics = hasUsableTextMetrics(state.win)
  if (!state.canvasMetrics) return null

  const block = wrappingBlock(parent, state.styles)
  if (!block) return null
  const cs = state.styles.get(block)

  // Require a numeric/px line-height: the rep's `lines × lh` identity is exact
  // only when CSS line-height is a fixed length, NOT `normal` or a bare ratio.
  // Read it from the text's own parent (the
  // element whose line box the run sits in), falling back to the block.
  const lh = pxValue(state.styles.get(parent).lineHeight) ?? pxValue(cs.lineHeight)
  if (lh === null || lh <= 0) return null

  // Require a named, capture-matched font — a generic family (`system-ui`,
  // `sans-serif`, …) gives pretext no concrete face to measure against (ADR
  // 0019 §2). Font metrics come from the text's parent.
  const fontCs = state.styles.get(parent)
  const family = firstFontFamily(fontCs.fontFamily)
  if (family === null || GENERIC_FONT_FAMILIES.has(family)) return null
  const font = canvasFontShorthand(fontCs)
  if (font === null) return null

  // Out-of-model wrap modes pretext does not reproduce — fall back rather than
  // emit a profile that would step at the wrong widths.
  // These guards reject only the KNOWN-bad values; an unset/empty computed value
  // (the CSS default `start`/`normal`/`auto`) passes through to the in-model path.
  if (cs.textAlign === 'justify') return null
  if (cs.hyphens === 'auto') return null
  if (cs.wordBreak === 'break-all') return null
  // pretext models `white-space: normal` and `pre-wrap` only. The default
  // (`normal`) serializes as `'normal'` in browsers but as `''` in a layout-less
  // engine, so treat empty as the default; any OTHER explicit value falls back.
  const ws = cs.whiteSpace === '' ? 'normal' : cs.whiteSpace
  if (ws !== 'normal' && ws !== 'pre-wrap') return null

  // The wrapping width the run laid out at: the block's content-box inner width.
  // The injected `container-type: inline-size` wrapper fills this slot, so this
  // is the width pretext must agree with at capture.
  const containerWidth = innerContentWidth(block, state.styles)
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null

  // Only a genuinely multi-line run earns the rep; a single line stays the thin
  // pill bar (a full-height block misreads a one-line label). Use the measured
  // rect: a run ≥ 1.5 line-heights tall is multi-line, matching `snapToLines`.
  if (height < lh * 1.5) return null

  const text = run.map((node) => node.textContent ?? '').join('')
  if (text.trim() === '') return null

  // pretext, the capture-side oracle. `prepareWithSegments` gives the richer
  // handle `measureNaturalWidth` needs; `wordBreak: 'keep-all'` is forwarded when
  // the author set it (pretext models it), else 'normal'. `letterSpacing` is
  // synced from CSS so canvas measurement matches (an unsynced value is a
  // documented pretext inaccuracy; an unparseable value defaults to 0).
  const letterSpacing = pxValue(fontCs.letterSpacing) ?? 0
  const wordBreak = fontCs.wordBreak === 'keep-all' ? 'keep-all' : 'normal'
  let prepared: PreparedTextWithSegments
  try {
    prepared = prepareWithSegments(text, font, {
      whiteSpace: ws === 'pre-wrap' ? 'pre-wrap' : 'normal',
      wordBreak,
      letterSpacing,
    })
  } catch {
    // pretext threw (a runtime missing a dependency the probe didn't catch) —
    // degrade to the pill bar rather than abort the capture.
    return null
  }

  // The unbreakable-token gate: only when a single UNBREAKABLE token is wider than the
  // container does the browser overflow it on one physical line while pretext
  // wraps it — there the rep would be wrong. That token width is the run's
  // MIN-content (the widest line under the narrowest possible wrap, maxWidth 1,
  // where every break is forced), NOT `measureNaturalWidth` (max-content — the
  // whole run on one line, which EVERY wrapping run exceeds by definition;
  // using it here rejected all legitimately multi-line text).
  const longestToken = measureLineStats(prepared, 1).maxLineWidth
  if (longestToken > containerWidth + 0.5) return null

  // Capture-time AGREEMENT check: pretext's predicted line count at the capture
  // width must equal what the browser actually rendered. This is the rep's own
  // honesty guard — it catches any residual disagreement (font substitution, an
  // edge pretext mismodels) and falls back rather than ship a wrong profile.
  const predictedAtCapture = Math.max(1, layout(prepared, containerWidth, lh).lineCount)
  if (predictedAtCapture !== renderedLineCount(range)) return null

  // Sweep the line-count step function across the full reflow range. The sweep
  // walks 1px from REP_MIN_WIDTH and STOPS the instant the run fits on one line
  // (no wider band exists past that), so the band stack covers the run reflowing
  // from its narrowest down to a single line — at ANY render container width, not
  // just widths ≤ capture. REP_MAX_WIDTH is only a worst-case bound; a normal run
  // reaches one line long before it. A `-webkit-line-clamp: N` ancestor caps the
  // per-band line count at N (the run is clipped there, so it never renders
  // taller) — exact for clamped text and a tighter bound than MAX_REP_LINES.
  const clamp = activeLineClamp(parent, state.styles)
  const maxLines = clamp === null ? MAX_REP_LINES : Math.min(MAX_REP_LINES, clamp)
  const bands = lineCountStepFunction(prepared, lh, REP_MIN_WIDTH, REP_MAX_WIDTH, maxLines)
  // A degenerate sweep (one band, i.e. never multi-line across the range) means
  // the rep adds nothing over the pill bar — fall back. The capture-width check
  // above already proved ≥2 lines, so this is belt-and-suspenders.
  if (bands.length < 2) return null

  // Emit the wrapper + bone as a branch node. The wrapper sits in the text leaf's
  // position and carries its inline layout role (a text run is inline flow), so
  // it does not disturb the parent's line box / flex-or-grid item count.
  const wrapperId = state.nextId++
  const boneId = state.nextId++
  // Plate-local-unique container-name from the wrapper's capture id. Per ADR 0019
  // §2 the container is leaf-scoped: the query on the bone resolves UPWARD to its
  // nearest named ancestor, which is always this wrapper (the bone's direct
  // parent), so even if a merged sibling view reused the same id-derived name in
  // its own gated subtree, the two never cross-bind (consistent with ADR 0007's
  // plate-prefix isolation, one layer down). The `xr-t` prefix keeps it from
  // colliding with any author container name.
  const containerName = `xr-t${wrapperId}`

  // The bone fills the container; its height is set ENTIRELY by the bands. No
  // frozen width or height — the rep replaces the pill bar's measured rect. Built
  // directly as the wrapper's single child IRNode (entry-less: `el: null`,
  // EMPTY_STYLE). Pushed to `state.nodes` AFTER the wrapper, preserving push order.
  const boneNode: IRNode = {
    id: boneId,
    el: null,
    kind: 'text-block',
    kids: [],
    depth: depth + 1,
    decls: { fallback: ['display: block', 'width: 100%'] },
    style: EMPTY_STYLE,
  }

  // The wrapper sits in the text leaf's position (a `container` IRNode holding the
  // bone). `display: inline-block` keeps it in the run's inline position
  // (vertical-align middle, like the pill bar) while giving it a block box that
  // sizes to its content width and can be a query container. `container-type:
  // inline-size` makes it the bone's sizing context; the name qualifies the
  // bands so they can never be hijacked by an author `@container` chain.
  const wrapperNode: IRNode = {
    id: wrapperId,
    el: null,
    kind: 'container',
    kids: [boneNode],
    depth,
    decls: {
      fallback: [
        'display: inline-block',
        'vertical-align: middle',
        'container-type: inline-size',
        `container-name: ${containerName}`,
        // A DEFINITE captured width, NOT `width: 100%`. The bone the wrapper holds
        // is empty — it has zero intrinsic width — so under any shrink-to-fit
        // ancestor (a flex column with `align-items` ≠ stretch, a float, a
        // table-cell) a `width: 100%` chain collapses to 0: the container's
        // inline-size becomes 0, NO `@container (min-width: …)` band matches, the
        // bone falls back to the baseline (the most-lines clamp) and renders
        // zero-wide — an invisible block reserving a huge frozen height. Freezing
        // to the wrapping width the run actually laid out at reproduces the slot the
        // real text occupied (text has the intrinsic width the bone lacks);
        // `max-width: 100%` still lets the wrapper — and so the bands — reflow
        // TALLER when the real render slot is narrower than capture.
        `width: ${px(containerWidth)}`,
        'max-width: 100%',
      ],
    },
    style: EMPTY_STYLE,
  }
  state.nodes.push(wrapperNode)
  state.nodes.push(boneNode)

  // The reflow bands as self-standing PlateRules (appended via state.extraRules).
  // All share SPEC_LEAF (this IS the leaf's measured height, just responsive, so
  // it outranks copied author width/height exactly as a frozen leaf size does)
  // and ascending `order` by min-width, so at any width the widest matching
  // `min-width` band wins by source order — the correct min-width cascade. The
  // baseline (narrowest, most lines) carries no container condition; each step
  // is gated `@container <name> (min-width: …)`. View-merge `display:none` gates
  // (SPEC_GATE) still beat these, as they must.
  let order = 0
  const baseline = bands[0]
  if (!baseline) return null
  state.extraRules.push({
    ids: [boneId],
    decls: [`height: calc(${baseline.lines} * ${px(lh)})`],
    spec: SPEC_LEAF,
    order: order++,
  })
  for (let i = 1; i < bands.length; i++) {
    const band = bands[i]
    if (!band) continue
    state.extraRules.push({
      ids: [boneId],
      decls: [`height: calc(${band.lines} * ${px(lh)})`],
      container: [`${containerName} (min-width: ${px(band.minWidth)})`],
      spec: SPEC_LEAF,
      order: order++,
    })
  }

  return wrapperNode
}

/**
 * A `Range` rect is the tight union of the glyph line boxes, so a wrapped run measures lines ×
 * glyph-height — short of the lines × line-height the source actually occupied (a 2-line paragraph
 * rendered ~3px short per line). When the parent's line-height resolves to px and the run is
 * clearly multi-line, round to a whole number of line boxes so the bone reserves the real block
 * height. A single line is left untouched — its line box comes from the parent's pinned
 * line-height, and the thin glyph bar reads as text rather than a fat block.
 */
function snapToLines(height: number, parent: Element | null, styles: StyleCache): number {
  if (!parent) return height
  const lh = pxValue(styles.get(parent).lineHeight)
  if (lh === null || lh <= 0) return height
  // A single line must never exceed its line box. A tight line-height (e.g. a
  // heading at line-height < 1) leaves the glyph box taller than the line box;
  // the bone is an inline-block, so a too-tall bar GROWS the line box and drifts
  // every following row down a px or two — it accumulates noticeably down a
  // column. Cap at the line-height so the bone's slot matches the real line box.
  if (height < lh * 1.5) return Math.min(height, lh)
  return Math.round(height / lh) * lh
}

/**
 * Shrink a text run's measured box to what's actually painted. A `Range`'s rect is the text's full
 * geometry and ignores ancestor clipping, so a `-webkit-line-clamp` box (fewer lines than the text
 * fills) or a single-line `text-overflow: ellipsis` (`white-space: nowrap; overflow: hidden`) makes
 * the bar over-measure — a 2-line title bone rendered at its unclamped 5-line height. Painted text
 * can't exceed any clipping ancestor's content box, so it intersects with each: per axis the
 * ancestor clips (`overflow !== visible`), clamp to its content box. A non-clipping or larger
 * ancestor leaves it be, so unclamped text is untouched. Walks to the root since the clamp may sit
 * a few inline wrappers up from the text node.
 */
interface ClippingStyle {
  overflowX: string
  overflowY: string
  paddingTop: string
  paddingBottom: string
  paddingLeft: string
  paddingRight: string
  borderTopWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  borderRightWidth: string
}

interface ClippingWindow {
  getComputedStyle(element: Element): ClippingStyle
}

export function clampToClipping(
  width: number,
  height: number,
  fromParent: Element | null,
  win: ClippingWindow,
): { width: number; height: number } {
  for (let host = fromParent; host; host = host.parentElement) {
    const cs = win.getComputedStyle(host)
    const clipsX = cs.overflowX !== 'visible'
    const clipsY = cs.overflowY !== 'visible'
    if (!clipsX && !clipsY) continue
    const hrect = host.getBoundingClientRect()
    if (clipsY) {
      const inner =
        hrect.height -
        pad(cs.paddingTop) -
        pad(cs.paddingBottom) -
        pad(cs.borderTopWidth) -
        pad(cs.borderBottomWidth)
      if (inner > 0) height = Math.min(height, inner)
    }
    if (clipsX) {
      const inner =
        hrect.width -
        pad(cs.paddingLeft) -
        pad(cs.paddingRight) -
        pad(cs.borderLeftWidth) -
        pad(cs.borderRightWidth)
      if (inner > 0) width = Math.min(width, inner)
    }
  }
  return { width, height }
}
