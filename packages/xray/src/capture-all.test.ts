// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, it, vi } from 'vitest'

import type { CaptureEnvelope, ClientOptions } from './client.ts'
import { installXrayClient } from './client.ts'

/**
 * Tests for the capture-all-views orchestration (ADR 0010): the extension ACK protocol, timeout
 * cleanup, reset-in-finally, and in-session sweep widths.
 *
 * The sweep builds ONE PlateIR per site across every emulated width (ADR 0022) and posts ONE
 * projected StoredPlate per site at the END of the sweep (no per-width POST). The backpressure
 * point is that single awaited POST: `reset` does not post until it resolves, and a rejected POST
 * rejects the sweep.
 *
 * The client both posts its `{ source: 'xray', kind, id }` commands and listens for `{ source:
 * 'xray-ext', kind: 'ack', id }` ACKs on the SAME window. happy-dom delivers a real `postMessage`
 * asynchronously, which would make the client's own commands race the test. So we spy on
 * `win.postMessage` to capture each outbound command synchronously and suppress self-delivery, then
 * simulate the extension by dispatching a synthetic `message` MessageEvent (synchronous, `source
 * === window`).
 */

let uninstall: (() => void) | undefined

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
  window.sessionStorage.clear()
})

interface ExtCommand {
  source: string
  kind: string
  id: number
  width?: number
  height?: number
  mobile?: boolean
}

/** Dispatch a synthetic `message` event at this window (synchronous in happy-dom). */
function dispatchMessage(data: unknown, source: Window | null = window): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }))
}

/** Simulate the extension answering a command with a matching `xray-ext` ACK. */
function ackCommand(id: number, res: { ok?: boolean; error?: string } = { ok: true }): void {
  dispatchMessage({ source: 'xray-ext', kind: 'ack', id, ...res })
}

/** Collect the emulate widths in the order the sweep posted them. */
function emulateWidths(commands: ExtCommand[]): number[] {
  return commands.filter((c) => c.kind === 'emulate').map((c) => c.width ?? Number.NaN)
}

/** The single `reset` command, asserted present (it posts in the sweep's finally). */
function resetCommand(commands: ExtCommand[]): ExtCommand {
  const reset = commands.find((c) => c.kind === 'reset')
  assert(reset, 'expected a reset command to have been posted')
  return reset
}

/** The first posted command, asserted present. */
function firstCommand(commands: ExtCommand[]): ExtCommand {
  const [first] = commands
  assert(first, 'expected at least one posted command')
  return first
}

/** Register a mounted site (a `<Skeleton>`) with the dev client by name. */
function mountSite(name: string): void {
  const id = `site-${name}`
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="${id}" style="display: contents"><div><p>x</p></div></div>`,
  )
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  globalThis.__XRAY__?.captured(name, el)
}

/**
 * Mount a site whose markup is governed by CSS-only `@media` rules: no `matchMedia`, no coverage —
 * the breakpoints exist ONLY as author `@media` blocks carrying a LAYOUT decl (padding survives
 * `filterLayoutDecls`; paint is dropped). The `<style>` is a child of the wrapper (filtered out of
 * the capture roots, and torn down with `document.body` in afterEach). Each `@media` block targets
 * a `<p>` under the wrapper so its lifted rule carries the threshold into the captured View.
 */
function mountCssResponsiveSite(name: string, breakpoints: readonly number[]): void {
  const id = `site-${name}`
  const media = breakpoints
    .map((bp, i) => `@media (min-width: ${bp}px) { #${id} p { padding: ${(i + 1) * 8}px } }`)
    .join(' ')
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="${id}" style="display: contents"><style>${media}</style><div><p>x</p></div></div>`,
  )
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  globalThis.__XRAY__?.captured(name, el)
}

/**
 * Drive a multi-width sweep to completion. The client posts ONE command at a time and only posts
 * the next after the current one ACKs and its capture pass (a real settle) finishes, so we wait for
 * each new command to appear, ACK it, and stop once the final `reset` has been ACKed. Bounded so a
 * stuck sweep fails the test instead of hanging.
 */
async function drainSweep(commands: ExtCommand[]): Promise<void> {
  const acked = new Set<number>()
  for (let i = 0; i < 30; i++) {
    const pending = commands.find((c) => !acked.has(c.id))
    if (pending) {
      acked.add(pending.id)
      ackCommand(pending.id)
      if (pending.kind === 'reset') return
    }
    // Let the next command post (capture pass settles on a timer).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('sweep did not reach reset')
}

/**
 * Install the client with `postMessage` spied so outbound extension commands are captured (and not
 * actually re-delivered to the client's own listener). The extension is simulated separately via
 * `ackCommand`/`dispatchMessage`.
 */
function installWithExtBridge(options?: Partial<ClientOptions>): {
  sink: ReturnType<typeof vi.fn>
  commands: ExtCommand[]
} {
  const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
  const commands: ExtCommand[] = []
  vi.spyOn(window, 'postMessage').mockImplementation((data: unknown) => {
    // The client always posts a structured `{ source, kind, id, ...extra }`.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- known posted shape
    commands.push(data as ExtCommand)
  })
  uninstall = installXrayClient({ sink, delay: 1, ...options })
  return { sink, commands }
}

describe('capture-all extension ACK protocol', () => {
  it('emits emulate commands and resolves the sweep when each is ACKed', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    // With no mounted sites + no matchMedia queries, sweepWidths() is the single
    // anchor width (390). One emulate command is posted before the first await.
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ source: 'xray', kind: 'emulate' })
    expect(commands[0]?.id).toBeTypeOf('number')
    ackCommand(firstCommand(commands).id)
    // After the emulate resolves and the (empty) capture pass runs, a reset posts.
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).resolves.toBeUndefined()
  })

  it('rejects the sweep when an emulate is answered with an error ACK', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    expect(commands[0]?.kind).toBe('emulate')
    ackCommand(firstCommand(commands).id, { ok: false, error: 'debugger detach' })
    // The reset in `finally` still posts; ACK it so its own promise settles.
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).rejects.toThrow('debugger detach')
  })

  it('treats an ACK with ok omitted as a failure (defaults to ok: false)', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    ackCommand(firstCommand(commands).id, {}) // no `ok` field at all
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).rejects.toThrow('xray extension error')
  })

  it('ignores unrelated window messages: wrong source, wrong id, junk shapes', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    const id = firstCommand(commands).id
    let settled = false
    void sweep.then(
      () => (settled = true),
      () => (settled = true),
    )

    // Wrong source (a page message, not the extension).
    dispatchMessage({ source: 'xray', kind: 'ack', id })
    // Right source but a non-ack kind.
    dispatchMessage({ source: 'xray-ext', kind: 'hello' })
    // Right source/kind but a different id.
    dispatchMessage({ source: 'xray-ext', kind: 'ack', id: id + 999 })
    // Random junk.
    dispatchMessage({ totally: 'unrelated' })
    dispatchMessage('a string')
    dispatchMessage(null)

    await Promise.resolve()
    expect(settled).toBe(false)

    // The real matching ACK still resolves it, proving state wasn't corrupted.
    ackCommand(id)
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).resolves.toBeUndefined()
  })

  it('ignores a message whose source is not the same window', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    const id = firstCommand(commands).id

    // A correctly-shaped, correctly-id'd ACK, but event.source is NOT this window
    // (e.g. an iframe or another frame relaying a message). It must be NON-NULL and
    // still `!== window`, so the ONLY thing that can reject it is the real
    // `event.source !== win` guard — a null source would be rejected by the guard
    // too AND would just look like an absent source, hiding a deleted guard.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- a stand-in frame, only its identity (!== window) matters
    const otherFrame = { name: 'not-this-window' } as unknown as Window
    dispatchMessage({ source: 'xray-ext', kind: 'ack', id, ok: true }, otherFrame)
    // Give the (wrongly) settled emulate a tick to advance the sweep, if it did.
    await new Promise((r) => setTimeout(r, 5))

    // The wrong-source ACK was IGNORED: the emulate is still pending, so the sweep
    // has NOT run its capture pass nor posted the next command. With no sites the
    // very next command would be the `reset` in `finally`, so its absence proves
    // the emulate never resolved. If the guard is deleted, the bad ACK resolves the
    // emulate and a `reset` is posted here, failing this assertion.
    expect(commands.some((c) => c.kind === 'reset')).toBe(false)
    expect(commands).toHaveLength(1)

    // The same ACK from the right source DOES advance it: reset posts and the
    // sweep settles, proving the pending entry was untouched by the bad ACK.
    ackCommand(id)
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).resolves.toBeUndefined()
  })
})

describe('capture-all extension timeout cleanup', () => {
  // `extCommand` arms a 10s timeout (client.ts) that rejects the pending command
  // and DELETES its ACK entry. These tests use fake timers to fire it
  // deterministically. The rest of the suite uses real timers, so they are
  // isolated here (vi.useRealTimers() runs in afterEach).
  it('rejects an unanswered command after 10s and clears the pending entry', async () => {
    vi.useFakeTimers()
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    // Attach a handler immediately so the rejection (fired deep inside the timer
    // advance below) is never momentarily unhandled.
    let rejection: unknown
    let didReject = false
    void sweep.catch((e: unknown) => {
      didReject = true
      rejection = e
    })
    const emulateId = firstCommand(commands).id

    // Advance past the emulate's 10s ACK timeout: it rejects, then the `finally`
    // posts reset whose own 10s timeout must also fire for the sweep to settle.
    await vi.advanceTimersByTimeAsync(10_000)

    // A late ACK for the now-cleared emulate id must not throw or double-settle:
    // its entry was deleted by the timeout, so the callback is gone.
    expect(() => ackCommand(emulateId)).not.toThrow()

    // The reset in finally was posted; let its own timeout fire and clear too.
    const resetCmd = commands.find((c) => c.kind === 'reset')
    expect(resetCmd).toBeDefined()
    await vi.advanceTimersByTimeAsync(10_000)

    // The whole sweep rejected with the emulate's timeout error (reset's failure
    // is swallowed in `finally`).
    expect(didReject).toBe(true)
    assert(rejection instanceof Error)
    expect(rejection.message).toContain('did not respond')
  })

  it('an ACK arriving before the timeout wins, and the later timeout is a no-op', async () => {
    vi.useFakeTimers()
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    const emulateId = firstCommand(commands).id
    // ACK promptly (before 10s) to resolve the emulate.
    ackCommand(emulateId)
    await vi.advanceTimersByTimeAsync(0)
    // reset posts; ACK it too.
    const resetCmd = commands.find((c) => c.kind === 'reset')
    expect(resetCmd).toBeDefined()
    ackCommand(resetCmd!.id)
    // Fire the timers well past 10s; the already-cleared entries are no-ops.
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(sweep).resolves.toBeUndefined()
  })
})

describe('capture-all reset in finally', () => {
  it('posts reset after a successful sweep', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    ackCommand(firstCommand(commands).id) // emulate
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await expect(sweep).resolves.toBeUndefined()
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })

  it('posts reset even after an emulate failure (and reset failure is swallowed)', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    ackCommand(firstCommand(commands).id, { ok: false, error: 'boom' }) // emulate rejects
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    // Even a FAILING reset ACK is swallowed (`.catch(() => undefined)`), so the
    // sweep still rejects with the original emulate error, not the reset error.
    ackCommand(resetCommand(commands).id, { ok: false, error: 'reset-fail' })
    await expect(sweep).rejects.toThrow('boom')
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })
})

describe('capture-all in-session sweep widths', () => {
  // Behavior lock for the sweep target widths: width discovery is
  // IN-SESSION, not from the disk coverage. The union is the matchMedia spy's JS
  // thresholds PLUS the author CSS `@media` thresholds carried in the Views captured
  // so far this sweep, plus a mobile-ish anchor inside the first band. `coverage.set`
  // no longer feeds sweepWidths, so these inject breakpoints via matchMedia (and the
  // off-range-collapse regression below proves the CSS-only `@media` path on its own).
  it('with no sites and no matchMedia queries, sweeps a single anchor width (390)', async () => {
    const { commands } = installWithExtBridge()
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    // All commands are posted lazily (one emulate at a time), so ACK as we go.
    ackCommand(firstCommand(commands).id)
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands).id)
    await sweep
    expect(emulateWidths(commands)).toEqual([390])
  })

  it('derives widths from the matchMedia thresholds plus a first-band anchor', async () => {
    const { commands } = installWithExtBridge()
    // matchMedia is intercepted by the client (records the query for breakpoints);
    // this is the in-session source (coverage never
    // feeds sweepWidths). Two JS thresholds → two non-anchor bands.
    window.matchMedia('(min-width: 768px)')
    window.matchMedia('(min-width: 1024px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    // min threshold is 768 → anchor = min(390, 768-1) = 390. Then the thresholds.
    expect(emulateWidths(commands)).toEqual([390, 768, 1024])
  })

  it('folds multiple matchMedia thresholds into the sweep widths', async () => {
    const { commands } = installWithExtBridge()
    // Several matchMedia thresholds union into the sweep's bands (deduped, sorted).
    window.matchMedia('(min-width: 600px)')
    window.matchMedia('(min-width: 900px)')
    mountSite('card')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    // matchMedia 600 + 900; min 600 → anchor = min(390, 599) = 390.
    expect(emulateWidths(commands)).toEqual([390, 600, 900])
  })

  it('sets mobile: true for widths below 600 and false at/above', async () => {
    const { commands } = installWithExtBridge()
    window.matchMedia('(min-width: 600px)')
    window.matchMedia('(min-width: 1200px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    const emulates = commands.filter((c) => c.kind === 'emulate')
    expect(emulates.map((c) => ({ width: c.width, mobile: c.mobile, height: c.height }))).toEqual([
      { width: 390, mobile: true, height: 2400 },
      { width: 600, mobile: false, height: 2400 },
      { width: 1200, mobile: false, height: 2400 },
    ])
  })
})

describe('capture-all posts ONE StoredPlate per site at the end of the sweep', () => {
  // ADR 0022: a sweep accumulates one PlateIR per site across every
  // emulated width and posts ONE projected StoredPlate per site at the end (no
  // per-width POST). A multi-width sweep therefore yields a single gated, multi-View
  // StoredPlate; a single-width sweep yields a single ungated StoredPlate.
  it('posts a single multi-View StoredPlate for a multi-width sweep', async () => {
    const { sink, commands } = installWithExtBridge({ capture: false })
    // Two bands → two emulate widths (anchor 390 then 800), both folded into ONE
    // StoredPlate. The 800 band comes from the in-session matchMedia spy.
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    expect(emulateWidths(commands)).toEqual([390, 800])
    // ONE POST for the site, after both widths were visited.
    expect(sink).toHaveBeenCalledTimes(1)
    const envelope = sink.mock.calls[0]?.[0]
    expect(envelope?.plate.name).toBe('hero')
    // Two Views gated into one plate → the merge emitted breakpoint gates.
    expect(envelope?.plate.css).toContain('display: none !important')
  })

  it('posts a single ungated StoredPlate for a single-width sweep', async () => {
    const { sink, commands } = installWithExtBridge({ capture: false })
    mountSite('hero')
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    expect(emulateWidths(commands)).toEqual([390])
    expect(sink).toHaveBeenCalledTimes(1)
    // One View → no breakpoint gate.
    expect(sink.mock.calls[0]?.[0]?.plate.css).not.toContain('display: none !important')
  })
})

describe('capture-all sink backpressure', () => {
  // The single
  // per-site POST at the end of the sweep is awaited, so `reset` does not post until
  // it resolves. A deferred sink lets us hold the write open and prove the sweep is
  // parked on it.
  it('does not post reset until the final StoredPlate POST resolves', async () => {
    let resolveSink: (() => void) | undefined
    const sinkGate = new Promise<void>((resolve) => {
      resolveSink = resolve
    })
    const sink = vi.fn<(envelope: CaptureEnvelope) => Promise<void>>().mockReturnValue(sinkGate)
    const { commands } = installWithExtBridge({ sink, capture: false })
    // A second band (800) from the in-session matchMedia spy → a two-width sweep.
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    void sweep.catch(() => undefined)

    // ACK both emulates as they post (one width at a time). After the last width's
    // capture splices, the final POST fires (gated).
    const acked = new Set<number>()
    await vi.waitFor(() => {
      for (const c of commands) {
        if (!acked.has(c.id) && c.kind === 'emulate') {
          acked.add(c.id)
          ackCommand(c.id)
        }
      }
      expect(emulateWidths(commands)).toEqual([390, 800])
    })
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))

    // The final POST is still pending, so the sweep is parked: NO reset yet. This
    // is the backpressure — server confirmation gates the sweep's completion.
    await new Promise((r) => setTimeout(r, 20))
    expect(commands.some((c) => c.kind === 'reset')).toBe(false)

    // Resolve the write; now reset posts and the sweep completes.
    resolveSink?.()
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'reset')).toBe(true))
    ackCommand(resetCommand(commands).id)
    await sweep
    expect(emulateWidths(commands)).toEqual([390, 800])
  })

  it('rejects the sweep when the final POST rejects (non-2xx write) and still posts reset', async () => {
    // The generated bootstrap sink rejects on a non-2xx POST; the sweep must surface
    // that as a failure instead of a silent network error AFTER the HUD says done.
    // Reset-in-finally must STILL hold so the viewport is restored.
    const sink = vi
      .fn<(envelope: CaptureEnvelope) => Promise<void>>()
      .mockRejectedValue(new Error('xray sink POST failed: 413'))
    const { commands } = installWithExtBridge({ sink, capture: false })
    // A second band (800) from the in-session matchMedia spy → a two-width sweep.
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    let rejection: unknown
    void sweep.catch((e: unknown) => (rejection = e))

    // ACK every emulate; both widths are captured into the bundle, then the final
    // POST rejects.
    const acked = new Set<number>()
    await vi.waitFor(() => {
      for (const c of commands) {
        if (!acked.has(c.id) && c.kind === 'emulate') {
          acked.add(c.id)
          ackCommand(c.id)
        }
      }
      expect(emulateWidths(commands)).toEqual([390, 800])
    })

    // The rejected write tears the sweep down, but `finally` still posts reset.
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'reset')).toBe(true))
    ackCommand(resetCommand(commands).id)
    await expect(sweep).rejects.toThrow('xray sink POST failed: 413')
    assert(rejection instanceof Error)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })
})

describe('capture-all coalescing and stale guard', () => {
  // capture performance plan, pieces 1/2/3; ADR 0022 §4. Capture-all composes with
  // the generation guard: a capture still settling at a previous emulated width must
  // be DISCARDED (its local View dropped, never spliced into the shared session
  // bundle) when the width changes underneath it — otherwise one width's geometry
  // would land under another's island/gate and corrupt the whole Plate's projection.

  it('coalesces a capture-all pass with an in-flight browse capture into one StoredPlate', async () => {
    // Browse capture is enabled (capture: true) so mounting a site starts a settling
    // browse capture; capture-all then starts while it is in flight. The sweep
    // coalesces with it (one inflight chain) and posts ONE StoredPlate at the end.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const { commands } = installWithExtBridge({ sink, delay: 20, capture: true })
    mountSite('hero')
    // Kick capture-all immediately, while the mount's browse capture is still
    // settling — the schedule must coalesce, not run a parallel settle.
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'emulate')).toBe(true))
    ackCommand(firstCommand(commands).id)
    await drainSweep(commands)
    await expect(sweep).resolves.toBeUndefined()
    // The sweep produced exactly ONE StoredPlate for `hero` (the in-flight browse
    // capture coalesced into it; it did not fire its own POST mid-sweep).
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })

  it('DISCARDS a View captured at a now-stale width instead of splicing it into the bundle', async () => {
    // THE generation-guard test (ADR 0022 §4). A browse capture for the site is
    // settling (long delay) when capture-all starts. The emulate bumps the
    // generation, so the original browse pass is DISCARDED (its local 1-View IR is
    // dropped, never spliced into the session bundle); capture-all's forced
    // follow-up then captures fresh at the current width and splices ONE View. The
    // single-width sweep must therefore post a SINGLE-View (ungated) StoredPlate — a
    // gate would prove a stale second View was wrongly spliced.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const { commands } = installWithExtBridge({ sink, delay: 40, capture: true })
    mountSite('hero')
    // The mount's browse capture is now settling at the current generation.
    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'emulate')).toBe(true))
    // ACK the emulate: this BUMPED the generation, invalidating the in-flight browse
    // capture that started before it.
    ackCommand(firstCommand(commands).id)
    await drainSweep(commands)
    await expect(sweep).resolves.toBeUndefined()

    // ONE POST, and it is a SINGLE-View StoredPlate: no breakpoint gate. If the
    // stale browse View had been spliced alongside the forced one, the bundle would
    // hold two Views and the merge would have emitted a `display: none !important`
    // gate — its absence proves the stale View was discarded, not appended.
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
    expect(sink.mock.calls[0]?.[0]?.plate.css).not.toContain('display: none !important')
  })

  it('does not write a capture in flight when the client is uninstalled mid-settle (generation bump)', async () => {
    // Mirrors the client.test disposal case but proves the GENERATION guard path:
    // uninstall bumps the generation, so a capture past its settle bails before it
    // posts even though it holds its own site reference.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const localUninstall = installXrayClient({ sink, delay: 40 })
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="site-x" style="display: contents"><div><p>x</p></div></div>',
    )
    const el = document.getElementById('site-x')
    assert(el, 'missing #site-x')
    globalThis.__XRAY__?.captured('x', el)
    // Tear down mid-settle; the generation bump (and disposed flag) both bail it.
    localUninstall()
    await new Promise((r) => setTimeout(r, 120))
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('capture-all fixpoint sweep', () => {
  // The fixpoint discovers NEW widths chiefly from a pass's captured matchMedia
  // queries: a width-gated lazy component that only runs `matchMedia()` once the
  // sweep emulates its band reveals a threshold AFTER pass 0, so the next
  // sweepWidths() yields more widths and the sweep runs another pass. It stops at a
  // fixpoint: a pass that adds nothing. Either way the whole bundle posts ONCE at the
  // end. `refreshCoverage` (called after each pass) is the deterministic hook these
  // tests use to STAND IN for that lazy mid-pass `matchMedia()` call — coverage.set
  // no longer feeds widths, so the new width must arrive through the matchMedia spy.
  it('runs a second pass when a lazy matchMedia reveals a newly discovered width', async () => {
    let pass = 0
    // After pass 0 (the anchor + the initial 800 band were visited), a width-gated
    // lazy component runs `matchMedia('(min-width: 1200px)')` for the first time,
    // revealing 1200; later passes add nothing, so the sweep converges after pass 1.
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      pass++
      if (pass === 1) window.matchMedia('(min-width: 1200px)')
    })
    const { commands, sink } = installWithExtBridge({ refreshCoverage, capture: false })
    // The initial 800 band is known up front (from the anchor View's matchMedia).
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    // Pass 0 visits 390 + 800; the lazy matchMedia reveals 1200; pass 1 visits only
    // the unvisited 1200 (390 and 800 are not re-emulated). Then it converges. All
    // three Views fold into ONE StoredPlate posted at the end.
    expect(emulateWidths(commands)).toEqual([390, 800, 1200])
    expect(refreshCoverage).toHaveBeenCalled()
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('does not re-emulate already-visited widths across passes', async () => {
    // Even if a later pass re-evaluates the SAME matchMedia threshold, a visited
    // width is never emulated twice — the sweep tracks visited widths and stops.
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      window.matchMedia('(min-width: 800px)')
    })
    const { commands } = installWithExtBridge({ refreshCoverage, capture: false })
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep
    expect(emulateWidths(commands)).toEqual([390, 800])
  })

  it('fails loudly to the HUD when the sweep never converges (loop guard)', async () => {
    // A pathological app that keeps running a FRESH matchMedia threshold every pass
    // would loop forever; the MAX_SWEEP_PASSES guard rejects instead of hanging, and
    // the HUD surfaces the rejection. Each refresh queries a never-before-seen width.
    let next = 1000
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      next += 100
      window.matchMedia(`(min-width: ${next}px)`)
    })
    const { commands } = installWithExtBridge({ refreshCoverage, capture: false })
    window.matchMedia('(min-width: 1000px)')
    mountSite('hero')

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    assert(sweep, 'captureAllViews should return a promise')
    void sweep.catch(() => undefined) // never momentarily unhandled
    // ACK every command as it posts; the guard trips after MAX_SWEEP_PASSES and
    // posts the `reset` in `finally`, which is our stop signal — ACK it and the
    // sweep rejects with the convergence failure.
    const ackedIds = new Set<number>()
    let sawReset = false
    for (let i = 0; i < 200 && !sawReset; i++) {
      const pending = commands.find((c) => !ackedIds.has(c.id))
      if (pending) {
        ackedIds.add(pending.id)
        ackCommand(pending.id)
        if (pending.kind === 'reset') sawReset = true
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2))
    }
    // Reset still posted in `finally` despite the loud failure.
    expect(sawReset).toBe(true)
    await expect(sweep).rejects.toThrow(/did not converge/)
  })
})

describe('capture-all CSS-only @media sweep (off-range collapse regression)', () => {
  // THE off-range collapse regression. A CSS-responsive plate whose
  // breakpoints are CSS-only author `@media` — NO `matchMedia`, NO coverage — must
  // STILL be swept at every band. Width discovery is in-session: pass 0 captures the
  // anchor-width View, whose lifted `@media` rules reveal the bands, and the fixpoint
  // visits them. The failure mode is a sweep reading widths only from the (never-
  // read) disk coverage: with no matchMedia, only the anchor is swept → ONE View →
  // that lone widest View rendered at EVERY width (the layout collapsed below 1200px).
  // The fix is the `sweepWidths` in-session loop over the captured Views' rules; if it
  // is removed, this test FALLS BACK to a single anchor width and an ungated 1-View
  // plate (confirmed by commenting the loop out — the sweep collapses to [390]).
  it('sweeps CSS-only @media bands with no matchMedia and emits a gated multi-View plate', async () => {
    const { sink, commands } = installWithExtBridge({ capture: false })
    // Two CSS-only bands (768, 1024) and NO matchMedia / NO coverage.set anywhere.
    mountCssResponsiveSite('hero', [768, 1024])

    const sweep = globalThis.__XRAY__?.captureAllViews?.()
    await drainSweep(commands)
    await sweep

    // (a) Both bands were swept purely from the captured View's lifted `@media` —
    // anchor 390 plus the two CSS thresholds, discovered with zero JS breakpoints.
    expect(emulateWidths(commands)).toEqual([390, 768, 1024])

    // (b) The single posted StoredPlate is MULTI-VIEW / gated: three captured Views
    // (one per band) fold into one plate whose island gates emit `display: none
    // !important`. A single ungated View — the off-range collapse — would carry no such gate.
    expect(sink).toHaveBeenCalledTimes(1)
    const envelope = sink.mock.calls[0]?.[0]
    expect(envelope?.plate.name).toBe('hero')
    expect(envelope?.plate.css).toContain('display: none !important')
  })
})
