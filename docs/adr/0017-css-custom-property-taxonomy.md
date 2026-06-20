---
status: accepted
---

# CSS custom-property taxonomy: `--xr-bone-*` / `--xr-skeleton-*` and the `--xrw-*` site split

> **Amends ADR 0011.** That ADR made `--xr-*` a public theming API but with flat,
> terse names (`--xr-bone`, `--xr-radius`, `--xr-anim`, …). This ADR restructured
> that surface into the current taxonomy — 0011's body carries these names,
> and the old→new mapping below is the historical record. The _policy_ in 0011
> (theming via inheritable custom properties + `light-dark()`, set-once-cascade)
> is unchanged.

Three forces converge: 0011's flat names aren't self-documenting; the
display-timing tokens (ADR 0016) need a home; and the website defines its _own_
`--xr-*` design tokens, including **`--xr-bone`** with a different meaning than
the runtime's, while rendering live `<Skeleton>` demos — a site-level
`--xr-bone`/`--xr-radius*` silently re-themes the very skeletons it demos.
Nothing is published, so a breaking rename is free; after publish it never is
again.

## Decision

- **Reserve `--xr-*` strictly for the runtime skeleton API.** Move _all_ website
  design tokens to **`--xrw-*`** ("xray website"). Starlight's `--sl-*` stays.
- **Restructure the runtime surface into two explicit families** (verbose,
  self-documenting, mirroring real CSS property names):
  - **`--xr-bone-*`** — appearance of an individual Bone:
    `--xr-bone-color`, `--xr-bone-highlight-color`, `--xr-bone-fill`,
    `--xr-bone-border-radius`, `--xr-bone-text-line-border-radius`,
    `--xr-bone-media-border-radius`, `--xr-bone-animation`,
    `--xr-bone-animation-duration`, `--xr-bone-pulse-opacity-min`,
    `--xr-bone-pulse-opacity-max`.
  - **`--xr-skeleton-*`** — whole-skeleton timing (ADR 0016):
    `--xr-skeleton-delay`, `--xr-skeleton-min-duration`,
    `--xr-skeleton-transition-duration`.
- **Private channels** `--xr-o` (pulse) and `--xr-reveal` (timing) stay
  undocumented `@property` plumbing — not a theming surface.
- **Terminology** (the [glossary](https://xray-js.dev/glossary/)): **Bone** = the rendered visual piece (what
  `--xr-bone-*` styles); **Leaf** = the internal structural node it paints from.
- **`--xr-bone-*` is theming vocabulary only; the DOM class is exempt from the
  rename.** The structural class stays `LEAF_CLASS = "xr-leaf"` (and `xr-leaf-text-line`
  / `-media` / `-box`), not `xr-bone-*`: Bone is how a Leaf renders, so the class —
  which names the structural Leaf node — keeps the Leaf name.

Old → new mapping:

| old (ADR 0011)        | new                                 |
| --------------------- | ----------------------------------- |
| `--xr-bone`           | `--xr-bone-color`                   |
| `--xr-bone-highlight` | `--xr-bone-highlight-color`         |
| `--xr-fill`           | `--xr-bone-fill`                    |
| `--xr-radius`         | `--xr-bone-border-radius`           |
| `--xr-radius-text`    | `--xr-bone-text-line-border-radius` |
| `--xr-radius-media`   | `--xr-bone-media-border-radius`     |
| `--xr-anim`           | `--xr-bone-animation`               |
| `--xr-duration`       | `--xr-bone-animation-duration`      |
| `--xr-pulse-min`      | `--xr-bone-pulse-opacity-min`       |
| `--xr-pulse-max`      | `--xr-bone-pulse-opacity-max`       |

## Considered alternatives

- **Keep the terse flat names.** Rejected: collision-prone and not
  self-documenting; the bone/skeleton split makes intent legible at the call site.
- **`--site-*` / `--rr-*` for the website.** `--xrw-*` chosen — keeps the visual
  family and is app-internal, so terseness is fine.
- **A neutral `--xr-transition-duration` (no family).** Rejected in favor of
  `--xr-skeleton-transition-duration` so every public token lives in exactly one
  family (zero orphans), accepting that the fade also covers the content swap-in.

## Consequences

- A breaking rename of the ADR-0011 token contract — acceptable only because
  nothing was published. 0011's original flat list is superseded; its body
  shows this taxonomy.
- ~40 website tokens renamed to `--xrw-*`; the latent `--xr-bone` collision is
  resolved by construction.
- New tokens added here remain a public API: renaming one is, again, a breaking
  change (the 0011 rule still holds).
