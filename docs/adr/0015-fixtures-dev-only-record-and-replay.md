---
status: accepted
---

# Fixtures: dev-only render-input record and replay

Capturing a faithful skeleton needs the component rendered in the state to
skeletonize. Some states are hard to reach live (an empty account, an
auth-walled view, a flaky or slow API), and even reachable ones _drift_: the
captured skeleton silently changes shape as real data changes. Fixtures give
deterministic, reproducible capture without reaching those states by hand every
time.

## Decision

A **Fixture** is dev-only stored render-_input_ data for a `<Skeleton>`: the
`data` (ADR 0014) that produced a Plate, serialized to a sidecar
`plates/<name>.fixture.json`. Two verbs, both dev-only, both flowing through the
render-prop `data`:

- **Record** — write the current `data` prop to the Fixture.
- **Replay** — at `loading=false`, feed the Fixture into the render prop _in place
  of_ live data.

**This is data substitution in front of the render prop, not a new capture
trigger.** ADR 0002's single readiness trigger stands untouched: display drives
capture, replay only changes _what renders_, and capture follows as it always
does. There is nothing to amend in ADR 0002.

Key choices:

- **One width-independent Fixture per Plate** (`name.json` ↔ `name.fixture.json`,
  1:1). Data doesn't change with viewport; only rendered structure does. This is
  what makes Replay compose with capture-all-views (ADR 0010): turn Replay on,
  sweep the breakpoints, and one recorded input deterministically produces a full
  multi-View Plate with zero live state.
- **Serialized with devalue** (dev-only weight; never in the prod bundle). It
  handles `Map`/`Set`/`Date`/`BigInt`/cycles/`undefined` holes that JSON can't,
  and throws loudly on the genuinely unrecordable (functions, class instances,
  Promises, DOM nodes) — so "Record fails loudly" is free.
- **The node side never parses a Fixture.** The dev server stores and serves the
  sidecar's devalue string as opaque, verbatim text; devalue encode/decode — and
  with it any trust in the hand-editable, git-tracked content — lives only in the
  browser dev client. Deserializing a committed artifact is a trust boundary, and
  it sits on exactly one side of the wire.
- **Control mirrors the `capture` option**: config sets the boot state, the HUD is
  per-tab authority. `record` defaults to **`'manual'`** (`manual | first-ready |
always`) — no auto-record default, so live app data is never silently committed.
  `replay` is `false | prefer | missing-only`, where **`missing ≡ nullish-only`**
  (an empty array/object is _present_; only true absence falls back to the
  Fixture, so genuine empty-states stay capturable).
- **Sidecars are git-tracked and hand-editable** — that's the point: stable,
  reviewable, regenerable, ignorable. PII hygiene for auth-walled states (scrub or
  hand-author rather than record live) is a documented developer responsibility.

Vocabulary (the [glossary](https://xray-js.dev/glossary/)): **Fixture / Record / Replay**, with **capture** kept
strictly for Plates (DOM → Plate). Never "capture a fixture."

## Considered alternatives

- **boneyard's `fixture={<Component/>}`.** Rejected: couples the fixture to a
  component instance. Storing plain _data_ keeps it decoupled and editable.
- **Inputs stored inside the Plate.** Rejected: it pollutes the structural
  artifact. A sidecar keeps the Plate purely structural and Fixtures independently
  editable, regenerable, and `.gitignore`-able.
- **A separate capture trigger for replay.** Rejected: replay is substitution at
  the existing readiness trigger — adding a second axis would re-spell ADR 0002.

## Consequences

- Fixtures never exist in production (dev-only by construction).
- The registry's `register` returns a disposer backed by a per-name instance
  stack: an unmounted Skeleton's `data` can never linger or be recorded, and
  while a still-mounted twin (same Plate name) keeps its entry, the live value
  is the most-recently-registered still-mounted instance. (Distinct from
  capture's twin policy in ADR 0006, where the first-in-DOM instance wins.)
- Participation is registered SEPARATELY from the live value (`registerSite`,
  counted per instance at the always-mounted Skeleton level): a render-prop
  site participates while mounted — across loading and Light Box — while
  `recordable` (live `data` in scope) tracks the ready-only registration
  above. Deriving participation from the live value made the HUD's fixtures
  section vanish whenever Light Box unmounted content; the split is what lets
  the per-plate ◆ record key and the record-all action render stably with an
  honest disabled state.
- The dev client boots whenever replay or auto-record is configured, not only
  when capture or the HUD is enabled — `fixtures: { replay: 'prefer' }` alone
  must inject the runtime, or it would be a silent no-op.
- A new committed artifact format; its stability depends on devalue's output
  format. Note for versioning if the on-disk shape ever changes.
  ([ADR 0033](./0033-fixtures-as-typescript-source.md) renders the recorded
  value as TypeScript source, reading the payload as JSON structure and
  writing value literals, with the invariant above restated as "renders
  text from the structure, never revives";
  [ADR 0034](./0034-plate-modules.md) lands the value as the plate module's
  `fixture` export.)
- Unlocks the deterministic CI / benchmark capture path together with ADR 0010.
