/**
 * The BLINK: the dev-only visual that confirms a capture landed and actually CHANGED the stored
 * result. It briefly "exposes" the captured element: a negative invert (`backdrop-filter: invert` —
 * an x-ray is a negative) that enters sharply and fades slower, framed by a soft shadow ring so the
 * captured area is visible. Feedback, not a light show. Under `prefers-reduced-motion` the invert
 * is dropped and only the shadow pulses. Rendered as a transient `position: fixed`,
 * `pointer-events: none` overlay just under the HUD; it never touches the capture pipeline or the
 * captured DOM.
 */

const STYLE_ID = 'xr-flash-style'
const DURATION_MS = 300

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .xr-flash {
      position: fixed; pointer-events: none; z-index: 2147483646;
      border-radius: 4px;
      animation: xr-expose ${DURATION_MS}ms ease-out forwards;
    }
    @keyframes xr-expose {
      /* Sharp in: full invert + ring by ~12% (~36ms). */
      0%   { backdrop-filter: invert(0); box-shadow: 0 0 0 1px rgba(56, 189, 248, 0), 0 0 0 0 rgba(56, 189, 248, 0) }
      12%  { backdrop-filter: invert(1); box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.85), 0 0 14px 1px rgba(56, 189, 248, 0.5) }
      /* Slower fade out (ease-out decelerates the remaining ~88%). */
      100% { backdrop-filter: invert(0); box-shadow: 0 0 0 2px rgba(56, 189, 248, 0), 0 0 14px 1px rgba(56, 189, 248, 0) }
    }
    @keyframes xr-expose-soft {
      0%   { box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.7) }
      100% { box-shadow: 0 0 0 2px rgba(56, 189, 248, 0) }
    }
    @media (prefers-reduced-motion: reduce) {
      .xr-flash { animation: xr-expose-soft ${DURATION_MS}ms ease-out forwards }
    }
  `
  ;(document.head ?? document.documentElement).append(style)
}

/** The element's box, or the union of its children's (a display:contents wrapper has none). */
export function boxOf(el: Element): DOMRect | null {
  const own = el.getBoundingClientRect()
  if (own.width > 0 && own.height > 0) return own
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const child of el.children) {
    const rect = child.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    left = Math.min(left, rect.left)
    top = Math.min(top, rect.top)
    right = Math.max(right, rect.right)
    bottom = Math.max(bottom, rect.bottom)
  }
  return Number.isFinite(left) ? new DOMRect(left, top, right - left, bottom - top) : null
}

/** Blink the radiographic effect over `el`'s box. No-op outside a laid-out DOM. */
export function blinkCapture(el: Element): void {
  if (typeof document === 'undefined') return
  const box = boxOf(el)
  if (!box) return
  ensureStyle()
  const flash = document.createElement('div')
  flash.className = 'xr-flash'
  flash.style.left = `${box.left}px`
  flash.style.top = `${box.top}px`
  flash.style.width = `${box.width}px`
  flash.style.height = `${box.height}px`
  flash.addEventListener('animationend', () => flash.remove(), { once: true })
  ;(document.body ?? document.documentElement).append(flash)
  // Safety net in case the animation never ends (element detached mid-flight).
  setTimeout(() => flash.remove(), DURATION_MS + 200)
}
