/**
 * Type declarations for xray virtual modules.
 *
 * Reference from the consuming app, e.g. in tsconfig: `"types": ["@hueest/xray/virtual"]`, or per
 * file: `/// <reference types="@hueest/xray/virtual" />`.
 *
 * @module @hueest/xray/virtual
 */

/**
 * Import a committed or not-yet-captured Plate by name.
 *
 * The import specifier is the Plate identity: `virtual:xray/plates/my-banner` reads and writes
 * `plates/my-banner.json`, and that name travels with the imported Plate. Pass the imported Plate
 * to `<Skeleton>`; do not repeat the name in props.
 *
 * A name is one or more `/`-separated path segments, each `\w+(-\w+)*` — word chars with single
 * interior hyphens. A segment may not contain `--` or a leading/trailing hyphen: the generated
 * class prefix renders `/` as `--` to keep nested names readable, and banning those forms keeps the
 * encoding collision-free (it is the isolation boundary across stitched Plates).
 *
 * If the file does not exist yet, the Vite plugin resolves an empty Plate with the same name so
 * `<Skeleton fallback={...}>` can render until the first Capture writes the file. Nested
 * `<Skeleton>` boundaries become Stitches; the generated virtual module wires child Plates into
 * `Plate.refs`, so production rendering follows the static import graph with no global registry.
 *
 * Captured Plate files are source artifacts. Commit files under `plates/` with the component change
 * they describe.
 */
declare module 'virtual:xray/plates/*' {
  import type { Plate } from '@hueest/xray'

  /**
   * The captured Plate named by the `virtual:xray/plates/<name>` import specifier.
   *
   * Enable this import in a consuming app with `"types": ["@hueest/xray/virtual"]` in tsconfig, or
   * with a per-file `/// <reference types="@hueest/xray/virtual" />` directive.
   *
   * The specifier maps to a file under `plates/`; for example, `virtual:xray/plates/my-banner` maps
   * to `plates/my-banner.json`. If that file does not exist yet, the plugin returns an empty Plate
   * with the same name so a `<Skeleton fallback={...}>` can render until the first Capture. Pass
   * the imported Plate to `<Skeleton>`; do not repeat the name in props.
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
