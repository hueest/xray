/**
 * Structural validation of a posted/committed `StoredPlate`, plus the single-CSS-declaration /
 * media-condition validators, for the dev `/__xray` endpoint and disk reads.
 *
 * NODE-ONLY (ADR 0023, ADR 0008). This module imports `valibot`, which must NEVER reach the browser
 * bundles: the dev capture client, the HUD, the React adapters, and the framework-neutral `core`
 * surface all ship to a browser, and none of them needs to validate an inbound payload. Only the
 * Vite plugin (`index.ts`, the package `.` entry, built with `platform: 'node'`) imports this file,
 * which keeps valibot out of every browser-facing dist chunk. Do NOT import this from `plate.ts`,
 * `css.ts`, or anything a render/browser path also imports, and do NOT re-export these helpers from
 * any public subpath — they stay private until a `doctor`-style tool creates a concrete external
 * need (ADR 0023).
 *
 * The endpoint accepts ONLY the artifact shape xray itself produces. The dev client posts a
 * finished `StoredPlate` — the whole Plate already projected in the browser (`serializePlateIR`,
 * ADR 0022) — so `parseStoredPlate` is the single validator: a post-classify `RenderNode` tree plus
 * an already-classified css blob, guarded for `<style>`-breakout only (a per-decl allowlist cannot
 * apply to a finished css string; see `isValidPlateCss`). The per-declaration / per-condition
 * validators (`isValidDeclaration` / `isValidCondition`) remain exported helpers — the css blob
 * already passed them AT CAPTURE TIME in the browser. Validation is necessary but not sufficient: a
 * committed `StoredPlate` is also untrusted (hand-edited or from git), so the render path
 * independently escapes raw-text `<style>` terminators (css-escape.ts).
 *
 * @module
 */
import * as v from 'valibot'
import { isLayoutProp } from './css.ts'
import { isValidPlateName } from './name.ts'
import { PLATE_VERSION } from './plate.ts'
import type { RenderNode, StoredPlate } from './plate.ts'

/**
 * Bounds chosen to be far above any real capture yet small enough that a hostile payload cannot
 * exhaust memory or wedge the merge. A `<Skeleton>` set too high is already caught by the
 * per-capture node guard and the serialized-size cap; these are the structural ceilings the schema
 * enforces before either runs.
 */
const MAX_TREE_NODES = 50_000
const MAX_BREAKPOINTS = 256
const MAX_TREE_DEPTH = 1_000
/**
 * A template node's repeat count (Template, ADR 0022). Far above any real feed, yet bounded so a
 * hostile `count` cannot drive an unbounded render-time string `.repeat`.
 */
const MAX_TEMPLATE_COUNT = 10_000
/** A single declaration is `prop: value [!important]`; real ones are short. */
const MAX_DECL_LENGTH = 2_000
/** A media/container condition string, generously bounded. */
const MAX_CONDITION_LENGTH = 1_000

/**
 * ASCII control characters (C0 range + DEL). Written with escaped code points so this module stays
 * a TEXT file: a literal control byte makes git treat it as binary and hides its lines from `grep`.
 * The class is identical in meaning to the previous literal-byte one (NUL through 0x1F, plus
 * 0x7F).
 */
// eslint-disable-next-line no-control-regex -- escaped C0/DEL class, intentional
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/**
 * Raw-text / markup terminators that must never appear in generated CSS, even when no bare `<`/`>`
 * is present: HTML comment delimiters, a CDATA opener, and a `</style` raw-text terminator. Shared
 * by the declaration and condition validators (case-insensitive).
 */
const RAW_TEXT_TERMINATORS = /<!--|-->|<!\[cdata\[|<\/style/iu

/**
 * Accept only a SINGLE CSS declaration of the form `property: value` with an optional trailing
 * `!important`, and only for a layout property the capture path would emit. This is the same
 * allowlist `filterLayoutDecls` applies (`isLayoutProp`), so a posted payload cannot persist paint-
 * or script-adjacent junk the real capture would never produce.
 *
 * Rejects anything that could escape the single-declaration context or the `<style>` raw-text
 * context downstream: rule braces (`{`/`}`), markup angle brackets (`<`/`>`), HTML comment / CDATA
 * delimiters, a `</style` terminator, ASCII control characters, and any extra semicolon-separated
 * declaration. A lone trailing `;` is tolerated (some serializers add one); a second declaration
 * after it is not.
 */
export function isValidDeclaration(decl: string): boolean {
  if (typeof decl !== 'string') return false
  if (decl.length === 0 || decl.length > MAX_DECL_LENGTH) return false
  // No control characters (includes newlines, NUL, etc.).
  if (CONTROL_CHARS.test(decl)) return false
  // No characters that could break out of a declaration, a rule block, or the
  // raw-text <style> the rendered CSS lands in.
  if (/[{}<>]/.test(decl)) return false
  // Belt-and-braces for the raw-text terminators even without a literal `<`/`>`
  // (the bracket check already covers these, but keep the intent explicit).
  if (RAW_TEXT_TERMINATORS.test(decl)) return false
  // Split off a single optional trailing `;`, then forbid any further `;`-joined
  // declaration — the endpoint takes one declaration per `decls[]` entry.
  const trimmed = decl.trim().replace(/;\s*$/, '')
  if (trimmed.includes(';')) return false
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return false
  const prop = trimmed.slice(0, colon).trim().toLowerCase()
  const value = trimmed.slice(colon + 1).trim()
  if (value.length === 0) return false
  // Strip an optional `!important` and require the property to be a layout
  // property — the only kind a plate carries (css.ts / ADR 0003).
  const body = value.replace(/\s*!\s*important\s*$/i, '').trim()
  if (body.length === 0) return false
  // Carried custom-property DEFINITIONS (ADR 0019 §1): the plate emits a
  // layout-reachable token's own definition (`--gap: 8px`, `--pad: var(--space)`)
  // on the scoped root so a kept `var(--gap)` re-resolves at render. These are NOT
  // layout properties (`isLayoutProp` excludes `--*`) but ARE a declaration the
  // capture path now legitimately produces, so a `--name` must be accepted. Its
  // value has already passed every breakout check above (no `{}<>`, no `</style`,
  // no control chars, no second `;`-joined declaration) and a custom property is
  // inert until a `var()` consumes it. The accepted name shape matches the only
  // source of carried names (`referencedTokens`' `--[\w-]+`), so it is exact, not
  // a widening of the trust boundary.
  if (prop.startsWith('--')) return /^--[\w-]+$/u.test(prop)
  return isLayoutProp(prop)
}

/**
 * Accept only a media/container condition (prelude) of the shape xray actually emits, and reject
 * anything that could break OUT of the `@media`/`@container` prelude into a top-level rule when
 * `classify` interpolates it RAW into the generated CSS (`@media <condition> { ... }`). The capture
 * path produces: synthesized span conditions `(min-width: 768px)` / `(max-width: 767.98px)`, author
 * media text such as `screen and (min-width: 768px)`, `(orientation: landscape)`, comma media lists
 * `screen, print`, and container queries like `(min-width: 400px)`, a named `sidebar (min-width:
 * 400px)`, or a style query `style(--x: 1)`. Authors may also use Media Queries Level 4 range
 * syntax, which browsers serialize into `mediaText`/`containerQuery` verbatim (`(width >= 600px)`,
 * `(400px < width <= 700px)`), so a condition can legitimately carry a bare `<`/`>` — those are
 * allowed.
 *
 * Rejects: rule braces (`{`/`}`) and a `;` — the CSS-rule breakout vectors — CSS comment delimiters
 * (`/*` / `*\/`), the raw-text/markup terminators (`</style`, `<!--`, `-->`, `<![CDATA[`), ASCII
 * control characters, and any over-length string.
 */
export function isValidCondition(condition: string): boolean {
  if (typeof condition !== 'string') return false
  if (condition.length === 0 || condition.length > MAX_CONDITION_LENGTH) return false
  if (CONTROL_CHARS.test(condition)) return false
  // Braces and a semicolon are the CSS-rule breakout. Bare angle brackets are
  // ALLOWED: Media Queries Level 4 range syntax (`(width >= 600px)`) keeps them
  // in the serialized condition, and a lone `<`/`>` can neither terminate the
  // `<style>` raw text (only the literal `</style` can, caught below) nor break
  // the rule structure.
  if (/[{};]/.test(condition)) return false
  // CSS comment delimiters never appear in a real prelude and could comment out
  // the trailing `{ ... }` to strand an injected rule.
  if (condition.includes('/*') || condition.includes('*/')) return false
  if (RAW_TEXT_TERMINATORS.test(condition)) return false
  return true
}

/** A finite number, no NaN/Infinity (valibot's `number()` already rejects NaN). */
const finiteNumber = v.pipe(v.number(), v.finite())

const leafSchema = v.picklist(['text-line', 'text-block', 'media', 'box', 'hidden'] as const)

/**
 * Depth + total-node guard shared by the recursive node schema. The recursive `array(lazy(...))`
 * bounds breadth per level; this guards total depth so a long thin chain cannot recurse without
 * limit, and the running `count` bounds the total node budget so a fanned-out payload cannot
 * exhaust memory.
 */
function treeWithinLimits(root: unknown): boolean {
  let count = 0
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_TREE_DEPTH) return false
    if (++count > MAX_TREE_NODES) return false
    if (typeof node !== 'object' || node === null) return true
    const kids = (node as { kids?: unknown }).kids
    if (!Array.isArray(kids)) return true
    for (const kid of kids) if (!walk(kid, depth + 1)) return false
    return true
  }
  return walk(root, 0)
}

/** A finished plate's css blob, generously bounded (post-classify, whole-plate). */
const MAX_PLATE_CSS_LENGTH = 4_000_000
/**
 * A NUL byte — the one control character that must never reach the rendered `<style>`. Unlike the
 * per-declaration validator, the whole-plate css blob legitimately carries newlines/tabs
 * (`classify` joins rules with `\n`), so the broad `CONTROL_CHARS` class does NOT apply here.
 */
// eslint-disable-next-line no-control-regex -- a lone NUL, intentional
const NUL = /\u0000/u

/**
 * Validate a STORED, already-classified css blob (ADR 0022). The trust model differs from a
 * pre-classify `decls[]` array: a `StoredPlate.css` is the WHOLE plate's content-addressed CSS — a
 * string of selectors, `{ ... }` rule blocks, and `@media`/`@container` at-rules — so the
 * per-declaration `isValidDeclaration` allowlist (which forbids `{}` and re-checks `isLayoutProp`)
 * cannot apply: it would reject every real plate. Braces, newlines, and bare `<`/`>` (Media Queries
 * Level 4 range syntax, `@media (width >= 600px)`) are all legitimate here. The css was produced by
 * `filterLayoutDecls`-filtered decls at capture time in the browser; the disk guard covers only the
 * security boundary the render path also enforces: no `<style>` raw-text breakout. Reject the
 * raw-text / markup terminators (`</style`, `<!--`, `-->`, `<![CDATA[`) and a NUL byte, and bound
 * the length. The render path independently escapes these (`escapeStyleText`, css-escape.ts) — that
 * stays as the belt; this is the braces. A `StoredPlate` is untrusted (hand-edited / arriving via
 * git).
 */
function isValidPlateCss(css: string): boolean {
  if (typeof css !== 'string') return false
  if (css.length > MAX_PLATE_CSS_LENGTH) return false
  if (NUL.test(css)) return false
  if (RAW_TEXT_TERMINATORS.test(css)) return false
  return true
}

/**
 * Recursive `RenderNode` — the POST-classify tree shape (plate.ts): no `id` (ids are stripped at
 * classify), an optional content-class string `cls`, and the same `leaf`/`ref`/`count`/`kids` the
 * renderer reads. Mirrors `plateNodeSchema` minus `id`, plus a bounded `cls`. Depth/breadth bounded
 * by the shared `treeWithinLimits`.
 */
const renderNodeSchema: v.GenericSchema<RenderNode> = v.pipe(
  v.object({
    leaf: v.optional(leafSchema),
    ref: v.optional(v.pipe(v.string(), v.check(isValidPlateName, 'invalid stitch ref'))),
    cls: v.optional(v.pipe(v.string(), v.maxLength(MAX_DECL_LENGTH))),
    count: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TEMPLATE_COUNT)),
    ),
    kids: v.optional(v.pipe(v.array(v.lazy(() => renderNodeSchema)), v.maxLength(MAX_TREE_NODES))),
  }),
  v.check((node) => treeWithinLimits(node), 'tree exceeds size or depth limits'),
)

/**
 * The committed/posted `StoredPlate` shape (plate.ts): the whole plate already projected in the
 * browser. Validated as untrusted input — a `StoredPlate` on disk is untrusted (hand-edited or
 * arriving via git). `tree` is a `RenderNode` (post-classify, nullable for a capture-less plate);
 * `css` is the already-classified blob, guarded for `<style>`-breakout only (`isValidPlateCss`,
 * above). `breakpoints` are finite non-negative numbers, bounded but NOT renormalized (the file is
 * the source of truth). `v` must be the current `PLATE_VERSION`.
 */
const storedPlateSchema: v.GenericSchema<StoredPlate> = v.object({
  v: v.literal(PLATE_VERSION),
  name: v.pipe(v.string(), v.check(isValidPlateName, 'invalid plate name')),
  breakpoints: v.pipe(v.array(v.pipe(finiteNumber, v.minValue(0))), v.maxLength(MAX_BREAKPOINTS)),
  tree: v.nullable(renderNodeSchema),
  css: v.pipe(v.string(), v.check(isValidPlateCss, 'invalid plate css')),
})

/**
 * Parse a committed/posted `StoredPlate` against its schema (ADR 0022). Returns the typed
 * `StoredPlate` on success or `null` on any structural failure (corrupt object, wrong shape,
 * version mismatch, an injected `<style>` terminator in the css, an oversized/over-deep tree). The
 * disk readers and the POST handler map `null` to an empty plate / a generic 400 and never echo the
 * payload — a malformed or hostile stored plate degrades to empty rather than breaking the build or
 * smuggling a `<style>`-escaping css blob through render.
 */
export function parseStoredPlate(value: unknown): StoredPlate | null {
  const result = v.safeParse(storedPlateSchema, value)
  return result.success ? result.output : null
}
