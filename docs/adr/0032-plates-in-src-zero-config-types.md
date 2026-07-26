---
status: accepted
---

# Plates live in `src/plates`, and one generated env file makes the typing zero-config

> **Amends [ADR 0001](./0001-plates-passed-by-reference.md): the default
> `platesDir` moves from `plates/` to `src/plates/`.**

Typed fixtures (ADR 0031) are only as live as the tsconfig: the plate
modules must be inside `include`, and the `virtual:xray/plates/*` wildcard
needs wiring. Any setup instruction here is a cost, and the obvious one
breaks working setups. `create-vite` templates ship `"types": ["vite/client"]`,
so a user told to add `"types": ["@hueest/xray/virtual"]` literally
clobbers their `vite/client` typings: `import.meta.env` and asset imports
silently untype. A default whose drift check is dead until the
user edits tsconfig is the wrong default.

## Decision

### 1. `platesDir` defaults to `src/plates`

Standard Vite TS templates use `include: ["src"]` (and glob variants that
match `.d.ts`), so everything the plugin writes lands inside the program by
existing. A directory under `src/` also reads as source, which plates are
(ADR 0001, committed source artifacts); a root-level `plates/` invited the
build-output gitignore instinct. The option keeps its meaning, relative to
the Vite root. Known edge, documented not solved: a Vite `root` that is not
the package dir resolves `src/plates` against that root and can land
outside `include`, silently disabling the drift check. The guide names the
case and the fix (`platesDir` plus one `include` entry).

### 2. One generated file carries all the declarations

`<platesDir>/xray-env.gen.d.ts` is fully codegen-owned and derived from the
directory: the `/// <reference types="@hueest/xray/virtual" />` directive,
then one block per fixture-bearing plate.

```ts
declare module 'virtual:xray/plates/news-feed' {
  import type { Plate } from '@hueest/xray'
  const plate: Plate<typeof import('./news-feed').fixture>
  export default plate
}
```

Reference directives resolve regardless of the tsconfig `types` allow-list,
the same mechanism as Vite's own `src/vite-env.d.ts`, so the wildcard wires
up with zero tsconfig edits and the footgun above cannot occur. The
path-specific blocks beat the wildcard, typing each fixtured plate's import
as `Plate<F>` with `F` computed live by tsc. Import types resolve relative
to this file, which sits in the directory the modules live in. The file
regenerates on dev-server start and on every plate-module watcher event,
and the write is skipped when the rendered content matches disk.
`noTypes: true` is the one switch over all of xray's declaration
generation: xray never writes the file. Accepted cost: two branches
recording different Fixtures conflict in this one file instead of disjoint
stubs, a union merge with no ordering conflicts.

### 3. The env file is an ambient script, and its inline `import()` types are the only legal form

Three TypeScript walls pin the shape:

- A file with a top-level import is a module, which turns every
  `declare module` inside it into an augmentation, and augmentations cannot
  override a wildcard's default export.
- Augmenting a specifier that resolves via the wildcard does not merge
  per-specifier (verified empirically; the injected members are ignored),
  so an augmentation-hook design does not exist either.
- Inside an ambient module block, TS2439 forbids relative import
  statements. The inline `typeof import('./news-feed')` is the one legal
  spelling, which some lint configs ban (`consistent-type-imports`). The
  generated file therefore opens with a file-level lint disable; for this
  rule the disable is load-bearing, not stylistic.

### 4. Generated names are collision-free by the dot rule

Plate names cannot contain dots (`isValidPlateName`), so the `xray-env.gen`
stem is unreachable by any plate's file family with no new rule, and `.gen`
is the established marker for committed generated files (TanStack Router's
`routeTree.gen.ts`). The stem also can never trip tsc's output-file
heuristic, which silently drops `<x>.d.ts` beside `<x>.ts` from the program
as presumed build output, because no `xray-env.gen.ts` can exist.

## Considered alternatives

- Keep `plates/` at root with tsconfig instructions: rejected. The drift
  check ships dead by default and one instruction actively breaks
  standard tsconfigs.
- A hidden generated dir (`.xray/`, the Astro/WXT pattern): rejected. Right
  for gitignored bulk, wrong for committed source artifacts.
- One declaration stub per fixtured plate: rejected. The pair cannot share
  a stem (the output-file heuristic), so every stub drags a suffix debate
  and a file. One env file scales to N plates with zero extra files, and
  the naming problem disappears instead of being solved.
- Reserving the literal name in `isValidPlateName`: rejected. A special
  case in a clean grammar the dot rule already covers.

## Consequences

- The standard template needs zero tsconfig edits. The zero-config e2e pins
  it against a real symlinked package, a stock `include: ["src"]`, and a
  real `tsc` run.
- Consumer linters that flag triple-slash references will flag the env
  file, the same friction `vite-env.d.ts` causes. The fix is silencing the
  rule for the file, not deleting the directive. The first scaffold in a
  project may need a TS-server restart to pick up the new ambient file.
- Cross-app stores (several Vite apps sharing one platesDir) point
  `platesDir` at the owning app's directory and add one `include` entry.
  Inherently custom, one line each.
