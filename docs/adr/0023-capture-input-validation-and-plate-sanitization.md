---
status: accepted
---

# The capture boundary and committed Plates are both untrusted

> **Builds on [ADR 0008](./0008-framework-agnostic-core-thin-adapters.md)
> (validation is Node-only, never in a browser bundle) and
> [ADR 0022](./0022-uniform-pass-pipeline.md) (the in-browser Serialize posts one
> finished `StoredPlate`). Keeps ADR 0006 isolation: the validator never reaches
> past a stitch.**

The dev `/__xray` endpoint is local, unauthenticated, and writes files. Two
inputs feed the render path and neither can be trusted on its face: the **POST
payload** (any process on the machine can hit the endpoint) and the **committed
`plates/<name>.json`** (hand-edited, or arriving over a git checkout). A
malformed `css` string is the sharp edge: it lands inside a raw-text
`<style>…</style>`, where the first `</style` ends the element and the rest of
the Plate parses as live HTML. Accept only the artifact shape xray itself
produces, and make a corrupt Plate degrade, never break out.

## Decision

### 1. The endpoint accepts only a finished `StoredPlate`

The dev client projects the whole Plate in the browser (ADR 0022) and posts it
inside a `{ plate, diagnostics? }` envelope. There is no server-side merge, so
`parseStoredPlate` is the single structural validator: `v` pinned to
`PLATE_VERSION`, `name` through `isValidPlateName`, `breakpoints` finite and
non-negative (bounded, **not** renormalized: the file is the source of truth),
the post-classify `RenderNode` `tree`, and the already-classified `css` blob.
`diagnostics` is a **sibling** field, logged to the server output and then
dropped; it never reaches disk.

Validation is **valibot for structure, hand-rolled predicates for the security
boundary**: `storedPlateSchema` / `renderNodeSchema` assert the shape, and
`v.check(...)` wires in the bespoke guards (`treeWithinLimits`, `isValidPlateCss`)
that a schema cannot express. `parseStoredPlate` returns the typed plate or
`null` on any failure.

### 2. Cheap front-door caps before a byte is buffered

`handleCapturePost` rejects non-`POST` (405), non-`application/json` (415), and a
`content-length` over `MAX_BODY_BYTES` (413) up front. The byte cap is **also**
re-counted while streaming (in bytes, not chars) and the request torn down once
exceeded, so a lying or absent `content-length` cannot slip an oversized body
into memory. A validated plate that serializes past `MAX_PLATE_BYTES` is refused
(413); that size means the `<Skeleton>` sits too high. Structural ceilings
(`MAX_TREE_NODES`, `MAX_TREE_DEPTH`, `MAX_BREAKPOINTS`, `MAX_TEMPLATE_COUNT`)
bound the tree so a long thin chain or a fanned-out payload cannot exhaust memory
or drive an unbounded `.repeat`.

Because both write paths (Plate capture, Fixture sidecar) put files in the
consumer's working tree, a browser POST must also be **same-origin**:
`isSameOriginWrite` requires an `Origin` whose host equals the request's `Host`,
port included — correct for localhost, LAN IPs, and `*.localhost` aliases with
zero config. A request with **no** Origin header is allowed (curl, node
scripts — the gate targets drive-by browser writes, not local tooling), while
`Origin: null` is rejected. A mismatch gets a generic 403 with the offending
origin named server-side only, keeping the never-echo discipline; probed
userinfo, subdomain, and port bypasses all fail closed. GET routes carry no
CORS headers, which is already the read protection.

### 3. CSS raw-text safety is belt **and** braces

A Plate's `css` can never be allowed to terminate the `<style>` it renders into.
Two independent layers, because either input can carry a terminator:

- **Braces (validate-time):** `isValidPlateCss` rejects a `css` blob containing
  `</style`, the HTML comment/CDATA delimiters (`<!--`, `-->`, `<![CDATA[`), or a
  NUL. It is the **whole-blob** guard, not the per-declaration allowlist: a
  finished `css` legitimately carries braces, newlines, and bare `<`/`>` (Media
  Queries Level 4 range syntax), so the per-decl allowlist would reject every
  real plate.
- **Belt (render-time):** `escapeStyleText` (its own dependency-free module, so no
  valibot leaks into a render/browser path) neutralizes the same terminators by
  splicing an inert empty CSS comment (`/​*​*​/`) into them, for the two string
  paths that interpolate `css` raw (`renderPlateHtml`, `react.core.tsx`'s
  `dangerouslySetInnerHTML`). React's text-child `<style>{css}</style>` path is
  already safe.

### 4. A corrupt committed Plate degrades to empty with a named warning

Disk reads run the **same** `parseStoredPlate` a POST does. A file that is
missing is the normal pre-capture state; a file that is **present but unreadable**
(corrupt JSON, wrong shape, version mismatch, an injected terminator) resolves to
an empty Plate and warns — in dev and at build — through the shared diagnostics
formatter (`invalid-plate-file`). The warning **names the file only**; no payload,
CSS, or parser message is ever echoed back, on disk or to the client (every error
response is generic).

### 5. The validators stay private

`parseStoredPlate` and the schemas are not exported from any public subpath, and
`validate.ts` is Node-only (imported solely by the Vite plugin built with
`platform: 'node'`), keeping valibot out of every browser-facing dist chunk (ADR
0008). The **capture-time** allowlist the browser applies while building the
`css` blob is `filterLayoutDecls` / `isLayoutProp` in `css.ts` (browser-bundled,
valibot-free). The parallel per-declaration / per-condition checkers
(`isValidDeclaration`, `isValidCondition`) are module-level exports of the
private Node-only `validate.ts` with no importer — not the allowlist the browser
runs, and not part of the POST/disk path. No `StoredPlate`-validation surface is
published until a `doctor`-style tool creates a concrete external need.

## Considered alternatives

- **Trust committed Plates; validate only the POST.** Rejected: a Plate is
  hand-editable and travels through git, so POST-time validation is necessary but
  not sufficient. The render path independently escapes `<style>` terminators for
  exactly this reason.
- **Per-declaration allowlist over the posted payload.**
  Superseded by ADR 0022: the wire shape is a finished, classified
  `css` blob, not a `rules[].decls` array, so `isValidDeclaration` cannot apply to
  it — it would reject every real plate. The allowlist moved to capture time in
  the browser; the POST guards only the `<style>`-breakout boundary.
- **A header/nonce on the endpoint.** Deferred: the endpoint is local and
  unauthenticated, so a forgeable header buys little. The same-origin gate covers
  the drive-by browser case a nonce would; structural validation and the
  byte/method/size caps are the rest of the hardening.
- **Pure hand-rolled or pure valibot.** Rejected both ways: valibot expresses the
  shape concisely; the breakout and depth/budget checks need bespoke predicates a
  schema cannot state, wired in via `v.check`.
- **Escape at render only (drop validate-time `isValidPlateCss`).** Rejected:
  keeping both means a corrupt plate is caught at the door (and the file warned
  about) rather than silently rendered through the escaper every paint.

## Consequences

- `/__xray` is hardened: method/content-type/declared-and-streamed-size caps, a
  same-origin gate on writes, one `parseStoredPlate` validator for both the POST
  and disk reads, generic error responses (400 / 403 / 413 / 405 / 415) that
  never echo input.
- A malformed or hostile Plate — posted or committed — degrades to empty with a
  file-named warning and can never smuggle a `<style>`-escaping `css` blob through
  render.
- `validate.ts` is a Node-only seam; valibot ships in no browser bundle. The
  raw-text escaper lives apart so render paths stay valibot-free.
- The `StoredPlate` validator stays private; the capture-time allowlist the
  browser runs is `filterLayoutDecls` / `isLayoutProp` in `css.ts`. A future
  `doctor` tool is the trigger to make a validation surface public.
