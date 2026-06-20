// @vitest-environment happy-dom

/**
 * RUN GROUPING + ABSORB — capture-time grouping (ADR 0021, superseding ADR 0019 §3 Fuse).
 *
 * - A RUN is the inline ink of one block (one inline formatting context): a block's text plus its
 *   pure-inline text wrappers coalesce into ONE Bone, while distinct block-level children stay
 *   SEPARATE Bones. The decision is the formatting context, NOT nesting depth — so the same CSS
 *   yields the same bones regardless of how the markup nests.
 * - ABSORB collapses a label-only contrast surface (fill / border / shadow) to one box Bone.
 *
 * Happy-dom has no layout engine, but run grouping is display-driven, not geometry-driven, so the
 * tree STRUCTURE these tests assert is exercised directly (geometry — line counts, sizes — is the
 * text-rep test's job). Note: happy-dom applies no UA stylesheet, so a `<span>` reads `display:
 * ''`, not `inline`; tests that exercise inline coalescing set `display: inline` explicitly, which
 * is what a real browser computes for them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { capture } from './__fixtures__/single-view-capture.ts'

beforeEach(() => {
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.innerHTML = ''
})

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`)
  return value
}

function query(selector: string): Element {
  return defined(document.querySelector(selector), selector)
}

/** A two-line "tab": a surname over a second line, whose nesting the test varies. */
function tabHtml(secondLine: string): string {
  return `<div style="display:flex;flex-direction:column"><div>Surname</div>${secondLine}</div>`
}

/** Build a DOMRect for the glyph-fold geometry stubs (happy-dom has no layout). */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

// ---------------------------------------------------------------------------
// RUN GROUPING — the ink-driven, markup-agnostic grouping (ADR 0021 §2).
// ---------------------------------------------------------------------------

describe('Run grouping — inline ink coalesces; distinct blocks stay separate (ADR 0021)', () => {
  it('coalesces the inline content of one block into a single text line', () => {
    // The dogfooded "stars + (128 reviews)" case: a bare text node and an inline
    // span are ONE inline formatting context → one Bone, not two. (Old Fuse left
    // them split because the text node was not an element it could merge.)
    document.body.innerHTML = '<p>★★★★½ <span style="display:inline">(128 reviews)</span></p>'
    const kids = capture([query('p')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(1)
    expect(kids?.[0]?.leaf).toBe('text-line')
  })

  it('keeps distinct block-level labels as separate bones (a flex column)', () => {
    // The dogfooded "name over price" case: separate flex-column items are
    // blockified → two Bones, never merged, even stacked one line-height apart.
    // (Old vertical Fuse merged them on equal box width.)
    document.body.innerHTML =
      '<div style="display:flex;flex-direction:column"><span>Comptometer</span><span>$720</span></div>'
    expect(capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids).toHaveLength(2)
  })

  it('groups identically regardless of nesting depth (markup-agnostic)', () => {
    // The dogfooded "artwork tab vs Track Record" divergence: same CSS, but the
    // second line is a single `div>text` in one and a double-nested `div>div>text`
    // in the other. Both MUST yield two separate bones — the extra wrapper must
    // not flip the grouping the way the old `fusableUnit` shape match did.
    document.body.innerHTML = tabHtml('<div>68% Progress</div>')
    const single = capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids?.length
    document.body.innerHTML = tabHtml('<div><div>68% Progress</div></div>')
    const nested = capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids?.length
    expect(single).toBe(2)
    expect(nested).toBe(2)
  })

  it('blockifies a flex parent: inline-display children stay separate bones', () => {
    // A flow parent would coalesce these inline spans into one run; a flex parent
    // blockifies every child, so they stay two Bones (the formatting context, not
    // the children's display, decides).
    document.body.innerHTML =
      '<div style="display:flex"><span style="display:inline">a</span><span style="display:inline">b</span></div>'
    expect(capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids).toHaveLength(2)
  })

  it('does NOT fold replaced media into a text run', () => {
    // An inline <img> is replaced media, not glyph ink — it breaks the run and is
    // its own media Bone, leaving the text its own line.
    document.body.innerHTML = '<p><span style="display:inline">label</span><img src="x.png"></p>'
    const kids = capture([query('p')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.some((k) => k.leaf === 'media')).toBe(true)
  })

  it('does NOT silently coalesce an inline wrapper that contains media', () => {
    // A `<span>` with an `<img>` descendant is not pure text, so it is walked on
    // its own and the media is not swallowed into a text bar.
    document.body.innerHTML = '<p><span style="display:inline"><img src="x.png">label</span></p>'
    const plate = capture([query('p')], { name: 'x' })
    expect(JSON.stringify(plate.tree)).toContain('"media"')
  })

  it('leaves a single child as one bone', () => {
    document.body.innerHTML = '<div style="display:flex"><span>only</span></div>'
    expect(capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// ABSORB — the contrast-surface collapse (unchanged by ADR 0021).
// ---------------------------------------------------------------------------

describe('Absorb — contrast surface collapses a label-only control to one box', () => {
  it('still collapses a contrasting FILL (existing behavior, unchanged)', () => {
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)"><button style="background: rgb(91,61,245)">Invest Now</button></div>'
    const plate = capture([query('button')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBe('box')
    expect(plate.tree?.kids?.[0]?.kids).toBeUndefined()
  })

  it('collapses a contrasting BORDER surface (an outlined chip) to one box', () => {
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)">' +
      '<span style="border: 2px solid rgb(0,0,0); background: rgba(0,0,0,0)">Filter</span>' +
      '</div>'
    const plate = capture([query('span')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBe('box')
    expect(plate.tree?.kids?.[0]?.kids).toBeUndefined()
  })

  it('collapses a BOX-SHADOW surface (a lifted card button) to one box', () => {
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)">' +
      '<a style="box-shadow: 0 1px 3px rgba(0,0,0,0.3); background: rgba(0,0,0,0)">Open</a>' +
      '</div>'
    const plate = capture([query('a')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBe('box')
    expect(plate.tree?.kids?.[0]?.kids).toBeUndefined()
  })

  it('does NOT collapse a plain (no-surface) control — outline button matching the page', () => {
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)"><button style="background: rgb(255,255,255)">Sec.gov</button></div>'
    const plate = capture([query('button')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('does NOT collapse a 1px same-as-page hairline border (incidental, not a surface)', () => {
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)">' +
      '<span style="border: 1px solid rgb(255,255,255); background: rgba(0,0,0,0)">Label</span>' +
      '</div>'
    const plate = capture([query('span')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.[0]?.leaf).toBe('text-line')
  })

  it('does NOT collapse a bordered SURFACE that has structured children (a real card)', () => {
    document.body.innerHTML =
      '<section style="border: 2px solid rgb(0,0,0); background: rgba(0,0,0,0)">' +
      '<h2>Title</h2><div><span>a</span><span>b</span></div></section>'
    const plate = capture([query('section')], { name: 'x' })
    expect(plate.tree?.kids?.[0]?.leaf).toBeUndefined()
    expect(plate.tree?.kids?.[0]?.kids?.length).toBe(2)
  })

  it('does NOT collapse a contrast surface wrapping REPLACED MEDIA (a media box + its label)', () => {
    // ADR 0021 §3: replaced media is never a swallowing surface. A filled card with
    // an image and an overlaid title stays a media box plus its text bone — even on a
    // contrasting fill — rather than collapsing to one box.
    document.body.innerHTML =
      '<div style="background: rgb(255,255,255)">' +
      '<div class="card" style="background: rgb(91,61,245)"><img src="x.png"><span>Title</span></div>' +
      '</div>'
    const surface = capture([query('.card')], { name: 'x' }).tree?.kids?.[0]
    expect(surface?.leaf).toBeUndefined()
    expect(surface?.kids?.some((k) => k.leaf === 'media')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// STITCH SAFETY — a Stitch is an un-mergeable boundary (ADR 0006). A run never
// crosses it, and Absorb never subsumes it.
// ---------------------------------------------------------------------------

describe('stitch safety — grouping never crosses a Stitch (ADR 0006)', () => {
  it('breaks a run at a Stitch boundary (the two sides stay separate, the ref survives)', () => {
    // Inline text around a nested <Skeleton> boundary: the boundary breaks the run
    // even though the text would otherwise coalesce, and the stitch stays a ref.
    document.body.innerHTML =
      '<p>before<span style="display:inline" data-xr-boundary="nested-card"></span>after</p>'
    const kids = capture([query('p')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(3)
    expect(kids?.[0]?.leaf).toBe('text-line')
    expect(kids?.[1]?.ref).toBe('nested-card')
    expect(kids?.[2]?.leaf).toBe('text-line')
  })

  it('keeps a Stitch as a ref even inside a contrast surface (Absorb does not subsume it)', () => {
    document.body.innerHTML =
      '<section style="border: 2px solid rgb(0,0,0); background: rgba(0,0,0,0)">' +
      '<span>label</span>' +
      '<div data-xr-boundary="nested"></div>' +
      '</section>'
    const node = capture([query('section')], { name: 'x' }).tree?.kids?.[0]
    expect(node?.leaf).toBeUndefined()
    expect(node?.kids?.map((k) => k.ref)).toContain('nested')
  })
})

// ---------------------------------------------------------------------------
// GLYPH-FOLD — an emoji-sized inline icon hugging the text joins the run; a
// bigger or gutter-gapped icon stays its own media Bone (ADR 0021 §2). This is
// geometry-driven, so it stubs the icon + text rects (happy-dom has no layout).
// ---------------------------------------------------------------------------
describe('Glyph-fold — an inline icon joins a run only when it reads as a letter (ADR 0021)', () => {
  // `<img> rating`: a 18px-tall icon at x0, the text at `textLeft`, line-height 20.
  // The single Range stub stands in for both the leading-icon peek and the bar.
  const mount = (iconHeight: number, textLeft: number): Element => {
    document.body.innerHTML =
      '<p style="line-height:20px;font-size:16px"><img style="display:inline"> rating</p>'
    Object.defineProperty(query('img'), 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 18, iconHeight),
    })
    vi.spyOn(
      Object.getPrototypeOf(document.createRange()),
      'getBoundingClientRect',
    ).mockReturnValue(rect(textLeft, 0, 50, 18))
    return query('p')
  }

  afterEach(() => vi.restoreAllMocks())

  it('folds an emoji-sized, tight icon into one text line (no separate media bone)', () => {
    const kids = capture([mount(18, 20)], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(1)
    expect(kids?.[0]?.leaf).toBe('text-line')
  })

  it('keeps a taller-than-text icon as its own media bone', () => {
    const kids = capture([mount(40, 20)], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.map((k) => k.leaf).toSorted()).toEqual(['media', 'text-line'])
  })

  it('keeps a gutter-gapped icon as its own media bone', () => {
    // gap to the text is 42px (textLeft 60 − icon right 18), well past ~a space.
    const kids = capture([mount(18, 60)], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.map((k) => k.leaf).toSorted()).toEqual(['media', 'text-line'])
  })

  it('does not drop a leading icon that abuts a NON-text sibling (regression)', () => {
    // A leading inline icon followed by an inline-block (not text): the `nextText`
    // peek used to return any non-media sibling's rect, so the icon "folded"
    // against the badge box, got queued, then was dropped when the empty run
    // flushed — a silent content loss. The icon must stay its own media bone (and
    // the badge its own bone). Geometry is emoji-sized + tight to tempt the fold.
    document.body.innerHTML =
      '<p style="line-height:20px"><img style="display:inline"><b style="display:inline-block">badge</b></p>'
    Object.defineProperty(query('img'), 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 18, 18),
    })
    Object.defineProperty(query('b'), 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(18, 0, 50, 18),
    })
    const kids = capture([query('p')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.some((k) => k.leaf === 'media')).toBe(true) // the icon survived
  })
})

// ---------------------------------------------------------------------------
// GLYPH-FOLD "ROW ANYTHING" — the fold is GEOMETRY-driven, not display-gated. In
// normal flow the icon folds into the run; in a flex / grid row the icon and its
// label are separate blockified siblings, so a post-pass folds the icon into the
// adjacent single-line label Bone when it reads as a glyph (ADR 0021 §2). The
// `LabelWithTooltip`/`Download` cases live in flex rows — this is that path.
// ---------------------------------------------------------------------------
describe('Glyph-fold across a flex/grid row — geometry decides, not the parent (ADR 0021)', () => {
  // An icon + a label as two siblings of a `display` container. The label's text
  // Range and the label wrapper share one rect; the icon gets its own.
  const mountRow = (display: string, iconRect: DOMRect, textRect: DOMRect): Element => {
    document.body.innerHTML =
      `<div style="display:${display};line-height:20px;font-size:16px;align-items:center">` +
      '<img style="display:inline">' +
      '<span style="line-height:20px;font-size:16px">Download our Q1 investor letter</span>' +
      '</div>'
    Object.defineProperty(query('img'), 'getBoundingClientRect', {
      configurable: true,
      value: () => iconRect,
    })
    Object.defineProperty(query('span'), 'getBoundingClientRect', {
      configurable: true,
      value: () => textRect,
    })
    vi.spyOn(
      Object.getPrototypeOf(document.createRange()),
      'getBoundingClientRect',
    ).mockReturnValue(textRect)
    return query('div')
  }

  afterEach(() => vi.restoreAllMocks())

  it('folds a glyph-sized icon into an adjacent label in a FLEX row', () => {
    // The dogfood "⬇ Download our Q1 investor letter" case: align-items:center flex
    // row, gap ~4px. The icon and label collapse to ONE text-line bar.
    const kids = capture([mountRow('flex', rect(0, 0, 18, 18), rect(22, 0, 200, 18))], {
      name: 'x',
    }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(1)
    expect(kids?.[0]?.leaf).toBe('text-line')
  })

  it('folds in a GRID row too — the parent display does not gate the fold', () => {
    const kids = capture([mountRow('grid', rect(0, 0, 18, 18), rect(22, 0, 200, 18))], {
      name: 'x',
    }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(1)
    expect(kids?.[0]?.leaf).toBe('text-line')
  })

  it('keeps a taller-than-text icon in a flex row as its own media bone', () => {
    const kids = capture([mountRow('flex', rect(0, 0, 18, 40), rect(22, 0, 200, 18))], {
      name: 'x',
    }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.some((k) => k.leaf === 'media')).toBe(true)
  })

  it('keeps a gutter-gapped icon in a flex row as its own media bone', () => {
    // 62px gap (label left 80 − icon right 18) is a layout gutter, not a space.
    const kids = capture([mountRow('flex', rect(0, 0, 18, 18), rect(80, 0, 200, 18))], {
      name: 'x',
    }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.some((k) => k.leaf === 'media')).toBe(true)
  })

  it('does NOT fold two text labels in a flex row — only a glyph icon folds', () => {
    // Two adjacent same-row text labels (`Total` `Payouts`): geometry alone would
    // pass, but the fold needs a MEDIA icon, so they stay two distinct Bones.
    document.body.innerHTML =
      '<div style="display:flex;line-height:20px;font-size:16px">' +
      '<span style="line-height:20px;font-size:16px">Total</span>' +
      '<span style="line-height:20px;font-size:16px">Payouts</span>' +
      '</div>'
    const spans = query('div').children
    Object.defineProperty(spans[0], 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 40, 18),
    })
    Object.defineProperty(spans[1], 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(44, 0, 60, 18),
    })
    vi.spyOn(
      Object.getPrototypeOf(document.createRange()),
      'getBoundingClientRect',
    ).mockReturnValue(rect(0, 0, 40, 18))
    const kids = capture([query('div')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
  })
})

describe('An inline wrapper with a block/inline-block descendant is not folded (ADR 0021)', () => {
  it('keeps an inline-block badge inside an inline link as its own bone', () => {
    // Without the descendant check `collectInlineText` would flatten the badge
    // into the "label" run; the badge is an atomic box and must stay separate.
    document.body.innerHTML =
      '<p>label <a style="display:inline"><span style="display:inline-block">badge</span></a></p>'
    const kids = capture([query('p')], { name: 'x' }).tree?.kids?.[0]?.kids
    expect(kids).toHaveLength(2)
    expect(kids?.[1]?.leaf).toBeUndefined() // the <a> is walked as a branch, not folded into a leaf
  })
})

describe('Single-line bone never exceeds its line box (overshoot fix, ADR 0021)', () => {
  afterEach(() => vi.restoreAllMocks())
  it('caps a single-line text bone at the line-height when its glyph box is taller', () => {
    // A tight line-height (20) with a taller glyph box (27): the bone must cap at
    // 20 so its inline-block can't grow the line box and drift content down a
    // pixel or two per row (it accumulates down a column).
    document.body.innerHTML = '<p style="line-height:20px;font-size:18px">Heading</p>'
    Object.defineProperty(query('p'), 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(0, 0, 80, 27),
    })
    vi.spyOn(
      Object.getPrototypeOf(document.createRange()),
      'getBoundingClientRect',
    ).mockReturnValue(rect(0, 0, 50, 27))
    const { css } = capture([query('p')], { name: 'x' })
    expect(css).not.toContain('27px') // the taller glyph height is capped away
  })
})
