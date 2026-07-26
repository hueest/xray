---
title: Responsive & Views
description: Capture every View into one Plate.
---

A **View** is a viewport-width band whose structure a Capture targets. Resize the
browser and browse; each width you visit is captured on its own and carried whole
into the same Plate.

CSS-driven responsiveness (flex, grid, media queries) rides along in the captured
CSS and needs no extra work. xray records a **Projection** only where JavaScript
renders _different structure_ per width, such as a `matchMedia` branch that swaps
the markup: a divergent subtree gated by a `@media` rule that toggles
`display:none` at the boundary.

## Capture another View

1. Start the Vite dev server with xray enabled.
2. Render the component with `<Skeleton plate={plate} loading={loading}>` and let
   it reach its real content state.
3. Turn on **Capture** in the HUD, or open the page with `?xray-capture`.
4. Resize the browser to the View you want and let the component render for real.
5. Turn **Capture** off to end the session and write the Plate, then commit the
   updated `src/plates/<name>.ts` file.

Each capture is filed under the width band it was taken in. If the component only
changes with CSS, the same structural capture can serve multiple widths. If the
component changes markup with JavaScript, xray records a Projection for that View
so the shipped Skeleton can switch structure with `@media` Gates and no runtime
width measurement.

## When a View is missing

Use the HUD Coverage bands as the checklist. A lit band has a captured View; a dim
band still needs one. Visit one width inside the dim band and let the component
render for real. The next capture updates the same Plate rather than creating a
new name.

If a component has several `<Skeleton>` instances with the same Plate mounted at
once, xray lets the first one in document order write the Plate. The rest still
render from it; they do not race to overwrite the file.
