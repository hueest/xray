// Type-level test for the render-prop `<Skeleton>` surface (ADR 0014). It is
// compiled by the typecheck gate, not executed; the runtime `it` is a placeholder
// so vitest counts the file. The load-bearing assertions are the `@ts-expect-error`
// directives — each must mark a line that genuinely fails to typecheck, or the
// build errors with "unused @ts-expect-error".
import { describe, it } from 'vitest'
import type { ReactNode } from 'react'
import type { Plate } from './plate.ts'
import { Skeleton } from './react.tsx'

declare const plate: Plate
declare const user: { id: number; name: string }

// Returning the elements makes each expression "used" (lint) without a runtime
// render. The function is exported and never called; tsgo still checks the bodies.
export function typeChecks(): ReactNode[] {
  return [
    // (a) Plain children and a bare loading Skeleton compile with NO type
    // arguments — the generic default keeps every existing call site working.
    <Skeleton key="bare" plate={plate} loading />,
    <Skeleton key="children" plate={plate}>
      <div />
    </Skeleton>,
    <Skeleton key="suspense" plate={plate} suspense>
      <div />
    </Skeleton>,

    // (b) `data` infers `T` into the render prop — no explicit type argument
    // needed. The destructured `data` is typed as the `user` shape, so reading its
    // fields is allowed without a cast.
    <Skeleton key="infers" plate={plate} data={user}>
      {({ data }) => (
        <span>
          {data.id} {data.name}
        </span>
      )}
    </Skeleton>,

    // `root="manual"` surfaces the `ref` and infers `data`; the ref spreads onto
    // any host element without a cast (callback-ref contravariance).
    <Skeleton key="manual-ok" plate={plate} root="manual" data={user}>
      {({ data, ref }) => <section ref={ref}>{data.name}</section>}
    </Skeleton>,

    // (c) `root="manual"` with PLAIN children is a type error — the only way to
    // hand back the boundary-writing `ref` is the render prop, so manual requires
    // it.
    // @ts-expect-error root="manual" requires render-prop children, not plain ReactNode
    <Skeleton key="manual-plain" plate={plate} root="manual">
      <div />
    </Skeleton>,

    // `root="manual"` with NO children is likewise an error (children is required).
    // @ts-expect-error root="manual" requires render-prop children
    <Skeleton key="manual-empty" plate={plate} root="manual" />,
  ]
}

describe('Skeleton types', () => {
  it('is a compile-time only suite', () => {})
})
