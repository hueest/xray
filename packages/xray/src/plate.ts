/**
 * Bump when the serialized shape changes incompatibly. The disk/wire shape is the STRUCTURED
 * `StoredPlate` (`{ v, name, breakpoints, tree, css }`) — the whole Plate already projected in the
 * browser (ADR 0022). The validator pins `v: PLATE_VERSION`, so a file carrying any other version
 * degrades to empty (recapture) rather than mis-parsing.
 */
export const PLATE_VERSION = 1

/** App code imports plates from here, e.g. `import plate from 'virtual:xray/plates/my-banner'`. */
export const VIRTUAL_PREFIX = 'virtual:xray/plates/'

/** Marks the rendered skeleton root; carries the plate name. Also a dev capture marker. */
export const ROOT_ATTR = 'data-xr-root'
/**
 * Marks an OUTERMOST skeleton root that is a stitch continuation (ADR 0020): a standalone
 * `<Skeleton>` replacing a stitch a still-showing parent skeleton was just rendering. BASE_CSS
 * reveals such a root instantly (no `--xr-skeleton-delay`, no fade) so the bones do not flash away
 * and back. Never present on a nested stitch (which inherits the parent's reveal and has no
 * `@starting-style` of its own) nor on an ordinary top-level skeleton (which keeps the normal
 * delay).
 */
export const ROOT_INSTANT_ATTR = 'data-xr-instant'
/**
 * Marks a `<Content>` capture boundary in dev; carries the plate name. A parent capture treats it
 * as a stitch — it references the child plate by name instead of re-serializing the child's subtree
 * (ADR 0006).
 */
export const BOUNDARY_ATTR = 'data-xr-boundary'

/**
 * `hidden` is EXPLICIT-ONLY (a `data-xr-bone-kind` hint or a walker `ctx.bone({ kind: 'hidden'
 * })`), never inferred: a bone that holds its measured box in the layout but paints nothing — the
 * space-preserving complement to `data-xr-ignore`, which drops the box entirely.
 */
export type LeafKind = 'text-line' | 'text-block' | 'media' | 'box' | 'hidden'

/**
 * The shipped structural capture of a component's rendered DOM — the TREE artifact a Skeleton
 * renders from (see the glossary: xray-js.dev/glossary). A Plate carries structure ONLY (ADR 0026):
 * its scoped CSS is an INDEPENDENT sibling artifact — the plugin serves it through Vite's own CSS
 * pipeline (`virtual:xray/plates/<name>.css`, plus the shared `virtual:xray/base.css`, and an
 * `export const css` on the virtual JS module for dev/programmatic reads), and the
 * framework-neutral `core.ts` path hands it back separately (`captureElement` → `{ plate, css }`;
 * `renderPlateHtml(plate, css)` receives it explicitly). Consumers decide how to render either
 * part. Still self-contained in ADR 0003's sense: both artifacts originate from the capture and
 * depend on nothing in the consumer's build. Built from the RenderNode tree at plugin load (see
 * chunk.ts), so the adapter injects strings instead of walking a tree on the latency-critical first
 * paint — and no per-framework serializer ships to the client (ADR 0008).
 */
export interface Plate<F = unknown> {
  v: number
  /** Capture name; comes from the virtual-module specifier, never typed at a call site. */
  name: string
  /**
   * PHANTOM fixture type (typed fixtures, ADR 0031) — never present at runtime; committed plates
   * carry no such field. The generated env file (`xray-env.gen.d.ts`, ADR 0032) declares a
   * fixture-bearing plate's virtual module as `Plate<typeof import('./<name>').fixture>` (the `as
   * const` fixture export's derived type), and this optional field is the structural anchor that
   * keeps `F` alive through assignability (an unused type parameter would be erased and the drift
   * check in react.core.tsx would silently no-op). The tilde key is the type-only-member convention
   * (standard-schema's `~standard`): it reads as internal, and a STRING key stays structural across
   * the package's bundled d.ts entry points — a `unique symbol` would be declared once PER ENTRY by
   * the d.ts bundler, and two copies of the symbol never unify, breaking `F` inference for any
   * consumer that mixes entry points (the React adapter with the plugin types). The `unknown`
   * default means a bare `Plate` — the wildcard virtual-module declaration, every internal use — is
   * UNCHECKED and stays assignable from any `Plate<F>`.
   */
  readonly '~fixture'?: F
  /**
   * The root's children, pre-serialized (ADR 0008): a stitch-free run is one HTML `string`; a
   * stitch is `{ r: name }`; a stitch-bearing element is `{ c: className, k: chunk[] }`. Null until
   * first capture.
   */
  chunks: Chunk[] | null
  /** The root node's own content classes (its inherited font context), if any. */
  rootCls?: string
  /**
   * Child plates named by the chunks' `{ r }` stitches, resolved through the import graph (ADR
   * 0006). Populated by the loader's generated imports, never serialized into the plates JSON;
   * absent in production when there are no stitches. In dev the live store takes precedence, so
   * this need not be present.
   */
  refs?: Record<string, Plate>
}

/**
 * One serialized child of a plate root (or of a stitch-bearing node): a stitch-free HTML run
 * (`string`), a stitch to a child plate (`{ r: name }`), a stitch-bearing element kept real so its
 * inner stitches can mount (`{ c: className, k: chunk[] }`), or a templated uniform run (`{ t:
 * html, n }`): the cell's HTML once plus a repeat count the adapter expands to N copies (Template,
 * ADR 0022). The framework-neutral render contract: an adapter injects the strings, mounts a child
 * plate at each stitch, and repeats each template (ADR 0008).
 */
export type Chunk = string | { r: string } | { c: string; k: Chunk[] } | { t: string; n: number }

/**
 * A plate after the in-browser Serialize (emit + gate + classify) but before chunk serialization:
 * the build-time RenderNode tree plus its scoped CSS. Produced by `serializePlateIR` (the
 * structural part of `StoredPlate`) and the single-View `capture`, then serialized into the shipped
 * `Plate` (chunks) at load (`serializePlate`). Never shipped to the client.
 */
export interface GatedPlate {
  v: number
  name: string
  tree: RenderNode | null
  css: string
}

export interface PlateNode {
  /** Plate-local id; rules reference it pre-classify. Stripped from the shipped tree. */
  id: number
  /** Present on paint leaves; absent on layout containers. */
  leaf?: LeafKind
  /**
   * A stitch: render the named child plate's skeleton here instead of own structure (ADR 0006).
   * Mutually exclusive with `leaf`/`kids`. Resolved against `Plate.refs` (prod) or the live store
   * (dev).
   */
  ref?: string
  /**
   * A templated uniform run (Template, ADR 0022): render this node's subtree `count` times. The
   * serializer emits the subtree's HTML once plus the count; the adapter expands it to N copies at
   * render. Absent on ordinary nodes.
   */
  count?: number
  kids?: PlateNode[]
}

/**
 * A node in the shipped tree, after classify (ADR 0007). Carries the content-addressed style
 * classes it needs instead of an id — the CSS targets those classes, not a per-node `data-xr`
 * value, so no per-node scoping key is needed. `cls` is a space-joined class-token list.
 */
export interface RenderNode {
  leaf?: LeafKind
  ref?: string
  cls?: string
  /**
   * A templated uniform run (Template, ADR 0022): serialize this subtree once + a count the adapter
   * repeats.
   */
  count?: number
  kids?: RenderNode[]
}

/**
 * A captured style rule in id form — selectors are generated downstream, so Serialize can remap
 * node ids without string surgery. `ids: []` targets the plate root.
 */
export interface PlateRule {
  ids: number[]
  decls: string[]
  /** Media-condition stack, outermost first; conditions AND together. */
  media?: string[]
  /** `@container`-condition stack, outermost first; conditions AND together. Absent when none. */
  container?: string[]
  layered?: boolean
  spec: number
  order: number
}

/**
 * Rule spec tiers. Context and plain fallbacks sit _under_ author rules (a guess the author CSS
 * refines). A leaf's measured size sits _over_ them: a leaf is a terminal paint block, so its
 * captured width/height is the truth — a copied `width: auto` or `width: 100%` must not shrink or
 * stretch it. Gates beat everything.
 */
export const SPEC_CONTEXT = -2
export const SPEC_FALLBACK = -1
export const SPEC_LEAF = 9_000_000
export const SPEC_INLINE = 10_000_000
export const SPEC_GATE = 20_000_000

/**
 * One capture of a component within one viewport view — `[min, max)` in px, either side open-ended
 * when undefined. The id-form `{ tree, rules }` shape `emit` projects a measured View into (ADR
 * 0004). The disk/wire shape is `StoredPlate` (below); this is the framework-neutral per-View
 * capture shape, exported for consumers reading the id-form projection directly.
 */
export interface ViewCapture {
  /** Viewport width at capture time. */
  width: number
  min?: number
  max?: number
  tree: PlateNode
  rules: PlateRule[]
  /**
   * TRANSIENT, dev-only capture diagnostics (why this view may be lower fidelity). Captured in the
   * browser (mirrored onto `ViewIR.diagnostics`); the dev client logs it and posts it alongside the
   * `StoredPlate` (so the Vite server can print the same text). It MUST NEVER be persisted: it is
   * not part of the committed `StoredPlate` disk shape, the validator does not carry it, and the
   * POST envelope keeps it in a SIBLING field that never reaches the stored artifact (ADR 0008).
   * Absent in production (the prod adapter ships no capture). See diagnostics.ts and ADR 0008.
   */
  diagnostics?: import('./diagnostics.ts').CaptureDiagnostic[]
}

/**
 * The committed plate structure (ADR 0022) — the named `plate` export of the plate module
 * `src/plates/<name>.ts` (ADR 0034): the whole Plate already projected in the browser (the
 * in-browser Serialize folds emit + the multi-View gating + classify in one session), so disk holds
 * ONE gated, content-addressed tree + css rather than per-View captures assembled at load. It is a
 * `GatedPlate` (the structural `{tree, css}` `serializePlate` consumes) PLUS the `breakpoints` the
 * HUD coverage reads — the analysis-only geometry never crosses the wire (ADR 0021). The gen-side
 * runs `serializePlate(stored) → Plate` (chunks) at module-load, leaving the Tailwind/Bundle
 * passthrough a clean gen-side seam.
 */
export interface StoredPlate extends GatedPlate {
  /**
   * Width thresholds (view boundaries), pruned to the plate's OBSERVABLE differences (ADR 0029);
   * the HUD coverage derives its bands from these.
   */
  breakpoints: number[]
  /**
   * The bands actually CAPTURED (each surviving island's range, folded runs merged — ADR 0029). A
   * partial browse session stores only the bands it touched; coverage reads these instead of
   * assuming every band complete. Absent on plates written before the field existed — readers fall
   * back to the historical complete-coverage assumption until a re-capture.
   */
  spans?: Span[]
}

/** Fixed renderer-owned classes every rendered node carries. */
export const ROOT_CLASS = 'xr-root'
export const NODE_CLASS = 'xr-node'
export const LEAF_CLASS = 'xr-leaf'

/**
 * Renderer-owned base styles, emitted once by the outermost view (ADR 0007), before a plate's node
 * rules so a node's captured class wins by source order. Everything visual is driven by inheritable
 * custom properties, so consumers theme by setting `--xr-*` in `:root` or on any ancestor — and
 * per-plate via `[data-xr-root="name"]` (the root carries its plate name). See ADR 0011 and
 * docs/architecture.md. Class-based and unlayered — `@layer` was rejected (unlayered app CSS would
 * beat layered skeleton rules, and it inverts `!important`).
 *
 * Progressive enhancement (ADR 0011): the plain bone fill + opacity pulse use only
 * universally-supported CSS and are the floor. `light-dark()` is guarded by `@supports` because an
 * unsupported VALUE drops the whole declaration (an invisible bone), and it is not
 * Baseline-widely-available until 2026-11-13 — drop the guard then. Features that merely no-op when
 * absent (`@property`, `prefers-contrast`, relative-color-as-fallback) carry no hard guard.
 *
 * Tokens (ADR 0017 taxonomy). The `--xr-bone-*` family styles an individual Bone: `--xr-bone-color`
 * (fill), `--xr-bone-highlight-color` (sheen), `--xr-bone-border-radius` (+
 * `--xr-bone-text-line-border-radius` / `--xr-bone-text-block-border-radius` /
 * `--xr-bone-media-border-radius`), `--xr-bone-animation-duration`, the pulse range
 * `--xr-bone-pulse-opacity-min`/`--xr-bone-pulse-opacity-max`, `--xr-bone-animation` (mode:
 * `xr-pulse` | `none` | a custom keyframe), and `--xr-bone-fill` (override the leaf paint, e.g. a
 * sheen gradient built from the two bone color tokens). The `--xr-skeleton-*` family governs
 * whole-skeleton display timing (ADR 0016): `--xr-skeleton-delay` (grace before the skeleton
 * becomes visible), `--xr-skeleton-min-duration` (minimum visible time once shown; read by the
 * `useSkeletonTiming` hook, not used in CSS), and `--xr-skeleton-transition-duration` (the
 * reveal/swap fade). The private channels `--xr-o` (pulse) and `--xr-reveal` (reveal) stay
 * undocumented `@property` plumbing, not a theming surface.
 *
 * Declared as a PLAIN template literal — no `.trim()` (or any other call) on the initializer. A
 * method call is not provably pure to a conservative tree-shaker (rolldown/Rollup) and would pin
 * this ~5 KB string into every consumer chunk that imports the React adapter, referenced or not
 * (ADR 0026). The template starts immediately after the backtick, so there is no leading newline to
 * strip.
 */
export const BASE_CSS = `/* One timeline per skeleton, not per leaf: the root animates one inherited
   opacity property and every leaf reads it. Hundreds of independent infinite
   opacity animations would pin the compositor and cook the CPU. */
@property --xr-o { syntax: "<number>"; inherits: true; initial-value: 1 }
/* The reveal channel (ADR 0016): a second inherited opacity factor the leaf
   multiplies into --xr-o. Transitioning THIS (not opacity directly) sidesteps
   the animation-vs-transition collision ADR 0012 flagged. initial-value 1 (NOT
   0) is the degradation floor: without @starting-style the reveal can never be
   driven 0->1, so it must REST at 1 (fully visible). The delay-hide below is
   pure progressive enhancement layered on top. */
@property --xr-reveal { syntax: "<number>"; inherits: true; initial-value: 1 }
.${ROOT_CLASS} {
  --xr-bone-highlight-color: #f4f4f5;
  display: contents;
  animation: var(--xr-bone-animation, xr-pulse) var(--xr-bone-animation-duration, 1.2s) ease-in-out infinite alternate;
}
/* No pointer-events:none — it blocks inspecting bones in devtools and buys
   nothing (no real content to click). border-color: a node may capture
   border-width for layout; its paint stays out. list-style: suppress a ::marker
   a captured display:list-item would otherwise paint. */
.${NODE_CLASS} { border-color: transparent; list-style: none }
.${LEAF_CLASS} {
  background: var(--xr-bone-fill, var(--xr-bone-color, #e4e4e7));
  border-radius: var(--xr-bone-border-radius, 4px);
  /* Composed opacity (ADR 0016): the pulse channel times the reveal channel.
     Never transition opacity directly (the pulse animation owns it). */
  opacity: calc(var(--xr-o) * var(--xr-reveal));
}
/* Per-kind defaults: a single text LINE reads as a rounded bar; a multi-line
   text BLOCK as a soft rect (a tall pill misreads as a button); media carries
   the author radius, defaulting to the same soft rect. Re-theme any kind via
   [data-xr-root] .${LEAF_CLASS}-text-line { ... }. */
.${LEAF_CLASS}-text-line { border-radius: var(--xr-bone-text-line-border-radius, 999px) }
.${LEAF_CLASS}-text-block { border-radius: var(--xr-bone-text-block-border-radius, var(--xr-bone-border-radius, 4px)) }
.${LEAF_CLASS}-media { border-radius: var(--xr-bone-media-border-radius, var(--xr-bone-border-radius, 4px)) }
/* A hidden bone holds its measured box in the flow but paints nothing: the
   space-preserving complement to data-xr-ignore. visibility (not display) so
   the captured size rules still lay the box out. */
.${LEAF_CLASS}-hidden { visibility: hidden }
@keyframes xr-pulse {
  from { --xr-o: var(--xr-bone-pulse-opacity-max, 1) }
  to { --xr-o: var(--xr-bone-pulse-opacity-min, 0.5) }
}
/* Reveal delay-hide (ADR 0016), a progressive enhancement guarded so it can NEVER
   strand a skeleton invisible (open Q3). @starting-style is the trigger: only a
   browser that supports it enters this block at all, and such a browser also
   honors @property + transitions, so the 0->1 reveal completes. The @supports
   selector(...) probe is the broadest cross-engine @starting-style feature test
   available. Without support the block is skipped entirely and --xr-reveal stays
   at its initial-value 1 = fully visible instant skeleton. INSIDE the block we
   start at 0 and transition to 1 after the delay: invisible for
   --xr-skeleton-delay, then a --xr-skeleton-transition-duration fade-in; a fast
   load unmounts before the delay elapses and the skeleton is never seen. */
@supports (selector(:has(*))) {
  /* The delay-hide applies to every root EXCEPT a stitch continuation (ADR 0020).
     Scoping with :not([data-xr-instant]) keeps an ordinary top-level skeleton
     byte-identical to before: it still mounts at --xr-reveal 0 and fades in after
     the delay. The transition/initial-1 rest state matches the original. */
  .${ROOT_CLASS}:not([${ROOT_INSTANT_ATTR}]) {
    --xr-reveal: 1;
    transition: --xr-reveal var(--xr-skeleton-transition-duration, 150ms) linear var(--xr-skeleton-delay, 250ms);
  }
  @starting-style { .${ROOT_CLASS}:not([${ROOT_INSTANT_ATTR}]) { --xr-reveal: 0 } }
  /* A stitch continuation (ADR 0020) reveals INSTANTLY: it was already visible as a
     stitch under a still-showing parent, so re-paying the delay would flash it away
     and back. No @starting-style and no transition — it rests at fully visible from
     its first frame, matching how the stitch inherited the parent's reveal. */
  .${ROOT_CLASS}[${ROOT_INSTANT_ATTR}] { --xr-reveal: 1 }
}
/* Reduced motion (open Q2): keep the anti-flash delay + min-duration (they are
   not motion), drop only the FADE — collapse the reveal transition to instant and
   kill the pulse animation (as before). */
@media (prefers-reduced-motion: reduce) {
  .${ROOT_CLASS} { animation: none; --xr-skeleton-transition-duration: 0s }
}
/* Dark + high-contrast bone defaults. Guarded: light-dark() is an invalid value
   without support and would drop the declaration — see the note above; remove
   this @supports once widely available (2026-11-13). */
@supports (color: light-dark(#000, #fff)) {
  .${ROOT_CLASS} { --xr-bone-highlight-color: light-dark(#f4f4f5, #52525b) }
  .${LEAF_CLASS} { background: var(--xr-bone-fill, var(--xr-bone-color, light-dark(#e4e4e7, #3f3f46))) }
  @media (prefers-contrast: more) {
    .${LEAF_CLASS} { background: var(--xr-bone-fill, var(--xr-bone-color, light-dark(#d4d4d8, #52525b))) }
  }
}
/* Derive the sheen highlight from --xr-bone-color so re-theming one token updates
   both. Relative color isn't widely available yet; the static highlight above is
   the fallback (sheen just looks flatter), so no hard guard is needed. */
@supports (color: oklch(from red l c h)) {
  .${ROOT_CLASS} { --xr-bone-highlight-color: oklch(from var(--xr-bone-color, #e4e4e7) calc(l + 0.08) c h) }
}`

/**
 * Compose a plate's scoped css with the renderer-owned BASE_CSS, base first so a plate rule beats a
 * base rule at equal specificity by source order — the standard composition for rendering a
 * skeleton outside the Vite plugin (where `virtual:xray/base.css` +
 * `virtual:xray/plates/<name>.css` do this through the CSS pipeline instead). css is the CALLER's
 * input (ADR 0026): `renderPlateHtml(plate, composeCss(css))`, or `<Skeleton plate={plate}
 * css={composeCss(css)}>` for a runtime-captured plate. Rendering a NESTED stitch under an
 * already-composed parent needs the raw css only (base is already on the page) — pass the string
 * uncomposed there.
 */
export function composeCss(css: string): string {
  return `${BASE_CSS}\n${css}`
}

/** The (unserialized) plate an import resolves to before anything has been captured. */
export function emptyPlate(name: string): GatedPlate {
  return { v: PLATE_VERSION, name, tree: null, css: '' }
}

/**
 * A dev-only sticky boolean toggle (get/set/subscribe), persisted per tab. Used for both "light
 * box" (render every `<Skeleton>` regardless of readiness) and "capture" (whether browsing
 * re-captures plates).
 */
export interface ToggleStore {
  get: () => boolean
  set: (value: boolean) => void
  subscribe: (onChange: () => void) => () => void
}

/**
 * Dev-only store of the freshest plate per name, updated in place when a capture lands.
 * `<Skeleton>` reads through it so a new plate re-renders the site rather than reloading the module
 * — which would remount the capture boundary and re-fire the capture, a feedback loop.
 */
export interface PlateStore {
  get: (name: string) => Plate | undefined
  subscribe: (name: string, onChange: () => void) => () => void
  /**
   * Register a plate imported via the ref graph if the store has none yet — so a stitch resolves
   * even before its child is re-captured, and survives a parent hot-swap (whose pushed plate
   * carries no resolved `refs`). Never overwrites a live capture.
   */
  seed: (name: string, plate: Plate) => void
}

/** A view interval `[min, max)`; an open end is undefined (ADR 0004). */
export interface Span {
  min?: number
  max?: number
}

/**
 * Dev-only Fixture store (ADR 0015): stored render-INPUT `data` per Plate, recorded to and replayed
 * from the plate module's `fixture` export (`src/plates/<name>.ts`, ADR 0034). Entirely dev-only —
 * this store never reaches the production bundle.
 *
 * Two cooperating halves, both flowing through the render-prop `data` seam (ADR 0014):
 *
 * - The dev adapter (`react.dev.tsx`) calls `register(name, data)` at `loading=false` with the live
 *   `data` it is about to render, so the latest recordable input for each mounted Plate is always
 *   in scope for Record.
 * - `record(name)` serializes that registered live `data` with devalue and POSTs it to the fixture
 *   endpoint (the HUD button and the `first-ready`/`always` modes call it). `has(name)` reports
 *   whether a Fixture exists (HUD coverage marker), and `read(name)` returns the Fixture `data` for
 *   Replay to substitute in front of the render prop.
 *
 * The store holds LIVE values; only the wire carries the opaque devalue string — disk holds the
 * rendered plate module (ADR 0033/0034).
 */
export interface FixtureStore {
  /**
   * Record the latest live `data` the dev adapter is about to render for `name`, so Record always
   * has the current recordable input in scope. A `register` with the same value is cheap; the
   * adapter calls it on every ready render. Returns a disposer the adapter runs on unmount so an
   * unmounted Skeleton's `data` never lingers in the store: an unmounted instance must never be
   * recorded or shadow a still-mounted one (ADR 0015). With several Skeletons of the same plate
   * name mounted, the live value is the most-recently-registered still-mounted instance.
   */
  register: (name: string, data: unknown) => () => void
  /**
   * Mark a mounted render-prop `<Skeleton>` SITE for `name`, independent of readiness: the dev
   * adapter calls this on mount and runs the disposer on unmount, across loading and Light Box
   * alike. This is what `status().participates` keys on — `register` above tracks the live `data`
   * VALUE, which exists only while content is mounted, and deriving participation from it made the
   * HUD's fixtures section vanish whenever Light Box unmounted content. Counted per instance, so
   * twins of one name participate until the last unmounts.
   */
  registerSite: (name: string) => () => void
  /** True once a recorded Fixture exists for `name` (drives the HUD coverage marker). */
  has: (name: string) => boolean
  /**
   * How many Fixtures are recorded, across ALL names. The HUD's fixtures footer keys on this
   * directly — deriving "any fixture exists" from the row/disk name lists silently hides the footer
   * whenever a recorded name drops out of both (an unstitched parent variant, coverage not yet
   * seeded); the store is the source of truth, so the footer can never vanish while a Fixture
   * exists.
   */
  recordedCount: () => number
  /**
   * The full per-plate fixture status the HUD renders. `participates` is whether a render-prop
   * `<Skeleton>` site for `name` is MOUNTED — stable across loading and Light Box (a plain-children
   * Skeleton never participates, so it shows no fixture affordances at all). `recordable` is
   * whether live `data` is in scope RIGHT NOW, i.e. `record(name)` would succeed — false while
   * loading or light-boxed, since content is not mounted. `recorded` mirrors `has`. `replaying` is
   * whether Replay substitution is IN EFFECT for the next ready render: the Replay toggle is on, a
   * Fixture exists, and — under `missing-only` — the registered live `data` is nullish. So a plate
   * can be `recorded` with Replay on and still render live data; the status says which. Changes to
   * any input (register/registerSite/dispose, record, seed, the Replay toggle) notify `subscribe`.
   */
  status: (name: string) => {
    participates: boolean
    recordable: boolean
    recorded: boolean
    replaying: boolean
  }
  /** The parsed Fixture `data` for `name`, or `undefined` when none is recorded. */
  read: (name: string) => { data: unknown } | undefined
  /**
   * Serialize the registered live `data` for `name` with devalue and POST it to the fixture
   * endpoint. Returns a promise that resolves once the write is server-confirmed (so the HUD can
   * surface a failed Record). Throws loudly when the live `data` is unrecordable (devalue's
   * contract) or no live `data` was registered (a plain-children `<Skeleton>` has none).
   */
  record: (name: string) => Promise<void>
  /**
   * Record every Skeleton that currently has live `data` registered (the HUD's single "Record
   * fixture" button — one click captures the inputs of all mounted render-prop Skeletons). Resolves
   * once all writes are server-confirmed; a rejected write surfaces to the HUD.
   */
  recordAll: () => Promise<void>
  /**
   * Seed the store with LIVE values — the plate modules' fixture exports imported through the
   * module graph (`virtual:xray/fixtures`, ADR 0033); no devalue decode is involved. By default
   * existing entries are not clobbered, so a Fixture recorded this session survives a boot re-seed;
   * `force` makes the seed AUTHORITATIVE — the HMR re-seed after a plate-module edit, where the
   * disk IS the fresher truth: listed names overwrite, and previously recorded names ABSENT from
   * `values` are removed (a Fixture deleted from its module must not stay `recorded`). A Record
   * that has not reached disk yet cannot be lost: the write lands before the watcher fires the
   * re-seed, so the fresh seed always contains it.
   */
  seed: (values: Record<string, unknown>, force?: boolean) => void
  /** React subscription so the HUD re-renders when a Fixture is recorded or seeded. */
  subscribe: (onChange: () => void) => () => void
}

/**
 * The one-action-at-a-time capture state (the HUD deck contract): recording or Light Box, never
 * both, engaged globally or for a named set of mounted plates. `idle` is the resting state. The
 * client enforces the exclusivity — an engage call while the OPPOSITE action is active is a warned
 * no-op, so a console caller cannot wedge the machine — and the HUD merely renders it.
 */
export type XrayModeState =
  | { action: 'idle' }
  | { action: 'record'; scope: 'global' | ReadonlySet<string> }
  | { action: 'lightbox'; scope: 'global' | ReadonlySet<string> }

/**
 * Dev-only mode store: the state machine behind the HUD's record/play controls.
 *
 * Recording is a SESSION with ONE lifecycle at every scope and every level of automation (the
 * extension is an amplifier, never a semantic switch — ADR 0027 §2): engaging accumulates Views,
 * disengaging writes. With a sweep-capable extension connected, an engage (global or per-name)
 * first sweeps the scope's derived widths; without one, your own resizes are the width visits —
 * either way absence is observed identically and the write happens at stop. Scope narrows what
 * captures: `'global'` records every mounted site, a name set records only those plates; names join
 * and leave the scope freely (a join is refused only while a sweep is mid-flight — one shared
 * viewport). Shrinking a record scope writes the removed plate's Views at that moment; the scope
 * emptying (or a global stop) writes the rest and returns to `idle`.
 *
 * Light Box is a pure view state: no writes, scope toggles freely between names, global wins.
 */
export interface ModeStore {
  get: () => XrayModeState
  subscribe: (onChange: () => void) => () => void
  /** Engage/disengage global recording. Resolves once a stop's writes settle (or reject-logged). */
  setRecord: (on: boolean) => Promise<void>
  /** Engage/disengage global Light Box. */
  setLightbox: (on: boolean) => void
  /** Toggle one plate in a record scope. Resolves once a triggered write settles. */
  recordName: (name: string, on: boolean) => Promise<void>
  /** Toggle one plate in a lightbox scope. */
  lightboxName: (name: string, on: boolean) => void
  /** True when `name` (or everything) is light-boxed — the dev adapter's read side. */
  lightboxed: (name: string) => boolean
}

/** Per-name summary of the mounted `<Skeleton>` sites (the HUD's plate list source). */
export interface MountedPlate {
  /**
   * How many instances of this plate name are mounted; the first in document order writes. `0` for
   * a STITCH-ONLY entry: the plate's bones are on the page as a stitch of a showing parent
   * skeleton, but no `<Skeleton>` component of its own is mounted — nothing can capture it, and its
   * own Light Box is moot while the parent covers it.
   */
  instances: number
  /** The capture-root model of the writing instance (ADR 0014). */
  captureRoot: 'auto' | 'manual'
  /** Capture refused (Collect limits, ADR 0022) — the HUD badges the row. */
  tooLarge: boolean
  /**
   * Parent plate names whose SHOWING skeletons are currently rendering this plate as a stitch (ADR
   * 0006). Present on stitch-only entries and on mounted plates that are ALSO stitched elsewhere on
   * the page.
   */
  stitchedUnder?: readonly string[]
}

/** Dev-only store of currently mounted capture sites, keyed by plate name. */
export interface SitesStore {
  get: () => ReadonlyMap<string, MountedPlate>
  subscribe: (onChange: () => void) => () => void
}

/** The recording session's live snapshot (the HUD ticker and plates-list source). */
export interface SessionSnapshot {
  /** Widths captured this session, per plate name — empty map when no session ran yet. */
  views: ReadonlyMap<string, readonly number[]>
  /**
   * The write lifecycle of the LAST stop: `idle` until a first stop, `writing` while the sink
   * settles, `saved` on success, `failed` when any plate's write rejected (the buffered Views are
   * kept in memory; the next engage retries them).
   */
  save: 'idle' | 'writing' | 'saved' | 'failed'
  /** Plates written by the last successful stop (the `✓ n plates` ticker). */
  savedCount: number
  /** The last failed write's message (set with `save: 'failed'`; the HUD error card body). */
  saveError?: string
  /** The extension sweep in flight, when recording is sweeping (drives the progress ring). */
  sweep?: { width: number; index: number; total: number }
  /** The last sweep failure (extension missing mid-run, DevTools attached, non-convergence). */
  sweepError?: string
}

/** Dev-only recording-session store. */
export interface SessionStore {
  get: () => SessionSnapshot
  subscribe: (onChange: () => void) => () => void
}

/**
 * Dev-only per-plate capture diagnostics, the HUD-visible mirror of the console warnings: the last
 * capture's diagnostics per plate name, replaced on every capture (an empty array is a clean
 * capture). The too-large refusal surfaces here as its diagnostic plus the site's sticky `tooLarge`
 * flag in the sites store.
 */
export interface DiagnosticsStore {
  get: (name: string) => readonly string[]
  subscribe: (onChange: () => void) => () => void
}

/**
 * Dev-only companion-extension presence (ADR 0010/0030). Fed by the content script's `hello`
 * beacon: `present` flips on the first hello and never back (no timeout, no false negative);
 * `version` and `caps` come from the handshake, and the client keys purely on `caps` — a hello
 * without them announces no usable capability (the HUD shows its update warnline).
 */
export interface ExtensionStore {
  get: () => { present: boolean; version?: string; caps: readonly string[] }
  subscribe: (onChange: () => void) => () => void
}

/** A plate's detected width thresholds and the spans actually captured, from disk. */
export interface PlateCoverage {
  breakpoints: number[]
  spans: Span[]
}

/**
 * Dev-only per-plate coverage, sourced from the committed plate files (not the session): the
 * breakpoints detected so far and which view spans are captured. The HUD renders every band —
 * covered ones lit, the rest dim — and the capture-all sweep derives its target widths from the
 * breakpoints.
 */
export interface CoverageStore {
  get: () => ReadonlyMap<string, PlateCoverage>
  set: (name: string, coverage: PlateCoverage) => void
  subscribe: (onChange: () => void) => () => void
}

/**
 * Dev-only capture hook, installed by the dev client before the app boots. Absent in production
 * builds, so `<Skeleton>` carries zero capture weight. `captured` returns a dispose callback (stop
 * observing this site).
 */
export interface CaptureHook {
  captured: (
    name: string,
    el: Element,
    // `walker` is the per-site programmable capture walker (ADR 0018), a closure
    // on the consumer's `<Skeleton>` forwarded into `captureView`. Typed
    // loosely as `unknown` here so plate.ts stays free of a measure.ts import
    // (it is the framework-neutral data module); the dev adapter and client
    // narrow it to `XrayCaptureWalker`. Capture-only, never persisted.
    //
    // `mode` is the capture-root model (ADR 0014). `'auto'` (the default) is the
    // `display:contents` wrapper whose CHILDREN are the content — the client
    // captures those children. `'manual'` is the consumer's OWN styled element as
    // the root — the client captures that element itself, so its box/classes/
    // padding/border survive. Never persisted.
    // `collect` is the per-site Collect limits (ADR 0022): the flat `<Skeleton>`
    // `maxNodes`/`maxBreadth`/`maxDepth` props, merged over the plugin defaults by
    // the client. Plain numbers, so plate.ts stays free of a measure.ts import.
    // Capture-only, never persisted.
    opts?: {
      delay?: number
      walker?: unknown
      mode?: 'auto' | 'manual'
      collect?: { maxNodes?: number; maxBreadth?: number; maxDepth?: number }
    },
  ) => (() => void) | undefined
  /** Light Box toggle: force every `<Skeleton>` to its skeleton, read by `<Skeleton>`. */
  lightbox?: ToggleStore
  /** Capture toggle: whether browsing re-captures plates, flipped from the HUD. */
  capture?: ToggleStore
  /** Read side for `<Skeleton>`. */
  plates?: PlateStore
  /** Write side for the dev client's HMR-event handler. Returns whether the plate changed. */
  updatePlate?: (name: string, plate: Plate) => boolean
  /** Dev-only per-plate breakpoints + captured spans, from disk; fed by the bootstrap. */
  coverage?: CoverageStore
  /**
   * Replay toggle (ADR 0015): when active, the dev adapter substitutes a recorded Fixture's `data`
   * for the live `data` at `loading=false`. The boolean is the coarse on/off the HUD owns per tab;
   * the per-mode policy (`prefer` vs `missing-only`) is carried alongside in `replayMode`.
   */
  replay?: ToggleStore
  /** Dev-only Replay policy: how a Fixture substitutes for live `data` (ADR 0015). */
  replayMode?: 'prefer' | 'missing-only'
  /**
   * Dev-only Record policy (ADR 0015): when the dev adapter records the live `data` it is about to
   * render. `'manual'` (the default) records nothing automatically — only the HUD button does;
   * `'first-ready'` records once when a Skeleton goes ready and has no Fixture yet; `'always'`
   * records on every ready render.
   */
  recordMode?: 'manual' | 'first-ready' | 'always'
  /** Dev-only Fixture record/replay store (ADR 0015); never present in production. */
  fixtures?: FixtureStore
  /**
   * The one-action mode machine behind the HUD's record/play controls. The legacy `capture` and
   * `lightbox` ToggleStores remain as global-scope facades over it (a console
   * `__XRAY__.lightbox.set(true)` IS `mode.setLightbox(true)`), so per-tab stickiness and the
   * `?xray-*` URL seeds keep working unchanged.
   */
  mode?: ModeStore
  /** Mounted capture sites by plate name (the HUD's plate list). */
  sites?: SitesStore
  /** The recording session's live snapshot (ticker, progress ring, unsaved counts). */
  session?: SessionStore
  /** Last capture diagnostics per plate (the HUD row notes). */
  diagnostics?: DiagnosticsStore
  /** Companion-extension presence and capabilities (promo card vs sweep-capable recording). */
  extension?: ExtensionStore
  /**
   * Steel-outline boundary highlight over a mounted plate's capture roots — the HUD row hover/focus
   * contract. `on: false` clears; clears implicitly on unmount/teardown.
   */
  highlight?: (name: string, on: boolean) => void
  /**
   * Register a mounted dev `<Skeleton>` by plate name, INDEPENDENT of what it currently shows —
   * content, the loading skeleton, or Light Box. The sites store lists presence, not capture
   * boundaries: Light Box unmounts the capture boundary by design, and a light-boxed plate must
   * stay listed or the control that disengages it disappears with it. `el` resolves the currently
   * rendered root, the highlight's fallback while no capture site exists. Returns the disposer the
   * adapter runs when the `<Skeleton>` itself unmounts.
   */
  mounted?: (name: string, el?: () => Element | null) => () => void
  /**
   * Report the DIRECT stitch names a showing skeleton is currently rendering (the same names the
   * adapter marks live for the ADR 0020 continuation). The sites store lists them as stitch-only
   * entries (`instances: 0`, `stitchedUnder`), so a plate whose bones are on the page stays in the
   * HUD's list even though no component of its own is mounted — the exact hole Light Box on a
   * stitch-bearing parent opens. Disposed when the skeleton stops showing.
   */
  stitched?: (parent: string, names: readonly string[]) => () => void
}

declare global {
  // eslint-disable-next-line no-var
  var __XRAY__: CaptureHook | undefined
}
