/*
 * Single source of truth for the project's outbound links — the repo and the
 * `@hueest/xray` package are published, and these point at the live targets.
 * Update them HERE once, and every consumer follows: the Starlight social link
 * (astro.config), the hero "View on GitHub" CTA + install chip (Hero.astro), and
 * the footer + the "Go deeper" GitHub card (index.astro).
 */
export const GITHUB = 'https://github.com/hueest/xray'
export const NPM = 'https://www.npmjs.com/package/@hueest/xray'
export const INSTALL = 'pnpm add @hueest/xray'

// The llms.txt entry point (https://llmstxt.org): a machine-readable index of the
// docs for coding agents. Same-origin, served from the site root
// (apps/website/public/llms.txt — keep it in step with the docs pages).
export const LLMS_TXT = '/llms.txt'
