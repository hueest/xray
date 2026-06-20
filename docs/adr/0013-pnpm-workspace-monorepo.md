---
status: accepted
---

# A pnpm-workspace monorepo: apps / packages / libs

xray is more than a single npm package: it needs a capture-all-views browser
**extension** (ADR 0010), a separate artifact with its own MV3 toolchain, and a
**docs/examples website** that links `@hueest/xray` to dogfood it in deployments.
The repo is a pnpm-workspace monorepo with three buckets, each with a distinct
distribution story:

- **`packages/`** — published to npm. Self-contained build artifacts; the sole
  tenant is `@hueest/xray`.
- **`apps/`** — deployed, never published (the website, the extension). Free to
  depend on `packages/*` and `libs/*` via `workspace:`.
- **`libs/`** — internal shared code, `workspace:` only, never published
  standalone. Starts empty; first likely tenant is a shared
  protocol/constants lib used by the dev client and the extension.

## The one hard rule

A **published** package (`packages/*`) must not keep a `workspace:` dependency on
a `libs/*` package — that specifier doesn't resolve for an npm consumer. Anything
in `libs/` that a published package uses must be **bundled into its `dist`** at
build time (tsdown/rolldown inlines it when it isn't marked `external`). `apps/*`
have no such constraint, since they are never published.

## Not in scope

Framework adapters stay **subpath exports of `@hueest/xray`**
(`@hueest/xray/react`, a future `@hueest/xray/solid`; ADR 0008), never separate
packages. The monorepo is for genuinely separate artifacts (the extension, the
website), not the adapters.

## Considered alternatives

- **Stay a single package.** Rejected — the extension is a different target
  (MV3 service worker + content script + manifest) and doesn't belong in the
  `@hueest/xray` `tsdown` build.
- **A separate repo for the extension.** Viable — its coupling to `@hueest/xray` is
  mostly runtime (CDP + `postMessage`), with only a few shared constants/protocol
  types. Rejected for cohesion: one repo keeps the protocol in sync and lets the
  extension and website import shared code directly, and the website wants to link
  `@hueest/xray` anyway.
- **Adapters as separate packages.** Rejected — they're subpath exports (ADR
  0008); splitting them buys nothing and complicates publishing.

## Consequences

- `@hueest/xray` moves to `packages/xray/` (its build/test/lint configs travel with
  it; a single `pnpm-lock.yaml` lives at the root; the root `package.json`
  delegates scripts via `pnpm -r`).
- The external dogfood app's `link:` specifiers move to `packages/xray/` and
  need a `pnpm install` to relink. The website app will eventually replace
  that `link:` as the primary dogfood.
- `apps/` and `libs/` start empty (tracked via `.gitkeep`).
