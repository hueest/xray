// @ts-check
import { defineConfig, fontProviders } from 'astro/config'
import starlight from '@astrojs/starlight'
import mermaid from 'astro-mermaid'
import starlightTypeDoc, {
  createStarlightTypeDocPlugin,
  typeDocSidebarGroup,
} from 'starlight-typedoc'
// Shared outbound links — single source of truth in src/lib/site.ts.
import { GITHUB } from './src/lib/site.ts'

const [coreTypeDoc, coreTypeDocSidebarGroup] = createStarlightTypeDocPlugin()
const [reactTypeDoc, reactTypeDocSidebarGroup] = createStarlightTypeDocPlugin()
const [virtualTypeDoc, virtualTypeDocSidebarGroup] = createStarlightTypeDocPlugin()

// https://astro.build/config
export default defineConfig({
  site: 'https://xray-js.dev',
  // Astro Fonts API: self-hosts the three families and generates metric-matched
  // fallbacks (size-adjust / ascent-override / …) so the web-font swap causes no
  // reflow (zero CLS). The cssVariable names match what theme.css already
  // consumes, so the <Font> component owns --xrw-font-* and theme.css just uses
  // them. The <Font> tags are injected via the Head override (components.Head).
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: 'Bricolage Grotesque',
      cssVariable: '--xrw-font-display',
      weights: ['200 800'],
      styles: ['normal'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'Public Sans',
      cssVariable: '--xrw-font-body',
      weights: ['100 900'],
      styles: ['normal', 'italic'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.fontsource(),
      name: 'JetBrains Mono',
      cssVariable: '--xrw-font-mono',
      weights: ['100 800'],
      styles: ['normal'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
  integrations: [
    // Must run before starlight so mermaid fences are claimed ahead of
    // expressive-code; autoTheme follows Starlight's data-theme.
    mermaid({ autoTheme: true }),
    starlight({
      title: 'xray',
      tagline: 'Auto-captured skeleton loading screens for Vite.',
      social: [{ icon: 'github', label: 'GitHub', href: GITHUB }],
      // Just the brand theme now — fonts come from the Astro Fonts API.
      customCss: ['./src/styles/theme.css'],
      plugins: [
        starlightTypeDoc({
          entryPoints: ['../../packages/xray/src/index.ts'],
          tsconfig: '../../packages/xray/tsconfig.json',
          output: 'reference/api/xray',
          sidebar: { label: '@hueest/xray' },
          typeDoc: { name: '@hueest/xray', readme: 'none' },
        }),
        coreTypeDoc({
          entryPoints: ['../../packages/xray/src/core.ts'],
          tsconfig: '../../packages/xray/tsconfig.json',
          output: 'reference/api/core',
          sidebar: { label: '@hueest/xray/core' },
          typeDoc: { name: '@hueest/xray/core', readme: 'none' },
        }),
        reactTypeDoc({
          entryPoints: ['../../packages/xray/src/react.tsx'],
          tsconfig: '../../packages/xray/tsconfig.json',
          output: 'reference/api/react',
          sidebar: { label: '@hueest/xray/react' },
          typeDoc: { name: '@hueest/xray/react', readme: 'none' },
        }),
        virtualTypeDoc({
          entryPoints: ['../../packages/xray/virtual.d.ts'],
          tsconfig: '../../packages/xray/tsconfig.json',
          output: 'reference/api/virtual',
          sidebar: { label: '@hueest/xray/virtual' },
          typeDoc: { name: '@hueest/xray/virtual', readme: 'none' },
        }),
      ],
      // Re-theme Expressive Code's diff markers onto the Reading Room palette.
      // Out of the box, ins/del render as saturated green/red — a 4th and 5th hue
      // that breaks the Three-Hue Rule across the whole Get-started section and goes
      // muddy under the light-mode invert. Here additions read as a faint bone
      // luminance lift (steel accent border + glyph) and deletions as a restrained
      // crimson tint, so diffs are carried by luminance + the +/- gutter glyph, not
      // colour alone. Values reference the --xrw-* tokens (defined on :root), so they
      // invert with the rest of the page in light mode.
      expressiveCode: {
        // One dark theme, never switched. Starlight's default pair swaps to a LIGHT
        // syntax theme in light mode, whose pale editor bg the page-wide root invert
        // then flips back to near-black — a dark code island on a light page. Pinned to
        // a single dark theme, code is just another dark surface the one root invert
        // turns into a clean light negative, consistent with the rest of the page.
        // (useStarlightUiThemeColors is left off — with a single theme it post-processes
        // the CSS after EC has computed its stylesheet <link> hash, so the link and the
        // emitted ec.<hash>.css diverge: the link 404s and syntax colours never apply.)
        themes: ['github-dark'],
        styleOverrides: {
          // Starlight forces square frames (borderRadius 0). Round them to the shared box
          // radius so code reads as the same family of box.
          borderRadius: 'var(--xrw-radius-md)',
          textMarkers: {
            markBackground: 'color-mix(in oklab, var(--xrw-accent), transparent 90%)',
            markBorderColor: 'color-mix(in oklab, var(--xrw-accent), transparent 55%)',
            insBackground: 'color-mix(in oklab, var(--xrw-bone), transparent 91%)',
            insBorderColor: 'color-mix(in oklab, var(--xrw-accent), transparent 45%)',
            insDiffIndicatorColor: 'var(--xrw-accent)',
            delBackground: 'color-mix(in oklab, var(--xrw-crimson), transparent 88%)',
            delBorderColor: 'color-mix(in oklab, var(--xrw-crimson), transparent 45%)',
            delDiffIndicatorColor: 'var(--xrw-crimson)',
          },
        },
      },
      // No theme toggle — follow the system (see ThemeSelect override). The
      // splash Hero is overridden to render the WebGL radiograph canvas.
      components: {
        // Inject the Astro <Font> tags (with metric-matched fallbacks) into <head>.
        Head: './src/components/Head.astro',
        Footer: './src/components/Footer.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Hero: './src/components/Hero.astro',
        // No nav bar on the home page; default Header everywhere else.
        Header: './src/components/Header.astro',
      },
      // Overview / How It Works / Install live on the homepage, not as docs pages.
      sidebar: [
        {
          label: 'Guides',
          items: [
            { label: 'Responsive & Views', slug: 'guides/responsive-views' },
            { label: 'Nested skeletons', slug: 'guides/nested-skeletons' },
            { label: 'The HUD & Light Box', slug: 'guides/hud-light-box' },
            { label: 'The Sweep', slug: 'guides/sweep' },
            { label: 'Fixtures', slug: 'guides/fixtures' },
            { label: 'Capture customization', slug: 'guides/capture-customization' },
            { label: 'Display timing', slug: 'guides/display-timing' },
            { label: 'Theming', slug: 'guides/theming' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            typeDocSidebarGroup,
            coreTypeDocSidebarGroup,
            reactTypeDocSidebarGroup,
            virtualTypeDocSidebarGroup,
          ],
        },
        {
          // Grouped in the sidebar only — the slugs stay at the root, so
          // /architecture/, /glossary/, /roadmap/, /status/ keep their short URLs.
          label: 'Project',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Glossary', slug: 'glossary' },
            { label: 'Roadmap', slug: 'roadmap' },
            { label: 'Status', slug: 'status' },
          ],
        },
      ],
    }),
  ],
})
