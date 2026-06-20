---
status: accepted
---

# A Plate is the tree artifact only; its css is an independent sibling served through Vite's CSS pipeline

> **Refines [ADR 0003](./0003-self-contained-plates.md): the self-contained
> capture unit is _two_ artifacts, a tree-only `Plate` and its scoped css
> string, instead of one css-carrying object. Self-containment survives: both
> artifacts originate from the capture and depend on nothing in the consumer's
> build. Keeps [ADR 0005](./0005-css-extraction-copies-author-rules.md) (what
> the css _is_) and [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md)
> (thin adapters, here literally css-free) intact.** The measured
> outcomes are pinned in the consequences below.

Plates originally carried their css as a field, and adapters injected
`BASE_CSS + plate.css` as a `<style>` at mount. That kept every plate's css
(and the ~5 KB `BASE_CSS`) in the consumer's JS chunks: parsed as JS,
uncacheable independently of code, invisible to Vite's CSS pipeline. It also
made css-carrying plates a recurring regression source: any dev-store or ws
path that produced a plate with css silently reverted mounted skeletons to
inline-`<style>` rendering, a bug class hit twice before the contract change.

## Decision

### 1. Two artifacts through every seam

`Plate` is the versioned, named **tree** only, with no `css` field.
The capture-side producer shapes (`GatedPlate`/`StoredPlate`) keep
`{ tree, css }`, and the on-disk `plates/<name>.json` format is unchanged;
`serializePlate` lowers to the tree-only `Plate` and deliberately does not
copy css. The public core surface hands both parts back separately:
`captureElement(roots, options): { plate, css }` and
`renderPlateHtml(plate, css)`, with `BASE_CSS` and
`composeCss(css)` (the standard `${BASE_CSS}\n${css}` composition) exported
for consumers that render outside Vite. The `xray:plate` ws announce and the
dev live store are tree-only by construction, so the css-carrying-plate
regression class is structurally impossible (and stays test-pinned).

### 2. The virtual plate module imports its css as real `.css` modules

`renderPlateModule` emits:

```js
import 'virtual:xray/base.css'
import 'virtual:xray/plates/<name>.css'
export default {/* tree-only plate JSON */}
export const css = '<the plate’s scoped css string>'
```

Both css ids are deliberately **un-`\0`-prefixed** (the vanilla-extract
pattern: Vite's internal CSS plugins route on the id, and an id ending in
`.css` must reach that pipeline). `base.css` serves `BASE_CSS` verbatim; the
plate `.css` serves the committed plate's css off disk. Production adapters
import only the default export, so `export const css` tree-shakes out of
built chunks; dev tooling may import `{ css }` as data.

### 3. BASE_CSS dedupes by JS module identity, not css `@import`

Every plate module JS-imports `base.css` before its own css module, so a
plate rule beats a base rule at equal specificity by source order, and Vite
dedupes the import by id: one injected `<style>` in dev, one copy across
built css assets, nested/stitched plates collapsed by module identity. A css
`@import` inside each plate's css was rejected: postcss-import inlines per
importer at build, duplicating BASE_CSS per plate asset.

### 4. Runtime-captured plates style via an explicit `css` prop

Adapters import neither `BASE_CSS` nor any css off a plate. The one inline
path left is `<Skeleton css={composeCss(css)}>` for runtime-captured
(`core.ts`) plates: the adapter injects the consumer-composed string as a
`<style>` on the outermost root only, `escapeStyleText`-guarded.
Plugin-imported plates omit it; their styling is entirely the CSS pipeline's.

### 5. Dev invalidation drops BOTH virtual modules, with split policies

A plate write (capture POST, hand edit, git checkout — observed by the
plates-dir watcher; `addWatchFile` stays deliberately unused to avoid the
capture loop) runs `invalidatePlateModules`. The `.css` module is invalidated
**and reloaded**: standard CSS-HMR push, fresh styles live, no remount risk.
The JS tree module is invalidated **only**, because a live re-import would
remount the capture boundary and re-fire capture; the next full page load
re-transforms the tree from disk. Both halves matter: invalidating only the
css leaves Vite's cached tree transform (stale content-addressed class names)
pairing with fresh rules after a no-source-edit capture round, garbling
skeletons until a server restart. (Fast Refresh masks this whenever a source
edit accompanies the capture, which is why it surfaced only in real dogfood
browsing.)

### 6. Tree-shake purity: no computed initializers on exported constants

`BASE_CSS` declared as `` `…`.trim() `` pinned ~5.3 KB into every consumer
chunk: a method call on the initializer is not provably pure to a
conservative tree-shaker, so the whole literal was retained. Declared as a
plain template literal it shakes fully. The sibling side-effect css imports
do NOT pin the unused `export const css` either (verified empirically).
Give any exported const the adapters must be able to drop a side-effect-free
initializer.

## Considered alternatives

- **Keep css on the plate, mark it external** (an interim `cssExternal`
  flag): a half-state. The regression class stayed reachable and the
  adapters still branched on css presence; making the tree-only shape the
  type closed it structurally.
- **css `@import` for base**: rejected (§3, per-asset duplication).
- **`@layer` for the cascade seam**: not prototyped. The one observable flip
  (an app rule targeting a plate's own `xr-` class wins at equal specificity
  by `.css`-order rather than losing to a mounted `<style>`) is accepted:
  scoped `xr-` classnames make accidental collisions a non-event, and
  deliberate targeting of xray internals is the consumer's coupling.

## Consequences

- Measured on the single-plate scratch app vs the inline baseline: **−33%
  raw, −32% brotli** across JS+css, with `BASE_CSS` and all plate rule text
  absent from JS chunks, `@keyframes xr-pulse` emitted once, base rules
  before plate rules, and no FOUC (`__vitePreload` loads a lazy chunk's css
  before `React.lazy` resolves). The css asset's BASE_CSS share is a fixed
  once-per-app cost that amortizes with more plates, and `.css` content
  hashes survive JS-only redeploys.
- **SSR / metaframework dual builds** must resolve `virtual:xray/base.css` /
  `virtual:xray/plates/<name>.css` identically in both passes. Unverified;
  inherited by the metaframework track on the
  [roadmap](https://xray-js.dev/roadmap/).
- **`cssCodeSplit: false`** consumers concatenate everything into one global
  stylesheet; correctness should hold (base deduped), the per-route split
  benefit disappears. Not verified empirically.
- **Mid-session dev preview staleness** (minor, scoped to a capture session in
  progress): the live store gets the fresh tree immediately, but the page's
  `.css` module serves the last committed css until the session stops
  (stop → write → §5 reconciles both). BASE_CSS keeps bones painted
  meanwhile. If it ever matters, the dev adapter could thread preview css
  through the `<Skeleton css>` param; noted, not built.
- **Name-collision edge**: a runtime-captured plate sharing a name with a
  plugin plate under active dev capture applies its static `css` prop to
  whatever tree the store serves. Degenerate; documented, not guarded.
- Payload work on the css measures against the extracted `.css` assets, not
  JS-embedded strings. (Measured this way, atomic CSS factoring proved
  counterproductive and was rejected;
  [ADR 0007](./0007-content-addressed-style-classes.md).)
