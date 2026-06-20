// Neutral leaf shared by the Measure walk (serialize.ts), the IR Distil passes
// (distil.ts), the DOM text-measurement (text-metrics.ts), and the author-CSS lift
// (css-extract.ts). It holds the per-capture computed-style memo, the walk's shared
// `WalkState`, plus the handful of low-level CSS-value helpers more than one of those
// modules reads, so the dependency graph stays strictly serialize.ts → {passes,
// text-metrics, css-extract} → leaves (this module, ir.ts, …) with no back-edges
// (ADR 0022).

import { type IRNode } from './ir.ts'
import { type PlateRule } from './plate.ts'
import { type DiagnosticsCollector } from './diagnostics.ts'

/**
 * A per-capture memo of `getComputedStyle(el)` keyed by element, scoped to ONE synchronous capture
 * (ADR 0025). The walk reads each entry node's own style through here, and the ancestor-walking
 * helpers (contrast, line-height, clipping) memoize the parents they climb. A `CSSStyleDeclaration`
 * is a live view, so this WeakMap lives only as long as the single capture that built it and is
 * then dropped — it is NEVER cached across captures or time (a stored style would silently go
 * stale; ADR 0025 forbids it). `get` lazily computes and stores on first lookup.
 */
export class StyleCache {
  readonly #win: Window
  readonly #map = new WeakMap<Element, CSSStyleDeclaration>()
  constructor(win: Window) {
    this.#win = win
  }
  get(el: Element): CSSStyleDeclaration {
    const hit = this.#map.get(el)
    if (hit) return hit
    const cs = this.#win.getComputedStyle(el)
    this.#map.set(el, cs)
    return cs
  }
}

export interface WalkState {
  nextId: number
  /**
   * The measured `IRNode`s in WALK PUSH ORDER. Each `defaultClassify` / `textBar` / text-rep build
   * site constructs its `IRNode` directly (linking it into its parent's `kids` and snapshotting
   * style / box / paint / salience inline), then pushes it here. The synthetic root is NOT pushed
   * (it is built in `walkAll`). `copyRules` iterates this list in push order; `emit` orders the
   * synthesized base rules by a node's position in it.
   */
  nodes: IRNode[]
  win: Window
  /** Per-capture computed-style memo, shared by the walk and the ancestor helpers. */
  styles: StyleCache
  /**
   * Dev-only diagnostics collector threaded through the walk and CSS lift. Each silent omission
   * site records its code here instead of swallowing; counts aggregate by code (diagnostics.ts).
   * Surfaced as `captureView`'s TRANSIENT `ViewIR.diagnostics` (mirroring
   * `ViewCapture.diagnostics`), never persisted (ADR 0008).
   */
  diagnostics: DiagnosticsCollector
  /**
   * Self-standing `PlateRule`s the walk emits directly (not derived from an Entry's
   * `fallback`/`sizeFallback`). Today this is only the `@container` line-count text rep (ADR 0019
   * §2): a wrapping text bone's reflow bands (`@container <name> (min-width: …) { height: calc(N ×
   * lh) }`), which are already-formed `PlateRule`s carrying a `container` condition, not per-node
   * fallback decls. `copyRules` appends them after the lifted author rules. Empty in the common
   * case, so a capture with no multi-line rep stays byte-identical to before this change.
   */
  extraRules: PlateRule[]
  /**
   * Memoized result of the `@container` text-rep feature gate (usable canvas text metrics +
   * `Intl.Segmenter`), probed lazily on the first multi-line run and reused for the rest of the
   * capture. Undefined until first probed; false in every layout-less env (happy-dom in tests),
   * where the rep is skipped and the pill-bar fallback keeps the path byte-identical to before.
   */
  canvasMetrics?: boolean
  /**
   * The reference area (px²) the Salience size axis normalizes a node against (ADR 0019 §4) — the
   * capture root's rendered area, measured once in `walkAll` and reused at every score site so all
   * nodes share one reference. 0 in a layout-less env (happy-dom: every rect is 0×0); the scorer
   * treats a non-positive reference as "disable the size axis", so a 0 here never divides by zero
   * and never affects the contrast-only Absorb decision.
   */
  rootArea: number
}

export function px(n: number): string {
  return `${Math.round(n * 10) / 10}px`
}

export function isInlineish(display: string): boolean {
  return display === 'inline' || display.startsWith('inline-')
}

/**
 * Does this container lay its children out in normal inline/block FLOW — so its inline-level
 * children coalesce into one run (ADR 0021 §2) — versus flex / grid / table, which blockify every
 * child into its own Bone? Keyed on the formatting context, not nesting depth: this is why two
 * flex-column labels stay two Bones while inline siblings in a block become one line.
 */
export function establishesInlineFlow(display: string): boolean {
  return !/\b(flex|grid|table|ruby)\b/.test(display)
}

export function pad(value: string): number {
  return Number.parseFloat(value) || 0
}

/** A computed value already resolved to a `px` length, or null (`normal`, a unitless ratio, ''). */
export function pxValue(value: string): number | null {
  return /(?:^|\s)-?[\d.]+px$/.test(value.trim()) ? Number.parseFloat(value) : null
}
