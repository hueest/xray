import { describe, expect, it } from 'vitest'

import {
  type CarryContext,
  filterLayoutDecls,
  freezeUncarriedVars,
  isLayoutProp,
  normalizeDisplay,
  referencedTokens,
  specificity,
  splitSelectorList,
} from './css.ts'

describe('isLayoutProp', () => {
  it('accepts box, flow, flex and grid properties', () => {
    for (const prop of [
      'display',
      'width',
      'min-height',
      'margin-top',
      'padding-inline-start',
      'inset-block-start',
      'flex-grow',
      'gap',
      'grid-template-columns',
      'align-items',
      'justify-content',
      'border-top-width',
      'border-left-style',
      'border-top-left-radius',
      'overflow-x',
      'line-height',
      'aspect-ratio',
      'container-type',
    ]) {
      expect(isLayoutProp(prop), prop).toBe(true)
    }
  })

  it('rejects paint and custom properties', () => {
    for (const prop of [
      'color',
      'background',
      'background-color',
      'background-image',
      'border-top-color',
      'box-shadow',
      'outline',
      'fill',
      'opacity',
      'cursor',
      'z-index',
      '--brand-color',
      'animation',
      'transition',
      'text-decoration',
    ]) {
      expect(isLayoutProp(prop), prop).toBe(false)
    }
  })
})

describe('specificity', () => {
  it('orders id > class > element', () => {
    expect(specificity('#a')).toBeGreaterThan(specificity('.a.b.c'))
    expect(specificity('.a')).toBeGreaterThan(specificity('div span'))
    expect(specificity('div.a')).toBeGreaterThan(specificity('.a'))
  })

  it('counts attributes and pseudo-classes as classes, pseudo-elements as elements', () => {
    expect(specificity('[data-x="1"]')).toBe(specificity('.x'))
    expect(specificity('a:first-child')).toBe(specificity('a.x'))
    expect(specificity('p::before')).toBe(specificity('p span'))
  })

  it('gives :where() zero weight and counts :not() arguments', () => {
    expect(specificity(':where(.a, .b) p')).toBe(specificity('p'))
    expect(specificity('div:not(.a)')).toBe(specificity('div.a'))
  })

  it('does not split on quoted or functional commas', () => {
    expect(splitSelectorList('a[title="x, y"], .b, :is(.c, .d)')).toEqual([
      'a[title="x, y"]',
      '.b',
      ':is(.c, .d)',
    ])
  })
})

// Rule → class rendering moved to classify.ts (ADR 0007); see classify.test.ts.

type StyleDecl = Parameters<typeof filterLayoutDecls>[0]
type ComputedDecl = NonNullable<Parameters<typeof filterLayoutDecls>[1]>

// Minimal CSSStyleDeclaration stand-ins (no DOM needed).
function declOf(props: Record<string, string>): StyleDecl {
  const keys = Object.keys(props)
  return {
    length: keys.length,
    item: (i: number) => keys[i] ?? '',
    getPropertyValue: (p: string) => props[p] ?? '',
    getPropertyPriority: () => '',
  }
}
function computedOf(vars: Record<string, string>): ComputedDecl {
  return { getPropertyValue: (p: string) => vars[p] ?? '' }
}

describe('normalizeDisplay (legacy -webkit-box → modern flow)', () => {
  it('maps the legacy line-clamp flexbox values to block / inline-block', () => {
    expect(normalizeDisplay('-webkit-box')).toBe('block')
    expect(normalizeDisplay('-webkit-inline-box')).toBe('inline-block')
    expect(normalizeDisplay('  -webkit-box  ')).toBe('block')
  })

  it('passes every other display value through untouched', () => {
    for (const v of ['block', 'flex', 'grid', 'inline-block', 'inline-flex', 'contents', 'table'])
      expect(normalizeDisplay(v)).toBe(v)
  })

  it('filterLayoutDecls normalizes a copied display: -webkit-box', () => {
    // The bug: `display: -webkit-box` + `overflow: hidden` was copied while the
    // idiom's companions (`-webkit-box-orient`/`-webkit-line-clamp`) were dropped,
    // leaving a horizontal old-flexbox that collapses the bone to a blank box.
    expect(filterLayoutDecls(declOf({ display: '-webkit-box' }))).toEqual(['display: block'])
    expect(filterLayoutDecls(declOf({ display: '-webkit-inline-box' }))).toEqual([
      'display: inline-block',
    ])
    // `overflow: hidden` is harmless on a normal block and is still copied.
    expect(filterLayoutDecls(declOf({ display: '-webkit-box', overflow: 'hidden' }))).toEqual([
      'display: block',
      'overflow: hidden',
    ])
  })
})

describe('filterLayoutDecls var() resolution', () => {
  it('substitutes a var token with the custom property computed value (shorthand)', () => {
    const out = filterLayoutDecls(
      declOf({ padding: 'var(--card-padding)' }),
      computedOf({ '--card-padding': '16px' }),
    )
    expect(out).toEqual(['padding: 16px'])
  })

  it('uses the fallback when the property is undefined, and drops if it resolves to nothing', () => {
    expect(filterLayoutDecls(declOf({ gap: 'var(--g, 8px)' }), computedOf({}))).toEqual([
      'gap: 8px',
    ])
    expect(filterLayoutDecls(declOf({ gap: 'var(--g)' }), computedOf({}))).toEqual([])
  })

  it('resolves nested vars and keeps surrounding syntax', () => {
    const out = filterLayoutDecls(
      declOf({ width: 'calc(var(--a, var(--b)) + 2px)' }),
      computedOf({ '--b': '40px' }),
    )
    expect(out).toEqual(['width: calc(40px + 2px)'])
  })
})

// LightningCSS enumerates the longhands of a `padding: var(--p)` shorthand but
// returns '' for them; the resolved value lives only in computed style.
function pendingPadding(): StyleDecl {
  const longhands = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']
  return {
    length: longhands.length,
    item: (i: number) => longhands[i] ?? '',
    getPropertyValue: () => '',
    getPropertyPriority: () => '',
  }
}

describe('filterLayoutDecls fluidizes frozen grid tracks', () => {
  it('rebuilds a centred column list as flexible gutters + capped content', () => {
    // Gutters (incl. the scrollbar-width asymmetry) flatten to equal 1fr; the
    // content track is capped so it shrinks but never overgrows.
    expect(filterLayoutDecls(declOf({ 'grid-template-columns': '75.5px 1176px 91.5px' }))).toEqual([
      'grid-template-columns: 1fr minmax(0, 1176px) 1fr',
    ])
  })

  it('caps each content track in a multi-column content area', () => {
    expect(
      filterLayoutDecls(declOf({ 'grid-template-columns': '200px 600px 600px 200px' })),
    ).toEqual(['grid-template-columns: 1fr minmax(0, 600px) minmax(0, 600px) 1fr'])
  })

  it('treats a uniform px column list as an even fr grid', () => {
    expect(filterLayoutDecls(declOf({ 'grid-template-columns': '400px 400px 400px' }))).toEqual([
      'grid-template-columns: 1fr 1fr 1fr',
    ])
  })

  it('turns frozen rows into content-sized auto tracks', () => {
    expect(filterLayoutDecls(declOf({ 'grid-template-rows': '2294.71px' }))).toEqual([
      'grid-template-rows: auto',
    ])
  })

  it('leaves already-fluid or structural track lists untouched', () => {
    for (const value of [
      '1fr 2fr',
      'minmax(0, 600px) 1fr',
      'repeat(3, 200px)',
      'auto 1fr auto',
      '20% 80%',
    ]) {
      expect(filterLayoutDecls(declOf({ 'grid-template-columns': value }))).toEqual([
        `grid-template-columns: ${value}`,
      ])
    }
  })
})

describe('filterLayoutDecls recovers pending-substitution longhands', () => {
  it('falls back to the computed value for an enumerated-but-empty layout longhand', () => {
    const computed: ComputedDecl = {
      getPropertyValue: (p: string) => (p.startsWith('padding') ? '16px' : ''),
    }
    expect(filterLayoutDecls(pendingPadding(), computed)).toEqual([
      'padding-top: 16px',
      'padding-right: 16px',
      'padding-bottom: 16px',
      'padding-left: 16px',
    ])
  })

  it('leaves it out when there is no computed style to fall back to', () => {
    expect(filterLayoutDecls(pendingPadding())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Carried custom properties (ADR 0019 §1; the plan's Phase-1 step 2).
// ---------------------------------------------------------------------------

describe('referencedTokens', () => {
  it('returns nothing for a value with no var()', () => {
    expect(referencedTokens('16px')).toEqual([])
    expect(referencedTokens('calc(100% - 20px)')).toEqual([])
  })

  it('collects the head token of each reference', () => {
    expect(referencedTokens('var(--gap)')).toEqual(['--gap'])
    expect(referencedTokens('calc(var(--a) + var(--b))')).toEqual(['--a', '--b'])
  })

  it('also collects tokens that appear only inside a fallback', () => {
    // The fallback branch is reachable when the head is undefined, so it must be
    // carried too for the chain to stay self-contained.
    expect(referencedTokens('var(--a, var(--b))')).toEqual(['--a', '--b'])
  })

  it('dedupes a repeated reference', () => {
    expect(referencedTokens('var(--g) var(--g)')).toEqual(['--g'])
  })
})

describe('filterLayoutDecls in carry mode', () => {
  it('keeps the raw var() and records the referenced token name', () => {
    const carry: CarryContext = { referenced: new Set() }
    const out = filterLayoutDecls(
      declOf({ gap: 'var(--gap)' }),
      computedOf({ '--gap': '8px' }),
      carry,
    )
    // The reference is NOT frozen — it survives raw so the plate's own
    // definition can drive it at render.
    expect(out).toEqual(['gap: var(--gap)'])
    expect([...carry.referenced]).toEqual(['--gap'])
  })

  it('does not fluidize a var()-driven grid (the heuristic is a last resort)', () => {
    const carry: CarryContext = { referenced: new Set() }
    const out = filterLayoutDecls(
      declOf({ 'grid-template-columns': 'var(--cols)' }),
      computedOf({}),
      carry,
    )
    expect(out).toEqual(['grid-template-columns: var(--cols)'])
    expect([...carry.referenced]).toEqual(['--cols'])
  })

  it('still freezes a pending-substitution longhand (no raw var() to keep)', () => {
    // The shorthand text is empty (LightningCSS), so carry mode has no var() to
    // keep — it falls back to the computed value, exactly as legacy mode does.
    const carry: CarryContext = { referenced: new Set() }
    const computed: ComputedDecl = {
      getPropertyValue: (p: string) => (p.startsWith('padding') ? '16px' : ''),
    }
    expect(filterLayoutDecls(pendingPadding(), computed, carry)).toEqual([
      'padding-top: 16px',
      'padding-right: 16px',
      'padding-bottom: 16px',
      'padding-left: 16px',
    ])
  })
})

describe('freezeUncarriedVars', () => {
  const computed = computedOf({ '--gap': '8px', '--pad': '12px' })

  it('freezes a var() whose token was NOT carried, to its computed value', () => {
    expect(freezeUncarriedVars(['gap: var(--gap)'], new Set(), computed)).toEqual(['gap: 8px'])
  })

  it('leaves a CARRIED token reference intact (the plate defines it)', () => {
    expect(freezeUncarriedVars(['gap: var(--gap)'], new Set(['--gap']), computed)).toEqual([
      'gap: var(--gap)',
    ])
  })

  it('prefers the frozen author map over computed style', () => {
    // Computed style cannot always resolve an inherited custom property; the
    // author value the caller already cascaded wins where present.
    const frozen = new Map([['--gap', '10px']])
    expect(freezeUncarriedVars(['gap: var(--gap)'], new Set(), computed, frozen)).toEqual([
      'gap: 10px',
    ])
  })

  it('falls back to the var() fallback when neither map nor computed resolves it', () => {
    expect(freezeUncarriedVars(['gap: var(--missing, 4px)'], new Set(), computedOf({}))).toEqual([
      'gap: 4px',
    ])
  })

  it('freezes only the uncarried heads in a mixed value', () => {
    const frozen = new Map([['--pad', '12px']])
    expect(
      freezeUncarriedVars(['margin: var(--gap) var(--pad)'], new Set(['--gap']), computed, frozen),
    ).toEqual(['margin: var(--gap) 12px'])
  })

  it('fluidizes a grid that froze to px-only tracks (the last-resort heuristic)', () => {
    const frozen = new Map([['--cols', '75.5px 1176px 91.5px']])
    expect(
      freezeUncarriedVars(['grid-template-columns: var(--cols)'], new Set(), computed, frozen),
    ).toEqual(['grid-template-columns: 1fr minmax(0, 1176px) 1fr'])
  })

  it('leaves a decl with no var() untouched', () => {
    expect(freezeUncarriedVars(['width: 100px'], new Set(), computed)).toEqual(['width: 100px'])
  })
})
