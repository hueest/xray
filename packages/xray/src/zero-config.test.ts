/**
 * ADR 0032's zero-config promise + ADR 0033/0034's derived typing, pinned end-to-end: a stock
 * consumer (tsconfig `include: ["src"]`, no xray wiring anywhere) gets typed
 * `virtual:xray/plates/*` imports from nothing but the files the plugin generates — the one
 * generated `xray-env.gen.d.ts` carries the wildcard reference plus a per-plate declare block whose
 * `typeof import('./<name>').fixture` beats the wildcard, a recorded Fixture lands as the plate
 * module's `as const` `fixture` export, and the consumer's own compiler reads LITERAL fields off
 * the import.
 *
 * `@hueest/xray` resolves by symlinking the REAL package directory into the consumer's
 * `node_modules`, so the check exercises the actual package.json `exports` (`./virtual` →
 * virtual.d.ts, `.` → dist types) under `moduleResolution: "bundler"`. That needs the built dist,
 * which exists whenever tests run after an install (`prepare`) — the same gate dist-isolation
 * uses.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import { renderEnvFile } from './plate-source.ts'
import { callable } from './test-helpers.ts'
import { handleFixturePost, xrayVitePlugin } from './index.ts'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const hasDist = existsSync(join(packageDir, 'dist', 'index.d.ts'))

/** Run the dev-server start hooks against `root`, generating the env file. */
function startDevServer(root: string): void {
  const ctx = { addWatchFile: () => {} }
  const [data, dev] = xrayVitePlugin()
  callable<(config: { root: string }) => void>(data?.configResolved).call(ctx, { root })
  const server = {
    watcher: { add: () => {}, on: () => {} },
    middlewares: { use: () => {} },
    ws: { send: () => {} },
    config: { logger: { warn: () => {} } },
  }
  callable<(server: unknown) => void>(dev?.configureServer).call(ctx, server)
}

/** POST a fixture Record for `demo` the way the dev client does (ADR 0033/0034). */
async function recordFixture(root: string): Promise<void> {
  const listeners: Record<string, (chunk?: Buffer | string) => void> = {}
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event: 'data' | 'end', cb: (chunk?: Buffer | string) => void) {
      listeners[event] = cb
    },
    destroy() {},
  }
  const res = { statusCode: 0, end: () => {} }
  const done = handleFixturePost(req, res, (name) => join(root, 'src', 'plates', `${name}.ts`))
  // devalue.stringify of { kind: 'news', id: 1 } — a discriminant-shaped record.
  listeners.data?.(
    Buffer.from(JSON.stringify({ name: 'demo', data: '[{"kind":1,"id":2},"news",1]' })),
  )
  listeners.end?.()
  await done
  if (res.statusCode !== 204) throw new Error(`fixture POST failed: ${res.statusCode}`)
}

describe('zero-config typed plates (ADR 0032 + 0034 e2e)', () => {
  it('a stock include:["src"] consumer typechecks typed and wildcard plate imports untouched', async () => {
    // A silent skip here would let the suite pass without exercising the
    // package-export contract at all; the build gate runs before tests, so a
    // missing dist is a broken checkout, not an acceptable state.
    expect(hasDist, 'dist/index.d.ts missing: run pnpm build first').toBe(true)
    const app = mkdtempSync(join(tmpdir(), 'xray-zero-config-'))
    try {
      // The minimal stock consumer: standard include, default `types` untouched —
      // no xray wiring anywhere in the tsconfig.
      writeFileSync(
        join(app, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['src'],
        }),
      )
      mkdirSync(join(app, 'src'), { recursive: true })
      // `demo` has a recorded fixture: the env file types its import as
      // `Plate<F>` with `F` the plate module's as-const `fixture` export, so
      // extracting `F` yields LITERAL fields satisfying a discriminant union —
      // none of which compiles under the bare wildcard (`F` is `unknown`
      // there, asserted below). `other` has no fixture: it resolves ONLY
      // through the env file's wildcard reference. The phantom anchor is a
      // tilde-keyed type-only member, so `F` is read through inference,
      // never as a runtime-looking property.
      writeFileSync(
        join(app, 'src', 'main.ts'),
        [
          "import type { Plate } from '@hueest/xray'",
          "import plate from 'virtual:xray/plates/demo'",
          "import other from 'virtual:xray/plates/other'",
          '',
          'type Recorded = typeof plate extends Plate<infer F> ? F : never',
          'type OtherF = typeof other extends Plate<infer F> ? F : never',
          'type Expect<T extends true> = T',
          "export type KindIsLiteral = Expect<Recorded['kind'] extends 'news' | 'auction' ? true : false>",
          "export type IdIsLiteral = Expect<Recorded['id'] extends number ? true : false>",
          'export type OtherUnchecked = Expect<unknown extends OtherF ? true : false>',
          'export const otherName: string = other.name',
          '',
        ].join('\n'),
      )
      // The real package, exports and all, resolvable from the consumer.
      mkdirSync(join(app, 'node_modules', '@hueest'), { recursive: true })
      symlinkSync(packageDir, join(app, 'node_modules', '@hueest', 'xray'), 'dir')

      // Everything xray contributes: the dev-server-start generation + one Record.
      startDevServer(app)
      // The start-time regeneration is fire-and-forget async and sees no plates
      // yet; wait for its write so it cannot race the fixture-bearing one below.
      const envFile = join(app, 'src', 'plates', 'xray-env.gen.d.ts')
      await vi.waitFor(() => {
        expect(existsSync(envFile)).toBe(true)
      })
      await recordFixture(app)
      // In a live dev server the watcher event for the demo.ts write drives this
      // regeneration (covered by the unit tests); the e2e writes the same
      // rendered content through the same exported renderer.
      writeFileSync(envFile, renderEnvFile(['demo']))

      const configFile = ts.readJsonConfigFile(join(app, 'tsconfig.json'), (path) =>
        ts.sys.readFile(path),
      )
      const parsed = ts.parseJsonSourceFileConfigFileContent(configFile, ts.sys, app)
      expect(parsed.errors).toEqual([])
      // The stock include glob covers the plate module and the generated env file.
      const basenames = parsed.fileNames.map((file) => file.split('/').at(-1))
      expect(basenames).toEqual(expect.arrayContaining(['main.ts', 'xray-env.gen.d.ts', 'demo.ts']))
      const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map(
          (d) =>
            `${d.file?.fileName ?? '<global>'}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
        )
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(app, { recursive: true, force: true })
    }
  })
})
