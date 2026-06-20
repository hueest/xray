---
name: xray
description: Auto-captured skeleton loading screens for Vite — a radiograph of your UI
colors:
  # The dark radiograph is canonical; LIGHT mode is this palette inverted (a
  # photographic negative), so only the dark values are defined. One unified cool
  # film-blue cast at hue ~250. OKLCH is the project's canonical format (Stitch's
  # linter prefers hex and will warn — accepted on purpose).
  # Steel and crimson share one base lightness (0.62) so the light-mode negative
  # (L → 1−L) can't flip which one reads lighter; the brightest text tokens also
  # carry a faint alpha (bone /0.78, ink /0.9) to read as exposed-on-film.
  radiograph-steel: 'oklch(0.62 0.11 246)'
  contrast-crimson: 'oklch(0.62 0.17 25)'
  film-black: 'oklch(0.09 0.02 256)'
  film-surface: 'oklch(0.13 0.02 254)'
  film-surface-2: 'oklch(0.17 0.02 252)'
  bone-white: 'oklch(0.95 0.012 244)'
  bone-muted: 'oklch(0.69 0.02 251)'
  film-line: 'oklch(0.28 0.02 253)'
typography:
  # Implemented as a token scale in theme.css (--xrw-text-xs…3xl + --xrw-display); the roles
  # below are the design abstraction over it. Display is Bricolage Grotesque; title-and-below
  # is Public Sans; labels are JetBrains Mono — the two grotesques never meet at one size.
  display: # hero catchphrase (--xrw-display); section h2 sits alongside at --xrw-text-3xl (≤2.6rem)
    fontFamily: "'Bricolage Grotesque', system-ui, sans-serif"
    fontSize: 'clamp(1.5rem, 1rem + 2.4vw, 2.5rem)'
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: '-0.02em'
  headline:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: 'clamp(1.5rem, 3vw, 2.25rem)'
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.01em'
  title:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: '1.25rem'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 'normal'
  body:
    # Site-wide reading size is --xrw-text-md (1.125rem); code blocks pin back to
    # 1rem. Base leading is --sl-line-height 1.5; long-form marketing/docs prose
    # opts up to 1.6.
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: '1.125rem'
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 'normal'
  label:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: '0.8125rem'
    fontWeight: 500
    letterSpacing: '0.02em'
rounded:
  # Two box radii only: sm for small chips/markers, md for every box (cards,
  # panels, code, the demo).
  sm: '3px'
  md: '8px'
  full: '999px'
spacing:
  # rem scale carrying the page's vertical rhythm (CSS: --xrw-space-*, in theme.css); the
  # two fluid steps set section spacing — --xrw-block within a section, --xrw-section between.
  2xs: '0.25rem' # 4px
  xs: '0.5rem' # 8px
  sm: '0.75rem' # 12px
  md: '1rem' # 16px
  lg: '1.5rem' # 24px
  block: 'clamp(1.75rem, 4vw, 2.75rem)'
  section: 'clamp(3rem, 7vw, 5rem)'
components:
  button-primary:
    backgroundColor: '{colors.radiograph-steel}'
    textColor: '{colors.film-black}'
    rounded: '{rounded.sm}'
    padding: '12px 24px'
  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.radiograph-steel}'
    rounded: '{rounded.sm}'
    padding: '12px 24px'
  card:
    backgroundColor: '{colors.film-surface}'
    textColor: '{colors.bone-white}'
    rounded: '{rounded.md}'
    padding: '24px'
  input:
    backgroundColor: '{colors.film-black}'
    textColor: '{colors.bone-white}'
    rounded: '{rounded.sm}'
    padding: '10px 14px'
  chip:
    backgroundColor: 'transparent'
    textColor: '{colors.bone-muted}'
    rounded: '{rounded.full}'
    padding: '4px 12px'
---

# Design System: xray

## 1. Overview

**Creative North Star: "The Reading Room"**

A darkened radiology reading room. A film hangs on the negatoscope and glows from
behind; the bones read as luminous blue-white against the black. That is the whole
system. xray captures the real skeleton of a UI and renders it faithfully — so the
brand should feel like reading a radiograph: clinical, exact, quietly luminous, and
faintly unnerving in the way that looking at your own bones always is. Playful, with
a hint of doom.

The two themes are a radiograph and its **negative**. The DOM is always painted as
the dark film; **light mode inverts the whole page** (`invert(1) hue-rotate(180deg)`,
with raster media re-inverted), the way a positive radiograph relates to its negative.
So there is one palette, not two. **Dark** — the signature, hero mood — is the backlit
film in the reading room: a near-black cool-blue field with bones glowing out of it.
**Light** is that exact image flipped: a cool, sterile near-white with the structure
printed dark on it. The site follows the system preference with **no toggle**.

This system explicitly rejects the four lanes its category drowns in. It is **not**
the generic dev-tool SaaS look (the Vercel/Linear clean-dark-gradient clone every
framework plugin ships). It is **not** editorial-magazine (display-serif italic over
ruled columns with lowercase track-spaced labels) — the display here is a _blunt
grotesque_, never a dainty italic serif. It is **not** a cutesy mascot site — the doctor mark is a
deadpan caricature, never a cuddly sticker. And it is **not** enterprise-corporate —
no stock-photo teams, no trust badges, no endless grid of identical feature cards.
It has its own character or it has failed.

**Key Characteristics:**

- One palette; dark is the positive radiograph, light is the page inverted. No toggle.
- A narrow three-hue cast (~250): cool film-blue, a desaturated steel accent, rare crimson.
- A page-wide film filter — grain, vignette, and glow — over the whole surface (no
  scroll-repainting blend or backdrop-filter; the tone curve lives in the palette).
- Depth is conveyed by **glow** (text + box, inward and outward), never grey drop shadows.
- A blunt idiosyncratic grotesque (Bricolage Grotesque) over clinical sans (Public Sans).
- The site dogfoods xray's own skeletons as its real loading states.

## 2. Colors

A near-greyscale cool film at one hue (~250), carrying exactly two real colors: a
desaturated steel accent and a rare arterial crimson. Values below are the **dark
(canonical)** palette; light mode is the whole page inverted, so it needs no separate
values. Contrast ratios are preserved through the invert.

### Primary

- **Radiograph Steel** (`oklch(0.62 0.11 246)`): the steel accent — links, primary
  actions, the focus ring, the glow that bleeds off the display type, the "captured"
  coverage state. An x-ray _plate-blue_: not a pure web-blue and never cyan. Its lightness
  is matched to crimson (both at L 0.62) so the light-mode negative (L → 1−L) can't flip
  which of the two reads brighter — they stay balanced in both themes.

### Secondary

- **Contrast Crimson** (`oklch(0.62 0.17 25)`): the hint of doom. Annotation red, the
  marker a radiologist circles a fracture with. Reserved for genuine danger and the rare
  macabre wink — never decoration. Luminance-matched to the steel accent (both L 0.62).

### Neutral

- **Film Black** (`oklch(0.09 0.02 256)`): the page — the unexposed film in the dark
  room. A deep near-black with a faint cool cast (darkened so the bones read brighter
  against it). Never a warm cream — this room is cold.
- **Film Surface** (`oklch(0.13 0.02 254)`): raised panels (cards, the nav bar) — one
  step off the page.
- **Film Surface-2** (`oklch(0.17 0.02 252)`): the deepest raised step — inline code and
  nested panels.
- **Bone White** (`oklch(0.95 0.012 244)`): primary text and the fill of the bones
  themselves. The diagnosis, in high contrast. (The body text token sits a hair below at
  `0.94`.) The brightest text tokens carry a faint alpha — bone `/0.78`, ink `/0.9` — so
  the dark field and grain show through the glyphs (exposed-on-film, not a flat sticker);
  the alpha survives the light-mode invert, which flips RGB but not alpha. Dim/muted tokens
  stay opaque to hold their contrast.
- **Bone Muted** (`oklch(0.69 0.02 251)`): secondary text, captions, mono labels.
  Contrast-checked to clear 4.5:1 against the film — never a decorative low-contrast grey.
- **Film Line** (`oklch(0.28 0.02 253)`): hairline borders and dividers — the edge of a
  film, the rule on a chart.

### Named Rules

**The Three-Hue Rule.** The entire system is one cool film-blue neutral plus the steel
accent plus contrast-crimson. No fourth hue earns its way in. Breadth comes from
luminance and the glow, not from more colors.

**The Negative Rule.** There is one palette: the dark film. Light mode is that exact
page inverted (`invert(1) hue-rotate(180deg)`), never a separately-tuned light theme.
Raster media (`img`, `video`, `canvas`) is re-inverted so photos read normally.

**The Bloodless Rule.** Contrast-crimson appears on a vanishingly small fraction of any
view. A hint of gore is unnerving; gore everywhere is a horror-movie poster. If crimson
is the first color you notice, it has already overstayed.

## 3. Typography

**Display Font:** Bricolage Grotesque (with `system-ui, sans-serif` fallback)
**Body Font:** Public Sans (with `system-ui, sans-serif` fallback)
**Label / Mono Font:** JetBrains Mono (with `ui-monospace, monospace` fallback)

**Character:** An idiosyncratic grotesque — uneven widths, blunt ink traps, a face that
looks engineered but slightly _off_, like signage in a building that's seen things — set
against the flat institutional neutrality of the U.S. government's own text face. The
headline is blunt and a little ominous; the body reads like an official chart. Both are
grotesques, so the contrast is carried by _size and weight_: Bricolage appears only big
and heavy, Public Sans handles everything at title size and below, and the two never meet
at the same size.

### Hierarchy

- **Display** (Bricolage Grotesque 700, `clamp(1.5rem, 1rem + 2.4vw, 2.5rem)` =
  `--xrw-display`; section `h2` sits alongside at `--xrw-text-3xl`, ≤2.6rem): the hero
  catchphrase and section titles. Big and rare — the wonk is the voice; never tracked out,
  never italic. (The navbar wordmark is the lone 800-weight use.)
- **Headline** (Public Sans 700, `clamp(1.5rem, 3vw, 2.25rem)`, line-height 1.15):
  sub-section heads inside docs and long pages.
- **Title** (Public Sans 600, 1.25rem, line-height 1.3): card titles, callout heads,
  the strong line above a paragraph.
- **Body** (Public Sans 400, 1.125rem = `--xrw-text-md`, base line-height 1.5): prose and
  docs, site-wide (docs, guides, splash). Code blocks pin back to 1rem (`--xrw-text-base`).
  Long-form marketing/docs prose opts up to line-height 1.6 (light type on dark needs the
  breathing room). Cap measure at 65–75ch.
- **Label** (JetBrains Mono 500, 0.8125rem, letter-spacing 0.02em): mono is _earned_
  here — this is a developer tool and the labels are code-adjacent (filenames, plate
  names, coverage bands, kbd hints). Not a costume; an actual signal that "this is the
  machine talking."

### Named Rules

**The Blunt-Not-Tasteful Rule.** Bricolage Grotesque is here for its wonk and bluntness,
not polish. Use it big and heavy; never tracked out, never italic over ruled columns
(the editorial-magazine lane this brand rejects). The _hint of doom_ rides on the
palette (rare crimson), the deadpan doctor mark, the dark reading-room mood, and an
optional fine film-grain texture — not on the type.

**The Mono-Means-Machine Rule.** JetBrains Mono is reserved for things the computer
produced or consumes — code, filenames, plate names, coverage states, shortcuts. Prose
is never mono. Mono used as generic "techy flavor" reads as costume and is forbidden.

**The No-Shift Rule.** All three families are self-hosted and preloaded through the
**Astro Fonts API** (`fontProviders.fontsource()`), each shipped with an automatic
metric-matched fallback (`size-adjust` / `ascent-override` / …). The fallback occupies
the exact space of the web font, so the swap causes zero layout shift (CLS 0). Plain
`@fontsource` CSS imports — which reflow on swap — are forbidden.

## 4. Elevation

Flat by default. This is film on a panel — no physical stack of cards casting shadows.
Depth is conveyed by **light**: text and boxes emit a soft steel/bone glow, and a
page-wide film filter sits over the whole surface. Grey drop shadows are off-concept and
forbidden; a glow says "this is lit from behind," a shadow says "this is a 2014 Material
card."

### The Film Filter (page-wide)

Two fixed, `pointer-events: none` overlays on the body, each on its own compositor layer
with **no blend mode and no backdrop-filter**: `mix-blend-mode`, `backdrop-filter`, and
`background-attachment: fixed` each force a full-viewport main-thread repaint every
scroll frame (scroll jank). The radiograph tone curve lives in the palette itself — the
deep Film Black against bright Bone — plus the glow, rather than a live filter.

- **Grain** (`feTurbulence`, white-alpha matrix, opacity ~0.11 via `--xrw-grain`): static
  quantum-mottle texture over the whole page, behind text legibility.
- **Vignette** (a single radial-gradient, `position: fixed`): the film edge.

### Glow Vocabulary

- **Text** (faint): a cool halo inherited by all text from the body, at full text contrast.
- **Display** (medium → big): headings get a medium bloom; the hero wordmark _emits light_
  (bright bone core → wide cool falloff). The small navbar wordmark stays medium — the big
  bloom reads as a box at that size.
- **Box** (`box-shadow`, outer **and** `inset`): cards and asides are backlit film edges —
  lit within and without, never an offset grey shadow. Code frames take a single soft
  **outer** edge only (a stacked inner+outer glow on every code block reads as haze).

### Named Rules

**The Backlight Rule.** Depth is light, not shadow. Every elevation is a glow toward steel
or bone-white; offset grey drop shadows are prohibited. Corollary: the
1px-border-plus-soft-grey-drop-shadow ghost card is doubly banned here.

## 5. Components

### Buttons

- **Shape:** film corners — small, precise (3px, `{rounded.sm}`). Never pill-rounded
  except true tags.
- **Ghost (the default):** the standard CTA — a translucent Film Surface fill, hairline
  Film Line border, Bone label, ~2.5rem min-height. The site's lead actions (View on
  GitHub, the install chip, llms.txt) are all this variant.
- **Solid (exceptional only):** solid Radiograph Steel fill, Film Black text, 12px×24px
  padding — the lit element on the page. Reserved for a single exceptionally important CTA,
  never the default; today it appears only on illustrative product-UI bits (the HUD
  "Capture all views", the demo's "Add to cart").
- **Hover (site-wide, every button):** the edge lights to Radiograph Steel with a backlit
  outer glow, struck on with a quick **flicker** (the `xr-edge-strike` keyframe, ~200ms,
  stepped) — no transform, no 1px lift. Borderless chrome buttons (search, copy, sidebar)
  just show the glow strike. Excluded: the comparison slider handle and the demo's
  decorative Add-to-cart. Reduced-motion drops the flicker and applies the resting hover
  instantly.
- **Focus:** a single 2px solid Radiograph Steel outline at 3px offset; never removed.

### Chips / Tags

- **Style:** transparent, pill (`{rounded.full}`), Bone Muted mono label, hairline Film
  Line border.
- **State:** coverage-style states pair color **with text and shape**, never color alone
  — "captured" is steel label + filled dot; "missing" is muted label + hollow dot. (This
  is the product's own HUD language and the accessibility line from PRODUCT.md.)

### Cards / Containers

- **Corner Style:** 8px (`{rounded.md}`) — the ceiling. Never more rounded.
- **Background:** Film Surface, one step off the page.
- **Shadow Strategy:** none at rest (flat). On hover, the Exposure bone-white bloom only.
  See § 4.
- **Border:** a single hairline Film Line border on all sides. Never a thick colored
  side-stripe.
- **Internal Padding:** 24px (`{spacing.lg}` scale).

### Inputs / Fields

- **Style:** inset — Film Black background recessed into the surface, hairline Film Line
  border, 3px corners.
- **Focus:** the field lights up — border goes Radiograph Steel and the steel backlight
  bloom appears behind it. Never a removed outline.
- **Error:** border and helper text go Contrast Crimson, paired with an icon and message
  (never crimson alone).

### Navigation

- **Style:** a flat Film Surface bar, mono (JetBrains Mono) labels, hairline bottom Film
  Line.
- **States:** default Bone Muted; hover brightens to Bone White; the active item gets a
  steel underline-glow (ambient backlight on the underline, not a filled pill).
- **Mobile:** collapses to a single mono "menu" toggle; the panel slides as a film over
  the page (reduced-motion: instant).

### Tabs

- **Style:** no full divider under the tablist. The active tab is marked by the Radiograph
  Steel label color, the head glow, and a 1px underline that fades out at both ends (a
  centered gradient hairline) — **no** box-shadow.
- **No reflow:** the active state never changes font-weight (a weight change widens
  the label and shoves the row sideways); emphasis rides color + glow only.

### The Skeleton & Light Box (signature)

**Built:** the hero stage runs a live before/after **comparison slider**. The real
product is server-rendered ("after"); a client script captures it with xray core
(`captureElement` → a Plate plus its css, `renderPlateHtml` — the two-artifact
contract, ADR 0026) and reveals the rendered skeleton
("before") clipped to a draggable seam — pixel-faithful, so dragging the seam morphs
bones↔content. Bones render in Bone White on the film; the grip pulses once to invite the
drag (reduced-motion: no pulse). No client framework ships — the bones come straight from
core as one HTML string.

**Pending (slated for the real docs):** the full _Dogfood Rule_ — the site's own loading
states being real xray skeletons — plus the one-shot steel **Blink** bloom (a
radiographic expose) and a docs **Light Box** affordance mirroring the plugin's HUD toggle
to flip live regions to their skeletons. Each will carry a `prefers-reduced-motion: reduce`
path (the Blink a quiet crossfade, the reveal an instant swap). Not yet implemented on
the static site.

### Named Rules

**The Dogfood Rule.** Loading and empty states on this site are real xray skeletons, not
hand-drawn placeholders. The site is the demo. (**Pending:** the live demo today is the
hero comparison slider, a real core capture; full loading-state dogfooding lands with the
real docs.)

## 6. Do's and Don'ts

### Do:

- **Do** follow the system theme with **no toggle**; light mode is the dark film inverted
  (the Negative Rule), not a separately-tuned theme.
- **Do** hold the palette to the Three-Hue Rule: one cool film-blue neutral, Radiograph
  Steel, and a rare Contrast Crimson.
- **Do** keep Contrast Crimson rare (the Bloodless Rule) — danger and the macabre wink only.
- **Do** convey depth with the steel/bone glow and the page-wide film filter (the Backlight
  Rule); flat at rest.
- **Do** dogfood xray's own skeletons as the site's real loading states (the Dogfood Rule)
  — _pending_ for now; the hero comparison slider is the current live capture demo.
- **Do** pair every color-coded state with text, icon, or shape — never color alone
  (WCAG 2.2 AA; the coverage bands are the test case).
- **Do** give every motion — the capture Blink, the reveal, nav slide — a
  `prefers-reduced-motion: reduce` crossfade-or-instant fallback.
- **Do** keep body measure at 65–75ch and add line-height for light type on dark film.

### Don't:

- **Don't** ship the **generic dev-tool SaaS** look: the Vercel/Linear clean-dark-gradient
  clone, the hero-metric template, the glow-blob background. The single biggest slop risk.
- **Don't** drift into **editorial-magazine**: display-serif _italic_, ruled multi-column
  layouts, lowercase track-spaced mono eyebrows above every section. Bricolage is blunt and
  heavy, never a dainty italic serif (the Blunt-Not-Tasteful Rule).
- **Don't** go **cutesy / mascot-heavy**: no hand-drawn doodles, sketchy SVG illustrations,
  or sticker energy. (The film grain is `feTurbulence` used as _texture_ — fine; this bans
  illustrations.) The doctor mark is a deadpan caricature, not a cuddly mascot.
- **Don't** go **enterprise / corporate**: no stock-photo teams, trust badges, or endless
  grids of identical icon-heading-text feature cards.
- **Don't** use grey offset drop shadows, or the 1px-border + ≥16px-blur ghost card. Depth
  is light here.
- **Don't** round cards past 8px, use colored side-stripe borders (`border-left` accents),
  gradient text (`background-clip: text`), default glassmorphism, or repeating-stripe
  backgrounds.
- **Don't** set body copy in mono or all-caps; mono means the machine is talking
  (the Mono-Means-Machine Rule).
