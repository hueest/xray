import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Build-output isolation pins. The dist exists whenever tests run after an install (`prepare`
 * builds it); a source-only checkout skips rather than fails.
 *
 * - Solid is the HUD's framework and NOTHING else's: it must be bundled into `hud.js` (the consumer
 *   resolves no Solid package) and reach no other chunk (ADR 0028). The `@solidjs` package marker
 *   survives bundling in rolldown's region comments and the runtime's own strings.
 * - Pretext is the capture-side text oracle (ADR 0019): the prod React adapter must not carry it.
 */

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const hasDist = existsSync(join(distDir, 'hud.js'))

describe.skipIf(!hasDist)('dist chunk isolation', () => {
  const jsFiles = () => readdirSync(distDir).filter((f) => f.endsWith('.js'))
  const read = (f: string) => readFileSync(join(distDir, f), 'utf8')

  it('bundles Solid into hud.js and into no other chunk', () => {
    expect(read('hud.js')).toContain('@solidjs')
    for (const file of jsFiles()) {
      if (file === 'hud.js') continue
      expect(read(file), `${file} must not carry Solid`).not.toContain('@solidjs')
    }
  })

  it('keeps pretext out of the prod React adapter chunks', () => {
    for (const file of ['react.js', 'react.dev.js']) {
      const code = read(file)
      expect(code, `${file} must not carry pretext`).not.toContain('pretext')
      expect(code).not.toContain('@chenglou')
    }
  })
})
