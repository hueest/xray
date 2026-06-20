import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { serializePlateIR } from './serialize.ts'
import { serializePlate } from './chunk.ts'
import { irFromTree, type PlateIR } from './ir.ts'
import { PLATE_VERSION, type PlateNode, type PlateRule } from './plate.ts'

// The golden safety net for the in-browser projection (ADR 0022). It pins the WHOLE
// projection — `serializePlateIR` (emit + the multi-View merge/gate + classify,
// content-addressed CSS, ADR 0007) followed by the gen-side `serializePlate`
// (chunking + stitches) — from one synthetic, committable input, so a drift in
// emitted markup or CSS is caught offline with no browser or auth. (It is a change-detector,
// not a byte gate — the snapshot regenerates.)
//
// The fixtures are already post-reduction `{ tree, rules }` (captured offline), so
// the IR reduction passes are NOT re-run; we go straight from a hand-built `PlateIR`
// (each View's `{ tree, rules }` reconstructed into an entry-less bundle via
// `irFromTree`, the rules carried as the bundle's `extraRules` so `emit` rebuilds
// them verbatim) through `serializePlateIR` → `serializePlate`.

/** A View bundle from a raw `{ tree, rules }` capture: rules ride as `extraRules`. */
function viewOf(width: number, tree: PlateNode, rules: PlateRule[]): PlateIR['views'][number] {
  return { width, bundle: irFromTree(tree, rules) }
}

// A two-view plate exercising every bone kind, a stitch, shared decls (so
// content-addressing must dedupe across nodes), and a per-view media gate.
const FIXTURE: PlateIR = {
  name: 'golden',
  breakpoints: [768],
  views: [
    viewOf(
      400,
      {
        id: 0,
        kids: [
          {
            id: 1,
            kids: [
              { id: 2, leaf: 'media' },
              { id: 3, leaf: 'text-line' },
              { id: 4, ref: 'avatar' },
            ],
          },
        ],
      },
      [
        { ids: [1], decls: ['display: flex', 'gap: 8px'], spec: 10, order: 1 },
        {
          ids: [2],
          decls: ['width: 48px', 'height: 48px', 'border-radius: 9999px'],
          spec: 20,
          order: 2,
        },
        { ids: [3], decls: ['width: 120px', 'height: 16px'], spec: 20, order: 3 },
      ],
    ),
    viewOf(
      1200,
      {
        id: 0,
        kids: [
          {
            id: 1,
            kids: [
              { id: 2, leaf: 'text-block' },
              { id: 3, leaf: 'box' },
            ],
          },
        ],
      },
      [
        // Same decls as the narrow view's container — classify must collapse
        // both to one shared class token.
        { ids: [1], decls: ['display: flex', 'gap: 8px'], spec: 10, order: 1 },
        { ids: [2], decls: ['width: 320px', 'height: 48px'], spec: 20, order: 2 },
        { ids: [3], decls: ['width: 80px', 'height: 80px'], spec: 20, order: 3 },
      ],
    ),
  ],
}

describe('node-side plate pipeline (golden)', () => {
  it('projects a 2-view PlateIR deterministically', () => {
    // Snapshot BOTH artifacts (two-artifact contract): the lowered tree-only
    // Plate AND the stored css string, so the golden keeps guarding css drift
    // even though `serializePlate` no longer carries the css.
    const stored = serializePlateIR(FIXTURE)
    expect({ plate: serializePlate(stored), css: stored.css }).toMatchSnapshot()
  })

  it('is a pure function of its input (same input → same output)', () => {
    expect(serializePlate(serializePlateIR(FIXTURE))).toEqual(
      serializePlate(serializePlateIR(FIXTURE)),
    )
    expect(serializePlateIR(FIXTURE).css).toBe(serializePlateIR(FIXTURE).css)
  })
})

// The real-content golden. A committed dogfood capture of the website's product
// demo (apps/website ComparisonDemo), taken once via `captureIdForm` and replayed
// offline, so it is deterministic and needs no browser or auth. Where the synthetic
// FIXTURE above pins STRUCTURE, this pins the content-driven paths: real geometry,
// 96 author rules across media/text/box leaves, and container-query content. A
// regression in those paths moves this snapshot even when the synthetic one stays
// green. The on-disk fixture stores raw per-View input (a `captures` key of
// `ViewCapture` `{ width, tree, rules }`) rather than a projected StoredPlate, so
// we zip each into a PlateIR View.
const dogfood: {
  name: string
  breakpoints: number[]
  captures: { width: number; tree: PlateNode; rules: PlateRule[] }[]
} = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/dogfood-product-page.json', import.meta.url)),
    'utf8',
  ),
)

function dogfoodPlate(): PlateIR {
  return {
    name: dogfood.name,
    breakpoints: dogfood.breakpoints,
    views: dogfood.captures.map((c) => viewOf(c.width, c.tree, c.rules)),
  }
}

describe('node-side pipeline over a real dogfood capture (golden)', () => {
  it('projects the dogfood product-page plate deterministically', () => {
    // Both artifacts snapshotted — see the synthetic golden above.
    const stored = serializePlateIR(dogfoodPlate())
    expect({ plate: serializePlate(stored), css: stored.css }).toMatchSnapshot()
  })
})

// Optional local smoke check: this suite runs ONLY against a maintainer-local,
// gitignored `example-capture.json` at the repo root — a full raw capture of real
// app data, too large to commit. It self-skips on fresh clones and in CI (the
// file is absent there); never committed, never snapshotted. The committed
// `__fixtures__/dogfood-product-page.json` suite above is the always-on golden.
// This one asserts only that a real capture flows through the projection cleanly
// and deterministically.
const examplePath = fileURLToPath(new URL('../../../example-capture.json', import.meta.url))

describe.skipIf(!existsSync(examplePath))('node-side pipeline over example-capture.json', () => {
  // Smoke + determinism only — NOT a drift guard (no committed snapshot, since the
  // input is untracked). The tracked dogfood golden is the real tripwire.
  it('flows a real capture through serializePlateIR → serializePlate without error', () => {
    const raw: { name: string; capture: { width: number; tree: PlateNode; rules: PlateRule[] } } =
      JSON.parse(readFileSync(examplePath, 'utf8'))
    const plate: PlateIR = {
      name: raw.name,
      breakpoints: [],
      views: [viewOf(raw.capture.width, raw.capture.tree, raw.capture.rules)],
    }
    const stored = serializePlateIR(plate)
    const out = serializePlate(stored)
    expect(out.chunks).not.toBeNull()
    // Css lives on the stored artifact — the lowered Plate is tree-only.
    expect(stored.css.length).toBeGreaterThan(0)
    expect(serializePlate(serializePlateIR(plate))).toEqual(out)
  })
})

// Keep PLATE_VERSION referenced so a version bump that should move the golden is
// not silently decoupled from this file (the projected plate carries `v`).
it('projects under the current PLATE_VERSION', () => {
  expect(serializePlate(serializePlateIR(FIXTURE)).v).toBe(PLATE_VERSION)
})
