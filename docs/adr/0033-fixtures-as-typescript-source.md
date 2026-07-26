---
status: accepted
---

# Fixture values are rendered as TypeScript source: the server writes text from structure and never revives

> **Amends [ADR 0015](./0015-fixtures-dev-only-record-and-replay.md): the
> on-disk fixture format becomes TypeScript source (the value IS the type,
> ADR 0031), and the server's no-devalue invariant is restated as "renders
> text from the structure, never revives".**

A recorded Fixture is committed, dev-executed source. That demands one
guarantee above all others: a page script may choose every VALUE in the
file but never a byte of its SYNTAX. Anything less makes Record an
arbitrary code-write primitive into the consumer's working tree.

## Decision

### 1. Record posts structure; the server renders literals

The Record POST envelope is `{ name, data }`, with `data` devalue's
FLATTENED payload. The server parses it as plain JSON structure and renders
value literals: string values pass through `JSON.stringify` escaping, keys
are identifier-checked or quoted, and devalue's markers become constructor
TEXT (`new Date(…)`, `new Map([…])`, `123n`). Nothing is instantiated or
revived server-side. The rendered value carries `as const`, which is what
makes bare `extends` sound in the drift check (ADR 0031 §3).

### 2. Rendering rules

- Deterministic pretty-printing, inline while short and one member per line
  past a width cap, so the committed file audits well with no formatter in
  the repo and the only diffs are value diffs.
- `undefined`-valued keys are omitted: a sample cannot distinguish
  optional-absent from present-undefined, and `exactOptionalPropertyTypes`
  consumers would false-positive. Array holes render as `undefined`.
- Cyclic graphs have no literal form. They fall back to hoisted shells
  typed `as any`, the drift check's deliberate unchecked marker. Shared
  non-cyclic references inline as value-equal duplicates.
- An own `__proto__` key is refused: it would render as a
  prototype-setting member, syntax semantics a page script must never
  control. devalue cannot emit one; only a crafted POST can.
- Exotic payloads a render input has no business being (typed arrays,
  ArrayBuffer, Temporal, devalue's very-sparse encoding) throw. The POST
  answers 400 carrying the renderer's reason in the body and nothing is
  written.
- The output is erasable-syntax-only by construction: value literals,
  `as const`, nothing else. That is what lets the server execute the
  committed file with Node's own type stripping (ADR 0034 §3).

### 3. Recordability is gated client-side

The client owns `devalue.stringify`, since it holds the live `data`.
Functions, DOM nodes, promises, and class instances fail loudly there
before any POST. The server-side refusals in §2 cover what passes that gate
but has no business in a fixture.

### 4. The invariant: page scripts control data, never code

Rendering text FROM a data structure honors "the server never revives page
content"; accepting client-authored module text would not. This guarantee
is what makes the whole family safe. The committed plate module lands in
the same trust class as `vite.config.ts`, every byte of its syntax authored
by this renderer or by the repo's developers, so the server may execute it
to read values back (ADR 0034 §3), and reviewing it in a PR is reviewing
values, not auditing for injected code.

## Considered alternatives

- Client renders the module text, server writes it verbatim: rejected. Any
  page script could write arbitrary code into a committed dev-executed file
  (§4).
- Store the devalue wire string on disk: rejected. An opaque one-line
  artifact whose diff shows the whole line changing for any value change,
  with no hand-editability, plus a decode
  step the module graph makes unnecessary (ADR 0034 §5).
- Store values as JSON and generate their type: rejected. The type either
  duplicates the value file, agreeing by construction instead of by
  definition, or needs an inference policy (ADR 0031 alternatives).

## Consequences

- Hand-authored edge-state fixtures are first-class: editing the file is
  editing source, and the values HMR into a running Replay (ADR 0034 §5).
- The renderer is one file (plate-source.ts) with an evaluated round-trip
  test pinning that its output revives to exactly what `devalue.parse`
  would produce.
- Recorded data from auth-walled views is committed source. Scrub before
  committing, as with any source file.
