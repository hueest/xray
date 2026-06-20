import { describe, expect, it } from 'vitest'

import type { PlateNode, PlateRule } from './plate.ts'
import { SPEC_CONTEXT, SPEC_FALLBACK, SPEC_GATE, SPEC_LEAF } from './plate.ts'
import { classify } from './classify.ts'

const tree: PlateNode = {
  id: 0,
  kids: [{ id: 1 }, { id: 2, leaf: 'text-line' }, { id: 3, ref: 'child' }],
}

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`)
  return value
}

describe('classify', () => {
  it('shares one class across nodes with identical declarations', () => {
    const rules: PlateRule[] = [
      { ids: [1, 2], decls: ['display: flex'], spec: 10, order: 1 },
      { ids: [1], decls: ['display: flex'], spec: 10, order: 3 },
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    const n1 = out.kids?.[0]?.cls?.split(' ') ?? []
    const n2 = out.kids?.[1]?.cls?.split(' ') ?? []
    // both reference the same single flex class…
    expect(n1).toHaveLength(1)
    expect(n1[0]).toBe(n2[0])
    // …emitted once as a descendant rule
    const flex = defined(n1[0], 'flex class')
    expect(css).toContain(`[data-xr-root] .${flex} { display: flex }`)
    expect(css.match(/display: flex/g)).toHaveLength(1)
  })

  it('drops ids and keeps leaf/ref on the shipped tree', () => {
    const { tree: out } = classify([], tree, 'x')
    expect(out).not.toHaveProperty('id')
    expect(out.kids?.[1]?.leaf).toBe('text-line')
    expect(out.kids?.[2]?.ref).toBe('child')
    expect(out.kids?.[2]?.cls).toBeUndefined() // a stitch carries no classes
  })

  it('targets the root element for root rules, descendants otherwise', () => {
    const rules: PlateRule[] = [
      // A surviving root rule (a carried-token def) — a font-only context rule is
      // dropped at gen, so it would target nothing.
      { ids: [], decls: ['--gap: 1rem'], spec: SPEC_CONTEXT, order: 0 },
      { ids: [2], decls: ['width: 50px'], spec: SPEC_LEAF, order: 2 },
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    const rootCls = defined(out.cls, 'root class')
    expect(css).toContain(`[data-xr-root].${rootCls} { --gap: 1rem }`)
    const leafCls = defined(out.kids?.[1]?.cls, 'leaf class')
    expect(css).toContain(`[data-xr-root] .${leafCls} { width: 50px }`)
  })

  it('emits classes in cascade order (losers first, winners last)', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['width: auto'], spec: 10, order: 2 }, // author
      { ids: [1], decls: ['width: 50px'], spec: SPEC_LEAF, order: 1 }, // leaf wins
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css.indexOf('width: auto')).toBeLessThan(css.indexOf('width: 50px'))
  })

  it('emits layered rules before unlayered ones, so unlayered wins', () => {
    // A layered app rule (`@layer`) must lose to the unlayered measured leaf
    // size, even though its spec is higher — else `img { height: auto }` would
    // collapse a media leaf.
    const rules: PlateRule[] = [
      { ids: [1], decls: ['height: auto'], spec: 1000, order: 0, layered: true },
      { ids: [1], decls: ['height: 80px'], spec: SPEC_LEAF, order: 1 },
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css.indexOf('height: auto')).toBeLessThan(css.indexOf('height: 80px'))
  })

  it('wraps media-conditional rules and keeps !important gates', () => {
    const rules: PlateRule[] = [
      {
        ids: [1],
        decls: ['display: none !important'],
        media: ['(min-width: 768px)'],
        spec: SPEC_GATE,
        order: 0,
      },
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    const cls = defined(out.kids?.[0]?.cls, 'media class')
    expect(css).toBe(
      `@media (min-width: 768px) { [data-xr-root] .${cls} { display: none !important } }`,
    )
  })

  it('wraps container-conditional rules in @container', () => {
    const rules: PlateRule[] = [
      {
        ids: [1],
        decls: ['grid-template-columns: 1fr 1fr'],
        container: ['(min-width: 28rem)'],
        spec: 10,
        order: 0,
      },
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    const cls = defined(out.kids?.[0]?.cls, 'container class')
    expect(css).toBe(
      `@container (min-width: 28rem) { [data-xr-root] .${cls} { grid-template-columns: 1fr 1fr } }`,
    )
  })

  it('nests @media inside @container when a rule carries both', () => {
    const rules: PlateRule[] = [
      {
        ids: [1],
        decls: ['display: grid'],
        media: ['(min-width: 768px)'],
        container: ['(min-width: 28rem)'],
        spec: 10,
        order: 0,
      },
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    const cls = defined(out.kids?.[0]?.cls, 'media/container class')
    expect(css).toBe(
      `@container (min-width: 28rem) { @media (min-width: 768px) { [data-xr-root] .${cls} { display: grid } } }`,
    )
  })

  it('keys container conditions into the class identity', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['display: grid'], spec: 10, order: 1 },
      { ids: [2], decls: ['display: grid'], container: ['(min-width: 28rem)'], spec: 10, order: 2 },
    ]
    const { tree: out } = classify(rules, tree, 'x')
    // Same declarations, different container condition → different classes.
    expect(out.kids?.[0]?.cls).not.toBe(out.kids?.[1]?.cls)
  })

  it('gives different declarations different classes', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['display: flex'], spec: 10, order: 1 },
      { ids: [2], decls: ['display: grid'], spec: 10, order: 2 },
    ]
    const { tree: out } = classify(rules, tree, 'x')
    expect(out.kids?.[0]?.cls).not.toBe(out.kids?.[1]?.cls)
  })

  it('namespaces class names by plate, so identical bodies in two plates differ', () => {
    // Two plates on one page each ship their own <style>; identical declarations
    // must NOT share a class name, or a later plate's block would reorder an
    // earlier plate's element that carries several shared classes.
    const rules: PlateRule[] = [{ ids: [1], decls: ['height: auto'], spec: 1, order: 0 }]
    const a = classify(rules, tree, 'news-feed').tree.kids?.[0]?.cls
    const b = classify(rules, tree, 'content-cards').tree.kids?.[0]?.cls
    expect(a).not.toBe(b)
    expect(a?.startsWith('xr-news-feed-')).toBe(true)
    expect(b?.startsWith('xr-content-cards-')).toBe(true)
  })

  it('names classes with a plain per-plate base36 counter in emit order', () => {
    // Ids are sequential, not content hashes: the plate prefix carries isolation,
    // so a counter is collision-free and compresses far better (ADR 0007
    // amendment). Handed out in cascade-emit order (losers first).
    const rules: PlateRule[] = [
      { ids: [1], decls: ['display: flex'], spec: 10, order: 0 },
      { ids: [1], decls: ['width: auto'], spec: 10, order: 2 }, // loser
      { ids: [1], decls: ['width: 50px'], spec: SPEC_LEAF, order: 1 }, // winner, emitted last
    ]
    const { tree: out, css } = classify(rules, tree, 'x')
    expect(out.kids?.[0]?.cls).toBe('xr-x-0 xr-x-1 xr-x-2')
    expect(css).toContain('[data-xr-root] .xr-x-0 { display: flex }')
    expect(css).toContain('[data-xr-root] .xr-x-2 { width: 50px }')
  })

  it('keeps two plates class tokens disjoint even with identical bodies (cross-stitch safety)', () => {
    // The squashed-circle regression: a node carries several shared classes
    // whose order decides the winner (a global `img { height: auto }` vs the
    // measured leaf size). A stitch renders a child plate inside the parent, so a
    // shared token would let a later <style> block reorder this plate's element.
    // Identical rule bodies in two plates must therefore still yield disjoint
    // token sets — the guarantee the per-plate prefix exists to give.
    const rules: PlateRule[] = [
      { ids: [1], decls: ['height: auto'], spec: 1, order: 0 },
      { ids: [1], decls: ['height: 80px'], spec: SPEC_LEAF, order: 1 },
    ]
    const tokens = (name: string) =>
      new Set(classify(rules, tree, name).tree.kids?.[0]?.cls?.split(' '))
    const a = tokens('news-feed')
    const b = tokens('content-cards')
    expect(a.size).toBe(2)
    expect([...a].some((t) => b.has(t))).toBe(false)
  })

  it('encodes nested names with -- so the prefix stays injective vs literal underscores', () => {
    // The encoder renders the path separator `/` as `--` (readable nesting), and
    // `isValidPlateName` forbids a literal `--` (or edge hyphen) in a segment, so
    // `/` and an underscore can never collide on the same class prefix. This is
    // the isolation boundary across stitched plates (ADR 0007).
    const rules: PlateRule[] = [{ ids: [1], decls: ['display: flex'], spec: 10, order: 0 }]
    const prefix = (name: string) =>
      defined(classify(rules, tree, name).tree.kids?.[0]?.cls, 'class').replace(/\d+$/, '')
    expect(prefix('product/card')).toBe('xr-product--card-')
    expect(prefix('product_card')).toBe('xr-product_card-')
    expect(prefix('product/card')).not.toBe(prefix('product_card'))
  })

  it('keeps slash-vs-underscore variants disjoint at every position', () => {
    const rules: PlateRule[] = [{ ids: [1], decls: ['display: flex'], spec: 10, order: 0 }]
    const tokens = (name: string) =>
      new Set(classify(rules, tree, name).tree.kids?.[0]?.cls?.split(' '))
    // `a/b_c` vs `a_b/c`: same chars, the slash sits on opposite sides.
    expect([...tokens('a/b_c')].some((t) => tokens('a_b/c').has(t))).toBe(false)
    // `a/b/c` vs `a/b_c`: a deeper path must not collide with a shallower one.
    expect([...tokens('a/b/c')].some((t) => tokens('a/b_c').has(t))).toBe(false)
  })
})

describe('dropDeadDecls (gen-side font/text drop)', () => {
  it('drops always-dead font/text decls but keeps alignment + layout', () => {
    const rules: PlateRule[] = [
      {
        ids: [1],
        decls: [
          'font-family: serif',
          'font-weight: 700',
          'letter-spacing: 1px',
          'white-space: nowrap',
          'vertical-align: middle',
          'text-align: center',
          'width: 50px',
        ],
        spec: 10,
        order: 0,
      },
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css).not.toMatch(/font-family|font-weight|letter-spacing|white-space/)
    // Alignment positions inline-block bones; it stays.
    expect(css).toContain('vertical-align: middle')
    expect(css).toContain('text-align: center')
    expect(css).toContain('width: 50px')
  })

  it('drops a rule that empties out (the all-font context rule)', () => {
    const rules: PlateRule[] = [
      {
        ids: [],
        decls: ['font-family: serif', 'font-size: 16px', 'line-height: 24px'],
        spec: SPEC_CONTEXT,
        order: 0,
      },
    ]
    expect(classify(rules, tree, 'x').css).toBe('')
  })

  it('keeps line-height on an inline-flow fallback row (the per-row pin)', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['line-height: 21.6px'], spec: SPEC_FALLBACK, order: 0 },
    ]
    expect(classify(rules, tree, 'x').css).toContain('line-height: 21.6px')
  })

  it('drops line-height on a flex fallback row (text is a flex item — no line box)', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['display: flex', 'line-height: 27px'], spec: SPEC_FALLBACK, order: 0 },
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css).toContain('display: flex')
    expect(css).not.toContain('line-height')
  })

  it('drops line-height that is not a fallback-rule pin (an author copy)', () => {
    const rules: PlateRule[] = [{ ids: [1], decls: ['line-height: 27px'], spec: 10, order: 0 }]
    expect(classify(rules, tree, 'x').css).not.toContain('line-height')
  })

  it('drops font-size when the plate uses only px/rem (no em/ex/ch)', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['font-size: 16px', 'width: 1rem'], spec: 10, order: 0 },
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css).not.toContain('font-size')
    expect(css).toContain('width: 1rem') // rem is root-relative — does not pin font-size
  })

  it('keeps font-size when a kept decl uses an element-font-relative unit', () => {
    const rules: PlateRule[] = [
      { ids: [1], decls: ['font-size: 16px'], spec: 10, order: 0 },
      { ids: [2], decls: ['padding: 0.5em'], spec: 10, order: 1 },
    ]
    const { css } = classify(rules, tree, 'x')
    expect(css).toContain('font-size: 16px')
    expect(css).toContain('padding: 0.5em')
  })
})
