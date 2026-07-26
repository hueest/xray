---
status: accepted
---

# One module per Plate: `<name>.ts` holds the plate and its Fixture, and the server reads it back with `import()`

> **Amends [ADR 0001](./0001-plates-passed-by-reference.md) (the on-disk
> artifact becomes a TypeScript module; the `virtual:xray/plates/<name>`
> import surface is untouched) and
> [ADR 0015](./0015-fixtures-dev-only-record-and-replay.md) (the Fixture
> sidecar dissolves into the plate module; loading moves from a devalue
> seed to the module graph).**

A Plate and its Fixture are one artifact's two halves: the captured
structure and the recorded input that reproduces it. Storing them as
separate files (JSON for one, source for the other) means two read paths,
two watcher filters, and a file count that grows with every feature. One
plate, one module.

## Decision

### 1. The Plate is a committed TypeScript module

`src/plates/<name>.ts`:

```ts
export const plate = {
  v: 1,
  name: 'news-feed',
  breakpoints: [390, 768, 1280],
  tree: { kids: [/* … */] },
  css: '/* … */',
}

export const fixture = {
  items: [{ kind: 'news', id: 'item-1', at: new Date(1753305600000) }],
} as const
```

`plate` is the StoredPlate structure, a plain literal. Nothing consumes its
type, and annotating it would only add relation-checking work and version
coupling. `fixture` is present only when one is recorded, `as const` as
ADR 0031 §3 requires. Consumers never import this file:
`virtual:xray/plates/<name>` stays the only public surface. The module is
import-free by contract, since the renderer emits only value literals
(ADR 0033 §2), and a hand-added value import fails loudly at the server's
read.

### 2. The virtual pipeline is unchanged

The plate virtual module, the per-plate css module, base-css dedup, and
build-time loading all read the same StoredPlate they read before. Only the
storage behind them changes. A missing module, or one with only a `fixture`
export (a Fixture recorded before first capture), falls back to
`emptyPlate` exactly as a missing file did.

### 3. The server reads plate modules with `import()`

Node strips erasable-only TypeScript on import (unflagged since 22.18 and
23.6; Bun and Deno always did), and ADR 0033 §2 guarantees the file is
erasable-only data. Every server read, from the plate virtual module to the
css pipeline, coverage, and the watcher announce, is
`await import(fileUrl + '?t=' + mtime)` plus the same StoredPlate
validation `JSON.parse` results got. The import key is the mtime plus a
per-file revision the server bumps on every write and watcher event, which
defeats Node's permanent ESM cache including two writes inside the same
millisecond; the retained stale modules are bounded by edit frequency.
The package requires
`engines: { node: "^22.18.0 || >=23.6.0" }`: within the 22 line stripping
is unflagged from 22.18, and 23.0 through 23.5 still flag it. `vite >= 7`
already excludes older runtimes, and Node 20 reached end of life in April 2026.

Executing the committed module is safe by ADR 0033 §4: every byte of its
syntax was authored by xray's renderer or the repo's developers, the same
trust class as `vite.config.ts`, which the toolchain already executes.

### 4. Writes are whole-file re-renders, never splices

The server holds one half at write time and reads the other back through
`import()`. Capture re-renders both sections with the imported fixture
VALUE re-serialized (devalue server-side, serializing a value the server
legitimately holds, not reviving page content). Record re-renders with the
imported plate structure. Every write emits the whole canonical file, an
unchanged render skips the write so the watcher stays quiet, and a per-file
lock serializes the read-render-write sequences: a concurrent Capture and
Record of the same plate would otherwise both import the old module and the
later write would discard the other's half.

Consequence, accepted deliberately: the module is codegen output. Hand
edits to VALUES survive round trips; hand formatting and comments are
canonicalized away by the next write. Every generated file opens with a
file-level `/* eslint-disable */`. Recorded values are data and
legitimately carry whatever a consumer's lint config bans (bare
`new Date(…)`, magic numbers), a fight no per-rule list wins, and for the
env file the disable is load-bearing (ADR 0032 §3). Type checking is
untouched; the drift check lives there.

### 5. Loading and invalidation collapse to one file kind

A dev-only `virtual:xray/fixtures` module imports the `fixture` export of
every fixture-bearing plate module (the server knows which from its own
`import()` reads) and seeds the fixtures store with LIVE values: real
`Date` and `Map` objects through Vite's own transform, no devalue decode.
It self-accepts, and the watcher reloads it (not merely invalidates: an
invalidated virtual module never re-executes in an open tab), so a Fixture
added, edited, or deleted lands in the running Replay without a page load;
a forced seed is authoritative, removing recorded names the fresh
enumeration no longer contains. One watcher
handler covers the directory. A `<name>.ts` event (valid plate stem; the
dot rule excludes every generated sidecar) announces the plate, invalidates
the plate's virtual modules and the fixtures module, and re-renders the env
file (ADR 0032 §2), so a deleted or hand-edited module can never strand a
stale declaration. Nothing imports plate modules in production builds, so
fixtures are never bundled.

## Considered alternatives

- Consumers import the plate module directly, no virtual id: rejected. The
  virtual pipeline carries css dedup, build-time loading, and cross-app
  stores; a relative import solves none of it and breaks the public
  surface.
- Parse the module text server-side instead of executing it: rejected.
  Needs a real TS parser to survive formatters, for no gain over `import()`
  on runtimes the package can now require.
- Marker-delimited region splicing for upserts: rejected. Preserves hand
  comments at the cost of a text contract that breaks under reordering;
  codegen owning its bytes is the simpler contract (§4).
- Separate files per half, JSON plate plus source fixture: superseded. The
  separate read path, watcher filter, and format existed only because
  plates predate fixtures-as-source.

## Consequences

- Every Plate is one file, plus the one shared `xray-env.gen.d.ts`
  (ADR 0032). A fixtured Plate adds a declaration block there, not a file.
- The plate module sits in the consumer's program and, when fixtured, in
  the browser's dev module graph. The literal adds one linear tsc walk per
  plate, the floor for anything stored as source, and nothing in production
  builds.
- Hand-authored comments inside plate modules do not survive re-capture or
  re-record (§4). The guide says so.
- Migration is one-shot at zero users: render each legacy artifact into the
  module form and delete the retired files. The env file regenerates on the
  next dev-server start.
