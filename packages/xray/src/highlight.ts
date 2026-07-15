import { boxOf } from './blink.ts'

/**
 * The dev-only boundary highlight: a steel-outlined, backlit overlay over a mounted plate's capture
 * box while its HUD row is hovered or focused. A persistent sibling of the Blink (which is a
 * one-shot expose): same box geometry, but it TRACKS — the box is re-read every animation frame
 * while active, so scrolling, resizes, and content changes under the cursor keep the outline glued
 * to the element. One highlight at a time (hover semantics): highlighting a second name replaces
 * the first. `pointer-events: none`, fixed, just under the HUD; never touches capture.
 */

const STYLE_ID = 'xr-highlight-style'

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .xr-highlight {
      position: fixed; pointer-events: none; z-index: 2147483645;
      border-radius: 4px;
      border: 2px solid oklch(0.62 0.11 246);
      box-shadow: 0 0 14px oklch(0.62 0.11 246 / 0.5), inset 0 0 10px oklch(0.62 0.11 246 / 0.25);
      transition: opacity 120ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .xr-highlight { transition: none }
    }
  `
  ;(document.head ?? document.documentElement).append(style)
}

/**
 * Build the `__XRAY__.highlight(name, on)` closure over a resolver from plate name to the writing
 * site's element (the first in document order — the same instance a capture would write from). The
 * resolver is consulted every frame, so a site unmounting mid-highlight fades the overlay out
 * rather than orphaning it, and a writer handoff re-targets the outline automatically.
 */
export function createHighlighter(resolve: (name: string) => Element | undefined): {
  set: (name: string, on: boolean) => void
  dispose: () => void
} {
  let active: { name: string; overlay: HTMLDivElement; raf: number } | undefined

  const clear = (): void => {
    if (!active) return
    cancelAnimationFrame(active.raf)
    active.overlay.remove()
    active = undefined
  }

  const set = (name: string, on: boolean): void => {
    if (typeof document === 'undefined') return
    if (!on) {
      // Clear only when the request names the CURRENT highlight: a stale mouseleave arriving
      // after the pointer already entered another row must not kill the new row's outline.
      if (active?.name === name) clear()
      return
    }
    if (active?.name === name) return
    clear()
    ensureStyle()
    const overlay = document.createElement('div')
    overlay.className = 'xr-highlight'
    overlay.style.opacity = '0'
    ;(document.body ?? document.documentElement).append(overlay)
    const entry = { name, overlay, raf: 0 }
    active = entry
    const track = (): void => {
      if (active !== entry) return
      const el = resolve(name)
      const box = el?.isConnected ? boxOf(el) : null
      if (box) {
        overlay.style.opacity = '1'
        overlay.style.left = `${box.left - 2}px`
        overlay.style.top = `${box.top - 2}px`
        overlay.style.width = `${box.width}px`
        overlay.style.height = `${box.height}px`
      } else {
        overlay.style.opacity = '0'
      }
      entry.raf = requestAnimationFrame(track)
    }
    track()
  }

  return { set, dispose: clear }
}
