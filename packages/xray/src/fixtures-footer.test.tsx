// @vitest-environment happy-dom
/**
 * End-to-end pins for the fixtures-footer stability contract: REAL client (installXrayClient), REAL
 * dev adapter (react.dev), REAL HUD (installXrayHud), on the dogfood shape that first showed the
 * jump — a render-prop Skeleton mounted inside a parent Skeleton's content. Under global Light Box
 * the parent's content unmounts, taking the child's React component (and its site registration)
 * with it; the footer must survive on the recorded fixture, whatever the row lists show.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'

import { PLATE_VERSION, type Plate } from './plate.ts'
import { serializePlate } from './chunk.ts'
import { installXrayClient } from './client.ts'
import { installXrayHud, type HudHandle } from './hud.tsx'
import { Skeleton as DevSkeleton } from './react.dev.tsx'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

const childPlate: Plate = serializePlate({
  v: PLATE_VERSION,
  name: 'news-feed',
  tree: { kids: [{ leaf: 'box' }] },
  css: '',
})
const parentPlate: Plate = {
  ...serializePlate({
    v: PLATE_VERSION,
    name: 'offerings-dashboard',
    tree: { kids: [{ ref: 'news-feed' }] },
    css: '',
  }),
  refs: { 'news-feed': childPlate },
}

function shadow(): ShadowRoot {
  const host = document.querySelector('[data-xray-hud]')
  assert(host?.shadowRoot, 'expected the HUD host with a shadow root')
  return host.shadowRoot
}

function App({ parent }: { parent: Plate }) {
  return (
    <DevSkeleton plate={parent} loading={false}>
      <section>
        <DevSkeleton plate={childPlate} loading={false} data={{ items: [1, 2] }}>
          {({ data }) => <p>{data.items.length} items</p>}
        </DevSkeleton>
      </section>
    </DevSkeleton>
  )
}

describe('fixtures footer under Light Box (e2e)', () => {
  let container: HTMLDivElement
  let root: Root | undefined
  let uninstall: (() => void) | undefined
  let hud: HudHandle | undefined

  beforeEach(() => {
    vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
      () =>
        // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a stub CSSStyleDeclaration; only getPropertyValue is read
        ({ getPropertyValue: () => '0ms' }) as unknown as CSSStyleDeclaration,
    )
    container = document.createElement('div')
    document.body.append(container)
    uninstall = installXrayClient({
      sink: () => {},
      recordFixtureSink: async () => {},
    })
    hud = installXrayHud()
  })

  afterEach(() => {
    act(() => root?.unmount())
    hud?.dispose()
    uninstall?.()
    container.remove()
    vi.restoreAllMocks()
    // The toggles are sticky per tab (sessionStorage); a light-boxed test must
    // not leak Light Box into the next install.
    window.sessionStorage.removeItem('xray:lightbox')
    window.sessionStorage.removeItem('xray:capture')
    window.sessionStorage.removeItem('xray:replay')
  })

  async function mountRecordAndOpen(parent: Plate): Promise<void> {
    root = createRoot(container)
    act(() => root?.render(<App parent={parent} />))
    await act(async () => tick())
    const fixtures = globalThis.__XRAY__?.fixtures
    assert(fixtures, 'expected the real fixtures store')
    expect(fixtures.status('news-feed')).toMatchObject({ participates: true, recordable: true })
    await act(async () => fixtures.record('news-feed'))
    await tick()
    const platesLine = shadow().querySelector('.plates-line')
    assert(platesLine instanceof HTMLElement)
    platesLine.click()
    await tick()
    expect(shadow().querySelector('.replay-line')).not.toBeNull()
  }

  async function engageLightbox(): Promise<void> {
    await act(async () => {
      globalThis.__XRAY__?.mode?.setLightbox(true)
      await tick()
    })
    await tick()
  }

  it('keeps the footer (recorded fixture) and the stitch row when Light Box unmounts the participant', async () => {
    await mountRecordAndOpen(parentPlate)
    expect(shadow().querySelector('.key.fx')).not.toBeNull()
    await engageLightbox()
    // Participation drops with the component (nothing mounted to record), but
    // the recorded fixture must keep the footer, and the stitch must keep the
    // row — no jump, no vanish.
    expect(globalThis.__XRAY__?.fixtures?.status('news-feed')).toMatchObject({
      participates: false,
      recorded: true,
    })
    const rows = [...shadow().querySelectorAll('.plate .name')].map((el) => el.textContent)
    expect(rows).toContain('news-feed')
    expect(shadow().querySelector('.replay-line')).not.toBeNull()
  })

  it('replay substitutes the seeded fixture into the render prop', async () => {
    root = createRoot(container)
    act(() => root?.render(<App parent={parentPlate} />))
    await act(async () => tick())
    // The fixtures virtual module seeds LIVE values (ADR 0033).
    act(() => {
      globalThis.__XRAY__?.fixtures?.seed?.({ 'news-feed': { items: [9, 9, 9] } }, true)
    })
    expect(container.textContent).toContain('2 items')
    // Toggle replay on: the render prop must receive the fixture, not live data.
    await act(async () => {
      globalThis.__XRAY__?.replay?.set(true)
      await tick()
    })
    expect(container.textContent).toContain('3 items')
    // A forced re-seed (the HMR path after a hand edit) updates the render live.
    await act(async () => {
      globalThis.__XRAY__?.fixtures?.seed?.({ 'news-feed': { items: [9] } }, true)
      await tick()
    })
    expect(container.textContent).toContain('1 items')
  })

  it('keeps the footer even when the recorded name drops out of every list (orphan)', async () => {
    // The hostile composition: the parent plate does NOT stitch the child (a
    // variant captured without it), and no coverage is seeded. Under Light Box
    // the child unmounts and its name vanishes from rows AND disk — only the
    // store still knows a Fixture exists, and that must be enough.
    const orphanParent: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'offerings-dashboard',
      tree: { kids: [{ leaf: 'box' }] },
      css: '',
    })
    await mountRecordAndOpen(orphanParent)
    await engageLightbox()
    const rows = [...shadow().querySelectorAll('.plate .name')].map((el) => el.textContent)
    expect(rows).not.toContain('news-feed')
    expect(shadow().querySelector('.replay-line')).not.toBeNull()
  })
})
