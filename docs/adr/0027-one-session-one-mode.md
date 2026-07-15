---
status: accepted
---

# One capture session, one action mode: the sweep amplifies recording, and record/Light Box are exclusive at every scope

> **Amends [ADR 0022](./0022-uniform-pass-pipeline.md) §2 (the per-session
> multi-View bundle is now the session buffer, shared by browse and sweep
> captures) and [ADR 0010](./0010-capture-all-views-via-extension.md) (the
> sweep is no longer a standalone write path); keeps ADR 0022 §4's generation
> guard and [ADR 0025](./0025-capture-performance.md)'s coalescing scheduler
> intact.**

The client used to carry two parallel accumulate-then-write paths: browse
captures buffered per plate name and wrote at the Capture toggle's off edge,
while the capture-all sweep threaded a per-site `PlateIR` through the emulated
widths and posted at its own end. Two paths meant two write moments, subtle
guards keeping them from racing each other, and a HUD that had to present
"capture" and "capture all" as different verbs when they produce the same
artifact.

## Decision

### 1. One accumulate path

Every capture — browse (navigation, resize, interaction) and the sweep's
forced emulated-width passes — lands in the same name-keyed session buffers.
Each View is seeded (`bpSeed`, from the raw pre-Distil rules) and distilled at
capture time; the Distil passes are strictly per-View, so distil-at-capture
equals the old distil-at-sweep-end. Buffers dedupe by exact captured width
(latest wins); the per-band collapse happens once, at projection. Disk writes
happen only at stop — replace semantics, the recorded Views become the plate —
or when a per-plate record key toggles off, which writes that plate's slice of
the session immediately.

### 2. The sweep is an amplifier — and automation is FULL automation

Engaging record with a sweep-capable extension connected sweeps every derived
width into the session and then, on success, presses the SAME stop a finger
would: automated visits have a knowable end, so the automation ends the
session and the write flows through the one write path. A sweep FAILURE never
auto-writes — the session stays engaged with the error surfaced, and the user
decides. Without the extension, recording captures at the live width, the
missing bands are the user's resize to-do list, and the session is
user-bounded — only the user knows when their visits are done. Per-name
recording is symmetric at both automation levels: a key-on with the extension
sweeps the scope and keys itself off; a manual key-on records until its
key-off. To capture an interaction state under full automation, HOLD the
state and engage — the sweep captures the held state at every width.

### 3. One action at a time, at one scope

The mode machine is `idle | record(global | names) | lightbox(global |
names)`. Light Box unmounts content, so nothing can capture under it —
the exclusivity is structural, not a UI nicety — and the client enforces it:
engaging either action while the other is active, at any scope, is a warned
no-op, so a console caller cannot wedge the machine. Global record absorbs an
active name scope. Per-name record is manual-only for multiple names; with the
extension it is a self-terminating one-shot scoped sweep (one shared viewport,
no joins mid-flight). The sticky `capture`/`lightbox` ToggleStores remain the
global-scope truth underneath the machine, so per-tab persistence, `?xray-*`
URL seeds, and console flips behave exactly as before.

### 4. The HUD is a projection

The client exposes read-only stores — mounted sites, session snapshot (views
per name, the `writing`/`saved`/`failed` save lifecycle with the sink's error
text, sweep progress), per-plate diagnostics, extension presence with
version + caps, per-plate fixture status (`participates` / `recorded` /
`replaying`, including the `missing-only` nullish rule), and the mode itself —
plus the `highlight` boundary overlay. The HUD renders these and calls the
mode setters; it owns no capture state of its own.

## Considered alternatives

- **Keep the two paths and coordinate them in the HUD**: rejected — the
  exclusivity and write-moment rules would live in UI code, unreachable from
  the console surface and untestable without a DOM.
- **Merge-with-disk on stop** (a session writes only the bands it captured):
  rejected — the committed `StoredPlate` is geometry-stripped, so the client
  cannot re-project old Views into a merged bundle; band-level merge would
  need a server-side gate splice. Replace semantics stay, and the sweep-first
  default makes a partial replace the escape hatch, not the norm.

## Consequences

- A sweep's Views survive a mid-sweep failure in the session buffer; stopping
  still writes what was captured, and a failed write keeps its buffer for the
  next engage (retry is the engage's first act).
- The emulate ACK contract now matters to tests: an acked emulate implies the
  viewport resized. The test harness applies the width, or same-width dedupe
  collapses the sweep into one View.
- `reset` posts when the widths are visited; the caller's promise, not the
  reset command, carries the write backpressure (`captureAllViews` resolves
  only after every sink confirmation).
