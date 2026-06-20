import type { CaptureOptions, CaptureViewOptions } from '../measure.ts'
import { captureView, distilPlate } from '../measure.ts'
import { emit } from '../ir.ts'
import { serializePlateIR } from '../serialize.ts'
import type { GatedPlate, PlateNode, PlateRule } from '../plate.ts'
import type { CaptureDiagnostic } from '../diagnostics.ts'

/**
 * TEST-ONLY single-View entry points over the uniform bundle path (ADR 0022 §5). The production API
 * exposes no single-View capture, but many suites assert on per-stage projections; these compose
 * the same stages — measure (`captureView`, which snapshots `viewportHeight = window.innerHeight`)
 * → reduce (`distilPlate`, which reads that snapshot) → project — so those suites get a stable
 * single-View surface without a second production capture path. `project.test.ts` pins the 1-View
 * equivalence of this path to the live `captureElement`.
 */

/** `capture(roots, options): GatedPlate` — the persisted single-View shape. */
export function capture(roots: readonly Element[], options: CaptureOptions): GatedPlate {
  const plate = captureView(roots, {
    walker: options.walker,
    captureRootIsBoundary: options.captureRootIsBoundary,
  })
  plate.name = options.name
  distilPlate(plate)
  // `serializePlateIR` returns a `StoredPlate` (= GatedPlate + breakpoints); the
  // single-View branch classifies the one View with no gating, so `{ v, name, tree,
  // css }` is the whole persisted shape. Drop `breakpoints` to hand back the bare
  // GatedPlate this signature promises.
  const { v, name, tree, css } = serializePlateIR(plate)
  return { v, name, tree, css }
}

/** `captureIdForm(roots, options): { tree, rules, diagnostics? }` — the id-form single-View view. */
export function captureIdForm(
  roots: readonly Element[],
  options: CaptureViewOptions = {},
): { tree: PlateNode; rules: PlateRule[]; diagnostics?: CaptureDiagnostic[] } {
  const plate = captureView(roots, options)
  distilPlate(plate)
  const view = plate.views[0]
  if (!view) throw new Error('single-view-capture: captureView produced no View')
  const { tree, rules } = emit(view.bundle)
  return { tree, rules, ...(view.diagnostics ? { diagnostics: view.diagnostics } : {}) }
}
