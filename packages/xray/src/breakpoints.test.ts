import { describe, expect, it } from 'vitest'

import {
  complementConditions,
  deriveBreakpoints,
  viewSpanFor,
  spanConditions,
} from './breakpoints.ts'
import type { PlateRule } from './plate.ts'

function rule(media: string[]): PlateRule {
  return { ids: [1], decls: ['display: flex'], media, spec: 0, order: 0 }
}

describe('deriveBreakpoints', () => {
  it('collects min-width thresholds from rule media conditions', () => {
    expect(
      deriveBreakpoints([rule(['(min-width: 768px)']), rule(['(min-width: 1200px)'])]),
    ).toEqual([768, 1200])
  })

  it('maps max-width boundaries to the next view start', () => {
    expect(deriveBreakpoints([rule(['(max-width: 767.98px)'])])).toEqual([768])
    expect(deriveBreakpoints([rule(['(max-width: 768px)'])])).toEqual([769])
  })

  it('reads range syntax and em units, and includes matchMedia queries', () => {
    expect(deriveBreakpoints([rule(['(width >= 48em)'])])).toEqual([768])
    expect(deriveBreakpoints([], ['(min-width: 576px)'])).toEqual([576])
  })

  it('honors strict vs inclusive operators in `width OP N` ranges', () => {
    // >= X: view starts at X; > X: view starts one px above.
    expect(deriveBreakpoints([rule(['(width >= 768px)'])])).toEqual([768])
    expect(deriveBreakpoints([rule(['(width > 768px)'])])).toEqual([769])
    // <= Y: this view includes Y, the next starts at Y+1; < Y: next starts at Y.
    expect(deriveBreakpoints([rule(['(width <= 768px)'])])).toEqual([769])
    expect(deriveBreakpoints([rule(['(width < 768px)'])])).toEqual([768])
  })

  it('honors strict vs inclusive operators in `N OP width` ranges', () => {
    // X <= width ≡ width >= X (inclusive); X < width ≡ width > X (strict).
    expect(deriveBreakpoints([rule(['(768px <= width)'])])).toEqual([768])
    expect(deriveBreakpoints([rule(['(768px < width)'])])).toEqual([769])
  })

  it('rounds decimal range bounds up to the first integer width', () => {
    // Sub-pixel bounds never start a view at a fractional width — always ceil.
    expect(deriveBreakpoints([rule(['(width >= 47.5px)'])])).toEqual([48])
    expect(deriveBreakpoints([rule(['(width > 47.5px)'])])).toEqual([48])
    expect(deriveBreakpoints([rule(['(width < 47.5px)'])])).toEqual([48])
    expect(deriveBreakpoints([rule(['(width <= 47.5px)'])])).toEqual([48])
    expect(deriveBreakpoints([rule(['(47.5px < width)'])])).toEqual([48])
  })

  it('dedupes and sorts across sources, ignoring non-width conditions', () => {
    const breakpoints = deriveBreakpoints(
      [rule(['(min-width: 768px)', '(orientation: landscape)']), rule(['print'])],
      ['(min-width: 768px)', '(prefers-reduced-motion: reduce)', '(max-width: 575.98px)'],
    )
    expect(breakpoints).toEqual([576, 768])
  })
})

describe('viewSpanFor', () => {
  const bps = [576, 768, 1200]

  it('finds the surrounding interval', () => {
    expect(viewSpanFor(320, bps)).toEqual({ max: 576 })
    expect(viewSpanFor(700, bps)).toEqual({ min: 576, max: 768 })
    expect(viewSpanFor(768, bps)).toEqual({ min: 768, max: 1200 })
    expect(viewSpanFor(1440, bps)).toEqual({ min: 1200 })
    expect(viewSpanFor(800, [])).toEqual({})
  })
})

describe('span conditions', () => {
  it('renders active and complement conditions', () => {
    expect(spanConditions({ min: 768, max: 1200 })).toEqual([
      '(min-width: 768px)',
      '(max-width: 1199.98px)',
    ])
    expect(complementConditions({ min: 768, max: 1200 })).toEqual([
      '(max-width: 767.98px)',
      '(min-width: 1200px)',
    ])
    expect(spanConditions({})).toEqual([])
  })
})
