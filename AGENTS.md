# AGENTS.md

## Quality gates

- `pnpm run format` format the whole repo, run before anything else
- `pnpm run lint` for oxlint linting with type-checking repo-wide
- `pnpm run typecheck` for additional type-checks not covered by oxlint
- `pnpm run test` for vitest
- `pnpm run build` to confirm apps and packages build cleanly

## Where the docs live

The root keeps only `README.md`. Internal docs sit in `docs/`; the public-facing
trio ships as website pages under `apps/website/src/content/docs/`:

| Doc                     | Path                                            | Skill             |
| ----------------------- | ----------------------------------------------- | ----------------- |
| Product brief           | `docs/PRODUCT.md`                               | `$impeccable`     |
| Design system           | `docs/DESIGN.md`                                | `$impeccable`     |
| Decision records (ADRs) | `docs/adr/NNNN-*.md`                            | `grill-with-docs` |
| Domain glossary         | `apps/website/src/content/docs/glossary.md`     | `grill-with-docs` |
| Architecture map        | `apps/website/src/content/docs/architecture.md` | —                 |
| Roadmap                 | `apps/website/src/content/docs/roadmap.md`      | —                 |

`docs/` filenames are UPPERCASE (`PRODUCT.md`, `DESIGN.md`); ADRs and website
content keep lowercase-kebab names. The website pages are public-facing: keep
their tone public and their links either site-relative or pointing at
`github.com/hueest/xray`.

## Skill-flow overrides

- **`$impeccable`** — `PRODUCT.md` and `DESIGN.md` live in `docs/`. The bundled `context.mjs` finds them there automatically via its built-in `docs/` fallback, so no env var or config is needed. Edit them in place; never recreate them at the repo root.
- **`grill-with-docs`** — the glossary is `apps/website/src/content/docs/glossary.md` (override the root default); decision records are in `docs/adr/`. Sharpen terms in the glossary page.
- **`.impeccable/` stays at the repo root.** Its scripts hardcode `cwd/.impeccable` (config, the edit-hook caches, critique storage, live mode) with no override, so moving it breaks the tooling. Treat it as tool data (like `.git` / `.astro`), not a doc. `.impeccable/design.json` is the machine mirror of `docs/DESIGN.md`.

## Design work → ADRs

Design intent lives in the roadmap (website); when work ships, its load-bearing
decisions land in the relevant ADR (`docs/adr/`) and the resulting state in the
architecture page. There is no separate plans directory.
