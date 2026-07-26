---
status: accepted
---

# Typed fixtures: the recorded value's type rides the plate import, and drift fails the consumer's compile

> **Amends [ADR 0015](./0015-fixtures-dev-only-record-and-replay.md): the
> `Plate` surface gains a phantom type parameter, defaulted to `unknown`,
> so every existing use is untouched.**

A committed Fixture can stop satisfying the component's `data` type, and
Replay then hands the render prop a value the type no longer describes.
Carrying the recorded type on the Plate import makes the consumer compiler
report that drift at the `<Skeleton>` site, in any compile of the branch,
with xray not running.

## Decision

### 1. The type travels as `Plate<F>`

`Plate` gains a phantom parameter: `Plate<F = unknown>` with an optional,
never-populated `'~fixture'` field as the structural anchor. The tilde key
is the type-only-member convention, so it does not read as a runtime
property; a string key (not a `unique symbol`) is required because the
d.ts bundler declares symbols once per entry point and two copies never
unify. An unused type parameter is erased by assignability and the whole
check would silently no-op. The `unknown` default keeps `Plate<anything>` assignable to
bare `Plate`, so no existing surface changes. `F` is
`typeof import('./<name>').fixture`, derived live by tsc from the plate
module's fixture export (ADR 0034) and wired to the import specifier by the
generated env file (ADR 0032). The import specifier is the plate's
identity. There is no global registry and nothing for the consumer to wire.

### 2. The check sits on the `plate` prop, direction recorded-extends-consumer

`SkeletonProps<T, F>` intersects the plate prop with a conditional:
`unknown` (a no-op) when compatible, the branded `FixtureOutOfDate<F, T>`
when drifted. Nothing satisfies the brand, and its field names spell out
the fix ("re-record it").

- On `plate`, not `data`: `T` infers from `data`, and a conditional on the
  inference site would be circular with unreadable errors. The plate prop
  is downstream of both inferences.
- Recorded-extends-consumer: Replay substitutes the recorded value in front
  of the render prop, so the recorded type must satisfy the declared `data`
  type, not the reverse. Recordings narrower than `T` pass.
- Gates that never error: `F` is `unknown` or `any` (no Fixture, or a
  cyclic fixture's `as any` fallback), and `T` is exactly `undefined` (no
  `data` prop). Accepted gap: a render-prop site passing `data={undefined}`
  explicitly types the same as an absent prop, so it is unchecked even
  though Replay in `prefer` mode still substitutes there; an optional prop
  cannot distinguish the two spellings.

### 3. `as const` plus the `Recorded<F>` projection make bare `extends` the whole check

Without `as const`, TypeScript widens literals (`type: 'news'` becomes
`string`) and the check false-positives against every discriminated union
(GraphQL `__typename`, variant tags) on a fresh recording. With it, every
recorded literal extends both its widened primitive and any literal-union
discriminant, tuples check per-element against variant unions, and a value
retired from an enum is caught. The check needs no comparator and no
widening policy, and a fresh recording cannot false-positive.

`Recorded<F>` (react.core) applies two transformations:

- `readonly` is stripped deep. Property readonly-ness never affects
  assignability, but readonly tuples do not extend mutable `T[]`. Built-ins
  (`Date`, `Map`, `Set`, `RegExp`) pass through untouched.
- A recorded `null` projects to `never`. GraphQL data uses null for
  "absent" while consumer types spell absence as `?: string` or
  `: string | null`, and the recording cannot know which; `never` satisfies
  both. Dogfooding surfaced this: a fresh recording flagged on
  `ctaLink: null` against `ctaLink?: string`.

The check is `[Recorded<F>] extends [T]`. Two costs are accepted, both
about what a sample can honestly claim: `undefined`-valued keys are omitted
at record time (ADR 0033), and null unsoundness cuts one way: a field
recorded as `null` passes against any target, including a required
non-nullable one, and Replay then supplies `null` at runtime. The
alternative (preserving `null`) flags every fresh recording of a
nullable-in-practice field instead, which dogfooding showed is the common
case; a projection cannot know the target's spelling.

## Considered alternatives

- Infer and generate the fixture's type text at Record time: rejected.
  Every generator needs a widening and merging policy, every policy has
  soundness gaps, and the text duplicates what the recorded value already
  says. `typeof` an `as const` export has no policy.
- Third-party value-to-type generators: surveyed and rejected.
  quicktype-core has the right union semantics but a dependency set far
  past a dev budget; json-to-ts collapses variant arrays into an
  optional-property superset and never emits literals.
- A bespoke `Satisfies<F, T>` comparator that forgives widened types:
  rejected. `as const` removes the widening instead of forgiving it, with a
  stronger check and less type-level machinery.
- A target-aware `RecordedAgainst<F, T>` projection that preserves recorded
  `null` and accepts it per target spelling: rejected. It is the pairwise
  comparator above returning under another name; recursing `F` against `T`
  through unions, tuples, optional properties, and built-ins is the
  soundness-gap surface bare `extends` exists to avoid, spent on one
  documented edge.
- Removing the `T`-is-`undefined` gate for render-prop sites: rejected.
  `root="manual"` legally uses a render prop with no `data` at all, and
  without the gate every fixtured plate at such a site reports
  `FixtureOutOfDate` on a fresh recording, the failure class this design
  ranks above the soundness gap.

## Consequences

- Drift surfaces in CI and in the editor with xray not running.
  Re-recording the Fixture updates its inferred type.
- A cyclic fixture types as `any` and is deliberately unchecked.
- The check's plumbing is three small types (`Recorded`, `FixtureCheck`,
  `FixtureOutOfDate`). react.types.test.tsx pins the matrix, and the
  zero-config e2e (ADR 0032) pins it against a real `tsc`.
