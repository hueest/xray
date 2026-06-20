import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    dts: true,
    clean: true,
    failOnWarn: true,
    // platform: 'node' defaults fixedExtension to true (.mjs/.d.mts); force the
    // package-type extension instead, so this type:module package emits .js/.d.ts.
    fixedExtension: false,
    // The repo-root LICENSE is the single source; npm only auto-includes a
    // LICENSE at the package root of the tarball, so mirror it there on build.
    copy: { from: '../../LICENSE', to: '.' },
  },
  {
    entry: {
      // The framework-neutral capture/serialize surface ships through `core`
      // (re-exported there); `serialize.ts` is bundled into it as source, so it
      // needs no standalone build entry and no public subpath (the `./serialize`
      // package export was dropped in favour of `@hueest/xray/core`).
      core: 'src/core.ts',
      react: 'src/react.tsx',
      'react.dev': 'src/react.dev.tsx',
      // Dev bootstrap implementation modules. Private: reachable only through the
      // `./internal/*` package subpaths the plugin-generated bootstrap imports,
      // not as top-level public API.
      client: 'src/client.ts',
      hud: 'src/hud.ts',
    },
    format: ['esm'],
    platform: 'browser',
    dts: true,
    clean: false,
    failOnWarn: true,
    fixedExtension: false,
    deps: {
      neverBundle: ['react', 'react/jsx-runtime'],
      alwaysBundle: ['devalue', '@chenglou/pretext'],
    },
    // devalue is a runtime `dependency`, which tsdown would auto-externalize for
    // the browser build. Bundle it INTO the dev-only chunks instead (it is used
    // only by `client.ts`, dev-only — ADR 0015): this keeps the dev client
    // self-contained (no consumer-side devalue resolution for an internal chunk)
    // and matches how valibot is inlined. It stays absent from the prod chunks
    // (`react.js`/`react.dev.js`) because nothing they import references it.
    //
    // @chenglou/pretext is the CAPTURE-SIDE text oracle (ADR 0019 §2): it is
    // imported only by `serialize.ts`, which is bundled into the capture chunks
    // (`core.js`, and `client.js` via the dev capture path) but NOT into the prod
    // react adapter (`react.tsx` imports `serialize.ts` types only, erased at
    // build). Bundling it here keeps those capture chunks self-contained (same
    // reasoning as devalue) AND, because `react.js` reaches no runtime serialize
    // code, keeps pretext out of the production bundle entirely — the ADR's hard
    // constraint. Verified post-build: `react.js` contains no pretext symbols.
    // Package-quality validation runs on THIS config because it builds last, so
    // every dist file the exports map names exists when the checks read them.
    // publint checks package.json against the emitted files; attw checks the
    // declarations across resolvers — esm-only profile, as the package ships
    // no require condition (type: module, import-only exports).
    publint: true,
    attw: { profile: 'esm-only', level: 'error' },
  },
])
