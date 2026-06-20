import {
  type PlateNode,
  type PlateRule,
  type RenderNode,
  ROOT_ATTR,
  SPEC_CONTEXT,
  SPEC_FALLBACK,
  SPEC_GATE,
  SPEC_INLINE,
  SPEC_LEAF,
} from './plate.ts'

/**
 * Turn id-form rules + an id-tree into the shipped plate: each distinct `(tier, media,
 * declarations)` becomes one class, named by a per-plate sequential id (`[data-xr-root]
 * .xr-<plate>-<n>`), and every node carries the class tokens it needs instead of an id (ADR 0007).
 * The id is a plain counter, not a content hash: the plate prefix already keeps tokens disjoint
 * across plates (the stitch-isolation guarantee), so a per-plate counter is collision-free by
 * construction — and low-entropy ids compress far better than random hashes (~31% smaller brotli on
 * a real plate; see the ADR 0007 amendment). Rules stay unlayered; the cascade is reproduced by
 * emission order (losers first), so the classes are emitted in `(layered, spec, order)` order.
 *
 * Pure data-in/data-out — runs at plugin load (node) and in tests.
 */
export function classify(
  rules: readonly PlateRule[],
  tree: PlateNode,
  plateName: string,
): {
  tree: RenderNode
  css: string
} {
  // Class names are namespaced by plate name. Content classes are global
  // selectors and every plate's `<style>` ships its own copy of the rules it
  // uses (self-contained, ADR 0003); a stitched page injects several such blocks.
  // Without the namespace, a class shared by two plates (e.g. a global `img`
  // rule) would be re-emitted in a later block and, for an element carrying
  // several shared classes, reorder them — overriding an earlier plate's
  // leaf-size with a later plate's `height: auto`. The name keeps each plate's
  // classes disjoint, the stitch isolation ADR 0006/0007 require.
  // This prefix is the *whole* isolation: it's why the per-plate id below can be
  // a bare counter, and why attribute-value scoping (`[data-xr-root="name"] .x`)
  // does NOT work as a substitute — a descendant combinator reaches through a
  // nested plate's root and matches its nodes (ADR 0007 amendment).
  const classBase = `${CLASS_PREFIX}${encodePlateName(plateName)}-`
  // Drop dead font/text-rendering decls BEFORE content-addressing (gen-side, not
  // capture): bones paint no glyphs, so most are inert, and dropping them here
  // (not in `filterLayoutDecls`) keeps capture + the validator accepting font,
  // applies on a rebuild without a re-capture, and merges rule-sets that differ
  // only by a font decl. `line-height`/`font-size` are kept where load-bearing —
  // see `dropDeadDecls`.
  const filtered = dropDeadDecls(rules)
  // Cascade order: layered rules first (they lose to unlayered — emitted-early
  // loses at flat specificity), then by spec, then by source order. Winners
  // last.
  const sorted = filtered.toSorted(
    (a, b) =>
      Number(b.layered ?? false) - Number(a.layered ?? false) ||
      a.spec - b.spec ||
      a.order - b.order,
  )

  const nameForKey = new Map<string, string>()
  const body = new Map<
    string,
    { media: readonly string[]; container: readonly string[]; decls: string }
  >()
  const usage = new Map<string, { root: boolean; desc: boolean }>()
  const emitOrder: string[] = []
  const nodeClasses = new Map<number, string[]>()

  for (const rule of sorted) {
    if (rule.decls.length === 0) continue
    const decls = rule.decls.join('; ')
    const media = rule.media ?? []
    const container = rule.container ?? []
    const tier = SPEC_FOLD === 'full' ? String(rule.spec) : tierLabel(rule.spec)
    const key = `${rule.layered ? 'l' : ''} ${tier} ${media.join(' && ')} ${container.join(' && ')} ${decls}`

    let name = nameForKey.get(key)
    if (name === undefined) {
      // Sequential per-plate id in base36, handed out in cascade-emit order. The
      // plate prefix keeps tokens disjoint across plates, so a counter never
      // collides — no hash, no collision guard. `nameForKey.size` is the count
      // of ids assigned so far, i.e. the next index.
      name = classBase + nameForKey.size.toString(36)
      nameForKey.set(key, name)
      body.set(name, { media, container, decls })
      usage.set(name, { root: false, desc: false })
      emitOrder.push(name)
    }

    // `ids: []` targets the plate root (synthetic node id 0).
    const ids = rule.ids.length === 0 ? [0] : rule.ids
    for (const id of ids) {
      const u = usage.get(name)
      if (!u) throw new Error(`missing usage entry for ${name}`)
      if (id === 0) u.root = true
      else u.desc = true
      let list = nodeClasses.get(id)
      if (!list) {
        list = []
        nodeClasses.set(id, list)
      }
      if (!list.includes(name)) list.push(name)
    }
  }

  const lines: string[] = []
  for (const name of emitOrder) {
    const item = body.get(name)
    const u = usage.get(name)
    if (!item || !u) throw new Error(`missing class body for ${name}`)
    const { media, container, decls } = item
    const sels: string[] = []
    // Root rules target the root element itself (it carries both the attr and
    // the class); descendant rules target nodes inside it.
    if (u.root) sels.push(`[${ROOT_ATTR}].${name}`)
    if (u.desc) sels.push(`[${ROOT_ATTR}] .${name}`)
    let text = `${sels.join(', ')} { ${decls} }`
    // media inside, container outside — both must hold to match, so nesting
    // order is immaterial; the captured `container-type` makes the bone a query
    // container so the condition re-evaluates against the skeleton's own width.
    for (const condition of media.toReversed()) text = `@media ${condition} { ${text} }`
    for (const condition of container.toReversed()) text = `@container ${condition} { ${text} }`
    lines.push(text)
  }

  return { tree: render(tree, nodeClasses), css: lines.join('\n') }
}

/** Strip ids, attach content-class tokens — the shipped tree shape (ADR 0007). */
function render(node: PlateNode, classes: Map<number, string[]>): RenderNode {
  const out: RenderNode = {}
  if (node.leaf) out.leaf = node.leaf
  if (node.ref !== undefined) out.ref = node.ref
  if (node.count !== undefined) out.count = node.count
  const cls = classes.get(node.id)
  if (cls && cls.length > 0) out.cls = cls.join(' ')
  if (node.kids) out.kids = node.kids.map((kid) => render(kid, classes))
  return out
}

/** Content-class prefix; distinct from the fixed `xr-root/node/leaf` base words. */
const CLASS_PREFIX = 'xr-'

/**
 * Font/text-rendering properties that are ALWAYS dead at generation. A bone paints no glyphs, so
 * these never reach its box — yet capture still emits them (the inherited context rule, node
 * fallbacks, lifted author rules), and `filterLayoutDecls`/the validator legitimately accept them.
 * `line-height` and `font-size` are NOT here: each can be load-bearing, so `dropDeadDecls` keeps
 * them conditionally. KEEP `vertical-align`/`text-align`: they position inline-block bones, not
 * text.
 */
const DROP_AT_GEN_ALWAYS = new Set([
  'font',
  'font-family',
  'font-weight',
  'font-style',
  'letter-spacing',
  'word-spacing',
  'text-indent',
  'white-space',
  'word-break',
  'overflow-wrap',
  'text-wrap',
])

/**
 * An element-font-relative length (`em`/`ex`/`ch`) — resolves against the element's own
 * `font-size`, so dropping a per-node `font-size` would shift it. EXCLUDES `rem` (root-relative,
 * unaffected): its `em` is preceded by `r`, never by a digit. Case-insensitive (author CSS may
 * write `1EM`); the trailing `\b` stops `2em` matching inside a longer identifier (`flex`,
 * `text`).
 */
const FONT_RELATIVE_LENGTH = /\d(?:em|ex|ch)\b/iu

/** A flex/grid/table/ruby display — its child boxes get no inline line box. */
const FLEXISH_DISPLAY = /\b(?:flex|grid|table|ruby)\b/u

/** The lowercased property of a `prop: value` declaration (`''` if malformed). */
function declProp(decl: string): string {
  const colon = decl.indexOf(':')
  return colon < 0 ? '' : decl.slice(0, colon).trim().toLowerCase()
}

/**
 * Drop dead font/text decls before content-addressing. The always-dead props go unconditionally;
 * the two that CAN matter are kept narrowly:
 *
 * - `line-height` survives only as the walk's per-row pin: a `SPEC_FALLBACK` rule on an inline-flow
 *   node (no flex/grid/table/ruby display). That pin (measure.ts, `hasTextBar`) sizes the
 *   inline-block text bone's line box, so dropping it drifts the row. The shared context
 *   `line-height`, author copies, and flex/grid rows (text is a flex _item_ there — no line box)
 *   are all dead.
 * - `font-size` survives only if some kept decl uses an element-font-relative unit (`em`/`ex`/`ch`)
 *   that resolves against it. A plate on `px`/`rem` only (e.g. MW) drops it everywhere. The scan is
 *   plate-wide: one such unit anywhere means a dropped per-node `font-size` could shift a size.
 *
 * A rule emptied by the filter (the all-font context rule) is dropped downstream by the existing
 * `decls.length === 0` guard.
 */
function dropDeadDecls(rules: readonly PlateRule[]): PlateRule[] {
  const keepFontSize = rules.some((rule) =>
    rule.decls.some(
      (decl) => !DROP_AT_GEN_ALWAYS.has(declProp(decl)) && FONT_RELATIVE_LENGTH.test(decl),
    ),
  )
  return rules.map((rule) => {
    const pinnedLineHeight =
      rule.spec === SPEC_FALLBACK &&
      !rule.decls.some((decl) => declProp(decl) === 'display' && FLEXISH_DISPLAY.test(decl))
    const decls = rule.decls.filter((decl) => {
      const prop = declProp(decl)
      if (DROP_AT_GEN_ALWAYS.has(prop)) return false
      if (prop === 'font-size') return keepFontSize
      if (prop === 'line-height') return pinnedLineHeight
      return true
    })
    return decls.length === rule.decls.length ? rule : { ...rule, decls }
  })
}

/**
 * Encode a plate name into a class-token prefix, injectively. This prefix _is_ the isolation
 * boundary across stitched plates (ADR 0007), so distinct plate names must never produce the same
 * prefix — a collision would let one plate's `<style>` block reorder another's classes.
 *
 * Plate names are constrained by `isValidPlateName`: each path segment is `\w+(-\w+)*` (word chars
 * with single interior hyphens, no doubled or edge hyphen) and segments are joined by `/`. The
 * slash is the only char that is not class-safe, so rendering it as `--` is enough — and because no
 * segment holds a literal `--` or an edge hyphen, no `-` ever abuts a `/`, so every `--` in the
 * prefix unambiguously came from a `/`, making the map injective. Keeping `/` visually as `--` also
 * leaves nested names readable in the generated CSS (`product--card`).
 */
function encodePlateName(name: string): string {
  return name.replace(/\//g, '--')
}

/**
 * What the class identity keys on, alongside media + declarations: - `'full'` (the shipped
 * setting): the exact `spec` — provably no inversion. - `'tier'`: the discrete cascade tier —
 * marginally smaller (more bodies dedupe), but a rare same-tier inversion within the continuous
 * `author` band can mis-order one property on one node (ADR 0007). One-line flip if size ever
 * matters more than the inversion risk.
 */
const SPEC_FOLD: 'tier' | 'full' = 'full'

function tierLabel(spec: number): string {
  if (spec <= SPEC_CONTEXT) return 'ctx'
  if (spec === SPEC_FALLBACK) return 'fb'
  if (spec >= SPEC_GATE) return 'gate'
  if (spec >= SPEC_INLINE) return 'inl'
  if (spec >= SPEC_LEAF) return 'leaf'
  return 'au'
}
