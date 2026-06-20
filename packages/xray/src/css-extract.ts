// =============================================================================
// AUTHOR-CSS LIFT (ADR 0005, ADR 0007, ADR 0019 §1). Flattens the reachable author
// stylesheets, indexes their selectors, matches each captured node, and rewrites the
// matched rules to plate-local ids — plus the carried-custom-property decision. The
// DOM-touching half of the build phase; split out of measure.ts as a leaf the walk
// core calls (`copyRules`). Dependency direction: measure.ts → css-extract.ts →
// {ir, plate, css, diagnostics, style-cache}.
// =============================================================================

import { type PlateRule, SPEC_CONTEXT, SPEC_FALLBACK, SPEC_LEAF, SPEC_INLINE } from './plate.ts'
import { type IRNode } from './ir.ts'
import {
  type CarryContext,
  filterLayoutDecls,
  freezeUncarriedVars,
  referencedTokens,
  specificity,
  splitSelectorList,
} from './css.ts'
import { type DiagnosticsCollector } from './diagnostics.ts'
import { type StyleCache } from './style-cache.ts'

/** Pseudo-classes that only apply under interaction — a static skeleton never needs them. */
const DYNAMIC_PSEUDO =
  /:(hover|active|focus|focus-visible|focus-within|visited|link|target|enabled|disabled|checked)\b/
/** Pseudo-element rules are skipped for v1 (no box to map them onto). */
const PSEUDO_ELEMENT =
  /::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter|file-selector-button)\b/

/** The capture-time measurements everything starts from, at the lowest precedence. */
function baseRules(nodes: readonly IRNode[], styles: StyleCache): PlateRule[] {
  const rules: PlateRule[] = []
  let order = 0
  // Inheritable text context from outside the subtree (the plate renders detached from it).
  const first = nodes.find((n) => n.el)
  const context = first?.el?.parentElement
  if (context) {
    // The context node is an ancestor of the subtree, memoized like the rest.
    const cs = styles.get(context)
    rules.push({
      ids: [],
      decls: [
        `font-family: ${cs.fontFamily}`,
        `font-size: ${cs.fontSize}`,
        `font-weight: ${cs.fontWeight}`,
        `line-height: ${cs.lineHeight}`,
      ],
      spec: SPEC_CONTEXT,
      order: order++,
    })
  }
  for (const node of nodes) {
    if (node.decls.fallback.length > 0) {
      rules.push({
        ids: [node.id],
        decls: node.decls.fallback,
        spec: SPEC_FALLBACK,
        order: order++,
      })
    }
    // A leaf's measured size outranks copied author width/height: the block
    // keeps the size it was captured at, never collapsed by `width: auto`.
    if (node.decls.size && node.decls.size.length > 0) {
      rules.push({ ids: [node.id], decls: node.decls.size, spec: SPEC_LEAF, order: order++ })
    }
  }
  return rules
}

interface FoundRule {
  rule: CSSStyleRule
  media: string[]
  /** `@container` condition stack, outermost first; conditions AND together (like media). */
  container: string[]
  layered: boolean
}

/** `@container <name>? <query>` — the text to re-wrap a lifted rule with. */
function containerCondition(rule: CSSContainerRule): string {
  const query = rule.containerQuery
  if (query) {
    const name = rule.containerName?.trim()
    return name ? `${name} ${query}` : query
  }
  // Engines that don't expose containerQuery (e.g. happy-dom): the condition
  // text already includes any container name; last resort parses the prelude.
  const cond =
    'conditionText' in rule && typeof rule.conditionText === 'string' ? rule.conditionText : ''
  if (cond) return cond
  const match = /@container\s+([^{]+)\{/.exec(rule.cssText ?? '')
  const condition = match?.[1]
  return condition ? condition.trim() : ''
}

function isCssStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return rule.constructor.name === 'CSSStyleRule'
}

function isCssMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return rule.constructor.name === 'CSSMediaRule'
}

function isCssContainerRule(rule: CSSRule): rule is CSSContainerRule {
  return rule.constructor.name === 'CSSContainerRule'
}

function isCssSupportsRule(rule: CSSRule): rule is CSSSupportsRule {
  return rule.constructor.name === 'CSSSupportsRule'
}

function isCssLayerBlockRule(rule: CSSRule): rule is CSSGroupingRule {
  return rule.constructor.name === 'CSSLayerBlockRule' && 'cssRules' in rule
}

function isCssImportRule(rule: CSSRule): rule is CSSImportRule {
  return rule.constructor.name === 'CSSImportRule'
}

function importLayerName(rule: CSSImportRule): string | null {
  if (!('layerName' in rule)) return null
  return typeof rule.layerName === 'string' ? rule.layerName : null
}

function supportsCondition(win: Window, condition: string): boolean {
  if (!('CSS' in win)) return true
  const css = win.CSS
  if (typeof css !== 'object' || css === null || !('supports' in css)) return true
  if (typeof css.supports !== 'function') return true
  try {
    return css.supports(condition) === true
  } catch {
    return true
  }
}

/** Flatten every reachable author rule, tracking media + container conditions and layer membership. */
function collectStyleRules(
  doc: Document,
  win: Window,
  diagnostics: DiagnosticsCollector,
): FoundRule[] {
  const out: FoundRule[] = []

  const visit = (
    list: CSSRuleList | null | undefined,
    media: string[],
    container: string[],
    layered: boolean,
  ) => {
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      const rule = list[i]
      if (!rule) continue
      if (isCssStyleRule(rule)) {
        out.push({ rule, media, container, layered })
        continue
      }
      if (isCssMediaRule(rule)) {
        visit(rule.cssRules, [...media, rule.media.mediaText], container, layered)
        continue
      }
      // Container queries are carried like media (ADR 0005): the condition is
      // re-wrapped at emit, and the skeleton re-evaluates it against the
      // captured `container-type` so a CQ layout reflows in the bones too.
      if (isCssContainerRule(rule)) {
        visit(rule.cssRules, media, [...container, containerCondition(rule)], layered)
        continue
      }
      if (isCssSupportsRule(rule)) {
        // @supports is engine-static: resolve it at capture instead of carrying it.
        if (supportsCondition(win, rule.conditionText))
          visit(rule.cssRules, media, container, layered)
        continue
      }
      if (isCssLayerBlockRule(rule)) {
        visit(rule.cssRules, media, container, true)
        continue
      }
      if (isCssImportRule(rule)) {
        try {
          const importMedia = rule.media.mediaText
          visit(
            rule.styleSheet?.cssRules,
            importMedia && importMedia !== 'all' ? [...media, importMedia] : media,
            container,
            layered || importLayerName(rule) != null,
          )
        } catch {
          // Cross-origin import: accessing cssRules throws, so nothing is readable.
          diagnostics.add('unreadable-import')
        }
        continue
      }
      // A rule kind the serializer doesn't lift (e.g. @font-face, @keyframes,
      // @page, @counter-style). Harmless to skip, but counted so a missing
      // effect is explained. The grouping/conditional kinds handled above
      // `continue` before reaching here, so this only sees true leaf kinds.
      diagnostics.add('unsupported-rule')
    }
  }

  const sheets: CSSStyleSheet[] = [
    ...Array.from(doc.styleSheets),
    ...(doc.adoptedStyleSheets ?? []),
  ]
  for (const sheet of sheets) {
    const sheetMedia = sheet.media.mediaText
    try {
      visit(sheet.cssRules, sheetMedia && sheetMedia !== 'all' ? [sheetMedia] : [], [], false)
    } catch {
      // Cross-origin stylesheet: accessing cssRules throws, so nothing is readable.
      diagnostics.add('unreadable-stylesheet')
    }
  }
  return out
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector)
  } catch {
    return false
  }
}

/**
 * One selector of one author rule — IMMUTABLE structural data (ADR 0025). It holds only what the
 * stylesheets themselves determine: the live `CSSStyleRule` (read for its `.style` and
 * `.selectorText` but never mutated), the selector text, the media/container conditions, layer
 * membership, specificity, and source order. Nothing here depends on the DOM being matched, so a
 * `RuleIndex` of these is safe to build once and (when the stylesheets are unchanged) reuse across
 * captures. The per-capture match results — which element ids matched, and the resolved `decls` —
 * live in a separate `MatchState` keyed by this object's identity, NEVER on the Selector itself, so
 * two concurrent captures (or a cached index) never cross-write.
 */
interface Selector {
  rule: CSSStyleRule
  selector: string
  media: string[]
  container: string[]
  layered: boolean
  spec: number
  order: number
}

/**
 * The immutable, DOM-independent selector index — bucketed the way a browser's rule hash is (id /
 * class / tag / universal). Cacheable: it does not mutate while matching one Plate (ADR 0025) and
 * carries no per-capture state. The per-capture `ids`/`decls` live in `MatchState`.
 */
interface RuleIndex {
  byId: Map<string, Selector[]>
  byClass: Map<string, Selector[]>
  byTag: Map<string, Selector[]>
  universal: Selector[]
}

/**
 * Per-capture match state for one `Selector`: the plate-local element ids it matched this capture,
 * and its `decls` resolved lazily on first match (the first matching element's computed style
 * resolves any `var()`, ADR 0005). Kept OFF the immutable Selector so the shared/cached index never
 * mutates (ADR 0025).
 */
interface SelectorMatch {
  ids: number[]
  decls: string[] | null
  /**
   * The computed-style reader the decls were resolved against — the FIRST matching element's style
   * (ADR 0025). Kept so the post-match freeze (`freezeUncarriedVars`, ADR 0019 §1) resolves any
   * UN-carried `var()` against the SAME element the inline freeze path would use. Null until first
   * match (no decls yet).
   */
  computed: CssValueReader | null
}

/** The minimal computed-style reader the freeze needs (a `var()` value resolver). */
interface CssValueReader {
  getPropertyValue: (property: string) => string
}

function pushSelector(map: Map<string, Selector[]>, key: string, sel: Selector): void {
  const list = map.get(key)
  if (list) list.push(sel)
  else map.set(key, [sel])
}

/** The rightmost compound of a selector — what an element must itself satisfy to match. */
function rightmostCompound(selector: string): string {
  let depth = 0
  let quote = ''
  for (let i = selector.length - 1; i >= 0; i--) {
    const ch = selector.charAt(i)
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === ')' || ch === ']') depth++
    else if (ch === '(' || ch === '[') depth--
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) {
      return selector.slice(i + 1)
    }
  }
  return selector
}

/**
 * Index author rules the way a browser's rule hash does: bucket each selector by a token its
 * matching element must carry (id, a class, or tag), so an element only tests the rules that could
 * possibly apply to it. CSS-module class names are unique, so this turns an O(rules × nodes) sweep
 * into a near-linear one. Selectors keyed on nothing concrete (`*`, attribute-only) fall back to a
 * universal bucket tested against every element.
 */
function indexRules(found: readonly FoundRule[], diagnostics: DiagnosticsCollector): RuleIndex {
  const index: RuleIndex = {
    byId: new Map(),
    byClass: new Map(),
    byTag: new Map(),
    universal: [],
  }
  let order = 1000
  for (const f of found) {
    order++
    for (const selector of splitSelectorList(f.rule.selectorText)) {
      // Dynamic pseudo-classes never fire in a static skeleton, and v1 has no
      // box to map a pseudo-element onto (DYNAMIC_PSEUDO / PSEUDO_ELEMENT). Both
      // are skipped, but counted separately so the cause is legible. A pseudo
      // ELEMENT takes precedence: a selector like `.x:hover::before` is dropped
      // for the element it can't paint, not the interaction state.
      if (PSEUDO_ELEMENT.test(selector)) {
        diagnostics.add('skipped-pseudo-element')
        continue
      }
      if (DYNAMIC_PSEUDO.test(selector)) {
        diagnostics.add('skipped-dynamic-pseudo')
        continue
      }
      const sel: Selector = {
        rule: f.rule,
        selector,
        media: f.media,
        container: f.container,
        layered: f.layered,
        spec: specificity(selector),
        order,
      }
      // Functional pseudo args (`:not(.x)`) describe other elements, not this
      // one — drop them before reading the element's own id/class/tag.
      const compound = rightmostCompound(selector).replace(/:{1,2}[\w-]+\([^()]*\)/g, '')
      const id = /#(-?[A-Za-z_][\w-]*)/.exec(compound)
      const cls = /\.(-?[A-Za-z_][\w-]*)/.exec(compound)
      const tag = /^(-?[A-Za-z][\w-]*)/.exec(compound)
      const idName = id?.[1]
      const className = cls?.[1]
      const tagName = tag?.[1]
      if (idName) pushSelector(index.byId, idName, sel)
      else if (className) pushSelector(index.byClass, className, sel)
      else if (tagName) pushSelector(index.byTag, tagName.toLowerCase(), sel)
      else index.universal.push(sel)
    }
  }
  return index
}

// ===========================================================================
// CARRIED CUSTOM PROPERTIES (ADR 0019 §1).
//
// Freezing every `var()` to its capture-time value (the ADR 0005 floor) is
// simple and self-contained but locks responsive spacing/grid to one viewport:
// a `var(--gap)` that an `@media` override grows could never grow in the bone.
// Carrying the author's token DEFINITIONS, conditionally, avoids that:
//
//   1. Filter kept layout decls in CARRY MODE (`filterLayoutDecls(..., carry)`),
//      keeping raw `var()` and collecting referenced token names.
//   2. Expand that seed set TRANSITIVELY over the token definitions: a token's
//      value may reference other tokens (`--gap: var(--space-2)`), and all of
//      them are reachable from a kept layout decl, so all are candidates.
//   3. DECIDE per reachable token (`decideTokens`): if every reachable definition
//      is UNCONDITIONAL it is CONSTANT — freeze it (smaller, identical). If any
//      definition carries an `@media`/`@container` condition it VARIES — CARRY it
//      (emit its conditional definitions as anchored `PlateRule`s).
//   4. ANCHOR each carried definition: a `:root`/`html`/`*` definition inherits
//      into the whole subtree, so it is emitted on the plate's scoped ROOT (node
//      id 0); a definition on a CAPTURED element is emitted on that node. A
//      definition on an UN-CAPTURED wrapper cannot be anchored — the token
//      stays out of the carry set and freezes.
//   5. FREEZE the leftovers (`freezeUncarriedVars`): any `var()` whose token did
//      NOT make the carry set resolves to its capture-time value — the
//      irreducible freeze (constant tokens, un-anchorable wrappers, the
//      unreadable). After this, every surviving `var()` names a token the plate
//      itself defines: SELF-CONTAINMENT (ADR 0003) holds by construction.
//
// @property registrations — NOT carried in v1; accepted edge risk. The
// carried tokens are layout LENGTHS consumed by plain `var()` substitution,
// which needs no `@property`: registration only governs a custom property's
// animation/transition/inheritance TYPE, none of which a static skeleton's
// frozen-in-time layout exercises. Carrying registrations would add an
// at-rule emission path through classify for no layout-visible gain, so v1
// skips it; revisit if a carried token is ever consumed somewhere type-sensitive.
//
// Un-captured ancestor — FREEZE; accepted loss. A conditional token defined
// only on an uncaptured wrapper BETWEEN :root and the subtree (a theme
// provider) has no node on the plate to host it, and hoisting it to node 0
// would drop the wrapper's own gating (a theme class) and mis-apply it. v1
// freezes such a token to its capture-time value (the responsive variance is
// lost) rather than emit an unsound definition. Only :root/html/* and in-subtree
// redefinitions are anchored; everything else falls through to the freeze.
// ===========================================================================

/**
 * One author definition of a custom property, lifted from the flattened rule set with the
 * conditions and selector it was written under. The carry logic groups these by token name to
 * decide constant-vs-conditional and to anchor each one.
 */
interface TokenDef {
  name: string
  /** The raw author value (`8px`, `var(--space-2)`, `clamp(…)`). */
  value: string
  /** The rule's selector text (one of a possibly-comma-separated list). */
  selector: string
  media: string[]
  container: string[]
  layered: boolean
  spec: number
  order: number
}

/**
 * Scan every flattened author rule for custom-property declarations and group them by token name. A
 * token may be defined many times (a `:root` base plus an `@media` override, or per-theme blocks);
 * each definition keeps its conditions and selector so the carry decision can see whether ANY of
 * them is conditional and where each anchors. Reuses the SAME flatten `copyRules` already paid for
 * (`collectStyleRules`), so this adds one extra pass over the rules, no new CSSOM traversal.
 * Dynamic-pseudo / pseudo-element rules never define carried layout tokens, but they are cheap to
 * include and harmless (their selectors won't anchor to a captured node or to :root), so the scan
 * stays simple and skips nothing.
 */
function collectTokenDefs(found: readonly FoundRule[]): Map<string, TokenDef[]> {
  const defs = new Map<string, TokenDef[]>()
  let order = 0
  for (const f of found) {
    order++
    const style = f.rule.style
    for (let i = 0; i < style.length; i++) {
      const prop = style.item(i)
      if (!prop.startsWith('--')) continue
      const value = style.getPropertyValue(prop).trim()
      if (!value) continue
      // A rule's selector list may name several subjects (`:root, .theme`); record
      // the definition once per selector so each can be anchored independently.
      for (const selector of splitSelectorList(f.rule.selectorText)) {
        const def: TokenDef = {
          name: prop,
          value,
          selector,
          media: f.media,
          container: f.container,
          layered: f.layered,
          spec: specificity(selector),
          order,
        }
        const list = defs.get(prop)
        if (list) list.push(def)
        else defs.set(prop, [def])
      }
    }
  }
  return defs
}

/**
 * A selector that puts a custom property in scope for the WHOLE captured subtree — `:root`, `html`,
 * or the universal `*` (optionally wrapped in zero-specificity `:where()`/`:is()`, and ignoring a
 * trailing dynamic state). Such a definition inherits down into every node, so it anchors on the
 * plate's scoped root (node id 0). Anything more specific is an element-level (re)definition
 * handled by matching it against the captured elements instead.
 */
const ROOT_SCOPE_SELECTOR = /^(?::root|html|\*)$/
function isRootScopeSelector(selector: string): boolean {
  // Strip zero-specificity `:where(...)`/`:is(...)` wrappers and any whitespace,
  // then test the bare subject. `:root:where(.theme)` is NOT root-scope — the
  // `.theme` gates it, so it is treated as a (likely un-capturable) conditional.
  const bare = selector
    .replace(/:where\([^()]*\)/g, '')
    .replace(/\s+/g, '')
    .trim()
  return ROOT_SCOPE_SELECTOR.test(bare)
}

/** Does a token have at least one definition gated by an `@media`/`@container` condition? */
function hasConditionalDef(defs: readonly TokenDef[]): boolean {
  return defs.some((def) => def.media.length > 0 || def.container.length > 0)
}

/**
 * The plate-id a token definition anchors to, or null when it cannot be anchored on the captured
 * tree (an un-captured wrapper). Root-scope selectors (`:root`/`html`/`*`) anchor on the scoped
 * root (id 0, emitted as `ids: []`); an element-level definition anchors on every captured element
 * it matches (a token redefined on a card anchors on that card's node). A definition that matches
 * NO captured element and is not root-scope is un-anchorable.
 */
function anchorIdsFor(
  def: TokenDef,
  elNodes: readonly (IRNode & { el: Element })[],
): number[] | null {
  if (isRootScopeSelector(def.selector)) return [0]
  const ids: number[] = []
  for (const node of elNodes) {
    if (safeMatches(node.el, def.selector)) ids.push(node.id)
  }
  return ids.length > 0 ? ids : null
}

/**
 * The winning UNCONDITIONAL definition value of a token — its constant value, picked by the cascade
 * among definitions that carry no `@media`/`@container` condition: highest specificity, then latest
 * source order. Null when the token has no unconditional definition (it only exists inside a query
 * — purely conditional). This is what a constant token freezes to, sourced from the author CSSOM
 * rather than computed style, so the freeze is correct even where computed style cannot resolve an
 * inherited custom property.
 */
function constantValueOf(defs: readonly TokenDef[]): string | null {
  let best: TokenDef | null = null
  for (const def of defs) {
    if (def.media.length > 0 || def.container.length > 0) continue
    if (!best || def.spec > best.spec || (def.spec === best.spec && def.order >= best.order)) {
      best = def
    }
  }
  return best ? best.value : null
}

/**
 * The carry decision (ADR 0019 §1). Given the tokens a kept layout decl seeds (`seed`), the full
 * definition index, and the captured elements, returns: - `carried` — token names whose CONDITIONAL
 * definitions will be emitted as `PlateRule`s, so a kept `var()` referencing them is left INTACT
 * (live); - `rules` — those emitted definition rules, anchored to node 0 / a node id; - `frozen` —
 * constant (or un-anchorable) reachable tokens mapped to their author value, the authoritative
 * freeze target `freezeUncarriedVars` prefers over computed style (computed style can't always
 * resolve an inherited custom property — happy-dom in tests, and any deeply-inherited token).
 *
 * The seed is expanded TRANSITIVELY: a carried token's own value may reference further tokens
 * (`--gap: var(--space-2)`), which must also be reachable and resolvable, so they enter the
 * worklist too. A token is carried iff (a) it has a conditional definition AND (b) EVERY one of its
 * definitions can be anchored on the captured tree — otherwise carrying it would leave the plate
 * referencing a token whose conditional variance it cannot honestly reproduce, so it is left to
 * freeze. A purely-constant token is also left out (it freezes inline, smaller and identical).
 * Paint-only tokens (a `--brand-color` never referenced by a kept layout decl, and never pulled in
 * transitively by a carried one) never enter the worklist — REACHABILITY: only layout-reachable
 * tokens are ever carried.
 *
 * SELF-CONTAINMENT of the carried DEFINITIONS themselves (ADR 0003). A carried token's value can
 * reference another token that the worklist decided to FREEZE, not carry (`--gap: var(--const)`
 * where `--const` is constant) — so the emitted `--gap` definition would dangle on a `--const` the
 * plate never defines. The emitted def decls are therefore run through `freezeUncarriedVars`
 * exactly like the consuming layout decls: a reference to a CARRIED token stays live (the plate
 * defines it elsewhere), every other reference freezes to its author value (from `frozen`, the
 * authoritative source `recordFrozen` already populated by following the worklist) or the anchored
 * element's computed value. This is deferred until AFTER the worklist drains, because whether a
 * referenced token is carried is not known until the fixpoint settles — freezing a def mid-walk
 * could freeze a head that a later iteration carries.
 */
interface TokenDecision {
  carried: Set<string>
  rules: PlateRule[]
  frozen: Map<string, string>
}

function decideTokens(
  seed: ReadonlySet<string>,
  tokenDefs: Map<string, TokenDef[]>,
  elNodes: readonly (IRNode & { el: Element })[],
  rootReader: CssValueReader,
  styles: StyleCache,
): TokenDecision {
  const carried = new Set<string>()
  const rules: PlateRule[] = []
  const frozen = new Map<string, string>()
  // A computed-style reader per captured node id, so a carried definition's
  // leftover (un-carried) `var()` can resolve against the SAME element a kept
  // layout decl on that node would have used. `frozen` (author values) is still
  // preferred; this is the secondary fallback for a referenced token that has no
  // constant author value (e.g. a fallback-only reference). Node 0 (the scoped
  // root) reads the document root's style. The per-element computed style comes
  // from the per-capture memo (`StyleCache.get` — the same live view the walk
  // snapshotted from), since the live `cs` is no longer stored on the node.
  const readerForIds = (ids: readonly number[]): CssValueReader => {
    for (const id of ids) {
      if (id === 0) return rootReader
      const node = elNodes.find((n) => n.id === id)
      if (node) return styles.get(node.el)
    }
    return rootReader
  }
  // Carried definitions, collected during the walk and EMITTED AFTER the worklist
  // drains. Emission is deferred because freezing a def's value depends on the
  // FINAL `carried`/`frozen` sets — a reference that a later worklist iteration
  // decides to carry must stay live, which is unknown until the fixpoint settles.
  const pending: { def: TokenDef; ids: number[] }[] = []
  // Tokens reachable from a kept layout decl, processed to a fixpoint. A carried
  // token's definition values add their OWN referenced tokens to the worklist
  // (transitive reachability); `visited` guards against a cyclic `var()` chain.
  const worklist = [...seed]
  const visited = new Set<string>()

  // Record a reachable token's constant author value (if any) as a freeze target,
  // and follow its value's own token references so a frozen chain stays resolvable.
  const recordFrozen = (name: string, defs: readonly TokenDef[]) => {
    const value = constantValueOf(defs)
    if (value !== null) {
      frozen.set(name, value)
      for (const ref of referencedTokens(value)) {
        if (!visited.has(ref)) worklist.push(ref)
      }
    }
  }

  while (worklist.length > 0) {
    const name = worklist.pop()
    if (name === undefined || visited.has(name)) continue
    visited.add(name)
    const defs = tokenDefs.get(name)
    // No author definition (the var() relies purely on its fallback, or a
    // JS-set inline custom prop the CSSOM never showed): nothing to carry — the
    // reference freezes to its computed value later.
    if (!defs || defs.length === 0) continue
    // A constant token (no conditional definition) is cheaper frozen — leave it
    // out of the carry set so `freezeUncarriedVars` inlines it.
    if (!hasConditionalDef(defs)) {
      recordFrozen(name, defs)
      continue
    }
    // Conditional: every definition must anchor on the captured tree. A
    // definition on an UN-CAPTURED wrapper (a theme provider above the capture
    // root) returns null: its variance cannot be reproduced soundly without the
    // wrapper's own gating, so the WHOLE token freezes and the responsive loss
    // is accepted. The freeze target is the token's winning UNCONDITIONAL
    // author definition (`recordFrozen` → `constantValueOf`): the author's
    // default value, deterministic across environments and self-contained — a
    // documented v1 corner (the capture-viewport value would be marginally more
    // faithful but is not reliably readable from inherited computed style).
    const anchored: { def: TokenDef; ids: number[] }[] = []
    let anchorable = true
    for (const def of defs) {
      const ids = anchorIdsFor(def, elNodes)
      if (ids === null) {
        anchorable = false
        break
      }
      anchored.push({ def, ids })
    }
    if (!anchorable) {
      recordFrozen(name, defs)
      continue
    }
    // Carry it: queue every definition for emission, and follow its value's own
    // token references transitively so the carried chain stays self-contained
    // (a referenced token is either carried too, or recorded as a freeze target).
    carried.add(name)
    for (const { def, ids } of anchored) {
      pending.push({ def, ids })
      for (const ref of referencedTokens(def.value)) {
        if (!visited.has(ref)) worklist.push(ref)
      }
    }
  }

  // Emit the carried definitions, now that `carried`/`frozen` are final. Each
  // def's value runs through the SAME `freezeUncarriedVars` the consuming layout
  // decls use, so a reference to a carried token stays live (the plate defines it)
  // while a reference to a constant/frozen token is substituted to its author
  // value — no carried definition can dangle on a token the plate never defines
  // (ADR 0003). `[0]` (root scope) emits as `ids: []`, the scoped-root anchor.
  for (const { def, ids } of pending) {
    const [frozenDecl] = freezeUncarriedVars(
      [`${def.name}: ${def.value}`],
      carried,
      readerForIds(ids),
      frozen,
    )
    rules.push({
      ids: ids[0] === 0 && ids.length === 1 ? [] : ids,
      decls: [frozenDecl ?? `${def.name}: ${def.value}`],
      ...(def.media.length > 0 ? { media: def.media } : {}),
      ...(def.container.length > 0 ? { container: def.container } : {}),
      layered: def.layered,
      spec: def.spec,
      order: def.order,
    })
  }
  return { carried, rules, frozen }
}

function hasInlineStyle(el: Element): el is Element & { style: CSSStyleDeclaration } {
  return (
    'style' in el &&
    typeof el.style === 'object' &&
    el.style !== null &&
    'length' in el.style &&
    'getPropertyValue' in el.style &&
    'getPropertyPriority' in el.style
  )
}

/** Lift matching author rules, rewritten to plate-local ids (ADR 0005). */
export function copyRules(
  nodes: readonly IRNode[],
  doc: Document,
  win: Window,
  styles: StyleCache,
  diagnostics: DiagnosticsCollector,
  extraRules: readonly PlateRule[] = [],
  // When present (the build phase, Stage 2), each lifted rule is also attached to
  // the IR node(s) it targets — `decls.author` for CSSOM + inline rules,
  // `decls.carried` for carried token defs. Purely additive: the returned flat
  // `rules` array is byte-identical with or without it.
  nodeById?: ReadonlyMap<number, IRNode>,
): PlateRule[] {
  const rules: PlateRule[] = baseRules(nodes, styles)
  const elNodes = nodes.filter((n): n is IRNode & { el: Element } => n.el !== null)
  // One flatten of the author rules (`collectStyleRules`), shared by the selector
  // index AND the token-definition scan (ADR 0019 §1) — the carry logic adds no
  // new CSSOM traversal, only one extra pass over the already-collected rules.
  const found = collectStyleRules(doc, win, diagnostics)
  // The immutable, DOM-independent selector index (ADR 0025). It is never
  // mutated below: all per-capture results go into `matches`, keyed by Selector
  // identity, so this structure is safe to share/cache across captures.
  const index = indexRules(found, diagnostics)
  // Author custom-property definitions, grouped by token name, for the carry
  // decision (ADR 0019 §1). Lifted from the SAME flatten.
  const tokenDefs = collectTokenDefs(found)
  // ONE carry context for the whole capture: every kept layout decl filtered in
  // carry mode records its referenced token names here, so `decideTokens` sees the
  // complete reachability set across all lifted + inline rules at once.
  const carry: CarryContext = { referenced: new Set() }
  // Per-capture match state, keyed by the immutable Selector. Holds the matched
  // ids and the lazily-resolved decls for THIS capture only.
  const matches = new Map<Selector, SelectorMatch>()
  const matchOf = (sel: Selector): SelectorMatch => {
    let m = matches.get(sel)
    if (!m) {
      m = { ids: [], decls: null, computed: null }
      matches.set(sel, m)
    }
    return m
  }
  const seen = new Set<Selector>()

  for (const node of elNodes) {
    const el = node.el
    // Candidate selectors: those bucketed under this element's id, any of its
    // classes, its tag, plus the universal bucket. Dedup across the buckets.
    seen.clear()
    const candidates: Selector[] = []
    const collect = (list: Selector[] | undefined) => {
      if (!list) return
      for (const sel of list) {
        if (!seen.has(sel)) {
          seen.add(sel)
          candidates.push(sel)
        }
      }
    }
    if (el.id) collect(index.byId.get(el.id))
    for (const cls of el.classList) collect(index.byClass.get(cls))
    collect(index.byTag.get(el.tagName.toLowerCase()))
    collect(index.universal)

    for (const sel of candidates) {
      if (!safeMatches(el, sel.selector)) continue
      const m = matchOf(sel)
      // Resolve decls on first match against the FIRST matching element's
      // computed style — from the per-capture memo (`StyleCache.get`, the same
      // live view the walk snapshotted from; ADR 0025) instead of a second
      // getComputedStyle(el). In CARRY MODE (ADR 0019 §1) the decls keep their raw
      // `var()` and record referenced tokens into `carry`; the per-token freeze of
      // any UN-carried reference runs at emit, against this same `computed`.
      if (m.decls === null) {
        const computed = styles.get(el)
        m.computed = computed
        m.decls = filterLayoutDecls(sel.rule.style, computed, carry)
      }
      if (m.decls.length > 0) m.ids.push(node.id)
    }
  }

  // The carry decision (ADR 0019 §1): with the full reachability set known, pick
  // the responsive tokens to carry and emit their conditional definitions. The
  // freeze below then resolves only the var()s NOT in `decision.carried`. The
  // document-root computed style backs node 0 (the scoped root) when a carried
  // definition's own value has a leftover `var()` to freeze.
  const decision = decideTokens(
    carry.referenced,
    tokenDefs,
    elNodes,
    styles.get(doc.documentElement),
    styles,
  )

  // Emit in the index's bucket order — a stable, deterministic total order;
  // classify re-sorts by `(layered, spec, order)`. Each rule's decls are
  // finalized by `freezeUncarriedVars`: a `var()` whose token is carried stays
  // live (the plate's emitted definition drives it); every other `var()`
  // freezes to its capture-time value (the irreducible freeze). With no carried
  // tokens this resolves EVERY var() — the full ADR 0005 freeze.
  for (const sel of allSelectors(index)) {
    const m = matches.get(sel)
    if (!m || m.ids.length === 0 || !m.decls || m.decls.length === 0 || !m.computed) continue
    const rule: PlateRule = {
      ids: m.ids,
      decls: freezeUncarriedVars(m.decls, decision.carried, m.computed, decision.frozen),
      media: sel.media,
      // Only present when non-empty; a non-CQ plate emits no container field.
      ...(sel.container.length > 0 ? { container: sel.container } : {}),
      layered: sel.layered,
      spec: sel.spec,
      order: sel.order,
    }
    rules.push(rule)
    if (nodeById) for (const id of m.ids) attachAuthor(nodeById, id, rule)
  }

  // Inline styles sit above every author rule. They are filtered in freeze mode
  // (no carry context), so any `var()` in a style attribute resolves to its
  // capture-time value here. Deliberate, per ADR 0019 §1's irreducible-freeze
  // floor: an inline custom property is the JS-set / unreadable case the ADR
  // names as un-carriable, and the carry decision already ran above — routing
  // inline var()s through carry would risk a dangling reference.
  let order = 10_000_000
  for (const node of elNodes) {
    if (!hasInlineStyle(node.el)) continue
    const style = node.el.style
    if (!style || style.length === 0) continue
    // The node's computed style (the per-capture memo) for inline var() resolution too.
    const decls = filterLayoutDecls(style, styles.get(node.el))
    if (decls.length === 0) continue
    const rule: PlateRule = { ids: [node.id], decls, spec: SPEC_INLINE, order: order++ }
    rules.push(rule)
    if (nodeById) attachAuthor(nodeById, node.id, rule)
  }

  // The carried custom-property definitions (ADR 0019 §1): conditional token defs
  // anchored to node 0 (a `:root`/`html`/`*` token, emitted as `ids: []`) or to a
  // captured node (a redefined token). They flow through the existing PlateRule /
  // classify machinery — classify re-wraps each in its `@media`/`@container` and
  // emits `--token: value` on the scoped root or node, so the engine re-resolves
  // the live `var()`s left in the lifted rules. Empty when nothing varies.
  for (const rule of decision.rules) {
    rules.push(rule)
    // `ids: []` anchors the def to the scoped root (node 0); otherwise to the
    // redefined node. Mirror that onto the IR node's `decls.carried`.
    if (nodeById)
      for (const id of rule.ids.length > 0 ? rule.ids : [0]) attachCarried(nodeById, id, rule)
  }

  // The walk's self-standing rules (the `@container` text-rep bands, ADR 0019
  // §2). They already carry their own `ids`, `spec`, `order`, and `container`
  // condition, so they append verbatim; classify orders the whole set by
  // `(layered, spec, order)`. Empty in the common case (no multi-line rep).
  rules.push(...extraRules)

  return rules
}

function* allSelectors(index: RuleIndex): Generator<Selector> {
  for (const list of index.byId.values()) yield* list
  for (const list of index.byClass.values()) yield* list
  for (const list of index.byTag.values()) yield* list
  yield* index.universal
}

/** Attach a lifted CSSOM/inline rule to the IR node it targets (build phase, Stage 2). */
function attachAuthor(nodeById: ReadonlyMap<number, IRNode>, id: number, rule: PlateRule): void {
  const node = nodeById.get(id)
  if (!node) return
  const author = (node.decls.author ??= [])
  author.push(rule)
}

/** Attach a carried token-definition rule to its anchor IR node (build phase, Stage 2). */
function attachCarried(nodeById: ReadonlyMap<number, IRNode>, id: number, rule: PlateRule): void {
  const node = nodeById.get(id)
  if (!node) return
  const carried = (node.decls.carried ??= [])
  carried.push(rule)
}
