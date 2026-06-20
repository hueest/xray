# Product

## Register

brand

## Users

Frontend developers building on Vite — React first, more framework adapters
planned. They hand-write and hand-maintain skeleton loading states, and they're
tired of the drift: placeholders that no longer match the component, fixed-height
hacks, separate headless-browser tooling, skeletons that rot the moment the UI
changes.

Their context when they hit the site: at their own dev server, mid-task,
evaluating whether xray is worth adopting — or already adopting and reaching for
the reference. They skim, they want to see it work, and they want the API in
front of them fast. This is an audience that smells marketing fluff instantly and
distrusts a dev tool that oversells.

## Product Purpose

@hueest/xray is an open-source Vite plugin that captures the **real rendered DOM** of
your components as you browse your own dev server, then renders faithful
skeleton loading states from those captures — no hand-drawn placeholders, no
separate headless browser, no fixed-height/absolute hacks.

The website is **docs-led with a thin persuasive front door**. Its job, in order:
teach the tool and its mental model — the radiographic metaphor (Plate, Capture,
Stitch, View, Projection, Light Box) that makes the whole system click — and get
a developer from "what is this" to a working `<Skeleton>` with minimal friction.
The landing is a slim, vivid entry point; the depth is in the docs.

Success: a developer lands, _immediately gets it_ from a demo that shows a real
capture becoming a faithful skeleton, trusts that it's low-effort and accurate,
and finds the API without hunting.

## Brand Personality

Playful and a little macabre — radiographic, witty, exacting. The skeletal /
x-ray metaphor is the throughline: bones, plates, the light box, the steel
capture Blink. It's used with wit, never gore — charming, not creepy; a wink, not a
horror set piece. The voice is confident and precise about the engineering (this
tool is _faithful_, and it says so plainly) but never stiff or salesy. It punches
well above the personality of a typical framework plugin.

Emotional goals: delight, the "oh, that's clever" recognition when the metaphor
lands, and trust that the captures are real and the output is faithful.

## Anti-references

Avoid all four saturated lanes — the site must have its own character, not a
recognizable template:

- **Generic dev-tool SaaS** — the Vercel/Linear clean-dark-gradient clone every
  framework tool ships. The single biggest slop risk for this category.
- **Editorial-magazine** — display-serif + italic + ruled columns + lowercase
  track-spaced mono labels. The "tasteful AI" lane.
- **Cutesy mascot-heavy** — illustrated characters, hand-drawn doodles, sticker
  energy. (Macabre-playful is the register, not cute.)
- **Enterprise/corporate** — stock-photo teams, trust badges, endless grids of
  identical feature cards.

## Design Principles

1. **Show the bones.** The product is about fidelity, so prove it live — a real
   capture becoming a faithful skeleton — instead of describing it. Demos over
   adjectives.
2. **Practice what you preach.** The site dogfoods xray's own skeletons in the
   open. Its loading states _are_ the product demo.
3. **The metaphor is the map.** Use the radiographic vocabulary
   (Plate / Capture / Stitch / View / Projection / Light Box) consistently and
   confidently, so the language teaches the system as the reader moves through it.
4. **Macabre with a wink, never gore.** Lean into skeletal wit and the x-ray
   conceit for memorability; keep it charming. Personality is the moat against the
   four anti-reference lanes.
5. **Respect the reader's time.** Expert tool, explained without condescension or
   filler. Concise, scannable, copy-pasteable; the fast path to a working
   `<Skeleton>` is always one click away.

## Accessibility & Inclusion

WCAG 2.2 AA. Body text ≥4.5:1; large text ≥3:1. Full keyboard navigation.

Two requirements the brand makes load-bearing:

- **Reduced motion is not optional.** The brand has real motion (the capture
  Blink, reveals, the radiographic conceit). Every animation needs a
  `prefers-reduced-motion: reduce` alternative — crossfade or instant.
- **Color is never the sole carrier of meaning.** This is true in the product
  itself (the HUD's green "captured" vs. grey "missing" coverage bands) and must
  hold on the site: pair color with text, shape, or icon.
