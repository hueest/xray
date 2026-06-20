---
title: Theming
description: Style the bones and the skeleton timing with CSS custom properties.
---

Skeletons are themed entirely through inheritable CSS custom properties: no
props, no JS config. Set a token on `:root`, a section, a plate root, or a
single leaf; it cascades into every skeleton inside.

The tokens split into two families. The `--xr-bone-*` tokens style an
individual Bone; the `--xr-skeleton-*` tokens govern whole-skeleton display
timing.

| token                                                         | default                        | role                                                                                               |
| ------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `--xr-bone-color`                                             | `light-dark(#e4e4e7, #3f3f46)` | leaf fill                                                                                          |
| `--xr-bone-highlight-color`                                   | derived from `--xr-bone-color` | sheen highlight                                                                                    |
| `--xr-bone-border-radius`                                     | `4px`                          | leaf radius (+ `--xr-bone-text-line-border-radius` `999px`, `--xr-bone-media-border-radius`)       |
| `--xr-bone-animation-duration`                                | `1.2s`                         | animation duration                                                                                 |
| `--xr-bone-pulse-opacity-min` / `--xr-bone-pulse-opacity-max` | `0.5` / `1`                    | pulse opacity range                                                                                |
| `--xr-bone-animation`                                         | `xr-pulse`                     | mode: `xr-pulse`, `none` (solid), or a custom keyframe                                             |
| `--xr-bone-fill`                                              | `var(--xr-bone-color)`         | override the leaf paint (e.g. a sheen gradient)                                                    |
| `--xr-skeleton-delay`                                         | `250ms`                        | grace period before the skeleton becomes visible; resolve within it and the skeleton is never seen |
| `--xr-skeleton-min-duration`                                  | `600ms`                        | minimum visible time once shown, so a shown skeleton never blinks away                             |
| `--xr-skeleton-transition-duration`                           | `150ms`                        | the reveal/swap fade                                                                               |

## Recipes

```css
/* global defaults */
:root {
  --xr-bone-color: #dcdcdc;
  --xr-bone-border-radius: 6px;
}

/* per-plate — scope by the plate name on its root */
[data-xr-root='news-feed'] {
  --xr-bone-color: #e9b8c4;
}
[data-xr-root='content-cards'] {
  --xr-bone-color: #b8d8c0;
}

/* per-leaf-kind — text bones vs media bones */
[data-xr-root] .xr-leaf-text-line {
  --xr-bone-color: #c9b8e8;
}
[data-xr-root] .xr-leaf-media {
  --xr-bone-color: #b8d4d8;
}

/* class-based dark mode (or rely on the light-dark() default) */
.dark {
  --xr-bone-color: #2a2a2e;
}

/* sheen mode — a unison highlight gradient built from the bone tokens */
[data-xr-root] {
  --xr-bone-fill: linear-gradient(
    100deg,
    var(--xr-bone-color) 35%,
    var(--xr-bone-highlight-color) 50%,
    var(--xr-bone-color) 65%
  );
}
```

To theme a single instance from JSX, wrap it in a `display:contents` element
that carries the token. It inherits into the skeleton and adds no box:

```tsx
<div style={{ display: 'contents', '--xr-bone-color': '#8fd694' } as CSSProperties}>
  <Skeleton plate={plate} loading={loading}>
    {children}
  </Skeleton>
</div>
```

Custom properties resolve to the nearest ancestor that sets them, so a value on
the skeleton root (`[data-xr-root="…"]`) or a leaf beats one on an outer
wrapper. React does not type `--*` keys, hence the `CSSProperties` cast.

## Behavior notes

- **Light/dark** follows the app's `color-scheme` via `light-dark()`, not the
  raw OS preference, so the skeleton tracks the app's chosen theme. Class-based
  themes override `--xr-bone-color` directly.
- **Leaf kinds** (`xr-leaf-text-line` / `xr-leaf-text-block` / `xr-leaf-media` /
  `xr-leaf-box` / `xr-leaf-hidden`) let text read as bars and media as blocks,
  themeable per kind.
- **Animation modes** are `solid | pulse | sheen`. A true traveling shimmer and
  per-bone stagger are non-goals: the bones share one animation timeline, and
  the `display:contents` root has no stacking box to host an overlay.
- Everything is progressive enhancement: a plain bone fill plus opacity pulse
  is the universally supported floor, and the only value-level features that
  can hard-break (`light-dark()`, relative color) are `@supports`-guarded.
