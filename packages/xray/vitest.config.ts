import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// The HUD is the ONE Solid-compiled surface (tsdown builds it in its own config;
// see tsdown.config.ts). Mirror that here: the Solid transform applies ONLY to the
// hud sources and their tests — the React adapters keep the default TSX transform.
export default defineConfig({
  plugins: [solid({ include: ['**/hud.tsx', '**/hud.test.tsx'] })],
  // @solidjs/web 2.0 points its `node` condition at the server build, where
  // `render` throws. The HUD tests mount for real, so they need the browser one.
  resolve: { conditions: ['development', 'browser'] },
  test: {
    // vite-plugin-solid injects `environment: 'jsdom'` when none is set; this
    // package runs node by default with per-file `@vitest-environment happy-dom`
    // pragmas, and jsdom is not installed. Pin the default back.
    environment: 'node',
    server: {
      deps: {
        // Solid ships real ESM with browser/dev conditions; inline it so the transform
        // and conditions resolve consistently under vitest.
        inline: [/solid-js/, /@solidjs/],
        // The server reads plate modules with a native `import(fileURL + '?t=' + mtime)`
        // (ADR 0034 §3). Vitest's module runner would otherwise intercept it, strip the
        // integer half of the `?t=` query (Vite's own timestamp param), and hand oxc an
        // id like `banner.ts?.1123` — parsed as JS, where the fixture's `as const`
        // fails. Externalizing the test tmp dirs (every mkdtemp prefix here is `xray-`)
        // routes those imports to Node's own loader, the same path the real dev server
        // takes.
        external: [/[\\/]xray-[^\\/]*[\\/]/],
      },
    },
  },
})
