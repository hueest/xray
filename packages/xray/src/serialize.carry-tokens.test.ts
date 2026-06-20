// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { capture } from './__fixtures__/single-view-capture.ts'

// Carried custom properties (ADR 0019 §1; the plan's Phase-1 step 2). These are
// integration tests over the full `capture` path: an author token referenced by
// a kept layout decl is CARRIED (its conditional definitions emitted on the
// plate) when it varies by @media/@container, INLINED (frozen) when it is
// constant, and never carried when it is paint-only (reachability). The
// overarching invariant — SELF-CONTAINMENT (ADR 0003): the emitted CSS defines
// every token it still references; no plate ships a dangling var().

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.innerHTML = ''
})

function style(css: string): void {
  const el = document.createElement('style')
  el.textContent = css
  document.head.append(el)
}

function mount(html: string): Element {
  document.body.innerHTML = `<div id="host">${html}</div>`
  const host = document.getElementById('host')
  if (!host) throw new Error('missing #host')
  const first = host.firstElementChild
  if (!first) throw new Error('missing capture root')
  return first
}

/** Every `--token` a CSS string still REFERENCES via `var(--token)`. */
function referencedIn(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (m[1]) out.add(m[1])
  }
  return out
}

/** Every `--token` the CSS DEFINES (a `--token: value` declaration). */
function definedIn(css: string): Set<string> {
  const out = new Set<string>()
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) {
    if (m[1]) out.add(m[1])
  }
  return out
}

describe('carried custom properties', () => {
  it('CARRIES a responsive token so the bone reflows', () => {
    // --gap varies across the captured @media condition, so its definitions are
    // emitted on the scoped root and the consuming decl keeps the live var().
    style(
      ':root { --gap: 8px }' +
        '@media (min-width: 700px) { :root { --gap: 16px } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 'x' })
    // The base definition on the root, and the @media override on the root.
    expect(plate.css).toMatch(/\[data-xr-root\][\w.-]* \{ --gap: 8px \}/)
    expect(plate.css).toContain('@media (min-width: 700px) {')
    expect(plate.css).toMatch(/--gap: 16px/)
    // The consuming layout rule keeps the LIVE reference — not frozen to a px.
    // (`--gap: 8px` definitions are fine; the CONSUMING `gap:` must not be frozen.)
    expect(plate.css).toContain('gap: var(--gap)')
    expect(plate.css).not.toMatch(/[^-]gap: 8px/)
    expect(plate.css).not.toMatch(/[^-]gap: 16px/)
  })

  it('INLINES (freezes) a constant token — smaller and identical', () => {
    // --gap has only one unconditional definition, so it is frozen inline and no
    // token definition is emitted (today's behavior, ADR 0005).
    style(':root { --gap: 8px } .card { display: flex; gap: var(--gap) }')
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 'y' })
    expect(plate.css).toContain('gap: 8px')
    expect(plate.css).not.toContain('var(--gap)')
    // No carried definition for a constant token.
    expect(plate.css).not.toContain('--gap:')
  })

  it('does NOT carry a paint-only token (reachability)', () => {
    // --brand is referenced only by `color` (paint, never a kept layout decl) and
    // would vary by @media — but it is unreachable from layout, so it is never
    // carried and never even appears (paint is stripped).
    style(
      ':root { --brand: red }' +
        '@media (min-width: 700px) { :root { --brand: blue } }' +
        '.card { display: flex; color: var(--brand) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 'z' })
    expect(plate.css).not.toContain('--brand')
    expect(plate.css).not.toContain('var(')
    expect(plate.css).not.toContain('red')
    expect(plate.css).not.toContain('blue')
  })

  it('carries a token transitively through a constant alias', () => {
    // --gap = var(--space-2) is a constant alias (one unconditional def), so it
    // freezes to its author value `var(--space-2)`; --space-2 varies, so it is
    // carried. The chain stays self-contained: the plate defines --space-2.
    style(
      ':root { --space-2: 8px; --gap: var(--space-2) }' +
        '@media (min-width: 700px) { :root { --space-2: 16px } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 't' })
    expect(plate.css).toMatch(/--space-2: 8px/)
    expect(plate.css).toMatch(/--space-2: 16px/)
    expect(plate.css).toContain('@media (min-width: 700px) {')
    // The consuming decl resolves --gap to its constant alias, still live on --space-2.
    expect(plate.css).toContain('gap: var(--space-2)')
    expect(plate.css).not.toContain('var(--gap)')
  })

  it('does NOT dangle when a carried conditional def references a CONSTANT token', () => {
    // The inverse of the alias test above, and a self-containment regression: the
    // CARRIED token's own VALUE references a constant token. --gap varies (carried)
    // and its definitions read --const, which is constant (frozen, NOT carried, NOT
    // emitted as its own def). Without freezing the carried def's value, the emitted
    // `--gap: var(--const)` would dangle on a --const the plate never defines.
    style(
      ':root { --const: 3px; --gap: var(--const) }' +
        '@media (min-width: 700px) { :root { --gap: calc(var(--const) + 10px) } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 'c1' })
    // The carried --gap definitions resolve --const to its frozen author value, so
    // no var(--const) survives in the emitted definitions.
    expect(plate.css).toMatch(/--gap: 3px/)
    expect(plate.css).toMatch(/--gap: calc\(3px \+ 10px\)/)
    expect(plate.css).not.toContain('var(--const)')
    // The consuming decl keeps the live var(--gap).
    expect(plate.css).toContain('gap: var(--gap)')
    // No dangling reference anywhere.
    const referenced = referencedIn(plate.css)
    const defined = definedIn(plate.css)
    for (const token of referenced) {
      expect(defined.has(token), `dangling var(${token})`).toBe(true)
    }
  })

  it('does NOT dangle when a carried conditional def references a constant --base', () => {
    // Reviewer repro 2: a --gap conditional definition references a constant --base.
    // --gap varies (carried); --base is constant (frozen). The emitted carried --gap
    // definitions must substitute --base, not reference it.
    style(
      ':root { --base: 6px; --gap: 8px }' +
        '@media (min-width: 700px) { :root { --gap: var(--base) } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 'c2' })
    expect(plate.css).toMatch(/--gap: 8px/)
    expect(plate.css).toMatch(/--gap: 6px/)
    expect(plate.css).not.toContain('var(--base)')
    expect(plate.css).toContain('gap: var(--gap)')
    const referenced = referencedIn(plate.css)
    const defined = definedIn(plate.css)
    for (const token of referenced) {
      expect(defined.has(token), `dangling var(${token})`).toBe(true)
    }
  })

  it('anchors a token redefined on a captured element to THAT node', () => {
    // --pad is redefined on .card under a query; that definition anchors on the
    // card's node (a descendant rule), not the root.
    style(
      ':root { --pad: 4px }' +
        '.card { padding: var(--pad) }' +
        '@media (min-width: 700px) { .card { --pad: 20px } }',
    )
    const plate = capture([mount('<div class="card"></div>')], { name: 'r' })
    expect(plate.css).toContain('padding: var(--pad)')
    // The base root definition, plus the captured-element override under @media.
    expect(plate.css).toMatch(/\[data-xr-root\][\w.-]* \{ --pad: 4px \}/)
    expect(plate.css).toMatch(
      /@media \(min-width: 700px\) \{ \[data-xr-root\] \.[\w-]+ \{ --pad: 20px \}/,
    )
  })

  it('does NOT fire fluidTracks when the grid track var is carried', () => {
    // A responsive grid driven by a carried token keeps its live var(); the
    // px-only fluidTracks heuristic (1fr / minmax) never runs on it.
    style(
      ':root { --cols: 1fr 1fr }' +
        '@media (min-width: 700px) { :root { --cols: 1fr 2fr 1fr } }' +
        '.grid { display: grid; grid-template-columns: var(--cols) }',
    )
    const plate = capture([mount('<div class="grid"><span>a</span></div>')], { name: 'g' })
    expect(plate.css).toContain('grid-template-columns: var(--cols)')
    expect(plate.css).toMatch(/--cols: 1fr 1fr/)
    expect(plate.css).toMatch(/--cols: 1fr 2fr 1fr/)
    // No reconstructed minmax/1fr gutter heuristic — the author value is carried.
    expect(plate.css).not.toContain('minmax(')
  })

  it('SELF-CONTAINMENT: the emitted CSS defines every token it still references', () => {
    // The load-bearing invariant (ADR 0003): a carried, transitive, and
    // constant-frozen mix must leave no dangling var().
    style(
      ':root { --base: 8px; --gap: var(--base); --pad: 12px }' +
        '@media (min-width: 700px) { :root { --base: 16px } }' +
        '.card { display: flex; gap: var(--gap); padding: var(--pad); margin: var(--unknown, 2px) }',
    )
    const plate = capture([mount('<div class="card"><span>a</span></div>')], { name: 's' })
    const referenced = referencedIn(plate.css)
    const defined = definedIn(plate.css)
    for (const token of referenced) {
      expect(defined.has(token), `dangling var(${token})`).toBe(true)
    }
  })

  it('FREEZES a conditional token defined only on an un-captured wrapper (Q5)', () => {
    // --gap varies, but its only conditional definition lives on `.theme`, a
    // wrapper ABOVE the capture root that we did not capture. There is no plate
    // node to anchor it on, so v1 freezes it (the responsive variance is lost)
    // rather than emit an unsound definition — and self-containment still holds.
    style(
      ':root { --gap: 8px }' +
        '.theme { --gap: 8px }' +
        '@media (min-width: 700px) { .theme { --gap: 24px } }' +
        '.card { display: flex; gap: var(--gap) }',
    )
    // The capture root is `.card`; `.theme` is its (un-captured) parent wrapper.
    document.body.innerHTML = '<div class="theme"><div class="card"><span>a</span></div></div>'
    const card = document.querySelector('.card')
    if (!card) throw new Error('missing .card')
    const plate = capture([card], { name: 'q5' })
    // The token is NOT carried (its conditional def is un-anchorable): the decl
    // is frozen to a px and no --gap definition is emitted.
    expect(plate.css).not.toContain('var(--gap)')
    expect(plate.css).toContain('gap: 8px')
    expect(plate.css).not.toContain('--gap:')
    // Self-containment holds: no dangling var().
    const referenced = referencedIn(plate.css)
    const defined = definedIn(plate.css)
    for (const token of referenced) expect(defined.has(token)).toBe(true)
  })
})
