// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { defineXrayCaptureWalker, type XrayCaptureWalker } from './measure.ts'
import { clampToClipping } from './text-metrics.ts'
import { capture, captureIdForm } from './__fixtures__/single-view-capture.ts'
import type { CaptureDiagnostic, DiagnosticCode } from './diagnostics.ts'

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.innerHTML = ''
})

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="host">${html}</div>`
  return defined(document.getElementById('host'), '#host')
}

function style(css: string): void {
  const el = document.createElement('style')
  el.textContent = css
  document.head.append(el)
}

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`)
  return value
}

function child(parent: Element, index = 0): Element {
  return defined(parent.children.item(index), `child ${index}`)
}

function query(selector: string): Element {
  return defined(document.querySelector(selector), selector)
}

describe('capture', () => {
  it('walks elements into a tree under the synthetic root', () => {
    const host = mount('<section><div><span>hi</span></div><div></div></section>')
    const plate = capture([child(host)], { name: 'x' })
    expect(plate.name).toBe('x')
    expect(plate.tree).not.toBeNull()
    const section = plate.tree?.kids?.[0]
    expect(section?.kids?.length).toBe(2)
  })

  it('references a nested skeleton boundary instead of descending into it', () => {
    // A loaded child boundary (data-xr-boundary) and a child still showing its
    // own skeleton (data-xr-root) both become stitches — the parent references the
    // child plate by name rather than re-serializing its subtree (ADR 0006).
    const host = mount(
      '<section>' +
        '<div data-xr-boundary="news-feed"><p>loaded feed</p></div>' +
        '<div data-xr-root="content-cards"><div data-xr="3" data-xr-leaf="box"></div></div>' +
        '</section>',
    )
    const plate = capture([child(host)], { name: 'dashboard' })
    const section = plate.tree?.kids?.[0]
    expect(section?.kids).toHaveLength(2)
    expect(section?.kids?.[0]?.ref).toBe('news-feed')
    expect(section?.kids?.[0]?.kids).toBeUndefined()
    expect(section?.kids?.[1]?.ref).toBe('content-cards')
    // A stitch carries no node-level rules of its own (only the root font context
    // rule is ever emitted here).
    expect(plate.css).not.toContain('data-xr="')
  })

  it('coalesces adjacent text nodes into one bar — only element boundaries split', () => {
    // JSX like `{value}% Progress` produces several adjacent text nodes
    const host = mount('<p></p>')
    const p = child(host)
    p.append(
      document.createTextNode('63'),
      document.createTextNode('% Progress'),
      document.createComment('x'),
      document.createTextNode(' more'),
    )
    const plate = capture([p], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.kids).toHaveLength(1)
    expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('turns text nodes into synthetic text bars', () => {
    const host = mount('<p>Hello <b>world</b></p>')
    const plate = capture([child(host)], { name: 'x' })
    const p = plate.tree?.kids?.[0]
    expect(p?.kids?.length).toBe(2)
    expect(p?.kids?.[0]?.leaf).toBe('text-line')
    const b = p?.kids?.[1]
    expect(b?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('classifies replaced elements as media leaves and skips their innards', () => {
    const host = mount('<div><img src="x.png"><select><option>a</option></select></div>')
    const plate = capture([child(host)], { name: 'x' })
    const div = plate.tree?.kids?.[0]
    expect(div?.kids?.map((k) => k.leaf)).toEqual(['media', 'media'])
    expect(div?.kids?.every((k) => k.kids === undefined)).toBe(true)
  })

  it('skips scripts, styles, and hidden elements', () => {
    const host = mount(
      '<div><script>1</script><style>.x{}</style><span style="display: none">gone</span><i>kept</i></div>',
    )
    const plate = capture([child(host)], { name: 'x' })
    const div = plate.tree?.kids?.[0]
    expect(div?.kids?.length).toBe(1)
  })

  it('skips fully-transparent (opacity:0) subtrees', () => {
    const host = mount('<div><span style="opacity: 0"><b>gone</b></span><i>kept</i></div>')
    const plate = capture([child(host)], { name: 'x' })
    const div = plate.tree?.kids?.[0]
    expect(div?.kids?.length).toBe(1)
  })

  it('keeps faint-but-visible (opacity above the epsilon) elements', () => {
    const host = mount('<div><span style="opacity: 0.5">faint</span><i>kept</i></div>')
    const plate = capture([child(host)], { name: 'x' })
    const div = plate.tree?.kids?.[0]
    expect(div?.kids?.length).toBe(2)
  })

  it('drops a visibility:hidden leaf (now a markInk dropped:"invisible", not a walk skip)', () => {
    // Measure now DESCENDS visibility:hidden (it skips only display:none); markInk
    // annotates the hidden node dropped:"invisible" and emit lowers it. A plain
    // hidden leaf disappears from the tree exactly as the old walk skip did.
    const host = mount('<div><span style="visibility: hidden">gone</span><i>kept</i></div>')
    const plate = capture([child(host)], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.kids?.length).toBe(1)
  })

  it('keeps a visibility:visible descendant of a visibility:hidden ancestor (the fixed latent bug)', () => {
    // visibility is inherited but a descendant can re-show with visibility:visible
    // (CSS composites it back in). The OLD walk skipped the hidden ancestor's WHOLE
    // subtree, vanishing the re-shown child — a latent bug. markInk drops only a
    // hidden node with no surviving descendant, so the hidden wrapper stays alive
    // (bone-free) and the re-shown child's bone survives.
    const host = mount(
      '<div style="visibility: hidden"><span style="visibility: visible">shown</span><i>hidden</i></div>',
    )
    const plate = capture([child(host)], { name: 'x' })
    // The hidden wrapper survives as a container (no bone) carrying the one re-shown
    // child; the still-hidden <i> is dropped.
    const wrapper = plate.tree?.kids?.[0]
    expect(wrapper?.leaf).toBeUndefined()
    expect(wrapper?.kids?.length).toBe(1)
    expect(wrapper?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('marks empty painted elements as box leaves, plain empties as containers', () => {
    const host = mount(
      '<div><span style="background-color: rgb(255, 0, 0)"></span><span style="background-color: rgba(0, 0, 0, 0)"></span></div>',
    )
    const plate = capture([child(host)], { name: 'x' })
    const div = plate.tree?.kids?.[0]
    expect(div?.kids?.[0]?.leaf).toBe('box')
    expect(div?.kids?.[1]?.leaf).toBeUndefined()
  })

  it('tolerates detached roots (ownerDocument is still there)', () => {
    const el = document.createElement('div')
    document.body.innerHTML = ''
    expect(() => capture([el], { name: 'x' })).not.toThrow()
  })

  it('collapses a long run of similar siblings: templated to one cell, FULL surviving count', () => {
    const card = '<li><b>Title</b><i>Sub</i></li>'
    const host = mount(`<ul>${card.repeat(20)}</ul>`)
    const plate = capture([child(host)], { name: 'x' })
    const list = plate.tree?.kids?.[0]
    // The Template pass (Phase 2) runs LAST, after Crop, and is lossless: it folds the
    // 20 uniform cells into one cell carrying the FULL surviving count. There is no
    // RUN_CAP — Crop drops the off-screen extent, Template never truncates. The happy-dom
    // shim has 0-size boxes so Crop is a no-op here; all 20 cells survive → count 20.
    expect(list?.kids).toHaveLength(1)
    expect(list?.kids?.[0]?.count).toBe(20)
  })

  it('templates a short uniform run to one cell + count (the same N items render)', () => {
    const host = mount('<ul><li>a</li><li>b</li><li>c</li></ul>')
    const plate = capture([child(host)], { name: 'x' })
    const list = plate.tree?.kids?.[0]
    expect(list?.kids).toHaveLength(1)
    expect(list?.kids?.[0]?.count).toBe(3)
  })

  // Capture the target element directly with an explicit opaque parent, so the
  // contrast check stops at it rather than climbing to the document default.
  it('paints a contrasting-fill control (button) as one block, not a bar for its label', () => {
    mount(
      '<div style="background: rgb(255,255,255)"><button style="background: rgb(91,61,245)">Invest Now</button></div>',
    )
    const button = query('button')
    const plate = capture([button], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBe('box')
    expect(plate.tree?.kids?.[0]?.kids).toBeUndefined()
  })

  it('leaves a non-contrasting (outline) button as a container with its label', () => {
    mount(
      '<div style="background: rgb(255,255,255)"><button style="background: rgb(255,255,255)">Sec.gov</button></div>',
    )
    const button = query('button')
    const plate = capture([button], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('does not collapse a filled element that has structured children', () => {
    mount(
      '<section style="background: rgb(20,20,40)"><h2>Title</h2><div><span>a</span><span>b</span></div></section>',
    )
    const section = query('section')
    const plate = capture([section], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.length).toBe(2)
  })

  describe('CSS extraction', () => {
    it('lifts matching layout rules rewritten to plate-local selectors, paint stripped', () => {
      style('.banner { display: flex; gap: 8px; color: red } .other { display: grid }')
      const host = mount('<div class="banner"><span>x</span></div>')
      const plate = capture([child(host)], { name: 'my-plate' })
      // rendered as a content-addressed class scoped under the root, paint stripped
      expect(plate.css).toMatch(/\[data-xr-root\] \.xr-[\w-]+ \{ display: flex; gap: 8px \}/)
      expect(plate.css).not.toContain('color')
      expect(plate.css).not.toContain('.banner')
      expect(plate.css).not.toContain('grid')
    })

    it('carries @media conditions with lifted rules', () => {
      style('@media (min-width: 600px) { .banner { display: flex } }')
      const host = mount('<div class="banner"></div>')
      const plate = capture([child(host)], { name: 'x' })
      expect(plate.css).toContain('@media (min-width: 600px) {')
      expect(plate.css).toContain('display: flex')
    })

    it('carries @container conditions with lifted rules', () => {
      style('@container (min-width: 400px) { .card { display: flex } }')
      const host = mount('<div class="card"></div>')
      const plate = capture([child(host)], { name: 'x' })
      expect(plate.css).toContain('@container (min-width: 400px) {')
      expect(plate.css).toContain('display: flex')
    })

    it('captures container-type so the bone is itself a query container', () => {
      style('.box { container-type: inline-size }')
      const host = mount('<div class="box"></div>')
      const plate = capture([child(host)], { name: 'x' })
      expect(plate.css).toContain('container-type: inline-size')
    })

    it('skips interaction pseudo-classes and pseudo-elements', () => {
      style('.banner:hover { width: 10px } .banner::before { height: 10px }')
      const host = mount('<div class="banner"></div>')
      const plate = capture([child(host)], { name: 'x' })
      expect(plate.css).not.toContain('width: 10px')
      expect(plate.css).not.toContain('height: 10px')
    })

    it('lifts inline layout styles above author rules', () => {
      const host = mount('<div style="display: inline-flex; color: blue"></div>')
      const plate = capture([child(host)], { name: 'x' })
      expect(plate.css).toContain('display: inline-flex')
      expect(plate.css).not.toContain('blue')
    })
  })
})

// Diagnostics ride the TRANSIENT `ViewCapture.diagnostics` from captureIdForm;
// `capture()` (the persisted GatedPlate path) intentionally drops them.
function codesFor(roots: Element[]): DiagnosticCode[] {
  return (captureIdForm(roots).diagnostics ?? []).map((d) => d.code)
}
function diagnosticFor(roots: Element[], code: DiagnosticCode): CaptureDiagnostic | undefined {
  return (captureIdForm(roots).diagnostics ?? []).find((d) => d.code === code)
}

describe('capture diagnostics', () => {
  it('records a pseudo-element skip without one entry per selector', () => {
    style('.banner::before { height: 10px } .banner::after { width: 10px }')
    const host = mount('<div class="banner"></div>')
    const diag = diagnosticFor([child(host)], 'skipped-pseudo-element')
    expect(diag).toBeDefined()
    // Aggregated: two pseudo-element selectors → one record with count 2.
    expect(diag?.count).toBe(2)
    // No user CSS body or captured text leaks into the message.
    expect(diag?.message).not.toContain('banner')
    expect(diag?.message).not.toContain('10px')
  })

  it('records a dynamic pseudo-class skip separately from pseudo-elements', () => {
    style('.banner:hover { width: 10px }')
    const host = mount('<div class="banner"></div>')
    expect(codesFor([child(host)])).toContain('skipped-dynamic-pseudo')
  })

  it('records an unreadable stylesheet via a throwing cssRules getter', () => {
    // happy-dom can't model a cross-origin sheet, so override `document.styleSheets`
    // (what collectStyleRules reads) with one whose `cssRules` throws exactly like
    // a cross-origin CSSStyleSheet does on access. `getComputedStyle` builds its
    // own sheet list from <style>/<link> elements, so the walk is unaffected.
    const host = mount('<div></div>')
    // collectStyleRules reads it via Array.from(doc.styleSheets) then `.cssRules`
    // and `.media.mediaText`; this minimal shape is all it touches.
    const throwing = {
      get cssRules(): never {
        throw new DOMException('cross-origin', 'SecurityError')
      },
      media: { mediaText: '' },
    }
    const fakeList = [throwing]
    const original = Object.getOwnPropertyDescriptor(document, 'styleSheets')
    Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => fakeList })
    try {
      expect(codesFor([child(host)])).toContain('unreadable-stylesheet')
    } finally {
      if (original) Object.defineProperty(document, 'styleSheets', original)
      else Reflect.deleteProperty(document, 'styleSheets')
    }
  })

  it('records dropped non-visual and hidden tags', () => {
    const host = mount(
      '<div><script>1</script><span style="display: none">x</span><i>kept</i></div>',
    )
    expect(codesFor([child(host)])).toContain('dropped-tag')
  })

  it('emits no diagnostics for a clean capture', () => {
    style('.banner { display: flex }')
    const host = mount('<div class="banner"><span>x</span></div>')
    expect(captureIdForm([child(host)]).diagnostics).toBeUndefined()
  })
})

describe('output parity (capture performance refactor)', () => {
  // capture performance plan, correctness guardrail. The computed-style reuse
  // (Entry store + per-capture WeakMap) and the rule-index split (immutable
  // selector data vs per-capture match state) are pure work-avoidance: a capture
  // of the same DOM at the same width must produce a BYTE-IDENTICAL plate. These
  // exercise the load-bearing paths — var() resolution (which reads the matched
  // element's computed style), ancestor-contrast lookups, inline styles, @media
  // and @container conditions — and assert two back-to-back captures of the same
  // DOM serialize identically.
  const captureJson = (host: HTMLElement): string =>
    JSON.stringify(capture([child(host)], { name: 'parity' }))

  it('produces a byte-identical plate across two captures of the same DOM', () => {
    style(
      ':root { --pad: 12px; --gap: 8px }' +
        '.card { display: flex; gap: var(--gap); padding: var(--pad); background: #2233ff }' +
        '.row { display: grid }' +
        '@media (min-width: 600px) { .card { gap: 16px } }' +
        '@container (min-width: 400px) { .row { display: flex } }',
    )
    const host = mount(
      '<div class="card"><div class="row"><span>a</span><span>b</span></div>' +
        '<button style="padding: 4px"><span>go</span></button></div>',
    )
    const first = captureJson(host)
    const second = captureJson(host)
    expect(second).toBe(first)
  })

  it('resolves var() the same whether or not the computed style was already memoized', () => {
    // The Entry stores the element's computed style during walk and copyRules
    // reuses it for var() resolution — the reused style must resolve var() to the
    // same value a fresh getComputedStyle would, so the lifted decls are stable.
    style(':root { --w: 40px } .b { gap: var(--w); display: flex }')
    const host = mount('<div class="b"><i>x</i></div>')
    const plate = capture([child(host)], { name: 'x' })
    // Whatever the engine resolves --w to, it must be deterministic across runs.
    const again = capture([child(host)], { name: 'x' })
    expect(JSON.stringify(again)).toBe(JSON.stringify(plate))
    expect(plate.css).toContain('display: flex')
  })
})

describe('clampToClipping', () => {
  // happy-dom has no layout engine, so the clamp math is tested against fake
  // ancestors with stubbed geometry/computed style rather than the DOM.
  type Box = { width: number; height: number }
  const defaults = {
    overflowX: 'visible',
    overflowY: 'visible',
    paddingTop: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
    paddingRight: '0px',
    borderTopWidth: '0px',
    borderBottomWidth: '0px',
    borderLeftWidth: '0px',
    borderRightWidth: '0px',
  }
  const computedStyles = new WeakMap<Element, typeof defaults>()
  const el = (rect: Box, computed: Partial<typeof defaults>, parent: HTMLElement | null = null) => {
    const node = document.createElement('div')
    computedStyles.set(node, { ...defaults, ...computed })
    Object.defineProperty(node, 'getBoundingClientRect', { value: () => rect })
    parent?.append(node)
    return node
  }
  const win = { getComputedStyle: (node: Element) => computedStyles.get(node) ?? defaults }

  it('leaves text alone when no ancestor clips', () => {
    const host = el({ width: 300, height: 40 }, {})
    expect(clampToClipping(500, 100, host, win)).toEqual({ width: 500, height: 100 })
  })

  it('clamps height to a line-clamp ancestor (overflow-y hidden, shorter than the text)', () => {
    const host = el({ width: 300, height: 40 }, { overflowY: 'hidden' })
    // 5-line text run (100px) inside a 2-line clamp box (40px)
    expect(clampToClipping(300, 100, host, win)).toEqual({ width: 300, height: 40 })
  })

  it('clamps width to a single-line ellipsis ancestor (overflow-x hidden)', () => {
    const host = el({ width: 300, height: 20 }, { overflowX: 'hidden' })
    // nowrap text measured at its full unwrapped width
    expect(clampToClipping(900, 20, host, win)).toEqual({ width: 300, height: 20 })
  })

  it('subtracts the clipping ancestor padding and border from its content box', () => {
    const host = el(
      { width: 300, height: 50 },
      { overflowY: 'hidden', paddingTop: '4px', paddingBottom: '4px', borderTopWidth: '1px' },
    )
    // inner height = 50 - 4 - 4 - 1 = 41
    expect(clampToClipping(300, 100, host, win)).toEqual({ width: 300, height: 41 })
  })

  it('never grows a box: a clipping ancestor taller than the text is a no-op', () => {
    const host = el({ width: 300, height: 400 }, { overflowY: 'hidden' })
    expect(clampToClipping(200, 20, host, win)).toEqual({ width: 200, height: 20 })
  })

  it('finds a clamp that sits above inline wrappers', () => {
    const clamp = el({ width: 300, height: 40 }, { overflowY: 'hidden' })
    const span = el({ width: 280, height: 100 }, {}, clamp) // inline wrapper, no clip
    expect(clampToClipping(300, 100, span, win)).toEqual({ width: 300, height: 40 })
  })
})

// Capture customization — annotations & the programmable walker (ADR 0018).
// Stitch guard (ADR 0006) -> custom walker -> annotations -> default classifier;
// the stitch guard always wins and is unreachable by either. Annotations are
// capture-only and never persist. No walker AND no annotations is byte-identical
// to the default capture.
describe('capture customization (ADR 0018)', () => {
  describe('byte-identical default', () => {
    it('produces the identical plate with no walker and no annotations', () => {
      const markup =
        '<section><h1>Title</h1><div><span>a</span><span>b</span></div>' +
        '<button style="background: rgb(91,61,245)">Go</button><img src="x.png"></section>'
      const before = capture([child(mount(markup))], { name: 'x' })
      const after = capture([child(mount(markup))], { name: 'x' })
      // An undefined walker (the common path) must not perturb the output.
      const withUndefined = capture([child(mount(markup))], { name: 'x', walker: undefined })
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
      expect(JSON.stringify(withUndefined)).toBe(JSON.stringify(before))
    })

    it('a no-op walker with no element hook matches the default exactly', () => {
      const markup = '<section><h1>Title</h1><p>body text here</p><img src="x.png"></section>'
      const plain = capture([child(mount(markup))], { name: 'x' })
      const noop = capture([child(mount(markup))], {
        name: 'x',
        walker: {},
      })
      expect(JSON.stringify(noop)).toBe(JSON.stringify(plain))
    })

    it('a walker that always defers via ctx.keep() matches the default exactly', () => {
      const markup = '<section><h1>Title</h1><p>body text here</p></section>'
      const plain = capture([child(mount(markup))], { name: 'x' })
      const kept = capture([child(mount(markup))], {
        name: 'x',
        walker: { element: (ctx) => ctx.keep() },
      })
      expect(JSON.stringify(kept)).toBe(JSON.stringify(plain))
    })
  })

  describe('data-xr-ignore annotation', () => {
    it('drops the annotated element and its whole subtree', () => {
      const host = mount(
        '<section><div>kept</div><aside data-xr-ignore><p>secret</p><p>more</p></aside></section>',
      )
      const plate = capture([child(host)], { name: 'x' })
      const section = plate.tree?.kids?.[0]
      // Only the kept div survives; the ignored <aside> contributes no node.
      expect(section?.kids).toHaveLength(1)
    })
  })

  describe('data-xr-bone-kind annotation', () => {
    it('collapses the subtree into one bone of the named kind', () => {
      const host = mount(
        '<section><div data-xr-bone-kind="media"><span>a</span><span>b</span><i>c</i></div></section>',
      )
      const plate = capture([child(host)], { name: 'x' })
      const div = plate.tree?.kids?.[0]?.kids?.[0]
      expect(div?.leaf).toBe('media')
      // The subtree is NOT descended into — one bone, no children.
      expect(div?.kids).toBeUndefined()
    })

    it('honors text and box kinds too', () => {
      const host = mount(
        '<section><div data-xr-bone-kind="text-line"><b>x</b></div>' +
          '<div data-xr-bone-kind="box"><b>y</b></div></section>',
      )
      const plate = capture([child(host)], { name: 'x' })
      const kids = plate.tree?.kids?.[0]?.kids
      expect(kids?.[0]?.leaf).toBe('text-line')
      expect(kids?.[1]?.leaf).toBe('box')
    })

    it('collapses to a hidden bone: box kept in the tree, explicit-only kind', () => {
      const host = mount(
        '<section><div data-xr-bone-kind="hidden"><canvas></canvas></div></section>',
      )
      const plate = capture([child(host)], { name: 'x' })
      const div = plate.tree?.kids?.[0]?.kids?.[0]
      // The bone ships (its box reserves layout space; BASE_CSS paints nothing
      // via .xr-leaf-hidden) and the subtree is not descended into.
      expect(div?.leaf).toBe('hidden')
      expect(div?.kids).toBeUndefined()
    })

    it('never infers hidden: an undecorated element classifies as before', () => {
      const host = mount('<section><canvas></canvas></section>')
      const plate = capture([child(host)], { name: 'x' })
      // inferLeafKind knows only media/box — hidden is reachable through a Hint
      // or a walker decision, never inference.
      expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('media')
    })

    it('falls through to the default classifier on an unrecognized kind', () => {
      const host = mount('<section><div data-xr-bone-kind="bogus"><span>x</span></div></section>')
      const plate = capture([child(host)], { name: 'x' })
      const div = plate.tree?.kids?.[0]?.kids?.[0]
      // Not collapsed: the default classifier descended, keeping the span whose
      // text child becomes a text bar.
      expect(div?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
    })
  })

  describe('annotations never persist (capture-only)', () => {
    it('leaves no data-xr-ignore / data-xr-bone-kind trace in the persisted plate', () => {
      const host = mount('<section data-xr-bone-kind="box"><div data-xr-ignore>x</div></section>')
      const plate = capture([child(host)], { name: 'x' })
      const json = JSON.stringify(plate)
      expect(json).not.toContain('data-xr-ignore')
      expect(json).not.toContain('data-xr-bone-kind')
    })
  })

  describe('stitch guard ALWAYS wins (ADR 0006)', () => {
    it('a data-xr-ignore on a boundary element does NOT override the stitch', () => {
      // A nested <Skeleton> boundary carrying an ignore annotation must still
      // become a stitch — the ignore must NOT reach it (capture leak is the
      // worst failure mode).
      const host = mount(
        '<section><div data-xr-boundary="child-plate" data-xr-ignore><p>loaded</p></div></section>',
      )
      const plate = capture([child(host)], { name: 'parent' })
      const node = plate.tree?.kids?.[0]?.kids?.[0]
      expect(node?.ref).toBe('child-plate')
      expect(node?.kids).toBeUndefined()
    })

    it('a bone()/ignore() walker on a NESTED boundary element does NOT override the stitch', () => {
      // The boundary is a NESTED element (a child of the captured root), the way a
      // child <Skeleton> actually appears in a parent capture. It becomes a stitch
      // at walk time (no `el`, `kind: 'stitch'`), so the `applyWalker` pass never
      // offers it to the walker. A walker that ignores or bones every element it
      // sees must STILL produce a stitch (capture leak is the worst failure mode).
      // (A TOP-LEVEL root carrying its own marker is the manual-root case and is
      // intentionally NOT a stitch; the manual root serializes as a real Entry.)
      const host = mount('<section><div data-xr-root="child-plate"><p>x</p></div></section>')
      // The walker would bone/ignore the boundary div if it ever reached it — but
      // the stitch carries no element, so the pass skips it. Scoped to the boundary
      // so the (top-level) section root is left to the default classifier and still
      // holds the stitch beneath it.
      const aggressive: XrayCaptureWalker = {
        element: (ctx) =>
          ctx.el.hasAttribute('data-xr-root')
            ? Math.random() < 0.5
              ? ctx.ignore()
              : ctx.bone()
            : ctx.keep(),
      }
      const plate = capture([child(host)], { name: 'parent', walker: aggressive })
      const node = plate.tree?.kids?.[0]?.kids?.[0]
      expect(node?.ref).toBe('child-plate')
      expect(node?.kids).toBeUndefined()
      expect(node?.leaf).toBeUndefined()
    })

    it('the walker is never invoked for a boundary element', () => {
      const host = mount('<section><div data-xr-boundary="child"><p>x</p></div></section>')
      const seen: string[] = []
      const walker: XrayCaptureWalker = {
        element: (ctx) => {
          seen.push(ctx.el.tagName)
          return ctx.keep()
        },
      }
      capture([child(host)], { name: 'parent', walker })
      // section is offered to the walker; the boundary div (a stitch, no element)
      // and its <p> (under the stitch, never built) never are.
      expect(seen).toContain('SECTION')
      expect(seen).not.toContain('DIV')
      expect(seen).not.toContain('P')
    })
  })

  describe('walker helpers (applyWalker pass; ADR 0022 §5)', () => {
    it('ctx.ignore() drops the element + subtree', () => {
      const host = mount('<section><div class="drop"><p>x</p></div><div>keep</div></section>')
      const walker: XrayCaptureWalker = {
        element: (ctx) => (ctx.el.classList.contains('drop') ? ctx.ignore() : ctx.keep()),
      }
      const plate = capture([child(host)], { name: 'x', walker })
      // The ignored div (and its <p>) lower out; only the kept div survives.
      expect(plate.tree?.kids?.[0]?.kids).toHaveLength(1)
    })

    it('ctx.ignore() prunes the descent — descendants are not offered to the walker', () => {
      const host = mount('<section><div class="drop"><p>deep</p></div></section>')
      const seen: string[] = []
      const walker: XrayCaptureWalker = {
        element: (ctx) => {
          seen.push(ctx.el.tagName)
          return ctx.el.classList.contains('drop') ? ctx.ignore() : ctx.keep()
        },
      }
      capture([child(host)], { name: 'x', walker })
      // section + the dropped div are offered; the <p> under the ignored div is not.
      expect(seen).toContain('SECTION')
      expect(seen).toContain('DIV')
      expect(seen).not.toContain('P')
    })

    it('ctx.bone() without a kind shares the default kind inference (media tag -> media)', () => {
      const host = mount('<section><img src="x.png"><div><span>x</span></div></section>')
      const walker: XrayCaptureWalker = {
        element: (ctx) => (ctx.el.tagName === 'IMG' ? ctx.bone() : ctx.keep()),
      }
      const plate = capture([child(host)], { name: 'x', walker })
      expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('media')
    })

    it('ctx.bone() on a non-media element infers box, yielding ONE childless bone', () => {
      const host = mount('<section><div class="card"><span>a</span><span>b</span></div></section>')
      const walker: XrayCaptureWalker = {
        element: (ctx) => (ctx.el.classList.contains('card') ? ctx.bone() : ctx.keep()),
      }
      const plate = capture([child(host)], { name: 'x', walker })
      const card = plate.tree?.kids?.[0]?.kids?.[0]
      expect(card?.leaf).toBe('box')
      expect(card?.kids).toBeUndefined()
    })

    it('ctx.bone({ kind }) honors the explicit kind', () => {
      const host = mount('<section><div class="card"><span>a</span></div></section>')
      const walker: XrayCaptureWalker = {
        element: (ctx) =>
          ctx.el.classList.contains('card') ? ctx.bone({ kind: 'text-line' }) : ctx.keep(),
      }
      const plate = capture([child(host)], { name: 'x', walker })
      const card = plate.tree?.kids?.[0]?.kids?.[0]
      expect(card?.leaf).toBe('text-line')
      expect(card?.kids).toBeUndefined()
    })

    it('ctx.bone() prunes the descent — descendants are not offered to the walker', () => {
      const host = mount('<section><div class="card"><p>deep</p></div></section>')
      const seen: string[] = []
      const walker: XrayCaptureWalker = {
        element: (ctx) => {
          seen.push(ctx.el.tagName)
          return ctx.el.classList.contains('card') ? ctx.bone() : ctx.keep()
        },
      }
      capture([child(host)], { name: 'x', walker })
      // section + the boned card are offered; the <p> under the bone is not.
      expect(seen).toContain('SECTION')
      expect(seen).toContain('DIV')
      expect(seen).not.toContain('P')
    })

    it('ctx.keep() defers to the default classifier (media tag stays media)', () => {
      // A walker that keeps every element produces the same media bone the default
      // classifier produces — the walker decides off `ctx.el`, then defers.
      const host = mount('<section><img src="x.png"></section>')
      const seen: string[] = []
      const walker: XrayCaptureWalker = {
        element: (ctx) => {
          seen.push(ctx.el.tagName)
          return ctx.keep()
        },
      }
      const plate = capture([child(host)], { name: 'x', walker })
      expect(seen).toContain('IMG')
      expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('media')
    })
  })

  describe('defineXrayCaptureWalker', () => {
    it('is an identity wrapper that returns its argument', () => {
      const def: XrayCaptureWalker = { element: (ctx) => ctx.keep() }
      const walker = defineXrayCaptureWalker(def)
      expect(walker).toBe(def)
      expect(typeof walker.element).toBe('function')
      // Round-trips through captureIdForm exactly like an inline walker.
      const host = mount('<section><p>x</p></section>')
      const plain = captureIdForm([child(host)])
      const wrapped = captureIdForm([child(host)], { walker })
      expect(JSON.stringify(wrapped.tree)).toBe(JSON.stringify(plain.tree))
    })
  })
})

// The MANUAL capture root (ADR 0014). With `root="manual"` the
// client passes the consumer's OWN styled element as the single capture root
// (`rootsFor` -> `[site.el]`) AND `captureRootIsBoundary: true`, so the element
// carries `data-xr-boundary` — the marker a PARENT capture stitches at. The
// gated top-level-root boundary skip in `walk`/`walkAll` makes that element
// serialize as a real Entry (its own box, classes, padding, border) rather than
// a stitch-to-itself, while a NESTED `<Skeleton>` inside it still stitches. AUTO
// capture (`captureRootIsBoundary` false) runs the guard on its top-level roots,
// so a direct-child nested `<Skeleton>` there stitches instead of leaking inline.
describe('manual capture root (ADR 0014)', () => {
  it('captures the root element ITSELF with its box/classes, not just its children', () => {
    style(
      '.panel { padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #2233ff }',
    )
    // The styled element carries data-xr-boundary, exactly as ManualBoundary's
    // ref writes it. Captured AS the root (the client passes [site.el]).
    const host = mount(
      '<section class="panel" data-xr-boundary="my-panel"><h1>Title</h1><p>body</p></section>',
    )
    const root = child(host)
    const plate = capture([root], { name: 'my-panel', captureRootIsBoundary: true })
    // The root is a real node under the synthetic root, NOT a stitch.
    const panel = plate.tree?.kids?.[0]
    expect(panel?.ref).toBeUndefined()
    // Its own layout rules (padding/border/radius) are lifted into the scoped CSS
    // (the serializer expands shorthands to longhand). Were the element captured
    // as a layout-neutral wrapper (a stitch-to-itself), none of these would exist.
    expect(plate.css).toContain('padding-top: 16px')
    expect(plate.css).toContain('border-top-width: 1px')
    expect(plate.css).toContain('border-top-left-radius: 8px')
    // The class is captured too: a content-addressed class targets this node.
    expect(plate.tree?.kids?.[0]?.cls ?? '').not.toBe('')
    // Its children are still walked (the title/body become bones).
    expect(panel?.kids?.length).toBeGreaterThan(0)
  })

  it('a NESTED <Skeleton> inside a manual root still serializes as a stitch', () => {
    const host = mount(
      '<section class="panel" data-xr-boundary="my-panel">' +
        '<div data-xr-boundary="news-feed"><p>loaded</p></div>' +
        '</section>',
    )
    const plate = capture([child(host)], { name: 'my-panel', captureRootIsBoundary: true })
    const panel = plate.tree?.kids?.[0]
    // The manual root itself is NOT a stitch...
    expect(panel?.ref).toBeUndefined()
    // ...but the nested boundary inside it IS (recursion passes isCaptureRoot=false).
    const nested = panel?.kids?.[0]
    expect(nested?.ref).toBe('news-feed')
    expect(nested?.kids).toBeUndefined()
  })

  it('does NOT serialize the top-level manual root to a self-stitch', () => {
    const host = mount('<section data-xr-boundary="my-panel"><p>x</p></section>')
    const plate = capture([child(host)], { name: 'my-panel', captureRootIsBoundary: true })
    const json = JSON.stringify(plate)
    // The root carries its OWN name's boundary marker; it must never become
    // `{ ref: "my-panel" }` (a stitch-to-itself).
    expect(json).not.toContain('"ref":"my-panel"')
    expect(plate.tree?.kids?.[0]?.ref).toBeUndefined()
  })

  it('honors data-xr-root on the top-level root too (a manual root mid-loading)', () => {
    // ROOT_ATTR is the other marker the stitch guard reads; a top-level root that
    // carries it (a boundary still showing its own skeleton) must not self-stitch
    // either — the skip covers both attributes.
    const host = mount('<section data-xr-root="my-panel"><p>x</p></section>')
    const plate = capture([child(host)], { name: 'my-panel', captureRootIsBoundary: true })
    expect(plate.tree?.kids?.[0]?.ref).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.length).toBeGreaterThan(0)
  })

  // The capture-leak regression (ADR 0006). In AUTO mode the top-level roots are
  // the display:contents wrapper's CHILDREN, and the canonical nested pattern
  //   <Skeleton plate={parent}><Skeleton plate={child} /></Skeleton>
  // renders the child Skeleton's boundary element as a DIRECT CHILD of the
  // parent's wrapper — i.e. a top-level root that DOES carry `data-xr-boundary`.
  // With the guard gated OFF for auto (`captureRootIsBoundary` false ≡ the auto
  // path), that direct-child boundary MUST stitch `{ ref }`, never be walked
  // inline. Were the skip unconditional (`walk(root, state, true)` for every
  // root, the regression), the child's content would leak inline into the parent
  // plate — the worst failure mode. These prove the guard runs for auto roots.
  describe('auto top-level root carrying a boundary marker stitches (capture leak, ADR 0006)', () => {
    it('a direct-child nested <Skeleton> boundary serializes as a stitch, not inline', () => {
      // The wrapper is the host div; its child IS a nested Skeleton boundary (it
      // carries data-xr-boundary), passed exactly as the client passes an auto
      // root (Array.from(wrapper.children)). captureRootIsBoundary is left at its
      // false default — the AUTO path.
      const host = mount('<div data-xr-boundary="child"><p>already-loaded child content</p></div>')
      const root = child(host)
      const plate = capture([root], { name: 'parent' })
      const node = plate.tree?.kids?.[0]
      // It is a stitch to the child plate, NOT a walked subtree.
      expect(node?.ref).toBe('child')
      expect(node?.kids).toBeUndefined()
      // The child's already-loaded content never leaks into the parent plate.
      expect(JSON.stringify(plate)).not.toContain('data-xr=')
    })

    it('honors data-xr-root on a direct-child auto root (a nested Skeleton mid-loading)', () => {
      // ROOT_ATTR is the other boundary marker: a nested Skeleton still showing
      // its own bones, rendered as a direct child of the parent's wrapper. It too
      // must stitch, never walk the child's own bones into the parent plate.
      const host = mount(
        '<div data-xr-root="child"><div data-xr="1" data-xr-leaf="box"></div></div>',
      )
      const node = capture([child(host)], { name: 'parent' }).tree?.kids?.[0]
      expect(node?.ref).toBe('child')
      expect(node?.kids).toBeUndefined()
    })
  })

  describe('AUTO output is byte-identical (the skip never triggers for auto roots)', () => {
    it('an auto capture (wrapper children, no boundary marker) is unchanged', () => {
      // Auto roots are the display:contents wrapper's CHILDREN, which never carry
      // data-xr-boundary/data-xr-root, so skipping the stitch guard for the
      // top-level roots changes nothing. Two captures of the same markup — one a
      // plain auto subtree — must serialize identically (parity).
      const markup =
        '<div><section class="card" style="padding: 12px; background: rgb(34,51,255)">' +
        '<h1>Title</h1><p>body text here</p><img src="x.png"></section></div>'
      // The wrapper is the host div; its child (the .card section) is the auto root,
      // exactly as the client passes Array.from(wrapper.children).
      const before = capture([child(mount(markup))], { name: 'parity' })
      const after = capture([child(mount(markup))], { name: 'parity' })
      expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    })
  })
})
