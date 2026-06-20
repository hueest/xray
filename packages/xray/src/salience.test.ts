// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { salience, type CssReader, type SalienceContext, type SalienceRect } from './salience.ts'

// ---------------------------------------------------------------------------
// Fixtures. The scorer is PURE and reads only `getPropertyValue`, so a test
// drives it with a plain property map instead of a live `getComputedStyle` —
// deterministic, and free of happy-dom's missing layout engine. `style()` builds
// a `CssReader` whose unset properties read as '' (exactly what a real computed
// style returns for an absent declaration). All colours are given as `rgb()`/
// `rgba()`, the form a browser serializes computed colours to.
// ---------------------------------------------------------------------------

function style(props: Record<string, string>): CssReader {
  return { getPropertyValue: (p: string) => props[p] ?? '' }
}

const rect = (width: number, height: number): SalienceRect => ({ width, height })

/** A 16px-base context on a white page, with a generous reference area. */
function ctx(over: Partial<SalienceContext> = {}): SalienceContext {
  return {
    behind: { r: 255, g: 255, b: 255, a: 1 },
    baseFontSizePx: 16,
    rootAreaPx: 1280 * 800,
    ...over,
  }
}

// A nondescript inline span: no paint, no spacing, body font, tiny box.
const PLAIN_SPAN = style({
  'background-color': 'rgba(0, 0, 0, 0)',
  'font-size': '16px',
  'font-weight': '400',
})

describe('salience — contrast axis', () => {
  it('scores a contrasting filled card high', () => {
    // A solid blue surface on a white page — the canonical Absorb signal.
    const s = salience(style({ 'background-color': 'rgb(37, 99, 235)' }), rect(320, 200), ctx())
    expect(s.contrast).toBeGreaterThan(0.8)
  })

  it('scores a same-colour fill on a same-colour ground low', () => {
    // A white button on a white card does NOT contrast (measure.ts's case).
    const s = salience(
      style({ 'background-color': 'rgb(255, 255, 255)' }),
      rect(120, 40),
      ctx({ behind: { r: 255, g: 255, b: 255, a: 1 } }),
    )
    expect(s.contrast).toBe(0)
  })

  it('discounts a near-transparent fill', () => {
    // Same hue as the stark-blue card but mostly transparent — reads weaker, and
    // below the alpha floor it does not count as a surface at all.
    const faint = salience(
      style({ 'background-color': 'rgba(37, 99, 235, 0.2)' }),
      rect(320, 200),
      ctx(),
    )
    expect(faint.contrast).toBe(0)
  })

  it('counts a background image as a full fill', () => {
    const s = salience(
      style({ 'background-image': 'linear-gradient(red, blue)' }),
      rect(320, 200),
      ctx(),
    )
    expect(s.contrast).toBe(1)
  })

  it('counts a contrasting border even with no fill', () => {
    const s = salience(
      style({
        'background-color': 'rgba(0, 0, 0, 0)',
        'border-style': 'solid',
        'border-width': '4px',
        'border-color': 'rgb(0, 0, 0)',
      }),
      rect(200, 120),
      ctx(),
    )
    expect(s.contrast).toBeGreaterThan(0.8)
  })

  it('ignores a border whose colour matches the page', () => {
    // A white border on a white page is invisible — width alone is not contrast.
    const s = salience(
      style({
        'border-style': 'solid',
        'border-width': '4px',
        'border-color': 'rgb(255, 255, 255)',
      }),
      rect(200, 120),
      ctx({ behind: { r: 255, g: 255, b: 255, a: 1 } }),
    )
    expect(s.contrast).toBe(0)
  })

  it('counts a box-shadow as lift-off contrast', () => {
    const s = salience(
      style({
        'background-color': 'rgba(0, 0, 0, 0)',
        'box-shadow': 'rgba(0, 0, 0, 0.1) 0px 4px 12px 0px',
      }),
      rect(320, 200),
      ctx(),
    )
    expect(s.contrast).toBe(1)
  })

  it('treats box-shadow: none as no shadow', () => {
    const s = salience(
      style({ 'background-color': 'rgba(0, 0, 0, 0)', 'box-shadow': 'none' }),
      rect(320, 200),
      ctx(),
    )
    expect(s.contrast).toBe(0)
  })

  it('assumes a white page behind a node with no painted ancestor', () => {
    // behind:null → treated as white. A dark fill still contrasts against it.
    const s = salience(
      style({ 'background-color': 'rgb(20, 20, 20)' }),
      rect(320, 200),
      ctx({ behind: null }),
    )
    expect(s.contrast).toBeGreaterThan(0.5)
  })

  it('scores a plain inline span at zero contrast', () => {
    expect(salience(PLAIN_SPAN, rect(40, 18), ctx()).contrast).toBe(0)
  })
})

describe('salience — spacing axis', () => {
  it('scores a generously padded container high', () => {
    const s = salience(
      style({
        'padding-top': '24px',
        'padding-right': '24px',
        'padding-bottom': '24px',
        'padding-left': '24px',
        'row-gap': '16px',
        'column-gap': '16px',
      }),
      rect(600, 400),
      ctx(),
    )
    expect(s.spacing).toBeGreaterThan(0.8)
  })

  it('counts margins, including negative pull-ins', () => {
    const positive = salience(style({ 'margin-top': '32px' }), rect(100, 20), ctx())
    const negative = salience(style({ 'margin-top': '-32px' }), rect(100, 20), ctx())
    expect(positive.spacing).toBeGreaterThan(0)
    expect(negative.spacing).toBe(positive.spacing)
  })

  it('gives an explicitly-aligned container a floor even with no length', () => {
    const s = salience(style({ 'justify-content': 'space-between' }), rect(600, 60), ctx())
    expect(s.spacing).toBeGreaterThanOrEqual(0.2)
  })

  it('treats default alignment as inert', () => {
    const s = salience(
      style({ 'justify-content': 'normal', 'align-items': 'stretch' }),
      rect(600, 60),
      ctx(),
    )
    expect(s.spacing).toBe(0)
  })

  it('scores a plain inline span at zero spacing', () => {
    expect(salience(PLAIN_SPAN, rect(40, 18), ctx()).spacing).toBe(0)
  })

  it('counts border width as rhythm', () => {
    const s = salience(style({ 'border-width': '8px' }), rect(100, 100), ctx())
    expect(s.spacing).toBeGreaterThan(0)
  })
})

describe('salience — size axis', () => {
  it('scores a full-bleed section near 1', () => {
    const s = salience(style({}), rect(1280, 800), ctx())
    expect(s.size).toBeCloseTo(1, 5)
  })

  it('scores a tiny icon near 0', () => {
    const s = salience(style({}), rect(16, 16), ctx())
    expect(s.size).toBeLessThan(0.02)
  })

  it('ranks a card between an icon and a full section', () => {
    const icon = salience(style({}), rect(16, 16), ctx()).size
    const card = salience(style({}), rect(320, 200), ctx()).size
    const section = salience(style({}), rect(1280, 800), ctx()).size
    expect(card).toBeGreaterThan(icon)
    expect(card).toBeLessThan(section)
  })

  it('applies the sqrt ramp — a quarter-area node scores about half', () => {
    // 640×800 = half width, full height = 50% of a 1280×800 root → sqrt(0.5) ≈ 0.707.
    const s = salience(style({}), rect(640, 800), ctx())
    expect(s.size).toBeCloseTo(Math.sqrt(0.5), 3)
  })

  it('clamps a node larger than the reference to 1', () => {
    const s = salience(style({}), rect(4000, 4000), ctx())
    expect(s.size).toBe(1)
  })

  it('disables the axis when the reference area is non-positive', () => {
    const s = salience(style({}), rect(320, 200), ctx({ rootAreaPx: 0 }))
    expect(s.size).toBe(0)
  })

  it('scores a zero-area node at 0', () => {
    expect(salience(style({}), rect(0, 0), ctx()).size).toBe(0)
  })
})

describe('salience — type-scale axis', () => {
  it('scores an h1-sized bold run high', () => {
    const s = salience(style({ 'font-size': '40px', 'font-weight': '700' }), rect(400, 48), ctx())
    expect(s.typeScale).toBeGreaterThan(0.9)
  })

  it('scores body text low', () => {
    const s = salience(style({ 'font-size': '16px', 'font-weight': '400' }), rect(400, 20), ctx())
    expect(s.typeScale).toBe(0)
  })

  it('scores sub-body caption text at 0', () => {
    const s = salience(style({ 'font-size': '12px', 'font-weight': '400' }), rect(200, 16), ctx())
    expect(s.typeScale).toBe(0)
  })

  it('lets weight break a tie at equal size', () => {
    const regular = salience(
      style({ 'font-size': '20px', 'font-weight': '400' }),
      rect(300, 24),
      ctx(),
    ).typeScale
    const bold = salience(
      style({ 'font-size': '20px', 'font-weight': '700' }),
      rect(300, 24),
      ctx(),
    ).typeScale
    expect(bold).toBeGreaterThan(regular)
  })

  it('is relative to the context base — 24px is body on a 24px page', () => {
    const onBigBase = salience(
      style({ 'font-size': '24px', 'font-weight': '400' }),
      rect(300, 28),
      ctx({ baseFontSizePx: 24 }),
    )
    expect(onBigBase.typeScale).toBe(0)
    const onSmallBase = salience(
      style({ 'font-size': '24px', 'font-weight': '400' }),
      rect(300, 28),
      ctx({ baseFontSizePx: 16 }),
    )
    expect(onSmallBase.typeScale).toBeGreaterThan(0)
  })

  it('falls back to the CSS default base when the context base is degenerate', () => {
    const s = salience(
      style({ 'font-size': '40px', 'font-weight': '700' }),
      rect(400, 48),
      ctx({ baseFontSizePx: 0 }),
    )
    // 40px over a 16px default still reads as a heading.
    expect(s.typeScale).toBeGreaterThan(0.9)
  })

  it('scores a node with no font-size at 0', () => {
    expect(salience(style({}), rect(100, 100), ctx()).typeScale).toBe(0)
  })
})

describe('salience — combined score', () => {
  it('every axis and the score land in 0..1', () => {
    const s = salience(
      style({
        'background-color': 'rgb(37, 99, 235)',
        'padding-top': '24px',
        'font-size': '40px',
        'font-weight': '700',
      }),
      rect(320, 200),
      ctx(),
    )
    for (const v of [s.contrast, s.spacing, s.size, s.typeScale, s.score]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('a salient card outscores a plain inline span overall', () => {
    const card = salience(
      style({
        'background-color': 'rgb(37, 99, 235)',
        'padding-top': '24px',
        'padding-bottom': '24px',
        'box-shadow': 'rgba(0,0,0,0.1) 0 4px 12px 0',
      }),
      rect(320, 200),
      ctx(),
    )
    const span = salience(PLAIN_SPAN, rect(40, 18), ctx())
    expect(card.score).toBeGreaterThan(span.score)
    expect(span.score).toBeLessThan(0.05)
  })

  it('a heading run outscores body text overall', () => {
    const heading = salience(
      style({ 'font-size': '40px', 'font-weight': '700' }),
      rect(600, 48),
      ctx(),
    )
    const body = salience(
      style({ 'font-size': '16px', 'font-weight': '400' }),
      rect(600, 20),
      ctx(),
    )
    expect(heading.score).toBeGreaterThan(body.score)
  })

  it('blends per WEIGHTS — score equals the weighted sum of the axes', () => {
    const s = salience(
      style({
        'background-color': 'rgb(37, 99, 235)',
        'padding-top': '24px',
        'padding-bottom': '24px',
        'font-size': '40px',
        'font-weight': '700',
      }),
      rect(320, 200),
      ctx(),
    )
    const expected = s.contrast * 0.35 + s.size * 0.3 + s.typeScale * 0.2 + s.spacing * 0.15
    expect(s.score).toBeCloseTo(expected, 10)
  })

  it('is pure — same inputs give an identical result', () => {
    const args = [
      style({ 'background-color': 'rgb(37, 99, 235)', 'font-size': '24px' }),
      rect(320, 200),
      ctx(),
    ] as const
    expect(salience(...args)).toEqual(salience(...args))
  })
})
