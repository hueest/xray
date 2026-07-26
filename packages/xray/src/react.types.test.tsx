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

// Typed fixtures (ADR 0031): plates whose env-file declare block (ADR 0034)
// types the virtual module as `Plate<F>`. `matching` recorded the full shape,
// `narrow` a subset (older but still-valid recording), `drifted` a shape the
// current `user` type has outgrown (no `name`).
declare const matchingPlate: Plate<{ id: number; name: string }>
declare const narrowPlate: Plate<{ id: number }>
declare const driftedPlate: Plate<{ id: number; label: string }>
declare const userMaybe: { id: number; name?: string } | undefined

// The ADR 0031 §3 encoding: `F` is the fixture export's `as const` type — readonly
// literal tuples — and the check strips readonly (`Recorded<F>`) before a bare
// `extends`. A recorded tuple of variant literals must satisfy a
// discriminated-union array, and literal-typed Map members must satisfy their
// widened declarations (method bivariance).
declare const constPlate: Plate<{
  readonly items: readonly [
    { readonly kind: 'a'; readonly n: 1 },
    { readonly kind: 'b'; readonly s: 'hi' },
  ]
}>
declare const constData: { items: ({ kind: 'a'; n: number } | { kind: 'b'; s: string })[] }
// GraphQL null-for-absent: the recorded null must satisfy BOTH `?: string` and
// `: string | null` spellings (Recorded<F> projects null to never).
declare const nullishPlate: Plate<{
  readonly template: { readonly title: 'Hi'; readonly ctaLink: null; readonly sub: null }
}>
declare const nullishData: { template: { title: string; ctaLink?: string; sub: string | null } }
declare const tuplePlate: Plate<[{ kind: 'a'; n: 1 }, { kind: 'b'; s: 'hi' }]>
declare const variants: ({ kind: 'a'; n: number } | { kind: 'b'; s: string })[]
declare const mapPlate: Plate<{ tags: Map<'a', 1>; when: Date }>
declare const mapData: { tags: Map<string, number>; when: Date }

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

    // (d) Typed fixtures (ADR 0031). A recorded Fixture whose shape satisfies the
    // `data` type compiles — including a NARROWER recording (`F extends T` is the
    // check direction: the replayed value must satisfy the declared type, and a
    // subset shape against an optional-field type does).
    <Skeleton key="fx-match" plate={matchingPlate} data={user}>
      {({ data }) => <span>{data.name}</span>}
    </Skeleton>,
    <Skeleton key="fx-narrow" plate={narrowPlate} data={userMaybe}>
      {({ data }) => <span>{data?.id}</span>}
    </Skeleton>,

    // A typed plate WITHOUT a data prop is unchecked — plain children, bare
    // loading, and suspense sites never participate in Replay, so drift cannot
    // affect them.
    <Skeleton key="fx-no-data" plate={driftedPlate} loading>
      <div />
    </Skeleton>,

    // DRIFT: `user` requires `name`, the recorded Fixture has none — the plate
    // prop fails with the branded FixtureOutOfDate type, at the call site, in the
    // consumer's own compile.
    // @ts-expect-error recorded Fixture no longer satisfies the data type — re-record it
    <Skeleton key="fx-drift" plate={driftedPlate} data={user}>
      {({ data }) => <span>{data.name}</span>}
    </Skeleton>,

    // (e) Exact-record encoding. A recorded tuple checks each element against
    // the discriminated union independently — the case literal-widening or
    // element-merging would false-positive (GraphQL __typename, variant tags).
    <Skeleton key="fx-tuple" plate={tuplePlate} data={variants}>
      {({ data }) => <span>{data.length}</span>}
    </Skeleton>,
    // The real emitted shape: readonly-everything from `as const`, stripped by
    // Recorded<F> before the extends — mutable-array data types stay satisfied.
    <Skeleton key="fx-const" plate={constPlate} data={constData}>
      {({ data }) => <span>{data.items.length}</span>}
    </Skeleton>,
    <Skeleton key="fx-null" plate={nullishPlate} data={nullishData}>
      {({ data }) => <span>{data.template.title}</span>}
    </Skeleton>,
    // Literal-membered Map satisfies its widened declaration.
    <Skeleton key="fx-map" plate={mapPlate} data={mapData}>
      {({ data }) => <span>{data.tags.size}</span>}
    </Skeleton>,
  ]
}

// A fixture-typed Plate stays assignable wherever a bare `Plate` is expected —
// the phantom parameter must never fracture the plain surface. (A function body
// like `typeChecks` above: compiled, never called.)
export function plateAssignability(typed: Plate<{ id: number; name: string }>): Plate {
  return typed
}

describe('Skeleton types', () => {
  it('is a compile-time only suite', () => {})
})
