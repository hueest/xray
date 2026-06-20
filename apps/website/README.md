# xray-website

The landing and documentation site for [@hueest/xray](../../packages/xray):
Astro + Starlight, with the "Reading Room" radiograph theme in
`src/styles/theme.css`.

```sh
pnpm --filter xray-website dev       # dev server
pnpm --filter xray-website build     # production build
pnpm --filter xray-website typecheck # astro check
```

The theme is system-driven (no toggle): dark is the backlit film, light is its
negative. See [`docs/DESIGN.md`](../../docs/DESIGN.md) for the visual system.

## Deploy

The site is a static Astro build served by Cloudflare Workers Static Assets
(`wrangler.jsonc`: `assets.directory` = `./dist`, no Worker script), not
Cloudflare Pages. Deploying is a maintainer-owned, credentialed step; this
section documents the commands, it does not run them.

```sh
pnpm --filter xray-website build     # → apps/website/dist/
cd apps/website
wrangler deploy                      # reads wrangler.jsonc; requires `wrangler login`
```

`wrangler deploy` publishes to the `xray-website` Workers project on the
account authenticated via `wrangler login` / `CLOUDFLARE_API_TOKEN`. First
deploy from a fresh account creates the project; subsequent deploys update it.

### Custom domain (xray-js.dev)

One-time, in the Cloudflare dashboard (or `wrangler` with an API token scoped
to the zone) once the Workers project exists:

1. Add `xray-js.dev` as a custom domain on the `xray-website` Worker
   (Workers & Pages → xray-website → Settings → Domains & Routes → Add →
   Custom Domain). Cloudflare provisions the DNS record and TLS certificate
   automatically when the zone is on the same account.
2. Confirm `astro.config.mjs`'s `site: 'https://xray-js.dev'` matches (it
   does; no config change is needed once the domain is attached).
3. Allow a few minutes for certificate issuance before checking the domain.

### Post-deploy checklist

- [ ] `https://xray-js.dev/` loads (home page, Hero renders, no console errors).
- [ ] A guide page renders, e.g. `https://xray-js.dev/guides/responsive-views/`.
- [ ] A TypeDoc reference page renders, e.g.
      `https://xray-js.dev/reference/api/xray/`, with linked types resolving.
- [ ] `https://xray-js.dev/llms.txt` returns 200 (not the Starlight 404 page).
- [ ] `https://xray-js.dev/sitemap-index.xml` returns 200.
- [ ] Outbound links resolve: the GitHub CTA/footer link
      (`https://github.com/hueest/xray`) and the npm link used in docs
      (`https://www.npmjs.com/package/@hueest/xray`) both 200.
- [ ] Search works (Pagefind index built during `astro build`).
- [ ] Dark/light theme follows the system preference (no toggle by design).
