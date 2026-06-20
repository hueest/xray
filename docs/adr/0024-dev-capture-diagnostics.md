---
status: accepted
---

# Dev-only capture diagnostics that never reach the persisted Plate

> **Builds on [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md) (the
> dev↔prod split: capture is `serve`-only, the prod adapter ships none of it) and
> [ADR 0022](./0022-uniform-pass-pipeline.md) (the in-browser Serialize; the POST
> envelope is `{ plate: StoredPlate, diagnostics? }`). Keeps the on-disk plate
> shape and validator unchanged.**

The serializer silently swallows a handful of capture omissions: an unreadable
cross-origin stylesheet, a skipped interaction pseudo-class or pseudo-element, a
CSS rule kind it does not lift, hidden/non-visual elements, bones dropped at the
fold (Crop) or absorbed into a superset (Superset), an over-the-limit subtree.
Early adopters asking "why does this skeleton look wrong?" had no answer short of
reading `measure.ts`. Surface those omissions as dev-only warnings, without
letting a byte of them touch the committed artifact.

## Decision

### Diagnostics are dev-only and never reach the persisted Plate

A `CaptureDiagnostic` is `{ code, message, count?, detail? }` (`diagnostics.ts`).
It is **not a public package export** and **MUST NEVER** appear in the on-disk
`StoredPlate`, the `GatedPlate`, the `parseStoredPlate` validator, or the
production adapter. It rides two transient channels only:

- the **`ViewIR.diagnostics`** side field (mirrored on `ViewCapture.diagnostics`),
  populated during in-browser capture and distillation, and
- the **POST envelope's SIBLING `diagnostics` field** — `CaptureEnvelope` is
  `{ plate: StoredPlate, diagnostics? }`; the dev server (`index.ts`) logs the
  sibling and **drops it before disk**.

So a committed `plates/<name>.json` is **byte-identical to a capture that
produced no diagnostics**. The prod adapter carries nothing: capture is
`serve`-only (ADR 0008), so `__XRAY__` and the whole diagnostics path do not
exist in production.

### The core returns diagnostics as data; callers log

The capture/serialize core performs **no console side effects**. A mutable
`DiagnosticsCollector` (`createDiagnostics()`) is threaded through the walk, CSS
extraction, and the Distil passes; each silent site calls `collector.add(code)`
instead of swallowing. The collector surfaces the list on `ViewIR.diagnostics`,
and **callers decide whether and where to log** — the browser client
(`reportDiagnostics`) and the Vite server (`reportServerDiagnostics`).

### Browser console and server output share one formatter, verbatim

`formatDiagnostic` and `diagnosticsHeader` (`diagnostics.ts`) are the **single
source of the warning text**, used identically by `client.ts` (a grouped
`console.warn` under `console.group`) and `index.ts` (Vite's `server.config.logger`,
falling back to `console.warn`). The per-code message table is centralized too, so
**browser and server text cannot drift**; the same vocabulary is reused for
the out-of-band `too-large` (mapped from `CaptureTooLargeError` via
`makeDiagnostic`) and the server-side `invalid-plate-file`.

### Counts aggregate by code; no user content in warnings

There is **at most one record per code per capture**: `add` aggregates by code, so
a feed that drops 195 bones below the fold yields **one** `dropped-cropped` record
with `count: 195`, never 195 records. A diagnostic carries **no DOM nodes, no CSS
bodies, no captured text** — only the stable `code`, the canonical `message`, an
aggregate `count`, and an optional short `detail` (a plate name or a node count).
`detail` is recorded from the first occurrence; later occurrences only bump the
count.

The shipped omission codes are `unreadable-stylesheet`, `unreadable-import`,
`skipped-dynamic-pseudo`, `skipped-pseudo-element`, `unsupported-rule`,
`dropped-tag`, `dropped-subset`, `dropped-cropped`, `too-large`, and
`invalid-plate-file`.

## Considered alternatives

- **Log from inside the core.** Rejected: it would couple the framework-neutral
  serializer to a console and rob callers of the choice of sink. Returning data
  is what lets the browser and the Vite server each render it in their own surface
  from the same formatter.
- **Separate browser and server message strings.** Rejected: they would drift on
  the first edit. One shared table + formatter makes divergence impossible.
- **One warning per skipped selector / dropped node.** Rejected as noise: a single
  capture can drop hundreds of off-screen bones. Aggregate counts explain the
  fidelity cost in one line.
- **Persist diagnostics in the Plate (or a sidecar).** Rejected: a committed plate
  must stay a pure, byte-stable, dev-tool-agnostic artifact. Diagnostics are a
  capture-time explanation, not plate content.
- **HUD warning badges/counts.** Deferred: console + server output ship first;
  the HUD surface is a later, additive step.
- **Fail capture when diagnostics exist.** Rejected: omissions are expected and
  recoverable; a reduced-fidelity skeleton is still useful. Diagnostics inform,
  they do not block.

## Consequences

- A new dev-only `diagnostics.ts` module (`CaptureDiagnostic`, `DiagnosticCode`,
  `createDiagnostics`/`DiagnosticsCollector`, `makeDiagnostic`,
  `formatDiagnostic`, `diagnosticsHeader`), none of it a public export.
- `ViewIR`/`ViewCapture` gain a transient, never-persisted `diagnostics?` field;
  `CaptureEnvelope` gains a sibling `diagnostics?` the server logs and discards.
- The collector is plumbed through `measureBundle`/`walkAll`/`build` and the
  Superset/Crop passes; each swallow site `add`s a code instead of staying
  silent.
- The message table doubles as the shared validation-warning vocabulary
  (`invalid-plate-file`), so a follow-up reusing it for posted/committed-plate
  validation does not re-invent the formatter.
