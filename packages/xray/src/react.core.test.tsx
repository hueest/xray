// @vitest-environment happy-dom
import { type ReactNode, act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  collectStitchNames,
  isStitchLive,
  markStitchesLive,
  renderPlate,
  useSkeletonTiming,
} from './react.core.tsx'
import { PLATE_VERSION, type Plate } from './plate.ts'
import { serializePlate } from './chunk.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function render(ui: ReactNode) {
  act(() => root.render(ui))
}

/**
 * Stub getComputedStyle so the hook reads deterministic `--xr-skeleton-*` tokens off the boundary
 * element (open Q4: the read works regardless of display:contents; here we simply return fixed
 * values). Returning `''` exercises the empty-read default path.
 */
function mockComputedStyle(tokens: Record<string, string>) {
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
    () =>
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a stub CSSStyleDeclaration; only getPropertyValue is read
      ({
        getPropertyValue: (prop: string) => tokens[prop] ?? '',
      }) as unknown as CSSStyleDeclaration,
  )
}

/** Mounts the hook against a real element and reports `showSkeleton` per render. */
function Probe({ loading, onRender }: { loading: boolean; onRender: (show: boolean) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const show = useSkeletonTiming(loading, ref)
  onRender(show)
  return <div ref={ref} data-testid="boundary" />
}

/**
 * Like Probe but never attaches the ref to a node — models a no-capture plate that only rendered a
 * fallback, so the hook sees `ref.current === null`.
 */
function NoRootProbe({
  loading,
  onRender,
}: {
  loading: boolean
  onRender: (show: boolean) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  onRender(useSkeletonTiming(loading, ref))
  return null
}

describe('useSkeletonTiming (ADR 0016 min-duration hold)', () => {
  it('shows the skeleton while loading', () => {
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()
    render(<Probe loading onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(true)
  })

  it('swaps synchronously (no timer) when min-duration resolves to 0', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '0ms' })
    const onRender = vi.fn()

    render(<Probe loading onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(true)

    act(() => render(<Probe loading={false} onRender={onRender} />))
    // min-duration 0 → swap now, no timer armed.
    expect(onRender).toHaveBeenLastCalledWith(false)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('swaps immediately when content arrives inside the grace delay (skeleton never seen)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    // Loading starts at t0 = 0; the skeleton mounts invisible (BASE_CSS reveals
    // it only at t0 + 250ms).
    render(<Probe loading onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(true)

    // Content arrives at 100ms — still inside the invisible grace window, so no
    // visible-time floor is owed: swap now, no timer, skeleton never seen.
    vi.setSystemTime(100)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(false)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('holds a skeleton that became visible until t0 + delay + min-duration, then swaps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    // Loading starts at t0 = 0.
    render(<Probe loading onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(true)

    // Content arrives at 400ms — past the 250ms delay, so the skeleton is on
    // screen and owes the min-duration floor; the hook must hold.
    vi.setSystemTime(400)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(true)

    // Still held just before t0 + 250 + 600 = 850ms.
    act(() => {
      vi.advanceTimersByTime(849 - 400)
    })
    expect(onRender).toHaveBeenLastCalledWith(true)

    // Floor reached → swap.
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onRender).toHaveBeenLastCalledWith(false)
  })

  it('swaps immediately when content arrives after the min-duration window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    render(<Probe loading onRender={onRender} />)
    // Content arrives at 2000ms, well past the 850ms floor.
    vi.setSystemTime(2000)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(false)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('falls back to the CSS defaults when the tokens read empty', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    // Empty reads → defaults: delay 250ms + min-duration 600ms = hold to 850ms.
    mockComputedStyle({})
    const onRender = vi.fn()

    render(<Probe loading onRender={onRender} />)
    // Resolve past the default delay so the skeleton was visible and owes the floor.
    vi.setSystemTime(300)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(true)
    act(() => {
      vi.advanceTimersByTime(849 - 300)
    })
    expect(onRender).toHaveBeenLastCalledWith(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onRender).toHaveBeenLastCalledWith(false)
  })

  it('clears the pending hold timer on unmount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    render(<Probe loading onRender={onRender} />)
    // Resolve past the delay so a hold timer is actually armed.
    vi.setSystemTime(400)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    // A hold timer is armed; unmounting must clear it.
    act(() => root.unmount())
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('shows the skeleton synchronously on a loading false→true restart (no content frame)', () => {
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    // Ready first: skeleton hidden (no loading episode ran → no hold).
    render(<Probe loading={false} onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(false)

    // Loading restarts. The hook must return true on THIS render — synchronously,
    // via the `loading` term — not one commit later after an effect flips state.
    // Capturing every value proves no `false` was rendered between flips.
    onRender.mockClear()
    act(() => render(<Probe loading onRender={onRender} />))
    expect(onRender).toHaveBeenCalled()
    for (const call of onRender.mock.calls) expect(call[0]).toBe(true)
  })

  it('swaps immediately with no hold when there is no skeleton root (ref null)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    mockComputedStyle({ '--xr-skeleton-delay': '250ms', '--xr-skeleton-min-duration': '600ms' })
    const onRender = vi.fn()

    // NoRootProbe (module scope) never attaches its ref to a node — models a
    // no-capture plate that only ever rendered a fallback, so no skeleton root
    // exists to hold.
    render(<NoRootProbe loading onRender={onRender} />)
    expect(onRender).toHaveBeenLastCalledWith(true)
    // Data ready: with no root element, swap NOW — no ~850ms hold over blank UI.
    act(() => render(<NoRootProbe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(false)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('parses seconds as well as milliseconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    mockComputedStyle({ '--xr-skeleton-delay': '0s', '--xr-skeleton-min-duration': '1s' })
    const onRender = vi.fn()

    render(<Probe loading onRender={onRender} />)
    act(() => render(<Probe loading={false} onRender={onRender} />))
    expect(onRender).toHaveBeenLastCalledWith(true)
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(onRender).toHaveBeenLastCalledWith(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onRender).toHaveBeenLastCalledWith(false)
  })
})

// The disposer defers its decrement to a microtask (so a same-task continuation
// still reads the stitch live); drain the queue before asserting it cleared.
const flushMicrotasks = () => Promise.resolve()

describe('live-stitch registry (ADR 0020)', () => {
  it('marks and unmarks a stitch name, ref-counted', async () => {
    expect(isStitchLive('child')).toBe(false)
    const dispose = markStitchesLive(['child'])
    expect(isStitchLive('child')).toBe(true)
    dispose()
    await flushMicrotasks()
    expect(isStitchLive('child')).toBe(false)
  })

  it('defers the unmark to a microtask so a same-task continuation still reads it live', async () => {
    const dispose = markStitchesLive(['child'])
    dispose()
    // Synchronously within the same task the entry is STILL live: a continuation
    // that flips `loading` a tick after the parent resolves (a mount effect, not
    // the same commit) reads it before the deferred decrement runs (ADR 0020).
    expect(isStitchLive('child')).toBe(true)
    await flushMicrotasks()
    // Once the task's microtask queue drains, the entry is gone — it cannot keep a
    // name live into a later macrotask (a tab, a network-paced mount).
    expect(isStitchLive('child')).toBe(false)
  })

  it('ref-counts concurrent marks of the same name (stays live until every disposer runs)', async () => {
    const a = markStitchesLive(['child'])
    const b = markStitchesLive(['child'])
    expect(isStitchLive('child')).toBe(true)
    a()
    await flushMicrotasks()
    // One showing parent unmarked, another still shows the stitch → still live.
    expect(isStitchLive('child')).toBe(true)
    b()
    await flushMicrotasks()
    expect(isStitchLive('child')).toBe(false)
  })

  it('handles several names per mark independently', async () => {
    const dispose = markStitchesLive(['a', 'b'])
    expect(isStitchLive('a')).toBe(true)
    expect(isStitchLive('b')).toBe(true)
    expect(isStitchLive('c')).toBe(false)
    dispose()
    await flushMicrotasks()
    expect(isStitchLive('a')).toBe(false)
    expect(isStitchLive('b')).toBe(false)
  })

  it('an extra disposer call does not drive the count negative or revive a name', async () => {
    const dispose = markStitchesLive(['child'])
    dispose()
    dispose()
    await flushMicrotasks()
    expect(isStitchLive('child')).toBe(false)
    // A fresh mark after over-disposing must still register cleanly (count starts at 0).
    const again = markStitchesLive(['child'])
    expect(isStitchLive('child')).toBe(true)
    again()
    await flushMicrotasks()
    expect(isStitchLive('child')).toBe(false)
  })
})

describe('collectStitchNames (ADR 0020)', () => {
  it('returns [] for a stitch-free plate', () => {
    const plate: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'leaf-only',
      tree: { kids: [{ leaf: 'text-line' }] },
      css: '',
    })
    expect(collectStitchNames(plate.chunks)).toEqual([])
  })

  it('collects a direct stitch name', () => {
    const plate: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'parent',
      tree: { kids: [{ leaf: 'text-line' }, { ref: 'child' }] },
      css: '',
    })
    expect(collectStitchNames(plate.chunks)).toEqual(['child'])
  })

  it('recurses a stitch-bearing element to find nested stitch names', () => {
    // A `{ c, k }` chunk (a real element kept around a deeper stitch): the helper
    // recurses its kids so the stitch is still collected.
    const plate: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'parent',
      tree: { kids: [{ cls: 'xr-wrap', kids: [{ ref: 'child' }] }] },
      css: '.xr-wrap { display: flex }',
    })
    expect(collectStitchNames(plate.chunks)).toEqual(['child'])
  })

  it('returns [] for null chunks (uncaptured plate)', () => {
    expect(collectStitchNames(null)).toEqual([])
  })
})

describe('renderPlate (Phase 2 template chunk)', () => {
  it('expands a { t, n } template chunk to n copies of the cell', () => {
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'feed',
      chunks: [{ t: '<div class="xr-node xr-leaf xr-leaf-box xr-feed-1"></div>', n: 3 }],
    }
    render(renderPlate(plate, () => null, false))
    // The cell HTML is injected `n` times as one display:contents island.
    expect(container.querySelectorAll('.xr-feed-1')).toHaveLength(3)
  })
})

// Two-artifact contract (plan 005 round 2): a `Plate` is tree-only and
// `renderPlate` neither reads css off it nor imports BASE_CSS (keeping the
// constant out of consumer bundles). Styling comes either from Vite's CSS
// pipeline (plugin plates — no inline `<style>` at all) or from the optional
// explicit `css` parameter (a runtime-captured `core.ts` plate, whose consumer
// composes `composeCss(css)` and passes it down via `<Skeleton css>`).
describe('renderPlate: the explicit css parameter', () => {
  it('emits NO <style> when no css is passed (plugin plates — the default)', () => {
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'my-banner',
      chunks: ['<div class="xr-node xr-leaf xr-leaf-text-line xr-my-banner-1"></div>'],
    }
    render(renderPlate(plate, () => null, false))
    expect(container.querySelector('style')).toBeNull()
    // The chunk content itself still renders.
    expect(container.querySelector('.xr-my-banner-1')).not.toBeNull()
  })

  it('emits NO <style> for a stitched plate when no css is passed', () => {
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'dashboard',
      chunks: [{ c: 'xr-node xr-wrap', k: [{ r: 'child' }] }],
    }
    render(renderPlate(plate, () => null, false))
    expect(container.querySelector('style')).toBeNull()
  })

  it('injects exactly the passed css on a stitch-free plate (vanilla-core path)', () => {
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'my-banner',
      chunks: ['<div class="xr-node xr-leaf xr-leaf-text-line xr-my-banner-1"></div>'],
    }
    const css = '@keyframes xr-pulse {} [data-xr-root] .xr-my-banner-1 { width: 10px }'
    render(renderPlate(plate, () => null, false, undefined, undefined, css))
    const style = container.querySelector('style')
    expect(style?.textContent).toContain('width: 10px')
    expect(style?.textContent).toContain('@keyframes xr-pulse')
    expect(container.querySelector('.xr-my-banner-1')).not.toBeNull()
  })

  it('injects the passed css on a stitched plate too', () => {
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'dashboard',
      chunks: [{ c: 'xr-node xr-wrap', k: [{ r: 'child' }] }],
    }
    render(renderPlate(plate, () => null, false, undefined, undefined, '.xr-wrap { gap: 4px }'))
    expect(container.querySelector('style')?.textContent).toContain('gap: 4px')
  })

  it('neutralizes a </style> break-out in the css on the raw-string path', () => {
    // The stitch-free path interpolates css into a raw dangerouslySetInnerHTML
    // string; a `</style>` in consumer-passed css must not escape into markup.
    const plate: Plate = {
      v: PLATE_VERSION,
      name: 'evil',
      chunks: ['<div class="xr-node xr-leaf xr-leaf-text-line"></div>'],
    }
    const evil = '.x { width: 1px }</style><img src=x onerror="globalThis.__xrPwned=1">'
    render(renderPlate(plate, () => null, false, undefined, undefined, evil))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('style')?.textContent).toContain('width: 1px')
  })
})
