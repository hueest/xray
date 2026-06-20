/**
 * Plate-name validation, shared by the Vite plugin (`index.ts`) and the Node-only POST validator
 * (`validate.ts`).
 *
 * Lives in its own dependency-free module so `validate.ts` can reuse it without importing the
 * plugin entry (which would be a cycle), and so the regex stays the single source of truth for what
 * a plate name may be — the same rule the loader, the file watcher, the coverage reader, the POST
 * endpoint, and the ref-graph emitter all gate on.
 *
 * @module
 */

/**
 * Names come from import specifiers and POST bodies — keep them inside the plates dir.
 *
 * Each path segment is `\w+(-\w+)*` — word chars with single interior hyphens, never doubled and
 * never at a segment edge — and segments are joined by `/`. The class-prefix encoder
 * (`classify.ts`) renders `/` as `--` to keep nested names readable, and that prefix is the
 * isolation boundary across stitched plates (ADR 0007), so the encoding must be injective. Banning
 * a literal `--` and any edge hyphen guarantees no `-` ever abuts a `/`, so every `--` in the
 * prefix came from exactly one `/` — making distinct names always map to distinct prefixes (else
 * e.g. `a/-b` and `a-/b` would both encode to `a---b`).
 *
 * @internal
 */
export function isValidPlateName(name: string): boolean {
  return /^\w+(?:-\w+)*(?:\/\w+(?:-\w+)*)*$/.test(name)
}
