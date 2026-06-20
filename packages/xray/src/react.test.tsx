// @vitest-environment happy-dom
import { type ComponentType, type ReactNode, Suspense, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, assert, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

// The min-duration hold (ADR 0016) now sits in both adapters. The shared-surface
// tests below assert the un-held swap behavior, so pin min-duration to 0 (the
// synchronous-swap path: no timer, content shows the instant loading flips
// false). happy-dom has no real computed `--xr-skeleton-*` tokens anyway. The
// dedicated "min-duration hold" describe block overrides this with a real value
// to exercise the held path.
function mockSkeletonTokens(minDurationMs: number) {
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(
    () =>
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a stub CSSStyleDeclaration; only getPropertyValue is read
      ({
        getPropertyValue: (prop: string) =>
          prop === '--xr-skeleton-min-duration'
            ? `${minDurationMs}ms`
            : prop === '--xr-skeleton-delay'
              ? '250ms'
              : '',
      }) as unknown as CSSStyleDeclaration,
  )
}

import { PLATE_VERSION, type Plate, composeCss } from './plate.ts'
import { serializePlate } from './chunk.ts'
import { isStitchLive, markStitchesLive } from './react.core.tsx'
import { Skeleton as ProdSkeleton, type SkeletonProps } from './react.tsx'
import { Skeleton as DevSkeleton } from './react.dev.tsx'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const plate: Plate = serializePlate({
  v: PLATE_VERSION,
  name: 'my-banner',
  tree: { kids: [{ cls: 'xr-flex', kids: [{ leaf: 'text-line' }] }] },
  css: '[data-xr-root] .xr-flex { display: flex }',
})

const bare: Plate = serializePlate({ v: PLATE_VERSION, name: 'my-banner', tree: null, css: '' })

function defined<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`missing ${label}`)
  return value
}

const child: Plate = serializePlate({
  v: PLATE_VERSION,
  name: 'news-feed',
  tree: { kids: [{ cls: 'xr-child1', leaf: 'box' }] },
  css: '',
})
const parent: Plate = {
  ...serializePlate({
    v: PLATE_VERSION,
    name: 'dashboard',
    tree: { kids: [{ cls: 'xr-own', leaf: 'text-line' }, { ref: 'news-feed' }] },
    css: '',
  }),
  refs: { 'news-feed': child },
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // Default: synchronous swap (min-duration 0) so loading→false reveals content
  // immediately, matching pre-hold behavior.
  mockSkeletonTokens(0)
})

afterEach(async () => {
  act(() => root.unmount())
  // Unmounting runs every Skeleton's mark cleanup (ADR 0020), but the cleanup defers
  // its decrement to a microtask; drain the queue so the live-stitch registry is
  // back to empty before asserting no entry leaked across tests.
  await Promise.resolve()
  expect(isStitchLive('news-feed')).toBe(false)
  expect(isStitchLive('dashboard')).toBe(false)
  expect(isStitchLive('child')).toBe(false)
  expect(isStitchLive('grandchild')).toBe(false)
  container.remove()
  globalThis.__XRAY__ = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function render(ui: ReactNode) {
  act(() => root.render(ui))
}

// A minimal fake of the dev hook's replay toggle + fixtures store (ADR 0015),
// enough to drive the dev adapter's record/replay seam without the full client.
function installFixtureHook(opts: {
  replayOn?: boolean
  replayMode?: 'prefer' | 'missing-only'
  recordMode?: 'manual' | 'first-ready' | 'always'
  recorded?: Record<string, { data: unknown }>
}): {
  register: Mock<(name: string, data: unknown) => () => void>
  record: Mock<(name: string) => Promise<void>>
  recordAll: Mock<() => Promise<void>>
  recorded: Map<string, { data: unknown }>
  liveData: Map<string, { data: unknown }>
} {
  const recorded = new Map(Object.entries(opts.recorded ?? {}))
  // Mirror the real client's `liveData` registry (client.ts) so the loud-throw
  // contract — `record`/`recordAll` only know names that actually registered —
  // is exercised faithfully: plain-children Skeletons must never register here.
  const liveData = new Map<string, { data: unknown }>()
  const register = vi.fn<(name: string, data: unknown) => () => void>((name, data) => {
    liveData.set(name, { data })
    return () => liveData.delete(name)
  })
  const record = vi.fn<(name: string) => Promise<void>>(async (name) => {
    if (!liveData.has(name)) {
      throw new Error(
        `[xray] cannot record fixture for "${name}": no render-prop \`data\` is in scope.`,
      )
    }
  })
  const recordAll = vi.fn<() => Promise<void>>(async () => {
    await Promise.all([...liveData.keys()].map((name) => record(name)))
  })
  let replayValue = opts.replayOn ?? false
  const listeners = new Set<() => void>()
  globalThis.__XRAY__ = {
    captured: () => undefined,
    replay: {
      get: () => replayValue,
      set: (next: boolean) => {
        replayValue = next
        for (const l of listeners) l()
      },
      subscribe: (onChange: () => void) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
    },
    replayMode: opts.replayMode ?? 'prefer',
    recordMode: opts.recordMode ?? 'manual',
    fixtures: {
      register,
      has: (name: string) => recorded.has(name),
      read: (name: string) => recorded.get(name),
      record,
      recordAll,
      seed: () => {},
      subscribe: (onChange: () => void) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
    },
  }
  return { register, record, recordAll, recorded, liveData }
}

// Rendering is identical for both adapters when no dev client is installed —
// the dev adapter only adds behavior once `__XRAY__` is present. Run the shared
// surface against both so the production adapter is held to the same contract.
describe.each([
  ['production', ProdSkeleton],
  ['dev', DevSkeleton],
] as [string, ComponentType<SkeletonProps>][])('Skeleton (%s)', (_label, Skeleton) => {
  it('renders the plate while loading, children unmounted (no inline <style>)', () => {
    render(
      <Skeleton plate={plate} loading>
        <p id="content">real</p>
      </Skeleton>,
    )
    expect(container.querySelector('#content')).toBeNull()
    const skeletonRoot = container.querySelector('[data-xr-root="my-banner"]')
    expect(skeletonRoot).not.toBeNull()
    expect(skeletonRoot?.getAttribute('aria-hidden')).toBe('true')
    expect(skeletonRoot?.querySelector('.xr-leaf')).not.toBeNull()
    // the leaf carries its kind modifier so text/media/box can be themed apart
    expect(skeletonRoot?.querySelector('.xr-leaf-text-line')).not.toBeNull()
    // Two-artifact contract: a plugin plate carries no css and the adapter
    // injects none — styling is entirely the Vite CSS pipeline's job.
    expect(skeletonRoot?.querySelector('style')).toBeNull()
  })

  it('injects the explicit css prop for a runtime-captured plate (vanilla-core path)', () => {
    // A `core.ts` `captureElement` consumer composes the css themselves
    // (`composeCss(css)`) and hands it to the adapter — the ONE inline-styling
    // path under the two-artifact contract (ADR 0026).
    render(
      <Skeleton plate={plate} css={composeCss('[data-xr-root] .xr-flex { display: flex }')} loading>
        <p id="content">real</p>
      </Skeleton>,
    )
    const skeletonRoot = container.querySelector('[data-xr-root="my-banner"]')
    const styleText = skeletonRoot?.querySelector('style')?.textContent ?? ''
    expect(styleText).toContain('display: flex')
    expect(styleText).toContain('@keyframes xr-pulse')
  })

  it('neutralizes a </style> raw-text break-out in a corrupt css prop', () => {
    // The css prop is consumer input, untrusted at render time. The
    // single-string chunk path interpolates it into a <style> STRING via
    // dangerouslySetInnerHTML, so a `</style>` in the css must not close the
    // element and inject live markup. css-escape.ts breaks the terminator up.
    const evil: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'evil',
      tree: { kids: [{ leaf: 'text-line' }] },
      css: '',
    })
    render(
      <Skeleton
        plate={evil}
        css={'.x { width: 1px }</style><img src=x onerror="globalThis.__xrPwned=1">'}
        loading
      >
        <p>real</p>
      </Skeleton>,
    )
    const skeletonRoot = container.querySelector('[data-xr-root="evil"]')
    // The injected <img> must NOT have escaped into the DOM as a real element.
    expect(skeletonRoot?.querySelector('img')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // The literal terminator text stays inside the <style>, harmless.
    const styleText = skeletonRoot?.querySelector('style')?.textContent ?? ''
    expect(styleText).toContain('width: 1px')
  })

  it('renders the fallback while loading when nothing is captured yet', () => {
    render(
      <Skeleton plate={bare} loading fallback={<span id="spin" />}>
        <p id="content">real</p>
      </Skeleton>,
    )
    expect(container.querySelector('#spin')).not.toBeNull()
    expect(container.querySelector('#content')).toBeNull()
    expect(container.querySelector('[data-xr-root]')).toBeNull()
  })

  it('renders children bare once ready (no dev client installed)', () => {
    render(
      <Skeleton plate={plate} loading={false}>
        <p id="content">real</p>
      </Skeleton>,
    )
    expect(container.querySelector('#content')).not.toBeNull()
    expect(container.querySelector('[data-xr-root]')).toBeNull()
    // No dev client → no capture wrapper at all.
    expect(container.querySelector('[style]')).toBeNull()
  })

  it('acts as a suspense boundary when opted in', () => {
    render(
      <Skeleton plate={plate} suspense>
        <p id="content">real</p>
      </Skeleton>,
    )
    expect(container.querySelector('#content')).not.toBeNull()
  })

  it('shows the skeleton as the suspense fallback while suspended', async () => {
    let resolve!: () => void
    const gate = new Promise<void>((r) => {
      resolve = r
    })
    let ready = false
    function Suspends() {
      if (!ready) throw gate
      return <p id="content">real</p>
    }
    render(
      <Suspense>
        <Skeleton plate={plate} suspense>
          <Suspends />
        </Skeleton>
      </Suspense>,
    )
    expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
    expect(container.querySelector('#content')).toBeNull()

    ready = true
    resolve()
    await act(async () => {
      await gate
    })
    expect(container.querySelector('#content')).not.toBeNull()
    expect(container.querySelector('[data-xr-root]')).toBeNull()
  })

  it('shows the skeleton while loading even in suspense mode — loading gates mount (ADR 0002 amended)', () => {
    render(
      <Skeleton plate={plate} suspense loading>
        <p id="content">real</p>
      </Skeleton>,
    )
    // `loading` and `suspense` are orthogonal and compose: `loading` gates whether
    // the children MOUNT, so the skeleton shows and the children never render even
    // with suspense opted in. (Before the amendment, suspense mode dropped `loading`
    // and mounted the children — the data-loading skeleton never showed for a
    // non-suspending data layer.)
    expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
    expect(container.querySelector('#content')).toBeNull()
  })

  it('renders children in suspense mode once loading is false', () => {
    render(
      <Skeleton plate={plate} suspense loading={false}>
        <p id="content">real</p>
      </Skeleton>,
    )
    expect(container.querySelector('#content')).not.toBeNull()
  })

  it('keeps the plate as ONE Suspense fallback across the data-loading phase and a suspending child (no remount flicker)', async () => {
    let resolve!: () => void
    const gate = new Promise<void>((r) => {
      resolve = r
    })
    let ready = false
    function LazyChild() {
      if (!ready) throw gate
      return <p id="content">real</p>
    }

    // Data phase: `loading` makes the internal suspender throw → the plate shows as
    // the Suspense fallback; the child is never committed.
    render(
      <Skeleton plate={plate} suspense loading>
        <LazyChild />
      </Skeleton>,
    )
    expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
    expect(container.querySelector('#content')).toBeNull()

    // Chunk phase: data is ready (loading=false) but the child still suspends. The
    // SAME Suspense fallback (the plate) keeps showing — the old code would have
    // remounted here (top-level skeleton -> Suspense-fallback skeleton).
    render(
      <Skeleton plate={plate} suspense loading={false}>
        <LazyChild />
      </Skeleton>,
    )
    expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
    expect(container.querySelector('#content')).toBeNull()

    // Child resolves → content, plate gone.
    ready = true
    resolve()
    await act(async () => {
      await gate
    })
    expect(container.querySelector('#content')).not.toBeNull()
    expect(container.querySelector('[data-xr-root]')).toBeNull()
  })

  it('mounts the referenced child plate at a stitch (static refs)', () => {
    render(<Skeleton plate={parent} loading />)
    // The parent's own leaf renders…
    expect(container.querySelector('[data-xr-root="dashboard"] .xr-own')).not.toBeNull()
    // …and the stitch mounts the child plate's own root + leaf.
    const childRoot = container.querySelector('[data-xr-root="news-feed"]')
    expect(childRoot).not.toBeNull()
    expect(childRoot?.querySelector('.xr-child1')).not.toBeNull()
  })

  it('emits no <style> anywhere in a stitched tree (styling is the CSS pipeline’s job)', () => {
    // Two-artifact contract: plates are tree-only, so neither the parent nor
    // the stitched child injects any inline css — BASE_CSS + plate rules reach
    // the page via `virtual:xray/base.css` / `virtual:xray/plates/<name>.css`
    // (deduped by module identity: that is the once-per-page mechanism now).
    render(<Skeleton plate={parent} loading />)
    expect(container.querySelectorAll('style')).toHaveLength(0)
  })

  it('the css prop styles the OUTERMOST root only, never a nested stitch', () => {
    render(<Skeleton plate={parent} css={composeCss('')} loading />)
    const styles = Array.from(container.querySelectorAll('style'))
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toContain('@keyframes xr-pulse')
    const childRoot = container.querySelector('[data-xr-root="news-feed"]')
    expect(childRoot?.querySelector('style')).toBeNull()
  })

  it('renders nothing at a stitch whose child plate is missing', () => {
    const orphan: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'dashboard',
      tree: { kids: [{ ref: 'never-captured' }] },
      css: '',
    })
    render(<Skeleton plate={orphan} loading />)
    expect(container.querySelector('[data-xr-root="dashboard"]')).not.toBeNull()
    expect(container.querySelector('[data-xr-root="never-captured"]')).toBeNull()
  })
})

describe('Skeleton (dev) — capture', () => {
  it('notifies the capture hook when content becomes ready, and disposes on unmount', () => {
    const dispose = vi.fn()
    const captured = vi.fn<(name: string, el: Element, opts?: { delay?: number }) => () => void>(
      () => dispose,
    )
    globalThis.__XRAY__ = { captured }

    render(
      <DevSkeleton plate={plate} loading>
        <p>real</p>
      </DevSkeleton>,
    )
    expect(captured).not.toHaveBeenCalled()

    render(
      <DevSkeleton plate={plate} loading={false} delay={50}>
        <p>real</p>
      </DevSkeleton>,
    )
    expect(captured).toHaveBeenCalledTimes(1)
    const [name, el, opts] = defined(captured.mock.calls[0], 'capture call')
    expect(name).toBe('my-banner')
    expect(el.querySelector('p')).not.toBeNull()
    expect(opts?.delay).toBe(50)

    render(<div />)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('does not capture in production (no Content wrapper, ignores the hook)', () => {
    const captured = vi.fn(() => undefined)
    globalThis.__XRAY__ = { captured }
    render(
      <ProdSkeleton plate={plate} loading={false}>
        <p id="content">real</p>
      </ProdSkeleton>,
    )
    expect(container.querySelector('#content')).not.toBeNull()
    expect(captured).not.toHaveBeenCalled()
    expect(container.querySelector('[data-xr-boundary]')).toBeNull()
  })
})

// The additive render-prop children form: `({ data, ref }) => ReactNode`, called
// at loading=false with `data` passed through verbatim (ADR 0014). `data` and the
// plain-children path are shared by both adapters.
describe.each([
  ['production', ProdSkeleton],
  ['dev', DevSkeleton],
] as [string, ComponentType<SkeletonProps<unknown>>][])(
  'Skeleton render-prop data (%s)',
  (_label, Skeleton) => {
    it('calls the render prop with the verbatim data once ready', () => {
      render(
        <Skeleton plate={plate} loading={false} data={{ id: 7 }}>
          {({ data }) => <p id="content">{JSON.stringify(data)}</p>}
        </Skeleton>,
      )
      expect(container.querySelector('#content')?.textContent).toBe('{"id":7}')
    })

    it('passes null data through (data presence is not folded into readiness)', () => {
      render(
        <Skeleton plate={plate} loading={false} data={null}>
          {({ data }) => <p id="content">{data === null ? 'null' : 'other'}</p>}
        </Skeleton>,
      )
      expect(container.querySelector('#content')?.textContent).toBe('null')
    })

    it('does not call the render prop while loading', () => {
      const fn = vi.fn(() => <p id="content">real</p>)
      render(
        <Skeleton plate={plate} loading data={1}>
          {fn}
        </Skeleton>,
      )
      expect(fn).not.toHaveBeenCalled()
      expect(container.querySelector('#content')).toBeNull()
    })
  },
)

describe('Skeleton render-prop (dev, root="manual")', () => {
  it('writes the boundary marker onto the consumer element and registers it as the capture root', () => {
    const dispose = vi.fn()
    const captured = vi.fn<(name: string, el: Element, opts?: { delay?: number }) => () => void>(
      () => dispose,
    )
    globalThis.__XRAY__ = { captured }

    render(
      <DevSkeleton plate={plate} root="manual" loading={false} delay={20} data={{ id: 9 }}>
        {({ data, ref }) => (
          <section id="content" ref={ref}>
            {data.id}
          </section>
        )}
      </DevSkeleton>,
    )

    const host = container.querySelector('#content')
    assert(host, 'render-prop content should mount')
    // No display:contents wrapper — the consumer's element carries the marker.
    expect(host.getAttribute('data-xr-boundary')).toBe('my-banner')
    expect(container.querySelector('div[style]')).toBeNull()
    expect(captured).toHaveBeenCalledTimes(1)
    const call = captured.mock.calls[0]
    assert(call, 'capture call should be recorded')
    const [name, el, opts] = call
    expect(name).toBe('my-banner')
    expect(el).toBe(host)
    expect(opts?.delay).toBe(20)

    render(<div />)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('console.errors when the ref is never spread (capture would leak into the parent)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const captured = vi.fn(() => undefined)
    globalThis.__XRAY__ = { captured }

    render(
      <DevSkeleton plate={plate} root="manual" loading={false}>
        {() => <section id="content">forgot the ref</section>}
      </DevSkeleton>,
    )

    expect(container.querySelector('#content')).not.toBeNull()
    expect(captured).not.toHaveBeenCalled()
    expect(container.querySelector('[data-xr-boundary]')).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    const errCall = spy.mock.calls[0]
    assert(errCall, 'console.error should have been called')
    expect(errCall[0]).toContain('root="manual"')
    expect(errCall[0]).toContain('my-banner')
    spy.mockRestore()
  })

  it('does not error when the ref is correctly spread', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    globalThis.__XRAY__ = { captured: () => undefined }
    render(
      <DevSkeleton plate={plate} root="manual" loading={false}>
        {({ ref }) => <section ref={ref}>ok</section>}
      </DevSkeleton>,
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('Skeleton render-prop (dev, root="auto")', () => {
  it('renders the render-prop result inside the display:contents boundary wrapper', () => {
    const captured = vi.fn(() => undefined)
    globalThis.__XRAY__ = { captured }
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 3 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    // The wrapper still carries the marker; the consumer's element does not.
    const wrapper = container.querySelector<HTMLElement>('[data-xr-boundary="my-banner"]')
    assert(wrapper, 'auto root should keep its display:contents boundary wrapper')
    expect(wrapper.style.display).toBe('contents')
    expect(wrapper.querySelector('#content')?.textContent).toBe('3')
    expect(container.querySelector('#content')?.getAttribute('data-xr-boundary')).toBeNull()
    expect(captured).toHaveBeenCalledTimes(1)
  })

  it('does not capture in production for a render prop, and adds no boundary attr', () => {
    const captured = vi.fn(() => undefined)
    globalThis.__XRAY__ = { captured }
    render(
      <ProdSkeleton plate={plate} loading={false} data={{ id: 1 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </ProdSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('1')
    expect(captured).not.toHaveBeenCalled()
    expect(container.querySelector('[data-xr-boundary]')).toBeNull()
  })
})

describe('Skeleton fixtures (dev, ADR 0015)', () => {
  it('registers the live data for recording at loading=false', () => {
    const { register } = installFixtureHook({})
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 7 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    expect(register).toHaveBeenCalledWith('my-banner', { id: 7 })
    // No auto-record in manual mode.
    expect(container.querySelector('#content')?.textContent).toBe('7')
  })

  it('replays the recorded fixture in place of live data when Replay is on (prefer)', () => {
    installFixtureHook({ replayOn: true, recorded: { 'my-banner': { data: { id: 99 } } } })
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 1 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    // The render prop saw the fixture, not the live data.
    expect(container.querySelector('#content')?.textContent).toBe('99')
  })

  it('does not replay when Replay is off, even with a fixture present', () => {
    installFixtureHook({ replayOn: false, recorded: { 'my-banner': { data: { id: 99 } } } })
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 1 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('1')
  })

  it('missing-only replays only when live data is nullish (missing ≡ nullish)', () => {
    // Present (non-nullish, even empty) → live data wins.
    installFixtureHook({
      replayOn: true,
      replayMode: 'missing-only',
      recorded: { 'my-banner': { data: { id: 99 } } },
    })
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 5 }}>
        {({ data }) => <p id="content">{data?.id ?? 'none'}</p>}
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('5')

    // Nullish live data → fixture fills in.
    installFixtureHook({
      replayOn: true,
      replayMode: 'missing-only',
      recorded: { 'my-banner': { data: { id: 99 } } },
    })
    render(
      <DevSkeleton<{ id: number } | null> plate={plate} loading={false} data={null}>
        {({ data }) => <p id="content">{data?.id ?? 'none'}</p>}
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('99')
  })

  it('auto-records on first-ready only when no fixture exists yet', () => {
    const { record } = installFixtureHook({ recordMode: 'first-ready' })
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 1 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    expect(record).toHaveBeenCalledWith('my-banner')

    // With a fixture already present, first-ready records nothing.
    const second = installFixtureHook({
      recordMode: 'first-ready',
      recorded: { 'my-banner': { data: { id: 1 } } },
    })
    render(
      <DevSkeleton plate={plate} loading={false} data={{ id: 1 }}>
        {({ data }) => <p id="content">{data.id}</p>}
      </DevSkeleton>,
    )
    expect(second.record).not.toHaveBeenCalled()
  })

  it('a plain-children Skeleton never registers, is not recorded, and record() throws loudly', async () => {
    // Only the render-prop form is the `data` seam (ADR 0014/0015). A plain-children
    // Skeleton has no `data`, so it must NOT register: recordAll() writes nothing for
    // it, and record(name) for its never-registered name throws the loud "no
    // render-prop data" error. (Against the unfixed path, useFixtureData registered
    // unconditionally — `{ data: undefined }` — so this name WOULD appear in
    // liveData, recordAll would record it, and the throw would not fire.)
    const { register, recordAll, record, liveData } = installFixtureHook({})
    render(
      <DevSkeleton plate={plate} loading={false}>
        <p id="content">plain</p>
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('plain')
    // Never registered: the live store has no entry for this name.
    expect(register).not.toHaveBeenCalled()
    expect(liveData.has('my-banner')).toBe(false)
    // The HUD "Record fixture" sweep writes nothing for a plain-children Skeleton.
    await recordAll()
    expect(record).not.toHaveBeenCalled()
    // The store contract is restored: recording it by name throws loudly.
    await expect(record('my-banner')).rejects.toThrow(/no render-prop `data` is in scope/)
  })

  it('a render-prop Skeleton with data={undefined} still registers and records', () => {
    // `data={undefined}` is still the render-prop seam: it must participate exactly
    // like any other render prop (register the live `undefined`, auto-record per
    // mode). The gate keys off the children form, NOT off `data !== undefined`.
    const { register, record } = installFixtureHook({ recordMode: 'first-ready' })
    render(
      <DevSkeleton plate={plate} loading={false} data={undefined}>
        {({ data }) => <p id="content">{data === undefined ? 'undef' : 'other'}</p>}
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')?.textContent).toBe('undef')
    expect(register).toHaveBeenCalledWith('my-banner', undefined)
    expect(record).toHaveBeenCalledWith('my-banner')
  })
})

describe('light box (dev toggle)', () => {
  it('renders the skeleton in place of ready content while light box is on, and back', () => {
    let value = false
    const listeners = new Set<() => void>()
    globalThis.__XRAY__ = {
      captured: () => undefined,
      lightbox: {
        get: () => value,
        set: (next: boolean) => {
          value = next
          for (const listener of listeners) listener()
        },
        subscribe: (onChange: () => void) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
      },
    }

    render(
      <DevSkeleton plate={plate} loading={false}>
        <p id="content">real</p>
      </DevSkeleton>,
    )
    expect(container.querySelector('#content')).not.toBeNull()

    act(() => globalThis.__XRAY__?.lightbox?.set(true))
    expect(container.querySelector('#content')).toBeNull()
    expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()

    act(() => globalThis.__XRAY__?.lightbox?.set(false))
    expect(container.querySelector('#content')).not.toBeNull()
    expect(container.querySelector('[data-xr-root]')).toBeNull()
  })
})

describe('live plate store (dev hot-swap without remount)', () => {
  it('renders the store plate over the prop, and updates in place', () => {
    const live = new Map<string, Plate>()
    const listeners = new Map<string, Set<() => void>>()
    globalThis.__XRAY__ = {
      captured: () => undefined,
      plates: {
        get: (name) => live.get(name),
        subscribe: (name, cb) => {
          const set = listeners.get(name) ?? new Set()
          listeners.set(name, set)
          set.add(cb)
          return () => set.delete(cb)
        },
        seed: (name, seeded) => {
          if (!live.has(name)) live.set(name, seeded)
        },
      },
      updatePlate: (name, next) => {
        live.set(name, next)
        for (const cb of listeners.get(name) ?? []) cb()
        return true
      },
    }

    render(
      <DevSkeleton plate={plate} loading>
        <p>real</p>
      </DevSkeleton>,
    )
    // Initially the store is empty → the prop plate renders (its `.xr-flex` node).
    expect(container.querySelector('.xr-flex')).not.toBeNull()
    expect(container.querySelector('.xr-fresh')).toBeNull()

    // A capture lands: the store plate renders in place, no remount.
    const fresh: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'my-banner',
      tree: { kids: [{ cls: 'xr-fresh', leaf: 'box' }] },
      css: '',
    })
    act(() => {
      globalThis.__XRAY__?.updatePlate?.('my-banner', fresh)
    })
    expect(container.querySelector('.xr-fresh')).not.toBeNull()
    expect(container.querySelector('.xr-flex')).toBeNull()
  })
})

function installStore() {
  const live = new Map<string, Plate>()
  const listeners = new Map<string, Set<() => void>>()
  globalThis.__XRAY__ = {
    captured: () => undefined,
    plates: {
      get: (name) => live.get(name),
      subscribe: (name, cb) => {
        const set = listeners.get(name) ?? new Set()
        listeners.set(name, set)
        set.add(cb)
        return () => set.delete(cb)
      },
      seed: (name, seeded) => {
        if (!live.has(name)) live.set(name, seeded)
      },
    },
    updatePlate: (name, next) => {
      live.set(name, next)
      for (const cb of listeners.get(name) ?? []) cb()
      return true
    },
  }
}

describe('stitches — store hot-swap (dev)', () => {
  it('resolves a stitch from the live store (seeded from refs) and hot-swaps it in place', () => {
    installStore()
    render(<DevSkeleton plate={parent} loading />)
    // Seeded from the parent's refs → the child renders even though the store
    // started empty.
    expect(container.querySelector('[data-xr-root="news-feed"] .xr-child1')).not.toBeNull()

    // Re-capturing the child hot-swaps it inside the parent, no remount.
    const freshChild: Plate = serializePlate({
      v: PLATE_VERSION,
      name: 'news-feed',
      tree: { kids: [{ cls: 'xr-child7', leaf: 'media' }] },
      css: '',
    })
    act(() => {
      globalThis.__XRAY__?.updatePlate?.('news-feed', freshChild)
    })
    expect(container.querySelector('[data-xr-root="news-feed"] .xr-child7')).not.toBeNull()
    expect(container.querySelector('[data-xr-root="news-feed"] .xr-child1')).toBeNull()
  })
})

// The min-duration hold (ADR 0016) is wired into BOTH adapters via the shared
// useSkeletonTiming hook. With a real (>0) min-duration the skeleton is held past
// loading=false for the floor window, then the real content swaps in. Run against
// both adapters so prod and dev keep identical timing.
describe.each([
  ['production', ProdSkeleton],
  ['dev', DevSkeleton],
] as [string, ComponentType<SkeletonProps>][])(
  'Skeleton min-duration hold (%s)',
  (_label, Skeleton) => {
    it('holds the skeleton briefly past loading=false, then reveals content', () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      // delay 250ms + min-duration 600ms → hold to 850ms.
      mockSkeletonTokens(600)

      render(
        <Skeleton plate={plate} loading>
          <p id="content">real</p>
        </Skeleton>,
      )
      expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
      expect(container.querySelector('#content')).toBeNull()

      // Content "arrives" at t=400ms — past the 250ms delay, so the skeleton is
      // visible and owes the min-duration floor; still held. (Arriving INSIDE the
      // delay swaps immediately instead — the hook test pins that path.)
      vi.setSystemTime(400)
      act(() => {
        root.render(
          <Skeleton plate={plate} loading={false}>
            <p id="content">real</p>
          </Skeleton>,
        )
      })
      expect(container.querySelector('[data-xr-root="my-banner"]')).not.toBeNull()
      expect(container.querySelector('#content')).toBeNull()

      // Past the 850ms floor → swap to the real content.
      act(() => {
        vi.advanceTimersByTime(850)
      })
      expect(container.querySelector('[data-xr-root="my-banner"]')).toBeNull()
      expect(container.querySelector('#content')).not.toBeNull()
    })
  },
)

// ADR 0020: a standalone <Skeleton> replacing a stitch a still-showing parent was
// just rendering must reveal INSTANTLY (data-xr-instant) so the continuing bones
// do not flash away and back. An independent nested skeleton (never a live stitch)
// keeps the normal delay. Run against both adapters: the registry + the
// register/read live in the shared/prod path, and the attr lands in BASE_CSS.
describe.each([
  ['production', ProdSkeleton],
  ['dev', DevSkeleton],
] as [string, ComponentType<SkeletonProps<unknown>>][])(
  'Skeleton instant reveal — stitch continuation (%s)',
  (_label, Skeleton) => {
    // `parent` stitches `news-feed`; `child` IS the `news-feed` plate. A standalone
    // <Skeleton plate={child}> therefore shares the stitch's name.
    it('marks the re-mounted child root data-xr-instant when it continues a live stitch', () => {
      // Parent is showing its skeleton; its effect marks `news-feed` live.
      render(<Skeleton plate={parent} loading />)
      expect(container.querySelector('[data-xr-root="news-feed"]')).not.toBeNull()
      // …but the stitched child is NESTED, so it carries no data-xr-instant (it
      // inherits the parent reveal). Only an outermost continuation gets the attr.
      expect(
        container.querySelector('[data-xr-root="news-feed"]')?.hasAttribute('data-xr-instant'),
      ).toBe(false)

      // Parent resolves; its content mounts a standalone child Skeleton for the same
      // plate. min-duration is 0 (beforeEach), so the swap is synchronous: the child
      // first-renders and reads the live stitch BEFORE the parent's unmark effect.
      act(() => {
        root.render(
          <Skeleton plate={parent} loading={false}>
            <Skeleton plate={child} loading />
          </Skeleton>,
        )
      })
      const childRoot = container.querySelector('[data-xr-root="news-feed"]')
      expect(childRoot).not.toBeNull()
      // The continuation: an OUTERMOST root carrying data-xr-instant.
      expect(childRoot?.hasAttribute('data-xr-instant')).toBe(true)
    })

    it('does NOT mark an independent nested skeleton (never a live stitch)', () => {
      // A standalone child Skeleton with no parent skeleton ever showing it as a
      // stitch — e.g. behind a tab. Its name was never marked live → normal delay.
      render(<Skeleton plate={child} loading />)
      const childRoot = container.querySelector('[data-xr-root="news-feed"]')
      expect(childRoot).not.toBeNull()
      expect(childRoot?.hasAttribute('data-xr-instant')).toBe(false)
    })

    it('does not mark a never-stitched name (no false positive)', () => {
      // `my-banner` is never a stitch of any showing parent.
      render(<Skeleton plate={plate} loading />)
      const banner = container.querySelector('[data-xr-root="my-banner"]')
      expect(banner?.hasAttribute('data-xr-instant')).toBe(false)
    })

    it('clears the live mark when the parent unmounts, so a LATER-task mount is not instant', async () => {
      render(<Skeleton plate={parent} loading />)
      // Parent gone entirely (not resolved): the unmark cleanup runs.
      act(() => root.render(<div />))
      // The unmark is deferred to a microtask (ADR 0020), so a same-task continuation
      // would still read it live. Drain it to model a genuinely LATER mount (a fresh
      // standalone child seconds later, e.g. behind a tab) — which must NOT be instant.
      await Promise.resolve()
      act(() => root.render(<Skeleton plate={child} loading />))
      expect(
        container.querySelector('[data-xr-root="news-feed"]')?.hasAttribute('data-xr-instant'),
      ).toBe(false)
    })
  },
)

// The cascade (ADR 0020): each level self-registers its DIRECT stitch as it becomes
// a real Skeleton, so a grandchild gets instant when its parent (itself a
// continuation) resolves. Tested on the prod adapter (shared path).
describe('Skeleton instant reveal — cascade (ADR 0020)', () => {
  // grandchild ← child(stitches grandchild) ← parent(stitches child)
  const grandchild: Plate = serializePlate({
    v: PLATE_VERSION,
    name: 'grandchild',
    tree: { kids: [{ cls: 'xr-gc', leaf: 'box' }] },
    css: '',
  })
  const childWithGrand: Plate = {
    ...serializePlate({
      v: PLATE_VERSION,
      name: 'child',
      tree: { kids: [{ leaf: 'text-line' }, { ref: 'grandchild' }] },
      css: '',
    }),
    refs: { grandchild },
  }
  const topParent: Plate = {
    ...serializePlate({
      v: PLATE_VERSION,
      name: 'top',
      tree: { kids: [{ ref: 'child' }] },
      css: '',
    }),
    refs: { child: childWithGrand },
  }

  it('a grandchild gets instant when its (continuation) parent resolves', () => {
    // Top showing: marks `child` live (its direct stitch). The grandchild is a
    // nested stitch two levels down — not directly marked here.
    render(<ProdSkeleton plate={topParent} loading />)

    // Top resolves; content mounts a standalone `child` Skeleton (a continuation),
    // which itself loads with content containing a standalone `grandchild` Skeleton.
    act(() => {
      root.render(
        <ProdSkeleton plate={topParent} loading={false}>
          <ProdSkeleton plate={childWithGrand} loading>
            {null}
          </ProdSkeleton>
        </ProdSkeleton>,
      )
    })
    // The child continuation is instant (it continued top's `child` stitch)…
    const childRoot = container.querySelector('[data-xr-root="child"]')
    expect(childRoot?.hasAttribute('data-xr-instant')).toBe(true)
    // …and while it shows, it marks ITS direct stitch `grandchild` live. Now resolve
    // the child: its content mounts a standalone grandchild Skeleton.
    act(() => {
      root.render(
        <ProdSkeleton plate={topParent} loading={false}>
          <ProdSkeleton plate={childWithGrand} loading={false}>
            <ProdSkeleton plate={grandchild} loading />
          </ProdSkeleton>
        </ProdSkeleton>,
      )
    })
    const gcRoot = container.querySelector('[data-xr-root="grandchild"]')
    expect(gcRoot).not.toBeNull()
    expect(gcRoot?.hasAttribute('data-xr-instant')).toBe(true)
  })
})

// Parity (ADR 0020 constraint): a top-level skeleton with no live-stitch
// continuation renders byte-identically to a baseline with the feature absent —
// i.e. it carries no data-xr-instant and its markup is unchanged.
describe('Skeleton instant reveal — non-instant parity (ADR 0020)', () => {
  it('a plain top-level skeleton root has no data-xr-instant attribute', () => {
    render(<ProdSkeleton plate={plate} loading />)
    const banner = defined(container.querySelector('[data-xr-root="my-banner"]'), 'root')
    expect(banner.hasAttribute('data-xr-instant')).toBe(false)
    // No stray instant marker anywhere in the rendered skeleton.
    expect(container.querySelector('[data-xr-instant]')).toBeNull()
  })

  it('a stitched (nested) child never carries data-xr-instant even under an instant parent', () => {
    // Even when the OUTERMOST root is a continuation, the nested stitch must not get
    // the attr (it inherits the parent reveal; only the outermost root is marked).
    // Force the outermost `dashboard` plate to read as a live stitch so its first
    // render is instant, then assert the marker stays on the outermost root only.
    const dispose = markStitchesLive(['dashboard'])
    render(<ProdSkeleton plate={parent} loading />)
    expect(
      container.querySelector('[data-xr-root="dashboard"]')?.hasAttribute('data-xr-instant'),
    ).toBe(true)
    // The nested news-feed stitch stays clean.
    expect(
      container.querySelector('[data-xr-root="news-feed"]')?.hasAttribute('data-xr-instant'),
    ).toBe(false)
    dispose()
  })
})
