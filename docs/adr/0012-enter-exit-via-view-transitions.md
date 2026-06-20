---
status: accepted
---

# Enter/exit animation via View Transitions, opt-in (not `@starting-style`)

When a `<Skeleton>` becomes ready it swaps to content, and an animated swap is
worth offering. Decision: the swap animation is the **View Transitions API**,
**opt-in** (a `viewTransition` prop/option), with the default staying a crisp
instant swap. `@starting-style` is _not_ used for the swap (it is the right
tool for boxed one-shot entrances; ADR 0016's reveal channel uses it in
BASE_CSS). **Implementation is deferred**: this records the direction so it is
not relitigated.

## Why View Transitions and not `@starting-style`

Three of the project's own design choices defeat a CSS enter/exit
(`@starting-style` + `transition-behavior: allow-discrete`) for the swap
specifically:

1. The skeleton root is `display:contents` — **no box** to fade or to stack for a
   crossfade.
2. ADR 0002 keeps content **unmounted while loading**, so there is no second
   layer to crossfade _to_ until the instant of the swap.
3. The single opacity channel (`--xr-o`) is already owned by the pulse timeline.

View Transitions sidesteps all three: it snapshots the outgoing skeleton and the
incoming content as _images_ and animates between them at the browser level,
needing no box, no overlap, and no pre-mounted content. Giving the skeleton root
and content root the same `view-transition-name` even makes the browser
**morph** skeleton → content — a fitting move, since the skeleton is that
content's captured structure.

## Why opt-in, not the default

Same-document View Transitions are document-scoped and **one-at-a-time** — a new
transition interrupts the active one. A feed with many `<Skeleton>`s resolving
independently would thrash. Element-scoped view transitions fix exactly this but
shipped in **Chrome/Edge 147 only** (April 2026) and are not Baseline. So a
per-instance default isn't safe yet; it stays opt-in for a single prominent/
route-level boundary until scoped transitions are widely available.

## Considered alternatives

- **`@starting-style` + `allow-discrete` for the swap** — rejected for the three
  reasons above. Reserved for the HUD's own enter/exit, where it fits and is
  Baseline.
- **Whole-document View Transitions as the default** — rejected: one-at-a-time
  scope thrashes with many independent boundaries.
- **Keep both skeleton and content mounted and CSS-crossfade** — rejected: a
  crossfade needs a stacking box, which conflicts with the `display:contents`
  layout-neutral root, and pre-mounting content violates ADR 0002.

## Consequences

- An opt-in `viewTransition` surface (prop/plugin option), implemented later. It
  touches the **production** adapter and the per-framework swap (React 19.2
  `<ViewTransition>`/`startViewTransition`; other adapters wrap the state flip in
  `document.startViewTransition`), so it is scoped as a follow-up, not part of the
  CSS-token theming pass.
- Always feature-detected (`if (document.startViewTransition)`) and gated by
  `prefers-reduced-motion` (incl. `::view-transition-group(*) { animation: none }`).
- Revisit promoting it to a per-instance default once element-scoped view
  transitions are Baseline.
