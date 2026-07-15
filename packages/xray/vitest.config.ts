import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// The HUD is the ONE Solid-compiled surface (tsdown builds it in its own config;
// see tsdown.config.ts). Mirror that here: the Solid transform applies ONLY to the
// hud sources and their tests — the React adapters keep the default TSX transform.
export default defineConfig({
  plugins: [solid({ include: ['**/hud.tsx', '**/hud.test.tsx'] })],
  test: {
    // vite-plugin-solid injects `environment: 'jsdom'` when none is set; this
    // package runs node by default with per-file `@vitest-environment happy-dom`
    // pragmas, and jsdom is not installed. Pin the default back.
    environment: 'node',
    // Solid ships real ESM with browser/dev conditions; inline it so the transform
    // and conditions resolve consistently under vitest.
    server: { deps: { inline: [/solid-js/, /@solidjs/] } },
  },
})
