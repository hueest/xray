import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as core from './core.ts'

// The public package boundary (the plan "public core surface and docs alignment").
// `@hueest/xray/core` is the public framework-neutral capture/render surface
// (ADR 0008); low-level serialization is reachable *through* core, not as a
// separate `./serialize` subpath; and the dev bootstrap implementation modules
// (client, HUD) are private behind `./internal/*`, resolvable only for the
// plugin-generated consumer-side bootstrap, never as top-level public names.
//
// This asserts against the `exports` map shape rather than a post-build module
// resolution: vitest runs against source, so a real subpath resolution would
// require building first. The map is the published contract, so checking its
// shape catches the same regressions without a build step.
const pkg: { exports: Record<string, unknown> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)

describe('package exports map', () => {
  const keys = Object.keys(pkg.exports)

  it('keeps the four public subpaths', () => {
    expect(keys).toEqual(
      expect.arrayContaining(['.', './core', './react', './react/dev', './virtual']),
    )
  })

  it('drops the public ./serialize subpath (it folds into ./core)', () => {
    expect(keys).not.toContain('./serialize')
  })

  it('makes the dev bootstrap modules private under ./internal/*', () => {
    // client/hud are no longer top-level public names…
    expect(keys).not.toContain('./client')
    expect(keys).not.toContain('./hud')
    // …but stay resolvable for the plugin-generated consumer-side bootstrap.
    expect(keys).toContain('./internal/client')
    expect(keys).toContain('./internal/hud')
  })
})

describe('@hueest/xray/core surface', () => {
  it('exposes the supported capture/serialize symbols through core', () => {
    // The curated capture/serialize surface, now reachable only via `core`.
    // (The old `./serialize` subpath mapped to the whole module, so it also
    // leaked `audit` / `clampToClipping`; those were never curated public API
    // and stay internal, reached via source imports. The single-View `capture` /
    // `captureIdForm` internals were collapsed onto the uniform bundle path that
    // backs `captureElement` and dropped from the surface entirely — ADR 0022 §5.)
    expect(typeof core.captureElement).toBe('function')
    expect(typeof core.serializePlate).toBe('function')
    expect(typeof core.CaptureTooLargeError).toBe('function')
    // `CaptureOptions` is a type (erased at runtime); its reachability is covered
    // by typecheck, exercised by the import above.
  })

  it('exposes the programmable capture walker surface (ADR 0018)', () => {
    // `defineXrayCaptureWalker` is the public typed identity wrapper; the
    // `XrayCaptureWalker` / `CaptureWalkerContext` types ride alongside it
    // (erased at runtime, reachability covered by typecheck).
    expect(typeof core.defineXrayCaptureWalker).toBe('function')
    const walker: core.XrayCaptureWalker = { element: (ctx) => ctx.keep() }
    expect(core.defineXrayCaptureWalker(walker)).toBe(walker)
  })

  it('exposes the two-artifact css surface (plan 005 round 2)', () => {
    // Consumers of the vanilla core compose css themselves: BASE_CSS is public,
    // and `composeCss` is the standard `${BASE_CSS}\n${css}` composition for
    // `renderPlateHtml(plate, css)` / `<Skeleton plate css>`.
    expect(typeof core.BASE_CSS).toBe('string')
    expect(core.BASE_CSS).toContain('@keyframes xr-pulse')
    expect(typeof core.composeCss).toBe('function')
    const composed = core.composeCss('.x { width: 1px }')
    expect(composed.startsWith(core.BASE_CSS)).toBe(true)
    expect(composed.endsWith('.x { width: 1px }')).toBe(true)
  })
})
