// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { PLATE_VERSION, type Plate, composeCss } from './plate.ts'
import { serializePlate } from './chunk.ts'
import { renderPlateHtml } from './core.ts'

// Two-artifact contract (plan 005 round 2): `renderPlateHtml(plate, css)`
// receives the css explicitly — the standard composition is
// `composeCss(css)` (BASE_CSS + the plate's rules); the caller owns it.
describe('renderPlateHtml', () => {
  const plateCss = '[data-xr-root] .xr-flex { display: flex }'
  const plate: Plate = serializePlate({
    v: PLATE_VERSION,
    name: 'my-banner',
    tree: { kids: [{ cls: 'xr-flex', kids: [{ leaf: 'text-line' }] }] },
    css: plateCss,
  })

  it('renders a stitch-free plate to a <style> + markup string with the given css', () => {
    const html = renderPlateHtml(plate, composeCss(plateCss))
    expect(html).toContain('data-xr-root="my-banner"')
    expect(html).toContain('display: flex')
    // The standard composition carries BASE_CSS (bones paint + pulse).
    expect(html).toContain('@keyframes xr-pulse')
  })

  it('injects exactly the css the caller passes — composition is the caller’s decision', () => {
    // Raw plate css only (e.g. base rules already on the page): no BASE_CSS.
    const html = renderPlateHtml(plate, plateCss)
    expect(html).toContain('display: flex')
    expect(html).not.toContain('@keyframes xr-pulse')
  })

  it('returns an empty string for an uncaptured plate', () => {
    const bare = serializePlate({ v: PLATE_VERSION, name: 'x', tree: null, css: '' })
    expect(renderPlateHtml(bare, composeCss(''))).toBe('')
  })

  it('neutralizes a </style> raw-text break-out in a corrupt css input', () => {
    // The HTML string lands inside a real document; a `</style>` in the untrusted
    // css must not close the style element and inject the trailing markup.
    const evil: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'evil',
      tree: { kids: [{ leaf: 'text-line' }] },
      css: '',
    })
    const evilCss = '.x { width: 1px }</style><img src=x onerror="globalThis.__xrPwned=1">'
    const host = document.createElement('div')
    host.innerHTML = renderPlateHtml(evil, composeCss(evilCss))
    document.body.append(host)
    try {
      // No <img> escaped the <style> into the live DOM.
      expect(host.querySelector('img')).toBeNull()
      // The style content (including the literal terminator text) stayed put.
      const styleText = host.querySelector('style')?.textContent ?? ''
      expect(styleText).toContain('width: 1px')
    } finally {
      host.remove()
    }
  })

  it('expands a templated (count) node, repeating its cell N times', () => {
    const feed: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'feed',
      tree: { kids: [{ count: 3, cls: 'xr-cell', kids: [{ leaf: 'text-line', cls: 'xr-b' }] }] },
      css: '',
    })
    const html = renderPlateHtml(feed, composeCss(''))
    expect(html).toContain('data-xr-root="feed"')
    // One template cell in the plate, rendered as N cells in the markup.
    expect((html.match(/xr-cell/g) ?? []).length).toBe(3)
  })

  it('renders a stitch-free wrapper around a templated run', () => {
    // A layout wrapper holding a feed serializes to { c, k: [{ t, n }] }; the
    // framework-neutral renderer must recurse into it, not throw.
    const wrapped: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'wrapped',
      tree: {
        kids: [
          {
            cls: 'xr-wrap',
            kids: [{ count: 2, cls: 'xr-cell', kids: [{ leaf: 'box', cls: 'xr-b' }] }],
          },
        ],
      },
      css: '',
    })
    const html = renderPlateHtml(wrapped, composeCss(''))
    expect(html).toContain('xr-wrap')
    expect((html.match(/xr-cell/g) ?? []).length).toBe(2)
  })

  it('still throws on a stitched plate — that needs a framework adapter', () => {
    const stitched: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'stitched',
      tree: { kids: [{ ref: 'child' }] },
      css: '',
    })
    expect(() => renderPlateHtml(stitched, composeCss(''))).toThrow(/framework adapter/)
  })
})
