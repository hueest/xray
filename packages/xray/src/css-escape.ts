/**
 * Dependency-free raw-text safety for the one place a Plate's CSS string is interpolated into
 * `<style>…</style>` markup.
 *
 * A plate's `css` is normally produced by the capture path (`filterLayoutDecls` + `classify`),
 * which only ever emits well-formed `selector { prop: value }` rules — never a raw-text terminator.
 * But a committed `plates/<name>.json` is UNTRUSTED at render time (it can be hand-edited or arrive
 * over git, ADR 0023), and a corrupt/malicious `css` could carry a `</style>` or an HTML comment
 * delimiter. `<style>` is a raw-text element: the parser ends the element at the first `</style` it
 * sees and resumes parsing the rest as ordinary HTML, so an unescaped terminator in the CSS body
 * turns the tail of the plate into live markup.
 *
 * The React text-child path (`<style>{css}</style>`) is already safe — React escapes the child —
 * but the two STRING paths interpolate `css` directly into a markup string (`renderPlateHtml`
 * builds an HTML string; `react.core.tsx` feeds one to `dangerouslySetInnerHTML`). Those must run
 * the body through this helper first.
 *
 * This lives in its own dependency-free module ON PURPOSE: it is imported by render/browser paths,
 * so it must NOT pull in the Node-only validation code (valibot). It neutralizes only the sequences
 * that can escape a raw-text `<style>` context — a `<` that begins `</style`, and the HTML comment
 * / CDATA delimiters the tokenizer treats specially inside raw text — by inserting a CSS-comment
 * break (`/​**​/`) that the CSS parser ignores. It does not, and is not meant to, sanitize CSS
 * semantically; POST-time validation (`validate.ts`) is what rejects junk declarations.
 *
 * @module
 */

/**
 * Make a CSS body safe to interpolate into a `<style>…</style>` STRING. Breaks up the only
 * sequences the HTML tokenizer acts on inside a raw-text `<style>` element, so none can terminate
 * the element early or open a comment/CDATA run:
 *
 * - `</style` (the end-tag open, case-insensitive) — inserts the break between `<` and `/style` so
 *   the parser never matches the end tag.
 * - `<!--`, `-->`, `<![CDATA[` — the comment/CDATA delimiters; split so neither a comment nor a CDATA
 *   section can open.
 *
 * The inserted `/​**​/` is an empty CSS comment: inert to the CSS parser (it cannot appear
 * mid-token in a value the capture emits, and a stray one only ends a token early), so a
 * well-formed plate is rendered byte-for-byte equivalently while a corrupt one can no longer break
 * out of the style element.
 */
export function escapeStyleText(css: string): string {
  return css
    .replace(/<(\/style)/gi, '</**/$1')
    .replace(/<!--/g, '<!/**/--')
    .replace(/-->/g, '--/**/>')
    .replace(/<!\[CDATA\[/g, '<![/**/CDATA[')
}
