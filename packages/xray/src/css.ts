/**
 * Pure CSS plumbing shared by both extraction strategies: which properties are layout (vs paint),
 * approximate selector specificity for cascade-preserving ordering, and rendering scoped rules back
 * to a single plate CSS string.
 */

const EXACT_PROPS = new Set([
  'display',
  'position',
  'float',
  'clear',
  'box-sizing',
  'top',
  'right',
  'bottom',
  'left',
  'width',
  'height',
  'block-size',
  'inline-size',
  'aspect-ratio',
  'order',
  'flex',
  'gap',
  'row-gap',
  'column-gap',
  'line-height',
  'font',
  'font-size',
  'font-family',
  'font-weight',
  'font-style',
  'white-space',
  'text-align',
  'text-indent',
  'vertical-align',
  'letter-spacing',
  'word-spacing',
  'word-break',
  'overflow-wrap',
  'text-wrap',
  'transform',
  'transform-origin',
  'translate',
  'scale',
  'rotate',
  'table-layout',
  'border-collapse',
  'border-spacing',
  'caption-side',
  'column-count',
  'column-width',
  'columns',
  'column-span',
  'column-fill',
  'writing-mode',
  'direction',
  'contain',
  'content-visibility',
  'container',
  'container-type',
  'container-name',
  'visibility',
])

const PATTERN_PROPS = [
  /^(margin|padding)(-(top|right|bottom|left|block|inline))?(-(start|end))?$/,
  /^inset(-(block|inline))?(-(start|end))?$/,
  /^border(-(top|right|bottom|left|block|inline))?(-(start|end))?-(width|style)$/,
  /^border(-(top|bottom)-(left|right))?-radius$/,
  /^border-(start|end)-(start|end)-radius$/,
  /^grid(-|$)/,
  /^flex-/,
  /^(min|max)-(width|height|block-size|inline-size)$/,
  /^(align|justify|place)-(items|content|self)$/,
  /^overflow(-[xy])?$/,
]

/** Layout properties are the only declarations a plate carries; paint stays out (ADR 0003). */
export function isLayoutProp(prop: string): boolean {
  if (prop.startsWith('--')) return false
  if (EXACT_PROPS.has(prop)) return true
  return PATTERN_PROPS.some((re) => re.test(prop))
}

/**
 * The legacy `-webkit-box` display family is the 2009 flexbox, used almost exclusively for the
 * `-webkit-line-clamp` truncation idiom (`display: -webkit-box; -webkit-box-orient: vertical;
 * -webkit-line-clamp: N; overflow: hidden`). Its companions `-webkit-box-orient` /
 * `-webkit-line-clamp` are NOT carried layout props, so copying `display: -webkit-box` alone yields
 * a broken box: with no `-webkit-box-orient` it defaults to a HORIZONTAL old-flexbox that collapses
 * an empty bone child to zero width (invisible), and `overflow: hidden` then reads as a blank
 * placeholder with the next sibling riding up under it. The idiom's only visible effect — clamping
 * text to N lines — is already captured in the text bone's measured (clamped) height, so the
 * container just needs to be a normal block. Map the legacy values to their modern flow
 * equivalents; every other display value passes through untouched.
 */
const LEGACY_DISPLAY: Record<string, string> = {
  '-webkit-box': 'block',
  '-webkit-inline-box': 'inline-block',
}
export function normalizeDisplay(value: string): string {
  return LEGACY_DISPLAY[value.trim()] ?? value
}

/**
 * Substitute every `var(--name[, fallback])` with the custom property's computed value: the FREEZE.
 * A reference the plate defines no token for would compute to nothing at render — silently
 * dropping, say, a `padding: var(--card-padding)` — so it must be resolved to its capture-time
 * value. Resolving the token (not the whole property via `getPropertyValue`) works for shorthands
 * too, which computed style never exposes. Iterates for nested `var(--a, var(--b))`.
 *
 * Freezing is the exception, not the rule (ADR 0019 §1, amending ADR 0005): a token whose
 * definition VARIES across the captured `@media`/`@container` conditions is CARRIED (its
 * definitions emitted on the plate, `measure.ts`), so the engine re-resolves it at render and the
 * bone reflows. Only a CONSTANT token, or one that cannot be anchored (an un-captured wrapper),
 * freezes. The caller decides which tokens carry (it alone has the cross-sheet view of every
 * definition); `freezeUncarriedVars` then runs this freeze over ONLY the leftover, un-carried
 * `var()`s.
 */
interface CssValueReader {
  getPropertyValue: (property: string) => string
}

interface CssDeclarationBlock extends CssValueReader {
  length: number
  item: (index: number) => string
  getPropertyPriority: (property: string) => string
}

function resolveVars(value: string, computed: CssValueReader): string {
  let out = value
  for (let i = 0; i < 10 && out.includes('var('); i++) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g,
      (_, name: string, fallback?: string) =>
        computed.getPropertyValue(name).trim() || fallback?.trim() || '',
    )
    if (next === out) break
    out = next
  }
  return out
}

/**
 * A non-nesting `var(--name[, fallback])` matcher used by the FREEZE: the fallback group `[^()]*`
 * deliberately stops at a nested paren, so a `var(--a, var(--b))` is rewritten head-first
 * (replacing `--a` re-exposes the inner `var(--b)` for the next iteration). The freeze loops to a
 * fixpoint, so one-level-at-a-time is correct and keeps the regex simple.
 */
const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g

/**
 * The HEAD token name of EVERY `var(` in a value — both the top-level heads and any head nested
 * inside a fallback (`var(--a, var(--b))` → `--a`, `--b`). A fallback branch is reached by the
 * engine only when its head is undefined, but a carried chain must stay self-contained whichever
 * branch renders, so every head is a reachability seed. Matching `var(\s*(--name)` globally catches
 * all of them in one pass regardless of nesting depth — simpler and more correct than a
 * fallback-recursing regex (whose `[^()]*` cannot see into a nested `var()`).
 */
const VAR_HEAD = /var\(\s*(--[\w-]+)/g
export function referencedTokens(value: string): string[] {
  const out: string[] = []
  if (!value.includes('var(')) return out
  for (const match of value.matchAll(VAR_HEAD)) {
    const name = match[1]
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Freeze ONLY the `var()` references whose token was NOT carried (ADR 0019 §1). A decl produced in
 * carry mode keeps its raw `var(--x, …)` text; once the caller knows which tokens it actually
 * emitted on the plate (`carried`), this resolves every leftover reference to its capture-time
 * value — the irreducible freeze for a constant token, an un-anchorable wrapper token, or a
 * genuinely unreadable one. A reference to a carried token is left INTACT so the plate's own
 * definition drives it. The result is self-contained by construction: after this runs, every
 * surviving `var()` names a token the plate defines.
 *
 * A leftover token resolves in this order: the caller's `frozen` map (the token's winning author
 * value, read straight from the CSSOM) FIRST, then the matched element's `computed` style, then the
 * var()'s own fallback. The author-value path is authoritative and independent of computed-style
 * inheritance — computed style cannot always resolve a deeply-inherited custom property (and
 * happy-dom never does), so without it a constant token could dangle and break self-containment.
 * The `frozen` map already carries the cascade winner, so it is preferred where present.
 *
 * Operates on whole `prop: value` decl strings (splitting on the FIRST colon, so a `calc()`/`url()`
 * value with colons is untouched) and re-runs `fluidTracks` on a frozen grid track list — a token
 * that froze to px-only tracks falls back to the heuristic, the documented last resort.
 */
export function freezeUncarriedVars(
  decls: readonly string[],
  carried: ReadonlySet<string>,
  computed: CssValueReader,
  frozen?: ReadonlyMap<string, string>,
): string[] {
  return decls.map((decl) => {
    if (!decl.includes('var(')) return decl
    const colon = decl.indexOf(':')
    if (colon === -1) return decl
    const prop = decl.slice(0, colon).trim()
    const value = decl.slice(colon + 1).trim()
    // Resolve only the heads NOT carried; a carried head is left as `var(--x)`
    // so the plate's emitted definition wins. Replace each uncarried head with
    // its frozen author value (preferred) or computed value, leaving carried
    // heads in place, iterating for nested cases.
    let out = value
    for (let i = 0; i < 10 && out.includes('var('); i++) {
      let changed = false
      const next = out.replace(VAR_REF, (whole, name: string, fallback?: string) => {
        if (carried.has(name)) return whole
        changed = true
        const authored = frozen?.get(name)?.trim()
        return authored || computed.getPropertyValue(name).trim() || fallback?.trim() || ''
      })
      out = next
      if (!changed) break
    }
    out = out.trim()
    if (!out) return decl // nothing resolved (shouldn't happen post-filter); keep raw
    if (prop === 'grid-template-columns') out = fluidTracks(out, 'columns')
    else if (prop === 'grid-template-rows') out = fluidTracks(out, 'rows')
    return `${prop}: ${out}`
  })
}

/**
 * A grid track list that is only `px` lengths is a frozen computed value — authors write
 * `fr`/`%`/`minmax`/`auto`, not sub-pixel tracks, so this is almost always a var()-driven `grid`
 * shorthand the engine dropped, leaving us the resolved computed track sizes. Frozen px locks the
 * grid to the capture width (off-centre at any other size); the author value is unrecoverable, so a
 * responsive one is reconstructed. Already-fluid lists (fr/%/minmax/repeat/auto/…) pass through
 * untouched.
 *
 * - Rows follow their content in a skeleton (the bones set the height), so a frozen row list becomes
 *   `auto` tracks.
 * - Columns are almost always a centred layout: a wide content track flanked by gutters. Make the
 *   gutters flexible and equal (`1fr`) so the grid recentres at any width — this also erases the
 *   scrollbar-width asymmetry the capture picked up — and cap the content track(s) at the captured
 *   size (`minmax(0, px)`) so they shrink on narrow viewports but never overgrow. A uniform list
 *   (no track ≥2× the others — e.g. an even `repeat(n, 1fr)`) has no gutters, so every track
 *   becomes `1fr`.
 *
 * A single capture can't tell fixed tracks from flexible ones; the precise fix is to diff track
 * sizes across the capture-all widths (deferred).
 */
const PX_ONLY_TRACKS = /^\s*(?:-?[\d.]+px\s*)+$/
function fluidTracks(value: string, axis: 'columns' | 'rows'): string {
  if (!PX_ONLY_TRACKS.test(value)) return value
  const tracks = value
    .trim()
    .split(/\s+/)
    .map((t) => Number.parseFloat(t))
  if (axis === 'rows') return tracks.map(() => 'auto').join(' ')
  const max = Math.max(...tracks)
  const isContent = tracks.map((t) => t >= max * 0.5)
  if (isContent.every(Boolean)) return tracks.map(() => '1fr').join(' ')
  return tracks.map((t, i) => (isContent[i] ? `minmax(0, ${t}px)` : '1fr')).join(' ')
}

/**
 * Carry-mode side-channel for `filterLayoutDecls` (ADR 0019 §1). When present, a `var()` in a kept
 * layout decl is NO LONGER frozen here: the raw `var(--x, …)` text is kept and every referenced
 * token NAME is recorded into `referenced`, so the caller can decide per token whether to carry its
 * definition (responsive) or freeze it later (`freezeUncarriedVars`). Absent, every `var()` freezes
 * to its capture-time value inline (the ADR 0005 freeze). The two modes share one code path.
 */
export interface CarryContext {
  /** Accumulates every custom-property name a kept layout decl references. */
  referenced: Set<string>
}

/**
 * Extract the layout-relevant declarations of a style block as `prop: value` strings.
 *
 * Without `carry`, custom-property references are resolved against `computed` (the matched
 * element's computed style) and FROZEN to their capture-time value (the ADR 0005 freeze).
 *
 * With `carry` (ADR 0019 §1), a `var()` is KEPT RAW and its referenced token names are recorded
 * into `carry.referenced`; the caller resolves the carry-vs-freeze decision globally (it alone sees
 * every cross-sheet definition) and runs `freezeUncarriedVars` afterward to freeze only the
 * leftovers. A responsive token thus survives as a live reference the plate's own emitted
 * definition drives, instead of locking to one viewport's px.
 */
export function filterLayoutDecls(
  style: CssDeclarationBlock,
  computed?: CssValueReader,
  carry?: CarryContext,
): string[] {
  const out: string[] = []
  for (let i = 0; i < style.length; i++) {
    const prop = style.item(i)
    if (!isLayoutProp(prop)) continue
    let value = style.getPropertyValue(prop).trim()
    if (value.includes('var(')) {
      if (carry) {
        // Carry mode: keep the raw var() and record what it references. The
        // freeze (if any) happens later in `freezeUncarriedVars`, per token.
        for (const name of referencedTokens(value)) carry.referenced.add(name)
      } else if (computed) {
        // Freeze mode: resolve the reference to its capture-time value.
        value = resolveVars(value, computed).trim()
      }
    }
    // A var()-valued shorthand (e.g. `padding: var(--p)`) is a
    // pending-substitution value: some engines (LightningCSS) enumerate its
    // longhands but return '' for them and drop the shorthand from cssText.
    // The longhand is declared yet unreadable — take its resolved computed
    // value so the box keeps its padding/margin/gap. (Carry mode can't keep a
    // raw var() it never saw — the cssText is empty — so it freezes here too.)
    if (!value && computed) value = computed.getPropertyValue(prop).trim()
    if (!value) continue
    // `fluidTracks` only fires on a px-ONLY track list, so a kept raw
    // `var()`-driven grid passes through untouched in carry mode (no premature
    // heuristic); a frozen px grid still fluidizes. It becomes the last resort
    // (ADR 0019 §1): a token-driven grid keeps its carried/raw author value, and
    // only a genuinely px-frozen list reaches the heuristic.
    if (prop === 'grid-template-columns') value = fluidTracks(value, 'columns')
    else if (prop === 'grid-template-rows') value = fluidTracks(value, 'rows')
    else if (prop === 'display') value = normalizeDisplay(value)
    const priority = style.getPropertyPriority(prop)
    out.push(`${prop}: ${value}${priority ? ' !important' : ''}`)
  }
  return out
}

/**
 * Approximate selector specificity packed as a single comparable number (`a * 1e6 + b * 1e3 + c`).
 * Good enough to order rewritten rules so the original cascade winner still wins; known
 * approximation: `:is()`/`:not()` sum their arguments instead of taking the max.
 */
export function specificity(selector: string): number {
  let a = 0
  let b = 0
  let c = 0
  let s = selector.replace(/(['"]).*?\1/g, ' ')
  // :where() contributes nothing
  s = s.replace(/:where\([^()]*\)/g, ' ')
  // functional pseudo-classes whose argument isn't a selector count as one class
  s = s.replace(/:(nth-[a-z-]+|lang|dir)\([^()]*\)/g, () => {
    b++
    return ' '
  })
  // :not/:is/:has count their argument, not themselves — drop the wrapper, keep the args
  s = s.replace(/:(not|is|has)\(/g, ' (')
  s = s.replace(/\[[^\]]*\]/g, () => {
    b++
    return ' '
  })
  s = s.replace(/#[a-zA-Z][\w-]*/g, () => {
    a++
    return ' '
  })
  s = s.replace(/\.[a-zA-Z][\w-]*/g, () => {
    b++
    return ' '
  })
  s = s.replace(/::[a-z-]+/g, () => {
    c++
    return ' '
  })
  s = s.replace(/:[a-z-]+/g, () => {
    b++
    return ' '
  })
  for (const _ of s.matchAll(/[a-zA-Z][\w-]*/g)) c++
  return a * 1_000_000 + b * 1_000 + c
}

/** Split a selector list on top-level commas (commas inside `()`/`[]`/strings don't split). */
export function splitSelectorList(selectorText: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of selectorText) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}
