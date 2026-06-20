---
status: accepted
---

# Theming via CSS custom properties and progressive enhancement

> **Amended by [ADR 0017](./0017-css-custom-property-taxonomy.md) (2026-06-20):**
> the _policy_ below stands; the token names below are the current
> `--xr-bone-*` / `--xr-skeleton-*` taxonomy 0017 introduced (the original flat
> names are mapped there), and website design tokens live at `--xrw-*`.

Skeletons need to be themeable (color, radius, animation) and to follow
light/dark. Because the skeleton is real CSS, theming is a tokens-and-defaults
exercise with no new machinery: an inheritable `--xr-*` custom-property
contract, with light/dark driven by `color-scheme`/`light-dark()` rather than
component props or JS config (boneyard's `color`/`darkColor`/`animate`). This
matches the project's stance elsewhere: breakpoints are derived rather than
configured, and theming cascades rather than being passed.

## What this buys

- **Set once, cascade everywhere.** `--xr-bone-color`, `--xr-bone-border-radius`
  (+ per-kind `--xr-bone-text-line-border-radius`/`--xr-bone-media-border-radius`),
  `--xr-bone-animation-duration`, the pulse range
  `--xr-bone-pulse-opacity-min`/`--xr-bone-pulse-opacity-max`,
  `--xr-bone-animation` (mode), `--xr-bone-fill` (override
  the leaf paint), and `--xr-bone-highlight-color` (sheen). Set them in `:root` or on
  any ancestor; they inherit into every skeleton inside.
- **Per-plate / per-section theming for free.** The root carries
  `data-xr-root="<name>"`, so `[data-xr-root="news-feed"] { --xr-bone-color: … }`
  themes one plate. boneyard's color is global; this one is scoped by construction.
- **Light/dark with no media query.** `--xr-bone-color` defaults to
  `light-dark(#e4e4e7, #3f3f46)`, which resolves against the app's _used_
  `color-scheme` (inherited into the `display:contents` root), so the skeleton
  follows the app's chosen theme rather than the raw OS preference. Apps that
  theme by class just override `--xr-bone-color` in that scope.
- **Leaf kinds.** Each leaf carries a kind modifier (`xr-leaf-text-line` etc.) so text
  reads as rounded bars, media as blocks, and consumers can re-theme per kind.

## Progressive-enhancement policy

The floor, a visible bone fill plus the opacity pulse, uses only
universally-supported CSS. Modern features layer on top, and the guard decision
turns on the failure mode rather than the feature's age:

- **Graceful (unknown property / at-rule / media → ignored): never guarded.**
  `@property` (without it the pulse interpolates discretely, still pulses),
  `prefers-contrast`, `prefers-reduced-motion`.
- **Catastrophic (unknown _value_ → the whole declaration is dropped): guarded
  only until Baseline Widely Available.** `light-dark()` is wrapped in
  `@supports` because otherwise an unsupporting browser drops the `background`
  and renders an _invisible_ bone; it goes widely available **2026-11-13**, after
  which the guard can be deleted. Relative color (`oklch(from …)`, used to derive
  the sheen highlight) is non-critical and falls back to a static highlight.

## Animation modes

`solid` (`--xr-bone-animation: none`), `pulse` (default), and `sheen`
(`--xr-bone-fill` set to a
gradient built from `--xr-bone-color`/`--xr-bone-highlight-color`, pulsing in unison on the
one shared timeline). A true **traveling shimmer** and per-bone **stagger** are
deliberate non-goals: both need per-leaf phase (per-bone declarations that
would defeat ADR 0007's content-addressed sharing, on the one opacity channel
the pulse already owns, ADR 0012 §3) or a stacking box the `display:contents`
root doesn't have.

## Considered alternatives

- **Component props (`color`, `darkColor`, `animate`)** — boneyard's model.
  Rejected: it's JS config over CSS, can't be scoped by the cascade, and forces
  every theme decision through the component API. Custom properties are
  CSS-native, inherit, and cost nothing per render.
- **`@media (prefers-color-scheme: dark)` for the dark default** — rejected: it
  keys off the OS, so a forced-light app on a dark OS would get a dark skeleton.
  `light-dark()` follows the app's `color-scheme`, which is correct.
- **Guarding everything / guarding nothing** — rejected both: guard exactly the
  catastrophic value-level features, and only until they're widely available.

## Consequences

- `--xr-*` is a **public API**; renaming a token is a breaking change.
- BASE_CSS is larger (the guarded blocks), shipped once per page — the
  `virtual:xray/base.css` module for plugin plates; the outermost view inline on
  the explicit-`css` path (ADR 0026) — acceptable for the theming foundation.
- The `light-dark()` and relative-color `@supports` blocks are **dated for
  removal** once those features are Baseline Widely Available.
