// Type-level test for the programmable capture walker (ADR 0018; ADR 0022 §5). It
// is compiled by the typecheck gate, not executed; the runtime `it` is a
// placeholder so vitest counts the file. The load-bearing assertion is the
// `@ts-expect-error` directive — it marks a line that genuinely fails to
// typecheck, or the build errors with "unused @ts-expect-error".
//
// The invariant under test: a walker's `element` may ONLY return a decision
// minted by `ctx.ignore()/bone()/keep()` (a `WalkerDecision`). A hand-built
// `PlateNode` can never cross the capture boundary, so xray keeps ownership of
// the Plate format — the `applyWalker` pass owns the lowering.
import { describe, it } from 'vitest'
import type { XrayCaptureWalker } from './measure.ts'

// Exported and never called; the type checker still checks the body. Returning
// the walkers makes each expression "used" (lint) without a runtime capture.
export function typeChecks(): XrayCaptureWalker[] {
  return [
    // (a) Returning a helper decision type-checks: ignore / bone / keep.
    { element: (ctx) => ctx.ignore() },
    { element: (ctx) => ctx.bone() },
    { element: (ctx) => ctx.bone({ kind: 'media' }) },
    { element: (ctx) => ctx.keep() },

    // (b) Branching between helpers type-checks — every arm is a `WalkerDecision`,
    // so the conditional unifies without a cast.
    {
      element: (ctx) => (ctx.el.classList.contains('drop') ? ctx.ignore() : ctx.keep()),
    },

    // (c) A hand-built `PlateNode` is a TYPE ERROR — it is not a `WalkerDecision`,
    // so the engine never lets an arbitrary node cross the capture boundary. This
    // directive is load-bearing: if `element` ever accepts a raw node again, the
    // unused `@ts-expect-error` fails the build.
    // @ts-expect-error a hand-built PlateNode is not a WalkerDecision (ADR 0018)
    { element: () => ({ id: 999, leaf: 'text-line', kids: [{ id: 1000 }] }) },
  ]
}

describe('capture walker types', () => {
  it('is a compile-time only suite', () => {})
})
