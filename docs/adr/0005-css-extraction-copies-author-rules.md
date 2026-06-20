---
status: accepted
---

# CSS extraction copies author rules (the bake-off winner)

A bake-off compared the two extraction strategies on a plate of the dogfood
app's portfolio banner (185+ nodes, two-column grid, SVG charts, tabs), captured in
a Storybook harness against an auto-mocked API schema and audited node-by-node
against the live render:

- **copy** (lift matching author rules, selectors rewritten to plate-local ids,
  cascade preserved by approximate specificity + source order): total height
  **1272px vs 1264px real** at the capture viewport, and the same desktop plate
  reflowed correctly to a single column at 390px through the carried `@media`
  rules — no recapture.
- **computed** (per-node `getComputedStyle` values, widths frozen to px):
  **2192px vs 1264px real** — frozen widths compose wrong as soon as the
  surrounding flow differs from the capture context, and there is no
  responsiveness at all without per-view recapture.

So plates carry copied author rules. The known costs, accepted: `var()`
references are frozen to their capture-time resolved value, pseudo-element
rules are dropped (v1), and `:is()/:not()` specificity is approximated by
summing arguments. None of these moved the fidelity numbers on a real-world
component.

The remaining mobile gap (section _order_ differs when JS `matchMedia` picks
different structure) is exactly the fork problem ADR 0004 assigns to multi-view
capture, not a CSS-extraction concern.

## Amendment: `@container` carried like `@media`

Container queries, deferred at v1 (viewport-only), are captured the same way
`@media` is: `collectStyleRules` descends `CSSContainerRule`, threading its
`<container-condition>` on each lifted rule (a `container: string[]` stack
alongside `media`), and `classify` re-wraps the rule in `@container …` at emit.
`container-type` / `container-name` / `container` join the captured layout
properties, so the bone is itself a query container and the condition
**re-evaluates against the skeleton's own width**: a container-query layout (a
grid that goes 1→2 columns) reflows in the bones with no recapture, exactly as
the `@media` case does. The copy strategy generalizes — a new
conditional-grouping at-rule is a threading change, not a schema rewrite.
(`@supports` stays resolved-at-capture; non-width media axes remain deferred.)

## Revisited: the frozen `var()` / `fluidTracks` costs

The two freezes accepted above — `var()` resolved to capture-time values and
px-only grid tracks reconstructed by `fluidTracks` — are revisited by
[ADR 0019](./0019-carried-intent-and-salience-driven-capture.md), which carries
author custom-property definitions conditionally so the engine re-resolves them
at render, reducing freezing to content-measured sizes and the genuinely
unreadable. The copy-over-freeze decision itself stands and is reinforced.
