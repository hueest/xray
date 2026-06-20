import { describe, expect, it } from 'vitest'

import { isValidCondition, isValidDeclaration, parseStoredPlate } from './validate.ts'
import { PLATE_VERSION, type StoredPlate } from './plate.ts'

describe('isValidDeclaration', () => {
  it('accepts single layout declarations, with optional !important', () => {
    expect(isValidDeclaration('display: flex')).toBe(true)
    expect(isValidDeclaration('width: 10px')).toBe(true)
    expect(isValidDeclaration('display: none !important')).toBe(true)
    expect(isValidDeclaration('grid-template-columns: minmax(0, 320px) 1fr')).toBe(true)
    expect(isValidDeclaration('padding-inline-start: 8px')).toBe(true)
    // a single trailing semicolon is tolerated (some serializers add one)
    expect(isValidDeclaration('display: flex;')).toBe(true)
  })

  it('rejects non-layout (paint/script-adjacent) properties via the allowlist', () => {
    // same allowlist filterLayoutDecls uses (isLayoutProp): paint stays out.
    expect(isValidDeclaration('color: red')).toBe(false)
    expect(isValidDeclaration('background: url(x)')).toBe(false)
    expect(isValidDeclaration('behavior: url(x.htc)')).toBe(false)
  })

  it('accepts carried custom-property definitions (ADR 0019 §1)', () => {
    // A plate with responsive author tokens emits their definitions on the scoped
    // root so a kept `var(--token)` re-resolves at render — these must validate or
    // the whole capture POSTs as 400 (a real dogfood re-capture failure).
    expect(isValidDeclaration('--gap: 8px')).toBe(true)
    expect(isValidDeclaration('--card-padding: var(--space-2)')).toBe(true)
    expect(isValidDeclaration('--x: calc(100% - 16px)')).toBe(true)
    expect(isValidDeclaration('--cols: minmax(0, 320px) 1fr')).toBe(true)
    // The value still goes through every breakout check; a malformed name or a
    // break-out value is rejected exactly as a layout decl would be.
    expect(isValidDeclaration('--evil: red } body {')).toBe(false)
    expect(isValidDeclaration('--a: 1; --b: 2')).toBe(false)
    expect(isValidDeclaration('--bad name: 1')).toBe(false)
    expect(isValidDeclaration('--x: </style>')).toBe(false)
  })

  it('rejects multiple declarations and rule-block / markup break-outs', () => {
    expect(isValidDeclaration('width: 10px; color: red')).toBe(false)
    expect(isValidDeclaration('width: 10px } body { color: red')).toBe(false)
    expect(isValidDeclaration('display: flex { ')).toBe(false)
    expect(isValidDeclaration('width: <script>')).toBe(false)
    expect(isValidDeclaration('width: 10px</style>')).toBe(false)
    expect(isValidDeclaration('width: <!-- 10px')).toBe(false)
  })

  it('rejects empty, value-less, and control-character declarations', () => {
    expect(isValidDeclaration('')).toBe(false)
    expect(isValidDeclaration('display:')).toBe(false)
    expect(isValidDeclaration(': flex')).toBe(false)
    expect(isValidDeclaration('display: flex\n')).toBe(false)
    expect(isValidDeclaration('display:\tflex')).toBe(false)
  })
})

describe('isValidCondition', () => {
  it('accepts every media/container form the capture path emits', () => {
    // synthesized span conditions (breakpoints.ts: spanConditions / complementConditions)
    expect(isValidCondition('(min-width: 768px)')).toBe(true)
    expect(isValidCondition('(max-width: 767.98px)')).toBe(true)
    // author media text (measure.ts: media.mediaText)
    expect(isValidCondition('screen and (min-width: 768px)')).toBe(true)
    expect(isValidCondition('(orientation: landscape)')).toBe(true)
    expect(isValidCondition('not all and (monochrome)')).toBe(true)
    expect(isValidCondition('only screen')).toBe(true)
    // comma media lists
    expect(isValidCondition('screen, print')).toBe(true)
    // container queries (measure.ts: containerCondition)
    expect(isValidCondition('(min-width: 400px)')).toBe(true)
    expect(isValidCondition('sidebar (min-width: 400px)')).toBe(true)
    expect(isValidCondition('style(--x: 1)')).toBe(true)
    // Media Queries Level 4 range syntax: browsers serialize it verbatim into
    // mediaText/containerQuery (bare `<`/`>`), so the validator must accept it.
    expect(isValidCondition('(width >= 600px)')).toBe(true)
    expect(isValidCondition('(width > 600px)')).toBe(true)
    expect(isValidCondition('(400px <= width <= 700px)')).toBe(true)
    expect(isValidCondition('sidebar (400px < width)')).toBe(true)
  })

  it('rejects the CSS-injection breakout vectors', () => {
    // the prelude breakout: closing the prelude and opening a top-level rule
    expect(isValidCondition('screen{}html{background:url(x)}')).toBe(false)
    expect(isValidCondition('screen {')).toBe(false)
    expect(isValidCondition('(min-width: 768px) }')).toBe(false)
    // raw-text / markup terminators (a bare `<`/`>` is allowed; only these are not)
    expect(isValidCondition('screen</style>')).toBe(false)
    expect(isValidCondition('<!-- screen')).toBe(false)
    expect(isValidCondition('screen -->')).toBe(false)
    expect(isValidCondition('<![CDATA[ screen')).toBe(false)
    // CSS comment delimiters
    expect(isValidCondition('screen /* x */')).toBe(false)
    expect(isValidCondition('screen */')).toBe(false)
    // a semicolon never appears in a real prelude
    expect(isValidCondition('screen; html { x: y }')).toBe(false)
    // control characters, empty, and over-length
    expect(isValidCondition('screen\n')).toBe(false)
    expect(isValidCondition('')).toBe(false)
    expect(isValidCondition(`(min-width: ${'9'.repeat(2_000)}px)`)).toBe(false)
  })
})

describe('parseStoredPlate (the ADR 0022 disk/wire shape)', () => {
  const valid: StoredPlate = {
    v: PLATE_VERSION,
    name: 'product-dashboard',
    breakpoints: [768, 1024],
    tree: {
      cls: 'xr-product-dashboard-0',
      kids: [
        { leaf: 'box', cls: 'xr-product-dashboard-1' },
        { ref: 'news-feed' },
        { leaf: 'text-line', cls: 'xr-product-dashboard-2', count: 4 },
      ],
    },
    css: '[data-xr-root] .xr-product-dashboard-1 { display: flex }\n@media (min-width: 768px) { [data-xr-root] .xr-product-dashboard-0 { display: none !important } }',
  }

  it('accepts a well-formed StoredPlate (post-classify tree + css blob + breakpoints)', () => {
    expect(parseStoredPlate(valid)).toEqual(valid)
  })

  it('accepts a capture-less plate (null tree, empty css)', () => {
    expect(
      parseStoredPlate({ v: PLATE_VERSION, name: 'empty', breakpoints: [], tree: null, css: '' }),
    ).toEqual({
      v: PLATE_VERSION,
      name: 'empty',
      breakpoints: [],
      tree: null,
      css: '',
    })
  })

  it('allows braces, newlines, and MQ4 range syntax in the css blob (legitimate post-classify CSS)', () => {
    // The per-decl allowlist forbids `{}` and bare `<`/`>`; a finished css blob has
    // both legitimately (rule blocks, `@media (width >= 600px)` range syntax).
    const css =
      '[data-xr-root] .a { display: grid }\n@media (width >= 600px) { [data-xr-root] .b { gap: 8px } }'
    expect(parseStoredPlate({ ...valid, css })).not.toBeNull()
  })

  it('rejects a css blob that breaks out of the <style> raw-text context', () => {
    // The security boundary the validator guards: no `</style`, HTML comment, or
    // CDATA terminator can escape the rendered `<style>`.
    expect(parseStoredPlate({ ...valid, css: 'a {}</style><script>alert(1)</script>' })).toBeNull()
    expect(parseStoredPlate({ ...valid, css: 'a {} <!-- x -->' })).toBeNull()
    expect(parseStoredPlate({ ...valid, css: 'a {} <![CDATA[ x' })).toBeNull()
  })

  it('rejects a bad name, wrong version, and an over-deep tree', () => {
    expect(parseStoredPlate({ ...valid, name: 'has space' })).toBeNull()
    expect(parseStoredPlate({ ...valid, v: PLATE_VERSION + 1 })).toBeNull()
    // A stitch ref must itself be a valid plate name.
    expect(parseStoredPlate({ ...valid, tree: { kids: [{ ref: 'bad name' }] } })).toBeNull()
  })

  it('rejects a non-object body', () => {
    expect(parseStoredPlate(null)).toBeNull()
    expect(parseStoredPlate('nope')).toBeNull()
    expect(parseStoredPlate(42)).toBeNull()
  })
})
