// @vitest-environment happy-dom
import { afterEach, assert, describe, expect, it, vi } from 'vitest'

import type { CaptureEnvelope, ClientOptions } from './client.ts'
import { installXrayClient } from './client.ts'

/**
 * Tests for the sweep (ADR 0010, ADR 0027 §2, ADR 0029): the extension ACK protocol, timeout
 * cleanup, reset-in-finally, in-session width discovery, captured absence, and the write-at-stop.
 *
 * The sweep is an AMPLIFIER of the recording session, never a separate mode: engaging record with a
 * sweep-capable extension announced fires it, every emulated width lands its Views in the same
 * session buffers a manual resize fills, and the STOP is the only write. Sweep failures surface on
 * the session store (`sweepError`), where the HUD reads them.
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

/** Announce a sweep-capable extension (the engage gates its auto-sweep on this). */
function helloEmulate(): void {
  dispatchMessage({ source: 'xray-ext', kind: 'hello', version: '1.0.0', caps: ['emulate'] })
}

/** Force `window.innerWidth` (the View width the capture reads) in happy-dom. */
function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
}

/**
 * Simulate the extension answering a command with a matching `xray-ext` ACK. A real emulate RESIZES
 * the tab before the ACK, so an acked emulate applies its width to `innerWidth` and dispatches
 * `resize` first — the session buffer keys Views by captured width, and JS-responsive harness sites
 * re-render on resize, exactly as an app would under real emulation.
 */
function ackCommand(
  command: ExtCommand | number,
  res: { ok?: boolean; error?: string } = { ok: true },
): void {
  const id = typeof command === 'number' ? command : command.id
  if (typeof command !== 'number' && command.kind === 'emulate' && res.ok !== false) {
    setWidth(command.width ?? window.innerWidth)
    window.dispatchEvent(new Event('resize'))
  }
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

function modeStore() {
  const mode = globalThis.__XRAY__?.mode
  assert(mode, 'expected the mode store')
  return mode
}

function sessionStore() {
  const session = globalThis.__XRAY__?.session
  assert(session, 'expected the session store')
  return session
}

/** Engage global recording with a sweep-capable extension announced: the engage IS the sweep. */
async function engage(): Promise<void> {
  helloEmulate()
  await modeStore().setRecord(true)
}

/** Stop the session by hand (mid-sweep aborts; after a FAILED sweep, the user's choice). */
async function stop(): Promise<void> {
  await modeStore().setRecord(false)
}

/** Wait for the sweep's FULL AUTOMATION to finish: auto-stop fired and the write settled. */
async function autoStopped(): Promise<void> {
  await vi.waitFor(() => {
    expect(modeStore().get()).toEqual({ action: 'idle' })
    expect(sessionStore().get().save).not.toBe('writing')
  })
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
 * Mount a site whose subtree depends on the viewport width, like a matchMedia-driven component: the
 * wide layout renders an extra node. Identical-structure captures FOLD at Serialize (ADR 0029) —
 * happy-dom has no real layout, so structural response is what makes per-width Views genuinely
 * differ, exactly as JS-responsive components do in a real browser.
 */
function mountJsResponsiveSite(name: string, threshold = 600): void {
  const id = `site-${name}`
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="${id}" style="display: contents"><div><p>x</p></div></div>`,
  )
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  const host = el.querySelector('div')
  if (!host) throw new Error('missing host')
  const sync = () => {
    const wide = window.innerWidth >= threshold
    const extra = host.querySelector('.wide')
    if (wide && !extra) host.insertAdjacentHTML('beforeend', '<p class="wide">wide</p>')
    else if (!wide && extra) extra.remove()
  }
  sync()
  window.addEventListener('resize', sync)
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
  // Width discovery here stays CSS-pure (the @media blocks above). The structural
  // response below only makes the per-width Views DIFFER, standing in for the
  // computed-geometry differences happy-dom cannot produce — identical Views fold
  // at Serialize (ADR 0029).
  const host = el.querySelector('div')
  if (host) {
    const sync = () => {
      const wide = window.innerWidth >= (breakpoints[0] ?? 0)
      const extra = host.querySelector('.grew')
      if (wide && !extra) host.insertAdjacentHTML('beforeend', '<p class="grew">w</p>')
      else if (!wide && extra) extra.remove()
    }
    sync()
    window.addEventListener('resize', sync)
  }
  globalThis.__XRAY__?.captured(name, el)
}

/**
 * Drive a sweep to completion. The client posts ONE command at a time and only posts the next after
 * the current one ACKs and its capture pass (a real settle) finishes, so we wait for each new
 * command to appear, ACK it, and stop once the final `reset` has been ACKed. Bounded so a stuck
 * sweep fails the test instead of hanging.
 */
async function drainSweep(commands: ExtCommand[]): Promise<void> {
  const acked = new Set<number>()
  for (let i = 0; i < 30; i++) {
    const pending = commands.find((c) => !acked.has(c.id))
    if (pending) {
      acked.add(pending.id)
      ackCommand(pending)
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
    // The client always posts a structured `{ source, kind, id, ...extra }`. The
    // install-time `whois` presence probe carries no id and is not part of the
    // command/ACK protocol these tests drive — keep the stream commands-only.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- known posted shape
    const posted = data as ExtCommand
    if (typeof posted.id === 'number') commands.push(posted)
  })
  uninstall = installXrayClient({ sink, delay: 1, ...options })
  return { sink, commands }
}

describe('sweep extension ACK protocol', () => {
  it('the engage posts emulate commands and the sweep completes when each is ACKed', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    // With no mounted sites + no matchMedia queries, sweepWidths() is the single
    // anchor width (390). The engage fires the sweep synchronously up to its
    // first await, so the emulate is already posted.
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ source: 'xray', kind: 'emulate' })
    expect(commands[0]?.id).toBeTypeOf('number')
    ackCommand(firstCommand(commands))
    // After the emulate resolves and the (empty) capture pass runs, a reset posts.
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands))
    // Full automation: the successful sweep ends its own session.
    await autoStopped()
    expect(sessionStore().get().sweepError).toBeUndefined()
  })

  it('surfaces an error ACK on the session store (the HUD error card)', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    expect(commands[0]?.kind).toBe('emulate')
    ackCommand(firstCommand(commands).id, { ok: false, error: 'debugger detach' })
    // The reset in `finally` still posts; ACK it so its own promise settles.
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands))
    await vi.waitFor(() => {
      expect(sessionStore().get().sweepError).toContain('debugger detach')
    })
    // A FAILED sweep never auto-writes: the session stays engaged for the user.
    expect(modeStore().get()).toEqual({ action: 'record', scope: 'global' })
    await stop()
  })

  it('treats an ACK with ok omitted as a failure (defaults to ok: false)', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    ackCommand(firstCommand(commands).id, {}) // no `ok` field at all
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands))
    await vi.waitFor(() => {
      expect(sessionStore().get().sweepError).toContain('xray extension error')
    })
    expect(modeStore().get()).toEqual({ action: 'record', scope: 'global' })
    await stop()
  })

  it('ignores unrelated window messages: wrong source, wrong id, junk shapes', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    const id = firstCommand(commands).id

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

    // Nothing advanced: the emulate is still pending, so no reset posted and no
    // failure surfaced.
    await new Promise((r) => setTimeout(r, 5))
    expect(commands.some((c) => c.kind === 'reset')).toBe(false)
    expect(sessionStore().get().sweepError).toBeUndefined()

    // The real matching ACK still resolves it, proving state wasn't corrupted.
    ackCommand(id)
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands))
    await autoStopped()
    expect(sessionStore().get().sweepError).toBeUndefined()
  })

  it('ignores a message whose source is not the same window', async () => {
    const { commands } = installWithExtBridge()
    await engage()
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
    ackCommand(resetCommand(commands))
    await autoStopped()
  })
})

describe('sweep extension timeout cleanup', () => {
  // `extCommand` arms a 10s timeout (client.ts) that rejects the pending command
  // and DELETES its ACK entry. These tests use fake timers to fire it
  // deterministically. The rest of the suite uses real timers, so they are
  // isolated here (vi.useRealTimers() runs in afterEach).
  it('fails an unanswered command after 10s and clears the pending entry', async () => {
    vi.useFakeTimers()
    const { commands } = installWithExtBridge()
    await engage()
    const emulateId = firstCommand(commands).id

    // Advance past the emulate's 10s ACK timeout: it rejects, then the `finally`
    // posts reset whose own 10s timeout must also fire for the sweep to settle.
    await vi.advanceTimersByTimeAsync(10_000)

    // A late ACK for the now-cleared emulate id must not throw or double-settle:
    // its entry was deleted by the timeout, so the callback is gone.
    expect(() => ackCommand(emulateId)).not.toThrow()

    // The reset in finally was posted; let its own timeout fire and clear too.
    expect(commands.find((c) => c.kind === 'reset')).toBeDefined()
    await vi.advanceTimersByTimeAsync(10_000)

    // The failure surfaced with the emulate's timeout message (reset's failure is
    // swallowed in `finally`) — and a failed sweep leaves the session engaged.
    expect(sessionStore().get().sweepError).toContain('did not respond')
    expect(modeStore().get()).toEqual({ action: 'record', scope: 'global' })
  })

  it('an ACK arriving before the timeout wins, and the later timeout is a no-op', async () => {
    vi.useFakeTimers()
    const { commands } = installWithExtBridge()
    await engage()
    // ACK promptly (before 10s) to resolve the emulate.
    ackCommand(firstCommand(commands))
    await vi.advanceTimersByTimeAsync(0)
    // reset posts; ACK it too.
    const resetCmd = commands.find((c) => c.kind === 'reset')
    expect(resetCmd).toBeDefined()
    ackCommand(resetCmd ?? 0)
    // Fire the timers well past 10s; the already-cleared entries are no-ops.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sessionStore().get().sweepError).toBeUndefined()
    // Full automation completed the session under fake timers too.
    expect(modeStore().get()).toEqual({ action: 'idle' })
  })
})

describe('sweep reset in finally', () => {
  it('posts reset after a successful sweep', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    ackCommand(firstCommand(commands)) // emulate
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    ackCommand(resetCommand(commands))
    await autoStopped()
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })

  it('posts reset even after an emulate failure (and reset failure is swallowed)', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    ackCommand(firstCommand(commands).id, { ok: false, error: 'boom' }) // emulate rejects
    await vi.waitFor(() => {
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    // Even a FAILING reset ACK is swallowed (`.catch(() => undefined)`), so the
    // surfaced failure is the original emulate error, not the reset error.
    ackCommand(resetCommand(commands).id, { ok: false, error: 'reset-fail' })
    await vi.waitFor(() => {
      expect(sessionStore().get().sweepError).toContain('boom')
    })
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
    expect(modeStore().get()).toEqual({ action: 'record', scope: 'global' })
    await stop()
  })
})

describe('in-session sweep widths', () => {
  // Behavior lock for the sweep target widths: width discovery is
  // IN-SESSION, not from the disk coverage. The union is the matchMedia spy's JS
  // thresholds PLUS the author CSS `@media` thresholds carried in the Views captured
  // so far this sweep, plus a mobile-ish anchor inside the first band.
  it('with no sites and no matchMedia queries, sweeps a single anchor width (390)', async () => {
    const { commands } = installWithExtBridge()
    await engage()
    await drainSweep(commands)
    expect(emulateWidths(commands)).toEqual([390])
    await autoStopped()
  })

  it('derives widths from the matchMedia thresholds plus a first-band anchor', async () => {
    const { commands } = installWithExtBridge()
    // matchMedia is intercepted by the client (records the query for breakpoints);
    // this is the in-session source. Two JS thresholds → two non-anchor bands.
    window.matchMedia('(min-width: 768px)')
    window.matchMedia('(min-width: 1024px)')
    mountSite('hero')
    await engage()
    await drainSweep(commands)
    // min threshold is 768 → anchor = min(390, 768-1) = 390. Then the thresholds.
    expect(emulateWidths(commands)).toEqual([390, 768, 1024])
    await autoStopped()
  })

  it('folds multiple matchMedia thresholds into the sweep widths', async () => {
    const { commands } = installWithExtBridge()
    window.matchMedia('(min-width: 600px)')
    window.matchMedia('(min-width: 900px)')
    mountSite('card')
    await engage()
    await drainSweep(commands)
    expect(emulateWidths(commands)).toEqual([390, 600, 900])
    await autoStopped()
  })

  it('sets mobile: true for widths below 600 and false at/above', async () => {
    const { commands } = installWithExtBridge()
    window.matchMedia('(min-width: 600px)')
    window.matchMedia('(min-width: 1200px)')
    mountSite('hero')
    await engage()
    await drainSweep(commands)
    const emulates = commands.filter((c) => c.kind === 'emulate')
    expect(emulates.map((c) => ({ width: c.width, mobile: c.mobile, height: c.height }))).toEqual([
      { width: 390, mobile: true, height: 2400 },
      { width: 600, mobile: false, height: 2400 },
      { width: 1200, mobile: false, height: 2400 },
    ])
    await autoStopped()
  })
})

describe('full automation: the sweep ends its own session', () => {
  it('a multi-width engage-sweep writes ONE gated multi-View StoredPlate by itself', async () => {
    const { sink, commands } = installWithExtBridge()
    // Two bands → two emulate widths (anchor 390 then 800), both carried in ONE
    // StoredPlate. The 800 band comes from the in-session matchMedia spy; the
    // site renders an extra node at wide widths so the two Views differ.
    window.matchMedia('(min-width: 800px)')
    mountJsResponsiveSite('hero')
    await engage()
    await drainSweep(commands)
    expect(emulateWidths(commands)).toEqual([390, 800])
    // The automation presses the stop itself: ONE write, session back to idle.
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    expect(sessionStore().get().save).toBe('saved')
    const envelope = sink.mock.calls[0]?.[0]
    expect(envelope?.plate.name).toBe('hero')
    // Two Views gated into one plate → the merge emitted breakpoint gates.
    expect(envelope?.plate.css).toContain('display: none !important')
  })

  it('a single-width sweep writes a single ungated StoredPlate by itself', async () => {
    const { sink, commands } = installWithExtBridge()
    mountSite('hero')
    await engage()
    await drainSweep(commands)
    expect(emulateWidths(commands)).toEqual([390])
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    expect(sink.mock.calls[0]?.[0]?.plate.css).not.toContain('display: none !important')
  })

  it('the automated stop keeps the write backpressure: saving until server-confirmed', async () => {
    let resolveSink: (() => void) | undefined
    const sinkGate = new Promise<void>((resolve) => {
      resolveSink = resolve
    })
    const sink = vi.fn<(envelope: CaptureEnvelope) => Promise<void>>().mockReturnValue(sinkGate)
    const { commands } = installWithExtBridge({ sink })
    window.matchMedia('(min-width: 800px)')
    mountJsResponsiveSite('hero')
    await engage()
    await drainSweep(commands)

    // The auto-stop initiated the write; while the sink holds it open the save
    // lifecycle is parked at 'writing' — the backpressure survives automation.
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    expect(sessionStore().get().save).toBe('writing')
    await new Promise((r) => setTimeout(r, 20))
    expect(sessionStore().get().save).toBe('writing')

    resolveSink?.()
    await vi.waitFor(() => expect(sessionStore().get().save).toBe('saved'))
  })

  it('a rejected write surfaces on the session store and keeps the views', async () => {
    const sink = vi
      .fn<(envelope: CaptureEnvelope) => Promise<void>>()
      .mockRejectedValue(new Error('xray sink POST failed: 413'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { commands } = installWithExtBridge({ sink })
    window.matchMedia('(min-width: 800px)')
    mountJsResponsiveSite('hero')
    await engage()
    await drainSweep(commands)
    // The automated stop's write rejects; the failure surfaces identically.
    await vi.waitFor(() => expect(sessionStore().get().save).toBe('failed'))
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sessionStore().get().saveError).toContain('413')
    // The buffered views survived for the next engage's retry.
    expect(sessionStore().get().views.get('hero')?.length).toBeGreaterThan(0)
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })
})

describe('stopping mid-sweep', () => {
  it('aborts the remaining widths; the stop writes what was captured, reset still posts', async () => {
    const { sink, commands } = installWithExtBridge()
    window.matchMedia('(min-width: 800px)')
    window.matchMedia('(min-width: 1000px)')
    mountJsResponsiveSite('hero')
    await engage()
    // Three widths pending: 390, 800, 1000. ACK only the first and let its
    // capture settle into the buffer.
    const acked = new Set<number>([firstCommand(commands).id])
    ackCommand(firstCommand(commands))
    await new Promise((r) => setTimeout(r, 20))
    await stop()
    // The abort takes effect at the next width boundary: the in-flight emulate
    // (800, posted before the stop) still needs its ACK to unblock the loop,
    // which then breaks before 1000 and posts the reset.
    await vi.waitFor(() => {
      for (const c of commands) {
        if (!acked.has(c.id)) {
          acked.add(c.id)
          ackCommand(c)
        }
      }
      expect(commands.some((c) => c.kind === 'reset')).toBe(true)
    })
    expect(emulateWidths(commands)).not.toContain(1000)
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
    // The stop wrote the captured slice.
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
  })
})

describe('captured absence (ADR 0029)', () => {
  it('a plate unmounted at narrow widths stores an empty island and complete spans', async () => {
    // A JS-conditional component: mounted only at/above 800px (like a
    // matchMedia-driven render). The sweep observes it unmounted at 390, records
    // the absence as an empty View, and the fold ships two islands: empty below
    // the mount boundary, content above — coverage complete, no fillable gap.
    const { sink, commands } = installWithExtBridge()
    window.matchMedia('(min-width: 800px)')
    const id = 'site-feed'
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="${id}" style="display: contents"><div><p>x</p></div></div>`,
    )
    const el = document.getElementById(id)
    if (!el) throw new Error(`missing #${id}`)
    let dispose: (() => void) | undefined
    const sync = () => {
      if (window.innerWidth >= 800 && !dispose) {
        dispose = globalThis.__XRAY__?.captured('feed', el)
      } else if (window.innerWidth < 800 && dispose) {
        dispose()
        dispose = undefined
      }
    }
    setWidth(1024)
    sync()
    window.addEventListener('resize', sync)

    await engage()
    await drainSweep(commands)
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    expect(emulateWidths(commands)).toEqual([390, 800])
    const plate = sink.mock.calls[0]?.[0]?.plate
    expect(plate?.name).toBe('feed')
    // The mount boundary survives; the absent band is captured, not a gap.
    expect(plate?.breakpoints).toEqual([800])
    expect(plate?.spans).toEqual([{ max: 800 }, { min: 800 }])
    // Two islands: the first EMPTY (absence), both gated.
    expect(plate?.tree?.kids).toHaveLength(2)
    expect(plate?.tree?.kids?.[0]?.kids ?? []).toEqual([])
    expect(plate?.css).toContain('display: none !important')
  })

  it('a plate MOUNTED but rendering nothing at narrow widths stores captured emptiness', async () => {
    // The boundary stays on the page at every width; the content renders null
    // below 800 (zero capture roots). Mounted-but-empty must read as captured
    // emptiness — not as a gap no re-capture can fill, and not as absence (the
    // observation engine sees it mounted throughout).
    const { sink, commands } = installWithExtBridge()
    window.matchMedia('(min-width: 800px)')
    const id = 'site-empty-feed'
    const markup = '<div><p>x</p></div>'
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="${id}" style="display: contents">${markup}</div>`,
    )
    const el = document.getElementById(id)
    if (!el) throw new Error(`missing #${id}`)
    const sync = () => {
      if (window.innerWidth >= 800 && el.children.length === 0) el.innerHTML = markup
      else if (window.innerWidth < 800 && el.children.length > 0) el.innerHTML = ''
    }
    setWidth(1024)
    sync()
    window.addEventListener('resize', sync)
    globalThis.__XRAY__?.captured('empty-feed', el)

    await engage()
    await drainSweep(commands)
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    const plate = sink.mock.calls[0]?.[0]?.plate
    expect(plate?.name).toBe('empty-feed')
    expect(plate?.breakpoints).toEqual([800])
    expect(plate?.spans).toEqual([{ max: 800 }, { min: 800 }])
    expect(plate?.tree?.kids).toHaveLength(2)
    expect(plate?.tree?.kids?.[0]?.kids ?? []).toEqual([])
    expect(plate?.css).toContain('display: none !important')
  })
})

describe('per-plate record with the extension (full automation)', () => {
  it('sweeps the scope and keys itself off — the automated key-off is the write', async () => {
    const { sink, commands } = installWithExtBridge()
    helloEmulate()
    window.matchMedia('(min-width: 800px)')
    mountJsResponsiveSite('hero')
    const mode = modeStore()

    await mode.recordName('hero', true)
    await drainSweep(commands)
    // The scoped sweep finished and pressed its own key-off: one write, idle.
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mode.get()).toEqual({ action: 'idle' }))
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
  })
})

describe('sweep coalescing and stale guard', () => {
  // Capture performance (ADR 0025); ADR 0022 §4. The sweep composes with the
  // generation guard: a capture still settling at a previous emulated width must
  // be DISCARDED (its local View dropped, never spliced into the session buffer)
  // when the width changes underneath it — otherwise one width's geometry would
  // land under another's island/gate and corrupt the whole Plate's projection.

  it('coalesces the engage-time browse capture with the sweep into one StoredPlate', async () => {
    // The engage schedules a browse capture for every mounted site AND fires the
    // sweep; the overlapping triggers must coalesce (one inflight chain per
    // site), and the stop posts ONE StoredPlate.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const { commands } = installWithExtBridge({ sink, delay: 20 })
    mountSite('hero')
    await engage()
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'emulate')).toBe(true))
    ackCommand(firstCommand(commands))
    await drainSweep(commands)
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    expect(sink.mock.calls[0]?.[0]?.plate.name).toBe('hero')
    expect(commands.filter((c) => c.kind === 'reset')).toHaveLength(1)
  })

  it('DISCARDS a View captured at a now-stale width instead of splicing it into the buffer', async () => {
    // THE generation-guard test (ADR 0022 §4). The engage's browse capture is
    // settling (long delay) when the sweep's first emulate lands: the emulate
    // bumps the generation, so the browse pass is DISCARDED (its local 1-View IR
    // dropped, never spliced); the sweep's forced follow-up captures fresh at the
    // emulated width.
    const sink = vi.fn<(envelope: CaptureEnvelope) => void>()
    const { commands } = installWithExtBridge({ sink, delay: 40 })
    setWidth(1024)
    mountSite('hero')
    await engage()
    await vi.waitFor(() => expect(commands.some((c) => c.kind === 'emulate')).toBe(true))
    // ACK the emulate: this BUMPED the generation, invalidating the in-flight
    // browse capture that started before it. The ack also applies the emulated
    // width, so a wrongly-spliced stale View would sit at the ORIGINAL width.
    ackCommand(firstCommand(commands))
    await drainSweep(commands)

    // The written plate is the proof (the auto-stop clears the buffer too fast
    // to read): ONE captured span, ungated. A wrongly-spliced stale View would
    // make a second span/gate at the pre-emulate width.
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
    const plate = sink.mock.calls[0]?.[0]?.plate
    expect(plate?.name).toBe('hero')
    expect(plate?.spans).toHaveLength(1)
    expect(plate?.css).not.toContain('display: none !important')
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

describe('sweep fixpoint', () => {
  // The fixpoint discovers NEW widths chiefly from a pass's captured matchMedia
  // queries: a width-gated lazy component that only runs `matchMedia()` once the
  // sweep emulates its band reveals a threshold AFTER pass 0, so the next
  // sweepWidths() yields more widths and the sweep runs another pass. It stops at
  // a fixpoint: a pass that adds nothing. `refreshCoverage` (called after each
  // pass) is the deterministic hook these tests use to STAND IN for that lazy
  // mid-pass `matchMedia()` call.
  it('runs a second pass when a lazy matchMedia reveals a newly discovered width', async () => {
    let pass = 0
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      pass++
      if (pass === 1) window.matchMedia('(min-width: 1200px)')
    })
    const { commands, sink } = installWithExtBridge({ refreshCoverage })
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')
    await engage()
    await drainSweep(commands)
    // Pass 0 visits 390 + 800; the lazy matchMedia reveals 1200; pass 1 visits
    // only the unvisited 1200. Then it converges.
    expect(emulateWidths(commands)).toEqual([390, 800, 1200])
    expect(refreshCoverage).toHaveBeenCalled()
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()
  })

  it('does not re-emulate already-visited widths across passes', async () => {
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      window.matchMedia('(min-width: 800px)')
    })
    const { commands } = installWithExtBridge({ refreshCoverage })
    window.matchMedia('(min-width: 800px)')
    mountSite('hero')
    await engage()
    await drainSweep(commands)
    expect(emulateWidths(commands)).toEqual([390, 800])
    await autoStopped()
  })

  it('fails loudly to the HUD when the sweep never converges (loop guard)', async () => {
    // A pathological app that keeps running a FRESH matchMedia threshold every
    // pass would loop forever; the MAX_SWEEP_PASSES guard fails the sweep instead
    // of hanging, and the session store surfaces it. Each refresh queries a
    // never-before-seen width.
    let next = 1000
    const refreshCoverage = vi.fn<() => void>().mockImplementation(() => {
      next += 100
      window.matchMedia(`(min-width: ${next}px)`)
    })
    const { commands } = installWithExtBridge({ refreshCoverage })
    window.matchMedia('(min-width: 1000px)')
    mountSite('hero')
    await engage()
    // ACK every command as it posts; the guard trips after MAX_SWEEP_PASSES and
    // posts the `reset` in `finally`, which is our stop signal.
    const ackedIds = new Set<number>()
    let sawReset = false
    for (let i = 0; i < 200 && !sawReset; i++) {
      const pending = commands.find((c) => !ackedIds.has(c.id))
      if (pending) {
        ackedIds.add(pending.id)
        ackCommand(pending)
        if (pending.kind === 'reset') sawReset = true
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2))
    }
    // Reset still posted in `finally` despite the loud failure.
    expect(sawReset).toBe(true)
    await vi.waitFor(() => {
      expect(sessionStore().get().sweepError).toMatch(/did not converge/)
    })
    // Non-convergence is a failure: no auto-write, the session stays engaged.
    expect(modeStore().get()).toEqual({ action: 'record', scope: 'global' })
    await stop()
  })
})

describe('CSS-only @media sweep (off-range collapse regression)', () => {
  // THE off-range collapse regression. A CSS-responsive plate whose breakpoints
  // are CSS-only author `@media` — NO `matchMedia`, NO coverage — must STILL be
  // swept at every band. Width discovery is in-session: pass 0 captures the
  // anchor-width View, whose lifted `@media` rules reveal the bands, and the
  // fixpoint visits them. The failure mode is a sweep reading widths only from
  // the (never-read) disk coverage: with no matchMedia, only the anchor is swept
  // → ONE View → that lone widest View rendered at EVERY width.
  it('sweeps CSS-only @media bands with no matchMedia and writes a gated multi-View plate', async () => {
    const { sink, commands } = installWithExtBridge()
    // Two CSS-only bands (768, 1024) and NO matchMedia / NO coverage.set anywhere.
    mountCssResponsiveSite('hero', [768, 1024])
    await engage()
    await drainSweep(commands)
    await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1))
    await autoStopped()

    // (a) Both bands were swept purely from the captured View's lifted `@media` —
    // anchor 390 plus the two CSS thresholds, discovered with zero JS breakpoints.
    expect(emulateWidths(commands)).toEqual([390, 768, 1024])

    // (b) The single posted StoredPlate is MULTI-VIEW / gated. A single ungated
    // View — the off-range collapse — would carry no such gate.
    const envelope = sink.mock.calls[0]?.[0]
    expect(envelope?.plate.name).toBe('hero')
    expect(envelope?.plate.css).toContain('display: none !important')
  })
})
