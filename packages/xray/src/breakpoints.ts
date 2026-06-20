import type { PlateRule } from './plate.ts'

/**
 * Per-plate breakpoint derivation (ADR 0004): the width thresholds that could change this plate
 * come from the `@media` conditions on its own copied rules plus the queries the app evaluated
 * through `matchMedia` during capture. Thresholds partition the width axis into Views; identical
 * captures in adjacent Views collapse at Serialize.
 */

const FONT_SIZE_PX = 16

/** A breakpoint is the first integer px width of the View ABOVE the boundary. */
function thresholdsOf(condition: string): number[] {
  const out: number[] = []
  const toPx = (value: string, unit: string) =>
    Number.parseFloat(value) * (unit === 'px' ? 1 : FONT_SIZE_PX)
  const push = (raw: number, exclusiveBelow: boolean) => {
    // min-width: X / width >= X → View starts at X.
    // max-width: Y / width <= Y → the NEXT View starts just above Y.
    const bp = exclusiveBelow ? (Number.isInteger(raw) ? raw + 1 : Math.ceil(raw)) : Math.ceil(raw)
    if (Number.isFinite(bp) && bp > 0) out.push(bp)
  }
  for (const m of condition.matchAll(/min-width:\s*([\d.]+)(px|em|rem)/g)) {
    push(toPx(m[1] ?? '', m[2] ?? 'px'), false)
  }
  for (const m of condition.matchAll(/max-width:\s*([\d.]+)(px|em|rem)/g)) {
    push(toPx(m[1] ?? '', m[2] ?? 'px'), true)
  }
  // Range syntax (`width OP N` / `N OP width`). `exclusiveBelow` is true exactly
  // when the operator bounding the View from BELOW is strict — i.e. the View
  // above the boundary does not start at the matched width itself:
  //   `width >= X` → View starts AT X            → inclusive  (exclusiveBelow=false)
  //   `width >  X` → View starts ABOVE X         → exclusive  (exclusiveBelow=true)
  //   `width <= Y` → this View includes Y; next starts at Y+1 → exclusive
  //   `width <  Y` → this View excludes Y; next starts AT Y    → inclusive
  //   `X <= width` ≡ `width >= X` → inclusive;  `X < width` ≡ `width > X` → exclusive
  // The captured operator group's missing `=` (strict) is what flips it.
  for (const m of condition.matchAll(/width\s*(>=?)\s*([\d.]+)(px|em|rem)/g)) {
    push(toPx(m[2] ?? '', m[3] ?? 'px'), m[1] === '>')
  }
  for (const m of condition.matchAll(/width\s*(<=?)\s*([\d.]+)(px|em|rem)/g)) {
    push(toPx(m[2] ?? '', m[3] ?? 'px'), m[1] === '<=')
  }
  for (const m of condition.matchAll(/([\d.]+)(px|em|rem)\s*(<=?)\s*width/g)) {
    push(toPx(m[1] ?? '', m[2] ?? 'px'), m[3] === '<')
  }
  return out
}

/** Width thresholds for this plate: its rules' media conditions + the app's matchMedia queries. */
export function deriveBreakpoints(
  rules: readonly PlateRule[],
  matchMediaQueries: readonly string[] = [],
): number[] {
  const set = new Set<number>()
  for (const rule of rules) {
    for (const condition of rule.media ?? []) {
      for (const bp of thresholdsOf(condition)) set.add(bp)
    }
  }
  for (const query of matchMediaQueries) {
    for (const bp of thresholdsOf(query)) set.add(bp)
  }
  return [...set].toSorted((a, b) => a - b)
}

export interface ViewSpan {
  min?: number
  max?: number
}

/** The View interval `[min, max)` a given viewport width falls into. */
export function viewSpanFor(width: number, breakpoints: readonly number[]): ViewSpan {
  let min: number | undefined
  let max: number | undefined
  for (const bp of breakpoints) {
    if (bp <= width) min = bp
    else {
      max = bp
      break
    }
  }
  return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
}

/** The media condition under which a span is ACTIVE (both bounds AND together). */
export function spanConditions(span: ViewSpan): string[] {
  const out: string[] = []
  if (span.min !== undefined) out.push(`(min-width: ${span.min}px)`)
  if (span.max !== undefined) out.push(`(max-width: ${span.max - 0.02}px)`)
  return out
}

/** The media conditions under which a span is INACTIVE (each gates separately). */
export function complementConditions(span: ViewSpan): string[] {
  const out: string[] = []
  if (span.min !== undefined) out.push(`(max-width: ${span.min - 0.02}px)`)
  if (span.max !== undefined) out.push(`(min-width: ${span.max}px)`)
  return out
}
