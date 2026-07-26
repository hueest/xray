/**
 * Type declarations for xray virtual modules.
 *
 * Wired automatically: the plugin generates `src/plates/xray-env.gen.d.ts` (commit it), whose `///
 * <reference types="@hueest/xray/virtual" />` directive makes these declarations part of the
 * program. For a manual or non-standard setup, add that same triple-slash reference line to any
 * ambient `.d.ts` the tsconfig includes (such as `src/vite-env.d.ts`). Avoid `"types":
 * ["@hueest/xray/virtual"]` in tsconfig: setting the `types` array replaces its default, which
 * silently drops `vite/client` in stock Vite templates.
 *
 * The wildcard declaration below lives here; the path-specific declarations (one per
 * fixture-bearing plate) are generated into `xray-env.gen.d.ts` (ADR 0034). That file is
 * codegen-owned and re-rendered whenever Fixtures change; do not edit it, and put your own ambient
 * types in your own files. If a lint rule flags the triple-slash reference, silence the rule for
 * the file; do not delete the directive.
 *
 * @module @hueest/xray/virtual
 */

/**
 * Import a committed or not-yet-captured Plate by name.
 *
 * The import specifier is the Plate identity: `virtual:xray/plates/my-banner` reads and writes the
 * plate module `src/plates/my-banner.ts`, and that name travels with the imported Plate. Pass the
 * imported Plate to `<Skeleton>`; do not repeat the name in props.
 *
 * A name is one or more `/`-separated path segments, each `\w+(-\w+)*`: word chars with single
 * interior hyphens. A segment may not contain `--` or a leading/trailing hyphen: the generated
 * class prefix renders `/` as `--` to keep nested names readable, and banning those forms keeps the
 * encoding collision-free (it is the isolation boundary across stitched Plates).
 *
 * If the file does not exist yet, the Vite plugin resolves an empty Plate with the same name so
 * `<Skeleton fallback={...}>` can render until the first Capture writes the file. Nested
 * `<Skeleton>` boundaries become Stitches; the generated virtual module wires child Plates into
 * `Plate.refs`, so production rendering follows the static import graph with no global registry.
 *
 * Typed Fixtures (ADR 0031/0034): the generated `xray-env.gen.d.ts` attaches each recorded
 * Fixture's type to the corresponding Plate import, and `<Skeleton>` checks that type against its
 * `data` prop. Custom setups (a `files`-only tsconfig, a custom Vite `root`) list the plates
 * directory in the tsconfig `include` themselves.
 *
 * Captured Plate files are source artifacts. Commit files under `src/plates/` with the component
 * change they describe.
 */
declare module 'virtual:xray/plates/*' {
  import type { Plate } from '@hueest/xray'

  /**
   * The captured Plate named by the `virtual:xray/plates/<name>` import specifier.
   *
   * The specifier maps to a file under `src/plates/`; for example, `virtual:xray/plates/my-banner`
   * maps to `src/plates/my-banner.ts`. If that file does not exist yet, the plugin returns an empty
   * Plate with the same name so a `<Skeleton fallback={...}>` can render until the first Capture.
   * Pass the imported Plate to `<Skeleton>`; do not repeat the name in props.
   *
   * Child Plates referenced by Stitches are wired into `Plate.refs` by the generated virtual
   * module. Production rendering follows that static import graph with no global Plate registry or
   * runtime name lookup.
   *
   * Captured Plate files are source artifacts. Commit them with the component change they describe.
   */
  const plate: Plate
  export default plate
}
