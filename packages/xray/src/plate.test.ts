import { describe, expect, it } from 'vitest'

import { BASE_CSS } from './plate.ts'

// The CSS reveal mechanism (ADR 0016) leans on @property, @starting-style, and
// custom-property transitions, none of which happy-dom implements (no real
// reveal animation runs in jsdom/happy-dom). So we hold the contract at the
// STRING level: the renamed token taxonomy (ADR 0017), the composed-opacity
// reveal channel, the reduced-motion handling, and the degradation guard must
// all be present in the emitted base stylesheet.
describe('BASE_CSS — ADR 0017 token taxonomy', () => {
  it('uses the renamed --xr-bone-* token names', () => {
    expect(BASE_CSS).toContain('--xr-bone-highlight-color')
    expect(BASE_CSS).toContain('var(--xr-bone-fill, var(--xr-bone-color, #e4e4e7))')
    expect(BASE_CSS).toContain('var(--xr-bone-border-radius, 4px)')
    expect(BASE_CSS).toContain('var(--xr-bone-text-line-border-radius, 999px)')
    expect(BASE_CSS).toContain(
      'var(--xr-bone-text-block-border-radius, var(--xr-bone-border-radius, 4px))',
    )
    expect(BASE_CSS).toContain(
      'var(--xr-bone-media-border-radius, var(--xr-bone-border-radius, 4px))',
    )
    expect(BASE_CSS).toContain('var(--xr-bone-animation, xr-pulse)')
    expect(BASE_CSS).toContain('var(--xr-bone-animation-duration, 1.2s)')
    expect(BASE_CSS).toContain('var(--xr-bone-pulse-opacity-max, 1)')
    expect(BASE_CSS).toContain('var(--xr-bone-pulse-opacity-min, 0.5)')
  })

  it('carries no stale flat token names from ADR 0011', () => {
    // Word-boundary regexes so the new names (which contain the old ones as
    // prefixes, e.g. --xr-bone-color) do not register as matches.
    expect(BASE_CSS).not.toMatch(/--xr-bone\b(?!-)/)
    expect(BASE_CSS).not.toMatch(/--xr-bone-highlight\b(?!-)/)
    expect(BASE_CSS).not.toMatch(/--xr-fill\b/)
    expect(BASE_CSS).not.toMatch(/--xr-radius\b/)
    expect(BASE_CSS).not.toMatch(/--xr-radius-text\b/)
    expect(BASE_CSS).not.toMatch(/--xr-radius-media\b/)
    expect(BASE_CSS).not.toMatch(/--xr-anim\b/)
    expect(BASE_CSS).not.toMatch(/--xr-duration\b/)
    expect(BASE_CSS).not.toMatch(/--xr-pulse-min\b/)
    expect(BASE_CSS).not.toMatch(/--xr-pulse-max\b/)
  })
})

describe('BASE_CSS — ADR 0016 reveal channel', () => {
  it('declares the private --xr-reveal @property with a VISIBLE initial-value', () => {
    // initial-value MUST be 1 (visible): the degradation floor (open Q3). If the
    // @starting-style block below is unsupported, the reveal can never be driven
    // 0->1, so resting at 1 keeps the skeleton fully visible rather than stranded
    // invisible.
    expect(BASE_CSS).toContain(
      '@property --xr-reveal { syntax: "<number>"; inherits: true; initial-value: 1 }',
    )
  })

  it('composes the pulse channel with the reveal channel rather than transitioning opacity', () => {
    expect(BASE_CSS).toContain('opacity: calc(var(--xr-o) * var(--xr-reveal))')
    // The pulse animation owns opacity; never transition opacity directly (ADR 0012/0016).
    expect(BASE_CSS).not.toMatch(/transition:\s*opacity/)
  })

  it('drives the reveal 0->1 with a delayed transition and @starting-style', () => {
    expect(BASE_CSS).toContain(
      'transition: --xr-reveal var(--xr-skeleton-transition-duration, 150ms) linear var(--xr-skeleton-delay, 250ms)',
    )
    expect(BASE_CSS).toContain('@starting-style')
    // The delay-hide is now scoped to non-instant roots (ADR 0020); a stitch
    // continuation is excluded from the 0 start. The selector carries the
    // :not([data-xr-instant]) guard.
    expect(BASE_CSS).toMatch(
      /@starting-style\s*{\s*\.xr-root:not\(\[data-xr-instant\]\)\s*{\s*--xr-reveal:\s*0\s*}/,
    )
  })

  it('guards the delay-hide behind feature detection so it can never strand the skeleton invisible', () => {
    // The delay-hide (start at reveal=0) lives inside a @supports block. A browser
    // that fails the probe skips it entirely and --xr-reveal stays at its visible
    // initial-value 1. Inside the block, even if @starting-style itself were
    // ignored, `.xr-root { --xr-reveal: 1 }` still applies (no 0 start), so the
    // skeleton is visible. No support combination leaves it permanently invisible.
    expect(BASE_CSS).toContain('@supports (selector(:has(*)))')
    expect(BASE_CSS).toMatch(/@supports \(selector\(:has\(\*\)\)\) {[\s\S]*--xr-reveal: 1;/)
  })
})

describe('BASE_CSS — ADR 0020 instant reveal for stitch continuations', () => {
  it('scopes the delay-hide to non-instant roots', () => {
    // Both the rest-state transition rule and the @starting-style 0 start exclude
    // a stitch continuation via :not([data-xr-instant]), so an ordinary top-level
    // skeleton keeps the normal delayed fade.
    expect(BASE_CSS).toMatch(
      /\.xr-root:not\(\[data-xr-instant\]\)\s*{\s*--xr-reveal:\s*1;\s*transition:\s*--xr-reveal/,
    )
    expect(BASE_CSS).toMatch(
      /@starting-style\s*{\s*\.xr-root:not\(\[data-xr-instant\]\)\s*{\s*--xr-reveal:\s*0\s*}/,
    )
  })

  it('reveals a continuation root instantly (reveal 1, no @starting-style, no transition)', () => {
    // The instant rule rests --xr-reveal at 1 with no @starting-style and no
    // transition, so the bones are visible from the first frame instead of fading
    // in after the delay (which would flash a continuing stitch away and back).
    expect(BASE_CSS).toMatch(/\.xr-root\[data-xr-instant\]\s*{\s*--xr-reveal:\s*1\s*}/)
  })

  it('keeps the instant rule inside the @starting-style @supports guard', () => {
    // The instant rule lives in the same @supports (selector(:has(*))) block as the
    // delay-hide: a browser without @starting-style support skips the whole block
    // and rests at initial-value 1 anyway, so a continuation is never stranded.
    const guard = BASE_CSS.slice(BASE_CSS.indexOf('@supports (selector(:has(*)))'))
    expect(guard).toContain('.xr-root[data-xr-instant] { --xr-reveal: 1 }')
  })
})

describe('BASE_CSS — reduced motion (ADR 0016 open Q2)', () => {
  it('keeps the anti-flash delay but drops the fade and the pulse', () => {
    // Drop only the FADE (collapse the transition to 0s) and kill the pulse
    // animation; the delay + min-duration are not motion and stay in force.
    expect(BASE_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) {\s*\.xr-root { animation: none; --xr-skeleton-transition-duration: 0s }/,
    )
  })
})
