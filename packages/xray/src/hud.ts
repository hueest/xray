import type { PlateCoverage, Span, ToggleStore } from './plate.ts'

/**
 * The opt-in dev HUD (Astro-dev-toolbar-style): a small fixed badge. For each plate it shows every
 * detected width band — captured ones lit, the rest dim — sourced from the committed plate files
 * (via `__XRAY__.coverage`), not the session, so it reflects what's actually on disk.
 *
 * It is also the controller for capture-all-views (ADR 0010): it probes for the companion extension
 * (which announces itself via its content script) and shows a "Capture all views" button when
 * present, or a one-line promotion when not. The sweep itself lives in the dev client
 * (`__XRAY__.captureAllViews`).
 */

export interface HudHandle {
  dispose: () => void
}

interface ExtensionHello {
  source: 'xray-ext'
  kind: 'hello'
}

function isExtensionHello(value: unknown): value is ExtensionHello {
  return (
    typeof value === 'object' &&
    value !== null &&
    'source' in value &&
    value.source === 'xray-ext' &&
    'kind' in value &&
    value.kind === 'hello'
  )
}

/**
 * A labelled checkbox bound to a sticky toggle store; reads the store on build so a console/URL
 * flip stays in sync with the box at the next render.
 */
function toggleRow(store: ToggleStore, text: string): HTMLLabelElement {
  const label = document.createElement('label')
  label.className = 'toggle'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = store.get()
  checkbox.addEventListener('change', () => {
    store.set(checkbox.checked)
  })
  label.append(checkbox, document.createTextNode(text))
  return label
}

/**
 * Expand a plate's coverage into the full set of width bands, flagging which are captured. The
 * breakpoints partition the width axis; a band is covered when a captured span matches it (spans
 * align to band boundaries, ADR 0004).
 */
function bandsOf({ breakpoints, spans }: PlateCoverage): { label: string; covered: boolean }[] {
  const sorted = [...breakpoints].toSorted((a, b) => a - b)
  const bands: Span[] = []
  for (let i = 0; i <= sorted.length; i++) {
    bands.push({
      min: i === 0 ? undefined : sorted[i - 1],
      max: i === sorted.length ? undefined : sorted[i],
    })
  }
  return bands.map((band) => ({
    label: `[${band.min ?? 0},${band.max ?? '∞'})`,
    covered: spans.some((span) => span.min === band.min && span.max === band.max),
  }))
}

export function installXrayHud(): HudHandle {
  const host = document.createElement('div')
  host.setAttribute('data-xray-hud', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    .hud {
      position: fixed; bottom: 12px; right: 12px; z-index: 2147483647;
      background: #1c1c1f; color: #e4e4e7; border: 1px solid #3f3f46;
      border-radius: 8px; padding: 8px 10px; max-width: 340px;
      font: 11px/1.5 ui-monospace, monospace; opacity: 0.92;
    }
    .title { font-weight: 700; margin-bottom: 2px; color: #a1a1aa }
    .plate { display: flex; gap: 8px; justify-content: space-between }
    .bands { text-align: right }
    .band.covered { color: #4ade80 }
    .band.missing { color: #52525b }
    .fixture { color: #fbbf24; margin-left: 6px }
    .toggle { display: flex; gap: 6px; align-items: center; cursor: pointer; user-select: none }
    .toggle input { accent-color: #4ade80; margin: 0 }
    .action {
      display: block; width: 100%; margin: 6px 0 2px; padding: 5px 8px;
      border: 0; border-radius: 5px; background: #4ade80; color: #0a0a0a;
      font: inherit; font-weight: 700; cursor: pointer;
    }
    .action:disabled { opacity: 0.6; cursor: default }
    .promo { margin: 6px 0 2px; color: #a1a1aa }
    .promo a { color: #4ade80 }
    .status { color: #a1a1aa }
  `
  const panel = document.createElement('div')
  panel.className = 'hud'
  shadow.append(style, panel)

  let extensionPresent = false
  let sweeping = false
  let sweepStatus = ''
  let recording = false
  let recordStatus = ''

  const render = () => {
    panel.textContent = ''
    const coverage = globalThis.__XRAY__?.coverage?.get()
    const count = coverage?.size ?? 0
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = count === 0 ? 'xray' : `xray — ${count} plate${count > 1 ? 's' : ''}`
    panel.append(title)
    // Capture flips browse-time re-capture on; Light Box flips every <Skeleton>
    // on the page to its skeleton.
    const capture = globalThis.__XRAY__?.capture
    if (capture) panel.append(toggleRow(capture, 'Capture'))
    const lightbox = globalThis.__XRAY__?.lightbox
    if (lightbox) panel.append(toggleRow(lightbox, 'Light Box'))
    // Replay flips Fixture substitution in front of the render prop (ADR 0015);
    // Record fixture writes the live `data` of every mounted render-prop Skeleton
    // to its sidecar. Both are dev-only, wired exactly like the Capture toggle.
    const replay = globalThis.__XRAY__?.replay
    if (replay) panel.append(toggleRow(replay, 'Replay'))
    const fixtures = globalThis.__XRAY__?.fixtures
    if (fixtures) {
      const button = document.createElement('button')
      button.className = 'action'
      button.type = 'button'
      button.disabled = recording
      button.textContent = recording ? 'Recording fixture…' : 'Record fixture'
      button.addEventListener('click', () => {
        void recordFixtures(fixtures)
      })
      panel.append(button)
      if (recordStatus) {
        const status = document.createElement('div')
        status.className = 'status'
        status.textContent = recordStatus
        panel.append(status)
      }
    }
    // Capture-all-views: a sweep button when the extension is present, else a
    // promo. Only shown in dev (where the dev client exposes the orchestrator).
    if (globalThis.__XRAY__?.captureAllViews) {
      if (extensionPresent) {
        const button = document.createElement('button')
        button.className = 'action'
        button.type = 'button'
        button.disabled = sweeping
        button.textContent = sweeping ? 'Capturing all views…' : 'Capture all views'
        button.addEventListener('click', () => {
          void startSweep()
        })
        panel.append(button)
        if (sweepStatus) {
          const status = document.createElement('div')
          status.className = 'status'
          status.textContent = sweepStatus
          panel.append(status)
        }
      } else {
        const promo = document.createElement('div')
        promo.className = 'promo'
        promo.textContent = 'Install the xray extension to capture all views in one click.'
        panel.append(promo)
      }
    }
    // Per-plate coverage: every detected band, captured ones lit and the rest
    // dim. Sourced from disk, so committed coverage shows on load.
    for (const [name, plateCoverage] of coverage ?? []) {
      const row = document.createElement('div')
      row.className = 'plate'
      const label = document.createElement('span')
      label.textContent = name
      // Fixture coverage marker (ADR 0015): a "◆ fixture" tag next to a
      // plate that has a recorded Fixture, so it's clear which Skeletons replay
      // from disk vs. live data.
      if (globalThis.__XRAY__?.fixtures?.has(name)) {
        const tag = document.createElement('span')
        tag.className = 'fixture'
        tag.textContent = '◆ fixture'
        label.append(tag)
      }
      const bands = document.createElement('span')
      bands.className = 'bands'
      for (const band of bandsOf(plateCoverage)) {
        const chip = document.createElement('span')
        chip.className = `band ${band.covered ? 'covered' : 'missing'}`
        chip.textContent = band.label
        bands.append(chip, document.createTextNode(' '))
      }
      row.append(label, bands)
      panel.append(row)
    }
  }

  // The dev client owns the sweep (drives the extension, captures each width);
  // the HUD just reflects in-progress/result state. Keep DevTools closed on the
  // tab — chrome.debugger can't attach otherwise (ADR 0010).
  async function startSweep(): Promise<void> {
    if (sweeping) return
    sweeping = true
    sweepStatus = ''
    render()
    try {
      await globalThis.__XRAY__?.captureAllViews?.()
      sweepStatus = 'Done — coverage updated.'
    } catch (error) {
      sweepStatus = `Failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      sweeping = false
      render()
    }
  }

  // Record every mounted render-prop Skeleton's live `data` to its sidecar (ADR
  // 0015). devalue throws loudly on the unrecordable, and a plain-children
  // Skeleton has no `data` to record; either surfaces as a failed status here.
  async function recordFixtures(
    fixtures: NonNullable<typeof globalThis.__XRAY__>['fixtures'],
  ): Promise<void> {
    if (recording || !fixtures) return
    recording = true
    recordStatus = ''
    render()
    try {
      await fixtures.recordAll()
      recordStatus = 'Fixture recorded.'
    } catch (error) {
      recordStatus = `Failed: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      recording = false
      render()
    }
  }

  // Presence probe: the extension's content script announces itself with a
  // `hello`; the HUD also asks once with a `whois` in case the extension loaded
  // first. Defaults to the promo and flips to the button on the first hello. No
  // timeout, so no false negative.
  const onHudMessage = (event: MessageEvent) => {
    if (event.source !== window) return
    if (isExtensionHello(event.data) && !extensionPresent) {
      extensionPresent = true
      render()
    }
  }
  window.addEventListener('message', onHudMessage)
  window.postMessage({ source: 'xray', kind: 'whois' }, '*')

  // Re-render whenever coverage changes (a capture lands, a plate file changes).
  const unsubscribeCoverage = globalThis.__XRAY__?.coverage?.subscribe(render)
  // Re-render whenever a Fixture is recorded or seeded, so the per-plate marker
  // reflects what's on disk (ADR 0015).
  const unsubscribeFixtures = globalThis.__XRAY__?.fixtures?.subscribe(render)

  render()

  const mount = () => {
    if (document.body) document.body.append(host)
    else document.addEventListener('DOMContentLoaded', () => document.body.append(host))
  }
  mount()

  return {
    dispose() {
      window.removeEventListener('message', onHudMessage)
      unsubscribeCoverage?.()
      unsubscribeFixtures?.()
      host.remove()
    },
  }
}
