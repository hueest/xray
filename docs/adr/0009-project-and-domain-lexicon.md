---
status: accepted
---

# Project and domain lexicon: xray, not boneorchard

The project began as **boneorchard**, a graveyard pun ("bone orchard" is slang
for a cemetery) whose terms named where skeletons are _stored_ (Orchard, Cast).
It was renamed **xray** because the stronger metaphor names the _mechanism_:
an x-ray exposes the skeleton inside a living thing, which is exactly what the
tool does to a component. The metaphor makes `<Skeleton>` self-evident (it is
what the plate reveals) and yields a clean, non-morbid, self-documenting
vocabulary.

The npm package coordinate is **`@hueest/xray`** — bare `xray` is taken by a
dormant v3, so the name lives under the org scope (see the dated amendment
below: the original pick was `xray-js`). The brand and the virtual-module
namespace stay `xray` (`virtual:xray/...`); the scope is only the package
coordinate.

## Term mapping

| Was                          | Now                              | Note                                                                    |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| boneorchard                  | xray (npm `@hueest/xray`)        | the tool                                                                |
| Cast                         | **Plate**                        | the stored capture; the `plate` prop                                    |
| Orchard (`orchard/`)         | **`plates/`**                    | committed directory; no longer a distinct noun                          |
| Seam                         | **Stitch**                       | a stitched radiograph joins plates by reference                         |
| Fork                         | **Projection**                   | a divergent per-View subtree                                            |
| Regime                       | **View**                         | a viewport-width band / radiographic view                               |
| Preview / `force`            | **Light Box**                    | dev-only "show every skeleton" toggle                                   |
| Capture                      | **Capture**                      | kept — theming it ("expose") read as _reveal_, colliding with Light Box |
| `virtual:boneorchard/<name>` | **`virtual:xray/plates/<name>`** | mirrors the on-disk `plates/` dir                                       |
| `virtual:boneorchard-client` | **`virtual:xray/client`**        | meta module, now collision-free under the partition                     |
| `boneorchard/react`          | **`@hueest/xray/react`**         | real package export                                                     |
| `__BONEORCHARD__`            | **`__XRAY__`**                   | dev client global                                                       |
| `data-bo-*`, `.bo-*`         | **`data-xr-*`, `.xr-*`**         | DOM/class prefix                                                        |

## Considered alternatives

Every rejected family named _storage or flavor_ rather than the _capture
mechanism_:

- **Graveyard** — `skullgarden` and `gravesite` (both free bare on npm),
  `gravestead`, `catacomb`, `ossuary`. Hold the original pun but only describe
  where skeletons sit; flavor over function, and several are morbid or obscure.
- **Anatomy** — `ribcage` (the frame that holds the place of the soft parts — a
  genuine function fit). Strong, but still a noun for the artifact, not the act;
  bare name taken.
- **Sculpture** — `armature` (the wire skeleton a form is built on), with
  `maquette` / `studio`. Elegant but niche vocabulary; bare name taken.
- **Radiography image** — `radiograph` (free bare), `roentgen`, `fluoroscope`.
  Same family as xray; lost on memorability, brevity, and the verb doubling as
  the capture action.

`xray` won because it alone names the **action the tool performs**, reads as both
noun and verb, and is short and universally understood.

## Consequences

- The "render vs store never share a word" rule (the [glossary](https://xray-js.dev/glossary/)) holds: **Skeleton**
  (rendered) vs **Plate** (stored).
- The rename is a repo-wide mechanical sweep — identifiers, exports, the virtual
  prefix, the DOM/class prefix, tests, and the dogfood app. Prior ADRs
  (0001–0008) keep their dated decisions but adopt the new terms.
- The published coordinate is locked; reversing after release is costly. This
  ADR records the why so it is not relitigated.

## Amendment (2026-06-21): the coordinate is `@hueest/xray`, not `xray-js`

The unscoped `xray-js` was dropped before first publish in favor of the scoped
**`@hueest/xray`**: the org scope guarantees availability and dodges the
squatted-adjacent-name problem the `-js` suffix worked around, and npm treats
scoped names as first-class. Everything else in this ADR stands — the brand,
the `xray` prefix everywhere user-visible (`virtual:xray/...`, `data-xr-*`,
`.xr-*`, `__XRAY__`), and the term mapping.
