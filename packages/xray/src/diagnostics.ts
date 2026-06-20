/**
 * Dev-only capture diagnostics: a small, serializable record of why a Plate may be incomplete or
 * lower-fidelity, plus the one shared formatter both the browser console (`client.ts`) and the Vite
 * server output (`index.ts`) print.
 *
 * Motivation: the serializer silently swallows a handful of capture omissions (an unreadable
 * cross-origin stylesheet, skipped pseudo-elements, off-screen bones dropped at the fold, an
 * over-the-limit subtree). Without these records, "why does this skeleton look wrong?" has no
 * answer short of reading the serializer source. Diagnostics surface those omissions as data the
 * capture returns, so a caller can log them; the core performs no console side effects.
 *
 * Strictly DEV-ONLY (ADR 0024, ADR 0008): this type is NOT a public package export and MUST NEVER
 * reach the persisted Plate JSON, the `GatedPlate`, or the production adapter. It rides on the
 * TRANSIENT `ViewIR.diagnostics` field only, which `captureView` populates and the dev client
 * strips before posting (so committed `plates/<name>.json` stays byte-identical to a capture that
 * produced no diagnostics).
 *
 * Centralized on purpose: invalid posted/committed plates (ADR 0023) reuse the same messaging, so
 * the code table and formatter stay reusable. Browser and server share `formatDiagnostic` so their
 * warning text cannot drift.
 *
 * @module
 */

/**
 * One aggregated capture omission. Serializable on purpose: NO DOM nodes, NO CSS bodies, NO
 * captured text — only a stable `code`, a human message, an optional aggregate `count`, and an
 * optional short `detail` (e.g. a plate name or a node count, never user content). `count`
 * aggregates occurrences: there is at most one record per code per capture, never one per skipped
 * selector or node.
 */
export interface CaptureDiagnostic {
  code: DiagnosticCode
  message: string
  count?: number
  detail?: string
}

/**
 * The closed set of capture-omission codes. Each maps to one silent site in the serializer (or an
 * existing oversized-capture warning folded into the same vocabulary). Kept as a const union so the
 * message table is exhaustive.
 */
export type DiagnosticCode =
  | 'unreadable-stylesheet'
  | 'unreadable-import'
  | 'skipped-dynamic-pseudo'
  | 'skipped-pseudo-element'
  | 'unsupported-rule'
  | 'dropped-tag'
  | 'dropped-subset'
  | 'dropped-cropped'
  | 'too-large'
  | 'invalid-plate-file'

/**
 * A mutable, aggregating collector threaded through the walk/CSS traversal. Each silent site calls
 * `add(code)` instead of swallowing; counts aggregate by code so a feed that drops 195 off-screen
 * bones yields ONE `dropped-cropped` record with `count: 195`, not 195 records. `detail` is
 * recorded from the first occurrence (the later ones only bump the count) and must stay free of
 * user content. `list()` returns the aggregated records, or an empty array.
 */
export interface DiagnosticsCollector {
  add: (code: DiagnosticCode, options?: { count?: number; detail?: string }) => void
  list: () => CaptureDiagnostic[]
}

export function createDiagnostics(): DiagnosticsCollector {
  // Insertion order is the report order — first-seen omission first.
  const byCode = new Map<DiagnosticCode, CaptureDiagnostic>()
  return {
    add(code, options) {
      const bump = options?.count ?? 1
      const existing = byCode.get(code)
      if (existing) {
        existing.count = (existing.count ?? 0) + bump
        return
      }
      byCode.set(code, {
        code,
        message: DIAGNOSTIC_MESSAGES[code],
        count: bump,
        ...(options?.detail !== undefined ? { detail: options.detail } : {}),
      })
    },
    list() {
      return [...byCode.values()]
    },
  }
}

/**
 * Build a single diagnostic record with its canonical message, for callers outside the walk that
 * surface a diagnostic directly (e.g. the client mapping `CaptureTooLargeError`, or the server
 * reporting an invalid committed plate). Uses the same message table as the collector so the text
 * is identical everywhere. `detail` must never carry user CSS or captured text.
 */
export function makeDiagnostic(
  code: DiagnosticCode,
  options?: { count?: number; detail?: string },
): CaptureDiagnostic {
  return {
    code,
    message: DIAGNOSTIC_MESSAGES[code],
    ...(options?.count !== undefined ? { count: options.count } : {}),
    ...(options?.detail !== undefined ? { detail: options.detail } : {}),
  }
}

/**
 * The human-readable message per code, shared verbatim by browser and server so their text cannot
 * drift. Messages describe the omission and its fidelity cost; none echoes user CSS or captured
 * text. `formatDiagnostic` appends the aggregate count and any short detail.
 */
const DIAGNOSTIC_MESSAGES: Record<DiagnosticCode, string> = {
  'unreadable-stylesheet':
    'could not read a stylesheet (likely cross-origin); rules from it were not captured',
  'unreadable-import':
    'could not read an @import (likely cross-origin); its rules were not captured',
  'skipped-dynamic-pseudo':
    'skipped interaction pseudo-class selectors (:hover, :focus, etc.) — a static skeleton never enters those states',
  'skipped-pseudo-element':
    'skipped pseudo-element selectors (::before, ::after, etc.) — v1 has no box to map them onto',
  'unsupported-rule': 'skipped CSS rules of a kind the serializer does not lift',
  'dropped-tag':
    'dropped hidden or non-visual elements (display:none, visibility:hidden, opacity:0, script/style/etc.)',
  'dropped-subset':
    'dropped bones wholly inside a larger solid bone — the superset renders the same area (overlapping bones collapse to their union)',
  'dropped-cropped':
    'dropped bones below the fold (off-screen at capture, in the viewport or a scroll container); real content fills in below without shifting the visible skeleton',
  'too-large':
    'capture exceeded a Collect limit and was skipped; the <Skeleton> likely sits too high in the tree',
  'invalid-plate-file':
    'a committed plate file could not be read (corrupt JSON, wrong shape, or a version mismatch) and was ignored',
}

/**
 * The single shared formatter. Renders one diagnostic to a stable one-line string used IDENTICALLY
 * by the browser console and the Vite server output, so the two can never disagree. Shape:
 * `<message> (<count>)[: <detail>]`. Count is omitted when 1 or absent; detail is appended only
 * when present and is never user content.
 */
export function formatDiagnostic(diagnostic: CaptureDiagnostic): string {
  const count =
    diagnostic.count !== undefined && diagnostic.count > 1 ? ` (${diagnostic.count})` : ''
  const detail = diagnostic.detail !== undefined ? `: ${diagnostic.detail}` : ''
  return `${diagnostic.message}${count}${detail}`
}

/** The grouped-warning header for a plate's diagnostics, shared by browser and server. */
export function diagnosticsHeader(name: string): string {
  return `[xray] "${name}" captured with reduced fidelity:`
}
