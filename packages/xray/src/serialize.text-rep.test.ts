// @vitest-environment happy-dom

/**
 * The `@container` line-count text rep (ADR 0019 §2; plan Phase-1 step 3).
 *
 * Two halves are tested here, both impossible to exercise from the plain capture tests because
 * happy-dom has NO layout engine (`getContext('2d')` is null, every `getClientRects()` is empty):
 *
 * 1. The REP itself, with canvas metrics + pretext MOCKED — pretext is the capture-side oracle (banned
 *    at render, ADR 0019 §2), so the unit boundary is "given a line-count step function, does the
 *    walk emit the right leaf-scoped `@container` wrapper + reflow bands?" The real pretext math is
 *    the spike's job, independently validated; here we pin the WIRING.
 * 2. The FALLBACK gates — each condition the rep can't safely cover (no canvas, generic font,
 *    `line-height: normal`, single line, `justify`, unbreakable token, pretext/browser
 *    disagreement) must degrade to the EXISTING measured pill bar, byte-identical to today. The
 *    no-canvas fallback is the default in this env and is asserted explicitly.
 *
 * Pretext is mocked so the rep path runs deterministically without real canvas text metrics; the
 * `scenario` object lets each test drive line counts / natural width. The mock mirrors the real
 * module's signature (prepareWithSegments / layout / measureLineStats). A scenario's bands at the
 * fixture's capture width MUST match the fixture's rendered line count, or the rep's agreement
 * check correctly declines (that check is itself tested below).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// pretext mock. `bands` is an ascending list of [minWidth, lines] steps; `layout`
// returns the lines of the widest band whose minWidth ≤ the queried width;
// `naturalWidth` is the unbreakable-token gate. The prepared handle just carries
// the text so a test can prove nothing pretext-internal reaches the plate.
// ---------------------------------------------------------------------------
interface Scenario {
  bands: Array<[minWidth: number, lines: number]>
  naturalWidth: number
}
let scenario: Scenario = { bands: [[0, 1]], naturalWidth: 0 }

vi.mock('@chenglou/pretext', () => ({
  prepareWithSegments: (text: string) => ({ __text: text }),
  layout: (_prepared: unknown, maxWidth: number, lineHeight: number) => {
    let lines = scenario.bands[0]?.[1] ?? 1
    for (const [minWidth, n] of scenario.bands) {
      if (maxWidth >= minWidth) lines = n
    }
    return { lineCount: lines, height: lines * lineHeight }
  },
  // The rep's unbreakable-token gate reads the longest unbreakable token
  // (min-content) via `measureLineStats(prepared, 1).maxLineWidth`; a scenario's
  // `naturalWidth` is that token width (small = fits; > container = fall back).
  measureLineStats: (_prepared: unknown, _maxWidth: number) => ({
    lineCount: 0,
    maxLineWidth: scenario.naturalWidth,
  }),
}))

import { capture, captureIdForm } from './__fixtures__/single-view-capture.ts'

// ---------------------------------------------------------------------------
// happy-dom has no canvas/layout, so the rep's environment is faked: a working
// `getContext('2d').measureText` (the feature gate) and Range geometry where the
// run's bounding rect is `lines × lh` tall and getClientRects yields one rect per
// line at distinct tops (the rendered-line-count agreement check). All runs in a
// given test share the same line count, so one Range spy per test suffices.
// ---------------------------------------------------------------------------
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  'getContext',
)

function enableCanvasMetrics(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => ({ measureText: (s: string) => ({ width: s.length * 8 }) }),
  })
}

function restoreCanvas(): void {
  if (originalGetContext)
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
}

const rect = (width: number, height: number, top = 0): DOMRect => ({
  width,
  height,
  top,
  left: 0,
  right: width,
  bottom: top + height,
  x: 0,
  y: top,
  toJSON: () => ({}),
})

/**
 * Make every `Range` in this test report `lines` line-fragment rects (distinct tops) in a
 * `blockWidth`-wide run `lines × lineHeight` tall. The rep reads this as the rendered geometry; the
 * per-element content box is stubbed per fixture.
 */
function stubRangeGeometry(blockWidth: number, lines: number, lineHeight: number): void {
  const proto = Object.getPrototypeOf(document.createRange())
  vi.spyOn(proto, 'getBoundingClientRect').mockReturnValue(rect(blockWidth, lines * lineHeight))
  const lineRects = Array.from({ length: lines }, (_, i) =>
    rect(blockWidth, lineHeight, i * lineHeight),
  )
  // `measure.ts` only iterates `Array.from(range.getClientRects())`, so an
  // array stands in for the live `DOMRectList` (typed loosely to avoid asserting
  // the richer DOM type the rep never touches).
  const list: DOMRect[] = lineRects
  vi.spyOn(proto, 'getClientRects').mockReturnValue(list)
}

/** Stub an element's content box (no padding/border in these fixtures). */
function stubBlock(el: Element, blockWidth: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect(blockWidth, height),
  })
}

/**
 * Make `el` report an active `-webkit-line-clamp: n` in computed style. happy-dom doesn't compute
 * the `-webkit-box` clamp idiom, so the clamp is injected by wrapping `getComputedStyle` for this
 * one element (everything else passes through unchanged). Mirrors what REAL Chrome reports for the
 * idiom — crucially `display: flow-root` (Chrome normalizes an active `-webkit-box` clamp to
 * flow-root in computed style), with `-webkit-box-orient` / `-webkit-line-clamp` exposed — so
 * detection must key on the box-orient + line-clamp pair, not on `display === -webkit-box` (which
 * never matches in Chrome).
 */
function stubLineClamp(el: Element, n: number): void {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (target: Element, pseudo?: string | null) => {
      const cs = real(target, pseudo ?? undefined)
      if (target !== el) return cs
      return new Proxy(cs, {
        get(t, prop) {
          if (prop === 'display') return 'flow-root'
          if (prop === 'getPropertyValue') {
            return (name: string) =>
              name === '-webkit-line-clamp'
                ? String(n)
                : name === '-webkit-box-orient'
                  ? 'vertical'
                  : t.getPropertyValue(name)
          }
          const v = Reflect.get(t, prop)
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    },
  )
}

const NAMED_FONT = "font-family: 'Helvetica Neue'; font-size: 16px"

/**
 * Mount a single `<p>` run with a named font + px line-height, and stub its geometry + the Range
 * geometry to render `lines` lines at `blockWidth`.
 */
function mountRun(opts: {
  text: string
  blockWidth: number
  lines: number
  lineHeight: number
  style?: string
}): Element {
  const { text, blockWidth, lines, lineHeight, style = '' } = opts
  document.body.innerHTML = `<p style="${NAMED_FONT}; line-height: ${lineHeight}px; ${style}">${text}</p>`
  const p = firstChild()
  stubBlock(p, blockWidth, lines * lineHeight)
  stubRangeGeometry(blockWidth, lines, lineHeight)
  return p
}

/** The body's first element child, asserted present (the just-mounted fixture). */
function firstChild(): Element {
  const el = document.body.firstElementChild
  if (!el) throw new Error('no mounted fixture')
  return el
}

/** Assert a captured run kept the EXISTING measured pill bar (a bare text leaf, no rep). */
function expectPillBar(p: Element): void {
  const plate = capture([p], { name: 'x' })
  const kid = plate.tree?.kids?.[0]?.kids?.[0]
  // The pill-bar fallback (no rep): a measured text bar — a LINE or a multi-line
  // BLOCK depending on the run's height; either is fine, the point is "no rep."
  expect(['text-line', 'text-block']).toContain(kid?.leaf)
  expect(kid?.kids).toBeUndefined()
  expect(plate.css).not.toContain('container-type')
}

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.innerHTML = ''
  scenario = { bands: [[0, 1]], naturalWidth: 0 }
})

afterEach(() => {
  vi.restoreAllMocks()
  restoreCanvas()
})

describe('@container line-count text rep (ADR 0019 §2)', () => {
  describe('the rep, with canvas metrics + pretext mocked', () => {
    beforeEach(enableCanvasMetrics)

    // 3 lines at the 300px capture width; steps to 2 at 320, to 1 at 480.
    const threeLine = (): Element => {
      scenario = {
        bands: [
          [0, 3],
          [320, 2],
          [480, 1],
        ],
        naturalWidth: 80,
      }
      return mountRun({
        text: 'a paragraph that wraps to three lines here',
        blockWidth: 300,
        lines: 3,
        lineHeight: 24,
      })
    }

    it('replaces a multi-line run with a leaf-scoped @container wrapper + text bone', () => {
      const plate = capture([threeLine()], { name: 'x' })
      // The <p>'s child is the injected wrapper (a branch node), not a bare text
      // leaf; the wrapper holds exactly one text-bone child.
      const wrapper = plate.tree?.kids?.[0]?.kids?.[0]
      expect(wrapper?.leaf).toBeUndefined()
      expect(wrapper?.kids).toHaveLength(1)
      expect(wrapper?.kids?.[0]?.leaf).toBe('text-block')
    })

    it('tags the bone kind by line count: multi-line is a text-block, a single line is text', () => {
      // A multi-line run → the rep's bone is a text-block (rendered as a soft
      // rect, not a tall pill — ADR 0021 §4).
      const block = capture([threeLine()], { name: 'x' }).tree?.kids?.[0]?.kids?.[0]
      expect(block?.kids?.[0]?.leaf).toBe('text-block')
      // A single line → a plain text leaf (the rounded line bar).
      scenario = { bands: [[0, 1]], naturalWidth: 40 }
      const line = capture(
        [mountRun({ text: 'one line', blockWidth: 300, lines: 1, lineHeight: 24 })],
        { name: 'x' },
      ).tree?.kids?.[0]?.kids?.[0]
      expect(line?.leaf).toBe('text-line')
    })

    it('emits container-type/name on the wrapper, with a definite width + max-width', () => {
      const { css } = capture([threeLine()], { name: 'x' })
      expect(css).toContain('container-type: inline-size')
      expect(css).toMatch(/container-name: xr-t\d+/)
      // The wrapper carries a DEFINITE captured width (the 300px block), NOT
      // `width: 100%`: an empty bone has no intrinsic width, so a shrink-to-fit
      // ancestor (a flex column with align-items ≠ stretch, a float) collapses a
      // `width: 100%` container to 0 — no band matches and the bone falls to the
      // baseline clamp, rendered zero-wide. `max-width: 100%` still lets it narrow.
      expect(css).toContain('width: 300px')
      expect(css).toContain('max-width: 100%')
      // The bone fills the wrapper.
      expect(css).toContain('width: 100%')
    })

    it('emits @container (min-width) bands with calc(N × lh) and a baseline', () => {
      const { css } = capture([threeLine()], { name: 'x' })
      // Baseline (narrowest, most lines) ungated; the two steps gated by min-width.
      expect(css).toContain('height: calc(3 * 24px)')
      expect(css).toMatch(
        /@container xr-t\d+ \(min-width: 320px\) \{[^}]*height: calc\(2 \* 24px\)/,
      )
      expect(css).toMatch(
        /@container xr-t\d+ \(min-width: 480px\) \{[^}]*height: calc\(1 \* 24px\)/,
      )
      // No frozen text height (the pill bar's `width: …px; height: …px` form) on
      // the bone — every height it carries is a `calc(N × lh)` band. (Matched with
      // a leading `; ` so the parent's legitimate `line-height: 24px` is excluded.)
      expect(css).not.toMatch(/; height: \d+(\.\d+)?px/)
    })

    it('orders the bands so the widest matching min-width wins (ascending source order)', () => {
      const { css } = capture([threeLine()], { name: 'x' })
      // The 480px band must be emitted AFTER the 320px band so it wins at wide
      // widths by source order (equal specificity, min-width cascade).
      expect(css.indexOf('min-width: 320px')).toBeLessThan(css.indexOf('min-width: 480px'))
      // And the ungated baseline is emitted before any gated band.
      expect(css.indexOf('calc(3 * 24px)')).toBeLessThan(css.indexOf('min-width: 320px'))
    })

    it('caps the bands at an active -webkit-line-clamp (clamped text is never taller)', () => {
      // The run would wrap to 5 lines at the narrow end / 3 at the 300px capture,
      // but a `-webkit-line-clamp: 2` ancestor clips it to 2 — so every band must
      // cap at 2. (The agreement check still sees the unclamped count: scenario at
      // 300 = 3 == the 3 stubbed line rects.)
      scenario = {
        bands: [
          [0, 5],
          [200, 3],
          [400, 1],
        ],
        naturalWidth: 80,
      }
      const p = mountRun({
        text: 'a long paragraph clipped to two lines by line-clamp',
        blockWidth: 300,
        lines: 3,
        lineHeight: 24,
      })
      stubLineClamp(p, 2)
      const { css } = capture([p], { name: 'x' })
      // Baseline capped at the clamp, not the unclamped 5/3.
      expect(css).toContain('height: calc(2 * 24px)')
      expect(css).not.toContain('calc(3 * 24px)')
      expect(css).not.toContain('calc(5 * 24px)')
      // Still steps to 1 line once the run fits (min-width 400 in this scenario).
      expect(css).toMatch(
        /@container xr-t\d+ \(min-width: 400px\) \{[^}]*height: calc\(1 \* 24px\)/,
      )
    })

    it('the container-name is plate-local-unique across two multi-line runs', () => {
      // Two sibling paragraphs, each a 2-line run at 200px (steps to 1 at 280).
      scenario = {
        bands: [
          [0, 2],
          [280, 1],
        ],
        naturalWidth: 60,
      }
      const host = document.createElement('div')
      const mk = (t: string): void => {
        const p = document.createElement('p')
        p.setAttribute('style', `${NAMED_FONT}; line-height: 24px`)
        p.textContent = t
        host.append(p)
        stubBlock(p, 200, 48)
      }
      mk('first paragraph wrapping to two lines')
      mk('second paragraph wrapping to two lines')
      document.body.append(host)
      stubRangeGeometry(200, 2, 24)
      const { css } = capture([host], { name: 'x' })
      const names = [...css.matchAll(/container-name: (xr-t\d+)/g)].map((m) => m[1])
      expect(names).toHaveLength(2)
      expect(new Set(names).size).toBe(2)
    })

    it('a contrasting-fill control with a multi-line label collapses to one box, no orphan bands', () => {
      // A filled control whose sole content is a multi-line run that qualified for
      // the rep still collapses to one box bone (the fill IS the visual), and the
      // rep's bands are dropped with it — no rule may reference the dropped bone.
      scenario = {
        bands: [
          [0, 2],
          [280, 1],
        ],
        naturalWidth: 60,
      }
      document.body.innerHTML = `<button style="background: rgb(20,40,200); ${NAMED_FONT}; line-height: 24px">a wrapping label across two lines</button>`
      const btn = firstChild()
      stubBlock(btn, 200, 48)
      stubRangeGeometry(200, 2, 24)
      const plate = capture([btn], { name: 'x' })
      // The control became ONE box leaf (no descent into the label).
      expect(plate.tree?.kids?.[0]?.leaf).toBe('box')
      expect(plate.tree?.kids?.[0]?.kids).toBeUndefined()
      // No leftover @container bands / container metadata from the dropped rep.
      expect(plate.css).not.toContain('@container')
      expect(plate.css).not.toContain('container-name')
    })
  })

  describe('fallback to the existing pill bar (no regression)', () => {
    it('falls back when there is no usable canvas (the default no-layout env)', () => {
      // No enableCanvasMetrics(): getContext is null here, exactly like prod
      // happy-dom — the rep is skipped and the run stays a single text leaf.
      scenario = {
        bands: [
          [0, 3],
          [320, 2],
        ],
        naturalWidth: 80,
      }
      const p = mountRun({
        text: 'three line paragraph that would qualify',
        blockWidth: 300,
        lines: 3,
        lineHeight: 24,
      })
      const plate = capture([p], { name: 'x' })
      const kid = plate.tree?.kids?.[0]?.kids?.[0]
      // 3-line run, rep declined → the fallback bar is a multi-line text-block.
      expect(kid?.leaf).toBe('text-block')
      expect(kid?.kids).toBeUndefined()
      expect(plate.css).not.toContain('container-type')
    })

    describe('with canvas metrics, the rep still declines for unsafe cases', () => {
      beforeEach(enableCanvasMetrics)

      it('a single-line run stays the pill bar', () => {
        scenario = { bands: [[0, 1]], naturalWidth: 40 }
        expectPillBar(mountRun({ text: 'one line', blockWidth: 300, lines: 1, lineHeight: 24 }))
      })

      it('line-height: normal (not a px length) falls back', () => {
        scenario = {
          bands: [
            [0, 3],
            [320, 2],
          ],
          naturalWidth: 80,
        }
        // The fixture geometry is 3 lines tall, but CSS line-height is `normal`,
        // so the exact `lines × lh` identity does not hold — fall back.
        const p = mountRun({
          text: 'three line paragraph here ok',
          blockWidth: 300,
          lines: 3,
          lineHeight: 24,
          style: 'line-height: normal',
        })
        expectPillBar(p)
      })

      it('a generic (system-ui) font with no named face falls back', () => {
        scenario = {
          bands: [
            [0, 3],
            [320, 2],
          ],
          naturalWidth: 80,
        }
        document.body.innerHTML = `<p style="font-family: system-ui; font-size: 16px; line-height: 24px">three line paragraph here ok</p>`
        const p = firstChild()
        stubBlock(p, 300, 72)
        stubRangeGeometry(300, 3, 24)
        expectPillBar(p)
      })

      it('text-align: justify falls back (out of pretext model)', () => {
        scenario = {
          bands: [
            [0, 3],
            [320, 2],
          ],
          naturalWidth: 80,
        }
        expectPillBar(
          mountRun({
            text: 'three line justified paragraph',
            blockWidth: 300,
            lines: 3,
            lineHeight: 24,
            style: 'text-align: justify',
          }),
        )
      })

      it('word-break: break-all falls back (out of pretext model)', () => {
        scenario = {
          bands: [
            [0, 3],
            [320, 2],
          ],
          naturalWidth: 80,
        }
        expectPillBar(
          mountRun({
            text: 'three line break-all paragraph',
            blockWidth: 300,
            lines: 3,
            lineHeight: 24,
            style: 'word-break: break-all',
          }),
        )
      })

      it('an unbreakable token wider than the container falls back (the spike failure)', () => {
        // naturalWidth (widest forced line) exceeds the 300px container.
        scenario = {
          bands: [
            [0, 3],
            [320, 2],
          ],
          naturalWidth: 360,
        }
        expectPillBar(
          mountRun({
            text: 'https://example.com/a/very/long/unbreakable/url',
            blockWidth: 300,
            lines: 3,
            lineHeight: 24,
          }),
        )
      })

      it('falls back when pretext disagrees with the rendered line count at capture', () => {
        // pretext predicts 2 lines at 300px, but the geometry rendered 3 — the
        // agreement check fails, so the rep declines rather than ship a wrong profile.
        scenario = { bands: [[0, 2]], naturalWidth: 80 }
        expectPillBar(
          mountRun({
            text: 'rendered three lines but pretext says two',
            blockWidth: 300,
            lines: 3,
            lineHeight: 24,
          }),
        )
      })
    })
  })

  describe('persisted plate shape', () => {
    beforeEach(enableCanvasMetrics)

    it('the rep emits no pretext-internal data into the plate and is deterministic', () => {
      scenario = {
        bands: [
          [0, 3],
          [320, 2],
          [480, 1],
        ],
        naturalWidth: 80,
      }
      const make = (): Element =>
        mountRun({
          text: 'three line wrapping paragraph here',
          blockWidth: 300,
          lines: 3,
          lineHeight: 24,
        })
      const json = JSON.stringify(capture([make()], { name: 'x' }))
      expect(json).not.toContain('prepareWithSegments')
      expect(json).not.toContain('__text')
      // The capture is byte-identical across two runs of the same DOM.
      expect(JSON.stringify(capture([make()], { name: 'x' }))).toBe(json)
    })

    it('captureIdForm surfaces the band rules with their @container condition', () => {
      scenario = {
        bands: [
          [0, 2],
          [280, 1],
        ],
        naturalWidth: 60,
      }
      const p = mountRun({
        text: 'two line wrapping paragraph here now',
        blockWidth: 200,
        lines: 2,
        lineHeight: 24,
      })
      const view = captureIdForm([p])
      const banded = view.rules.filter((r) => r.container && r.container.length > 0)
      expect(banded.length).toBeGreaterThan(0)
      expect(banded[0]?.container?.[0]).toMatch(/^xr-t\d+ \(min-width: \d/)
      expect(banded[0]?.decls?.[0]).toMatch(/^height: calc\(/)
    })
  })
})
