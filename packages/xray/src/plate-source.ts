/**
 * Render a PLATE MODULE — `src/plates/<name>.ts`, the one committed file per Plate (ADR 0034):
 * `export const plate = <StoredPlate literal>` plus, when a Fixture is recorded, `export const
 * fixture = <value literal> as const`. Runs node-side in the dev server and reads both inputs as
 * pure STRUCTURE: the plate is validated JSON, the fixture is devalue's FLATTENED payload, string
 * values pass through `JSON.stringify` escaping, devalue's markers become constructor TEXT (`new
 * Date(…)`, `new Map([…])`), and nothing is ever instantiated or revived — page scripts control
 * every VALUE in the emitted file, never its syntax (the "never revives page content" invariant,
 * ADR 0015 as restated by ADR 0033 §4). That guarantee is what makes the READ side safe: the server
 * may `import()` the committed module (ADR 0034 §3) because every byte of its syntax was authored
 * here or by the repo's developers. The emitted module is erasable-syntax-only by construction, so
 * Node's type stripping executes it directly.
 *
 * The fixture export is the single source of both the replayed values (imported through the module
 * graph) and the drift-check type (`typeof import(...)` in the constant d.ts stub): `as const`
 * keeps every literal and turns arrays into tuples, so the check in react.core.tsx is bare
 * `extends` after a readonly-strip. Rules serving that:
 *
 * - `undefined`-valued object keys are OMITTED (a sample cannot distinguish optional-absent from
 *   present-undefined, and `exactOptionalPropertyTypes` consumers would false-positive).
 * - Cyclic graphs cannot be a literal: they fall back to a hoisted-shells form typed `as any` — the
 *   usual unchecked marker. Shared (non-cyclic) references inline as duplicates: value-equal, which
 *   is all replay data needs.
 * - Exotic payloads a render-input has no business being (typed arrays, ArrayBuffer, Temporal,
 *   devalue's very-sparse array encoding) throw — the Record POST answers 400 and nothing is
 *   written. Array holes render as `undefined`.
 *
 * Pretty by construction: inline while short, one member per line past a width cap, so the
 * committed file audits well even with no formatter in the repo.
 */

import type { StoredPlate } from './plate.ts'

// devalue's flattened-form sentinels (constants.js).
const UNDEFINED = -1
const HOLE = -2
const NAN = -3
const POSITIVE_INFINITY = -4
const NEGATIVE_INFINITY = -5
const NEGATIVE_ZERO = -6
const SPARSE = -7

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * An own `__proto__` key would render as a prototype-SETTING literal member (and as a
 * prototype-setting assignment in the hoisted form) — syntax semantics a page script must never
 * control. devalue cannot produce one, so refusing loses nothing legitimate.
 */
function guardKey(key: string): string {
  if (key === '__proto__') throw new Error('unsupported fixture object key: __proto__')
  return key
}

function keyLiteral(key: string): string {
  return IDENTIFIER.test(guardKey(key)) ? key : JSON.stringify(key)
}
/** Line width above which a composite literal breaks one member per line. */
const INLINE_CAP = 72

function indentLines(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** Join a composite inline when it fits, or break it one member per line. */
function group(open: string, close: string, members: string[], padded: boolean): string {
  const pad = padded ? ' ' : ''
  const inline = `${open}${pad}${members.join(', ')}${pad}${close}`
  if (!inline.includes('\n') && inline.length <= INLINE_CAP) return inline
  return `${open}\n${members.map((member) => indentLines(member)).join(',\n')}\n${close}`
}

function sentinelExpr(ref: number): string {
  switch (ref) {
    case UNDEFINED:
    case HOLE:
      return 'undefined'
    case NAN:
      return 'NaN'
    case POSITIVE_INFINITY:
      return 'Infinity'
    case NEGATIVE_INFINITY:
      return '-Infinity'
    case NEGATIVE_ZERO:
      return '-0'
    default:
      throw new Error(`unknown devalue sentinel ${ref}`)
  }
}

function isRef(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/** The child refs a node points at — the edges of the flattened graph. */
function childRefs(node: unknown): number[] {
  if (Array.isArray(node)) {
    if (typeof node[0] === 'string') {
      switch (node[0]) {
        case 'Set':
        case 'Map':
        case 'Object':
          return node.slice(1).filter(isRef)
        case 'null':
          // ["null", key, ref, key, ref, ...] — refs sit at even offsets from 2.
          return node.filter((entry, i): entry is number => i >= 2 && i % 2 === 0 && isRef(entry))
        default:
          return [] // Date/RegExp/BigInt/URL payloads are strings, not refs
      }
    }
    return node.filter(isRef)
  }
  if (typeof node === 'object' && node !== null) return Object.values(node).filter(isRef)
  return []
}

/** DFS for a back-edge: a cyclic graph cannot render as a literal. */
function hasCycle(nodes: unknown[]): boolean {
  const state = new Map<number, 'in-progress' | 'done'>()
  const visit = (ref: number): boolean => {
    if (ref < 0) return false
    const seen = state.get(ref)
    if (seen === 'in-progress') return true
    if (seen === 'done') return false
    state.set(ref, 'in-progress')
    for (const child of childRefs(nodes[ref])) if (visit(child)) return true
    state.set(ref, 'done')
    return false
  }
  return visit(0)
}

interface Ctx {
  nodes: unknown[]
  budget: { count: number }
}

function expr(ref: number, ctx: Ctx): string {
  if (ref < 0) return sentinelExpr(ref)
  ctx.budget.count -= 1
  if (ctx.budget.count <= 0) throw new Error('fixture payload too large to render')
  const node = ctx.nodes[ref]
  if (node === null) return 'null'
  switch (typeof node) {
    case 'string':
      return JSON.stringify(node)
    case 'number':
    case 'boolean':
      return String(node)
    case 'object':
      break
    default:
      throw new Error(`unsupported devalue node of type ${typeof node}`)
  }
  if (Array.isArray(node)) {
    if (typeof node[0] === 'string') return taggedExpr(node[0], node, ctx)
    if (node[0] === SPARSE) throw new Error('sparse arrays are not supported in fixtures')
    return group(
      '[',
      ']',
      node.map((child) => (isRef(child) ? expr(child, ctx) : fail(child))),
      false,
    )
  }
  // Plain object node: { key: ref }. UNDEFINED-valued keys are omitted.
  const fields: string[] = []
  for (const [key, child] of Object.entries(node)) {
    if (!isRef(child)) fail(child)
    if (child === UNDEFINED) continue
    fields.push(`${keyLiteral(key)}: ${expr(child, ctx)}`)
  }
  if (fields.length === 0) return '{}'
  return group('{', '}', fields, true)
}

function fail(node: unknown): never {
  throw new Error(`malformed devalue payload near ${JSON.stringify(node)}`)
}

function taggedExpr(tag: string, node: unknown[], ctx: Ctx): string {
  switch (tag) {
    case 'Date':
      if (typeof node[1] !== 'string') fail(node)
      return `new Date(${JSON.stringify(node[1])})`
    case 'RegExp': {
      if (typeof node[1] !== 'string') fail(node)
      if (node[2] === undefined) return `new RegExp(${JSON.stringify(node[1])})`
      if (typeof node[2] !== 'string') fail(node)
      return `new RegExp(${JSON.stringify(node[1])}, ${JSON.stringify(node[2])})`
    }
    case 'BigInt':
      if (typeof node[1] !== 'string' || !/^-?\d+$/.test(node[1])) fail(node)
      return `${node[1]}n`
    // The `as const` on the Set/Map ARGUMENT is load-bearing: an outer const
    // assertion does not reach constructor arguments, so without it members
    // widen (`new Set(['open'])` infers `Set<string>`) and the drift check
    // false-positives against literal-union members on a fresh recording.
    case 'Set':
      return `new Set(${group(
        '[',
        ']',
        node.slice(1).map((child) => (isRef(child) ? expr(child, ctx) : fail(child))),
        false,
      )} as const)`
    case 'Map': {
      const pairs: string[] = []
      for (let i = 1; i < node.length; i += 2) {
        const k = node[i]
        const v = node[i + 1]
        if (!isRef(k) || !isRef(v)) fail(node)
        pairs.push(group('[', ']', [expr(k, ctx), expr(v, ctx)], false))
      }
      return `new Map(${group('[', ']', pairs, false)} as const)`
    }
    case 'Object': {
      // Boxed primitive wrapper (new Number(3) etc.).
      const inner = node[1]
      if (!isRef(inner)) fail(node)
      return `Object(${expr(inner, ctx)})`
    }
    case 'URL':
      if (typeof node[1] !== 'string') fail(node)
      return `new URL(${JSON.stringify(node[1])})`
    case 'URLSearchParams':
      if (typeof node[1] !== 'string') fail(node)
      return `new URLSearchParams(${JSON.stringify(node[1])})`
    case 'null': {
      // Null-prototype object — rendered as a PLAIN literal: render-input data
      // never cares about the missing prototype, and a literal keeps `as const`.
      const fields: string[] = []
      for (let i = 1; i < node.length; i += 2) {
        const key = node[i]
        const child = node[i + 1]
        if (typeof key !== 'string' || !isRef(child)) fail(node)
        if (child === UNDEFINED) continue
        fields.push(`${keyLiteral(key)}: ${expr(child, ctx)}`)
      }
      return fields.length === 0 ? '{}' : group('{', '}', fields, true)
    }
    default:
      // TypedArrays, ArrayBuffer, Temporal, custom reducers — no business being
      // render-input data; refuse rather than corrupt.
      throw new Error(`unsupported fixture value type: ${tag}`)
  }
}

/**
 * Cyclic fallback: shells first, contents patched after, typed `as any` — a cycle has no literal
 * form and no finite type, so the drift check treats it as unchecked (the `any` gate).
 */
function renderHoisted(nodes: unknown[]): string {
  const ctx: Ctx = { nodes, budget: { count: 100_000 } }
  const containers = new Set<number>()
  for (const [i, node] of nodes.entries()) {
    if (typeof node !== 'object' || node === null) continue
    if (
      Array.isArray(node) &&
      typeof node[0] === 'string' &&
      !['Set', 'Map', 'null'].includes(node[0])
    )
      continue
    containers.add(i)
  }
  const refExpr = (ref: number): string => (containers.has(ref) ? `v${ref}` : expr(ref, ctx))
  const lines: string[] = []
  for (const ref of containers) {
    const node = nodes[ref]
    if (Array.isArray(node) && node[0] === 'Set') lines.push(`const v${ref} = new Set<unknown>()`)
    else if (Array.isArray(node) && node[0] === 'Map')
      lines.push(`const v${ref} = new Map<unknown, unknown>()`)
    else if (Array.isArray(node) && node[0] === 'null')
      lines.push(`const v${ref}: Record<string, unknown> = {}`)
    else if (Array.isArray(node)) lines.push(`const v${ref}: unknown[] = []`)
    else lines.push(`const v${ref}: Record<string, unknown> = {}`)
  }
  for (const ref of containers) {
    const node = nodes[ref]
    if (Array.isArray(node) && node[0] === 'Set') {
      for (const child of node.slice(1)) {
        if (!isRef(child)) fail(node)
        lines.push(`v${ref}.add(${refExpr(child)})`)
      }
    } else if (Array.isArray(node) && node[0] === 'Map') {
      for (let i = 1; i < node.length; i += 2) {
        const k = node[i]
        const v = node[i + 1]
        if (!isRef(k) || !isRef(v)) fail(node)
        lines.push(`v${ref}.set(${refExpr(k)}, ${refExpr(v)})`)
      }
    } else if (Array.isArray(node) && node[0] === 'null') {
      for (let i = 1; i < node.length; i += 2) {
        const key = node[i]
        const child = node[i + 1]
        if (typeof key !== 'string' || !isRef(child)) fail(node)
        if (child === UNDEFINED) continue
        lines.push(`v${ref}[${JSON.stringify(guardKey(key))}] = ${refExpr(child)}`)
      }
    } else if (Array.isArray(node)) {
      for (const child of node) {
        if (!isRef(child)) fail(node)
        lines.push(`v${ref}.push(${refExpr(child)})`)
      }
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        if (!isRef(child)) fail(node)
        if (child === UNDEFINED) continue
        lines.push(`v${ref}[${JSON.stringify(guardKey(key))}] = ${refExpr(child)}`)
      }
    }
  }
  return `// Cyclic fixture — no literal form exists; typed \`as any\` (unchecked).\n${lines.join(
    '\n',
  )}\nexport const fixture = ${refExpr(0)} as any\n`
}

/**
 * Whether the ROOT expression may carry `as const`. TS1355 limits const assertions to enum members
 * and string, number, boolean, array, and object literals; a constructor root (`new Date(…) as
 * const`) is a compile error in the committed file. Non-assertable roots lose nothing: `Date` has
 * no literal members, and Set/Map roots keep theirs through the argument assertion above.
 */
function constAssertableRoot(node: unknown): boolean {
  if (node === null) return false
  if (typeof node !== 'object') return true
  if (!Array.isArray(node)) return true
  if (typeof node[0] !== 'string') return true
  // 'BigInt' renders a bigint literal, 'null' a plain object literal; every
  // other tag renders a constructor or call expression.
  return node[0] === 'BigInt' || node[0] === 'null'
}

/** The `export const fixture` declaration, from the PARSED devalue payload. */
function fixtureDecl(payload: unknown): string {
  if (typeof payload === 'number') return `export const fixture = ${sentinelExpr(payload)}\n`
  if (!Array.isArray(payload) || payload.length === 0) throw new Error('malformed devalue payload')
  if (hasCycle(payload)) return renderHoisted(payload)
  const body = expr(0, { nodes: payload, budget: { count: 100_000 } })
  const assertion = constAssertableRoot(payload[0]) ? ' as const' : ''
  return `export const fixture = ${body}${assertion}\n`
}

/**
 * A plain-JSON value as a TypeScript literal — the StoredPlate side of the module. Same
 * pretty-printing and key discipline as the fixture side; `undefined` values are omitted the way
 * `JSON.stringify` omits them.
 */
function jsonExpr(value: unknown, budget: { count: number }): string {
  budget.count -= 1
  if (budget.count <= 0) throw new Error('plate too large to render')
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number in plate structure')
      return String(value)
    case 'boolean':
      return String(value)
    case 'object':
      break
    default:
      throw new Error(`unsupported plate value of type ${typeof value}`)
  }
  if (Array.isArray(value)) {
    return group(
      '[',
      ']',
      value.map((item) => jsonExpr(item, budget)),
      false,
    )
  }
  const fields: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    fields.push(`${keyLiteral(key)}: ${jsonExpr(item, budget)}`)
  }
  if (fields.length === 0) return '{}'
  return group('{', '}', fields, true)
}

// The blanket disable is the codegen convention (routeTree.gen.ts and friends):
// recorded values are data and legitimately carry whatever a consumer's lint
// config happens to ban (bare `new Date(…)`, magic numbers), a fight no
// per-rule list wins. Type checking is untouched — the drift check lives there.
const MODULE_HEADER = [
  '/* eslint-disable */',
  '// Generated by xray — one module per Plate (ADR 0034). Codegen owns this file:',
  '// value edits survive the next capture or record, comments and formatting do not',
  "// (writes re-render the whole module). Keep the fixture's `as const`.",
  '',
].join('\n')

/**
 * The full text of a `<name>.ts` plate module (ADR 0034): the StoredPlate structure as the default
 * export, and the recorded Fixture — devalue's parsed FLATTENED payload (`JSON.parse` of the wire
 * string: a number for bare sentinels, else the node array) — as `export const fixture`. Either
 * side may be absent (a Fixture recorded before first capture, a Plate with no Fixture), never
 * both. Throws on malformed or unsupported input; the caller answers 400 and writes nothing.
 */
export function renderPlateSourceModule(parts: {
  plate?: StoredPlate | null
  fixturePayload?: unknown
}): string {
  const sections: string[] = [MODULE_HEADER]
  if (parts.plate != null) {
    sections.push(`export const plate = ${jsonExpr(parts.plate, { count: 500_000 })}\n`)
  }
  if (parts.fixturePayload !== undefined) sections.push(fixtureDecl(parts.fixturePayload))
  return sections.join('\n')
}

/**
 * The generated env file (ADR 0032): the `/// <reference />` directive that wires the
 * `virtual:xray/plates/*` wildcard with zero tsconfig edits (it resolves regardless of the tsconfig
 * `types` allow-list — the same mechanism as Vite's own `src/vite-env.d.ts`), plus one
 * path-specific `declare module` per fixture-bearing plate. The specific declarations beat the
 * wildcard, typing each plate's import as `Plate<F>` with `F` derived LIVE by tsc from the plate
 * module's `fixture` export; import types resolve relative to THIS file, which sits in the same
 * directory as the modules they point at. The `xray-env.gen` stem is unreachable by any plate's
 * file family (names cannot contain dots) and safe from tsc's output heuristic (no
 * `xray-env.gen.ts` can exist).
 *
 * @internal
 */
export function renderEnvFile(fixtureNames: readonly string[]): string {
  const declarations = fixtureNames.map((name) =>
    [
      '',
      `declare module 'virtual:xray/plates/${name}' {`,
      "  import type { Plate } from '@hueest/xray'",
      `  const plate: Plate<typeof import('./${name}').fixture>`,
      '  export default plate',
      '}',
    ].join('\n'),
  )
  // The lint disable is load-bearing, not just convention: TS2439 forbids
  // relative import STATEMENTS inside ambient module blocks, so the inline
  // `import()` type is the only legal spelling — a consumer's
  // consistent-type-imports rule can never be satisfied here.
  return [
    '/* eslint-disable */',
    '// Generated by xray (ADR 0034). Codegen owns this file — it is re-rendered',
    '// whenever Fixtures change; do not edit. `noTypes: true` stops xray writing it.',
    '/// <reference types="@hueest/xray/virtual" />',
    ...declarations,
    '',
  ].join('\n')
}
