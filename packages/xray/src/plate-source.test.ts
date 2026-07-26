import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as devalueParse, stringify as devalueStringify } from 'devalue'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { StoredPlate } from './plate.ts'
import { renderPlateSourceModule } from './plate-source.ts'

/**
 * Every rendered module starts with the codegen header (ADR 0034 §4). Assert only the load-bearing
 * directive, not the prose (editing a comment must not break value-rendering tests), and strip the
 * block so the assertions below stay about the sections.
 */
function stripHeader(text: string): string {
  expect(text).toMatch(/^\/\* eslint-disable \*\//)
  const end = text.indexOf('\n\n')
  expect(end).toBeGreaterThan(0)
  return text.slice(end + 2)
}

/** Render a fixture section straight from a live value, the way the wire does. */
function render(value: unknown): string {
  return stripHeader(
    renderPlateSourceModule({ fixturePayload: JSON.parse(devalueStringify(value)) }),
  )
}

/** Render a fixture section from a raw (already-parsed) devalue payload. */
function renderPayload(payload: unknown): string {
  return stripHeader(renderPlateSourceModule({ fixturePayload: payload }))
}

describe('renderPlateSourceModule — the fixture section (ADR 0033/0034)', () => {
  it('renders scalars and objects as an as-const fixture export', () => {
    expect(render({ type: 'news', n: 1, ok: true })).toBe(
      'export const fixture = { type: "news", n: 1, ok: true } as const\n',
    )
    expect(render([1, 'a', null])).toBe('export const fixture = [1, "a", null] as const\n')
    expect(render('hello')).toBe('export const fixture = "hello" as const\n')
  })

  it('renders bare sentinel roots without as const (no literal to assert)', () => {
    expect(render(undefined)).toBe('export const fixture = undefined\n')
    expect(render(Number.NaN)).toBe('export const fixture = NaN\n')
  })

  it('renders devalue specials as constructor text, never instantiating anything', () => {
    // A constructor ROOT carries no `as const` (TS1355 limits const assertions
    // to literals); Set/Map keep their member literals through the ARGUMENT
    // assertion instead, which an outer `as const` would not reach.
    expect(render(new Date(0))).toBe(
      'export const fixture = new Date("1970-01-01T00:00:00.000Z")\n',
    )
    expect(render(new Map([['a', 1]]))).toBe(
      'export const fixture = new Map([["a", 1]] as const)\n',
    )
    expect(render(new Set(['a', 'b']))).toBe(
      'export const fixture = new Set(["a", "b"] as const)\n',
    )
    expect(render(/ab+c/gi)).toBe('export const fixture = new RegExp("ab+c", "gi")\n')
    expect(render(123n)).toBe('export const fixture = 123n as const\n')
    expect(render(new URLSearchParams('a=1&b=2'))).toBe(
      'export const fixture = new URLSearchParams("a=1&b=2")\n',
    )
    expect(render({ score: Number.POSITIVE_INFINITY, neg: -0 })).toBe(
      'export const fixture = { score: Infinity, neg: -0 } as const\n',
    )
  })

  it('omits undefined-valued keys and renders holes as undefined', () => {
    expect(render({ a: 1, gone: undefined })).toBe('export const fixture = { a: 1 } as const\n')
    // eslint-disable-next-line no-sparse-arrays -- the hole IS the case under test
    expect(render([1, , 3])).toBe('export const fixture = [1, undefined, 3] as const\n')
  })

  it('escapes strings and quotes non-identifier keys', () => {
    expect(render({ 'kebab-key': 'say "hi"\n' })).toBe(
      'export const fixture = { "kebab-key": "say \\"hi\\"\\n" } as const\n',
    )
  })

  it('wraps long structures formatter-style', () => {
    const value = {
      activity: { id: 'abc-123', title: 'A reasonably long headline string', pinned: true },
      tags: ['alpha', 'beta'],
    }
    expect(render(value)).toBe(
      [
        'export const fixture = {',
        '  activity: {',
        '    id: "abc-123",',
        '    title: "A reasonably long headline string",',
        '    pinned: true',
        '  },',
        '  tags: ["alpha", "beta"]',
        '} as const\n',
      ].join('\n'),
    )
  })

  it('inlines shared (non-cyclic) references as value-equal duplicates', () => {
    const shared = { id: 1 }
    expect(render({ a: shared, b: shared })).toBe(
      'export const fixture = { a: { id: 1 }, b: { id: 1 } } as const\n',
    )
  })

  it('falls back to hoisted shells typed as any for cycles', () => {
    const cyclic: { self?: unknown; n: number } = { n: 1 }
    cyclic.self = cyclic
    const text = render(cyclic)
    expect(text).toContain('export const fixture = v0 as any')
    expect(text).toContain('v0["self"] = v0')
    expect(text).not.toContain('as const')
  })

  it('hoists a cyclic null-prototype object as a declared container', () => {
    // The wire form devalue emits for a self-referencing Object.create(null):
    // a ["null", key, ref] node whose cycle must hoist like any container's.
    const text = renderPayload(JSON.parse('[["null","self",0]]'))
    expect(text).toContain('const v0: Record<string, unknown> = {}')
    expect(text).toContain('v0["self"] = v0')
    expect(text).toContain('export const fixture = v0 as any')
  })

  it('refuses an own __proto__ key — it would render as a prototype-setting member', () => {
    // devalue cannot emit this shape; the POST endpoint accepts arbitrary JSON, so the
    // renderer must refuse it in both the literal and hoisted forms. JSON.parse is the
    // only way to build the payload: a `{ __proto__: 1 }` literal here would set the
    // test object's prototype instead of an own key — the exact hazard under test.
    expect(() => renderPayload(JSON.parse('[{"__proto__":1},{"evil":2},7]'))).toThrow(
      /unsupported fixture object key/,
    )
    expect(() => renderPayload(JSON.parse('[{"__proto__":1,"self":0},{"evil":2},7]'))).toThrow(
      /unsupported fixture object key/,
    )
    expect(() => renderPayload(JSON.parse('[["null","__proto__",1],{"evil":2},7]'))).toThrow(
      /unsupported fixture object key/,
    )
  })

  it('refuses payloads a render input has no business being', () => {
    expect(() => render(new Uint8Array([1, 2]))).toThrow(/unsupported fixture value type/)
    expect(() => renderPayload('nonsense')).toThrow(/malformed/)
    expect(() => renderPayload([])).toThrow(/malformed/)
  })

  it('round-trips: the rendered literal evaluates to what devalue.parse revives', () => {
    // The module text is meant to produce the SAME value the old devalue seed
    // did. Evaluate the expression (test-only!) and compare against parse.
    const value = {
      when: new Date(0),
      tags: new Map([['a', 1]]),
      set: new Set(['x']),
      items: [{ n: 1 }, { n: 2 }],
      big: 7n,
    }
    const wire = devalueStringify(value)
    const text = stripHeader(renderPlateSourceModule({ fixturePayload: JSON.parse(wire) }))
    // Strip every const assertion (root AND Set/Map arguments): the evaluator
    // is plain JS, and `as const` is erased type syntax.
    const exprText = text
      .replace('export const fixture = ', '')
      .replaceAll(' as const', '')
      .trimEnd()
    // eslint-disable-next-line typescript/no-implied-eval -- test-only evaluation of our own rendered output
    const evaluated: unknown = new Function(`return (${exprText})`)()
    expect(evaluated).toEqual(devalueParse(wire))
  })
})

describe('renderPlateSourceModule — the plate section and the whole module (ADR 0034)', () => {
  const plate: StoredPlate = {
    v: 1,
    name: 'demo',
    breakpoints: [],
    tree: null,
    css: '',
  }

  it('renders the StoredPlate structure as a pretty named plate export', () => {
    expect(stripHeader(renderPlateSourceModule({ plate }))).toBe(
      'export const plate = { v: 1, name: "demo", breakpoints: [], tree: null, css: "" }\n',
    )
  })

  it('renders plate + fixture as two sections, plate export first', () => {
    const text = stripHeader(
      renderPlateSourceModule({
        plate,
        fixturePayload: JSON.parse(devalueStringify({ a: 1 })),
      }),
    )
    expect(text).toBe(
      [
        'export const plate = { v: 1, name: "demo", breakpoints: [], tree: null, css: "" }',
        '',
        'export const fixture = { a: 1 } as const',
        '',
      ].join('\n'),
    )
  })

  it('renders no fixture export for a plate-only module', () => {
    expect(renderPlateSourceModule({ plate })).not.toContain('export const fixture')
  })

  it('refuses a non-finite number in the plate structure', () => {
    expect(() =>
      renderPlateSourceModule({ plate: { ...plate, breakpoints: [Number.POSITIVE_INFINITY] } }),
    ).toThrow(/non-finite number in plate structure/)
  })

  it('refuses an own __proto__ key in the plate structure', () => {
    // Same keyLiteral guard as the fixture side; JSON.parse builds the own key.
    const evil: unknown = JSON.parse(
      '{"v":1,"name":"demo","breakpoints":[],"tree":{"__proto__":{"evil":1}},"css":""}',
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the malformed shape IS the case under test
    expect(() => renderPlateSourceModule({ plate: evil as StoredPlate })).toThrow(
      /unsupported fixture object key/,
    )
  })

  it('round-trips through Node: the module imports back as the plate and revived fixture', async () => {
    const stored: StoredPlate = {
      v: 1,
      name: 'news-feed',
      breakpoints: [390, 768],
      tree: { kids: [{ leaf: 'text-line', cls: 'xr-news-feed-1' }] },
      css: '[data-xr-root] .xr-news-feed-1 { display: flex }',
    }
    const fixtureValue = {
      items: [{ kind: 'news', id: 'item-1', at: new Date(1753305600000) }],
      tags: new Set(['a']),
    }
    const text = renderPlateSourceModule({
      plate: stored,
      fixturePayload: JSON.parse(devalueStringify(fixtureValue)),
    })
    const dir = mkdtempSync(join(tmpdir(), 'xray-plate-source-'))
    try {
      const file = join(dir, 'news-feed.ts')
      writeFileSync(file, text)
      // Node strips the erasable type syntax (`as const`) natively — the same
      // read path the dev server uses (ADR 0034 §3).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test-only import of our own rendered output
      const ns = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
        plate: unknown
        fixture: { items: { at: Date }[] }
      }
      expect(ns.plate).toEqual(stored)
      expect(ns.fixture).toEqual(fixtureValue)
      expect(ns.fixture.items[0]?.at).toBeInstanceOf(Date)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('renderPlateSourceModule — generated output compiles under tsc', () => {
  // Text assertions and the JS round-trip above cannot catch TypeScript-level
  // defects in the output (a const assertion on a constructor root is TS1355;
  // widened Set/Map members false-positive the drift check). This program IS
  // the compile check the committed files face in a consumer's build.
  it('every supported root kind typechecks and Set/Map members stay literal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xray-compile-'))
    try {
      const cases: Record<string, unknown> = {
        obj: {
          kind: 'news',
          states: new Set(['open']),
          tags: new Map([['a', 1]]),
          at: new Date(0),
        },
        'root-date': new Date(0),
        'root-map': new Map([['a', 1]]),
        'root-set': new Set(['open']),
        'root-regexp': /x/g,
        'root-bigint': 7n,
        'root-null': null,
        'root-usp': new URLSearchParams('a=1'),
        'root-url': new URL('https://xray-js.dev/'),
        'root-boxed': Object(3),
        'root-string': 'hello',
      }
      for (const [name, value] of Object.entries(cases)) {
        writeFileSync(
          join(dir, `${name}.ts`),
          renderPlateSourceModule({ fixturePayload: JSON.parse(devalueStringify(value)) }),
        )
      }
      writeFileSync(
        join(dir, 'consumer.ts'),
        [
          "import { fixture as obj } from './obj'",
          "import { fixture as rootSet } from './root-set'",
          "import { fixture as rootMap } from './root-map'",
          '',
          // Literal members satisfying literal-union targets is the drift
          // check's soundness condition (method bivariance carries Set/Map).
          "export const states: Set<'open' | 'closed'> = obj.states",
          "export const kind: 'news' | 'auction' = obj.kind",
          "export const set: Set<'open' | 'closed'> = rootSet",
          "export const map: Map<'a' | 'b', number> = rootMap",
          '',
        ].join('\n'),
      )
      const program = ts.createProgram({
        rootNames: [
          ...Object.keys(cases).map((name) => join(dir, `${name}.ts`)),
          join(dir, 'consumer.ts'),
        ],
        options: {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        },
      })
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map(
          (d) =>
            `${d.file?.fileName ?? '<global>'}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
        )
      expect(diagnostics).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
