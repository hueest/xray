/**
 * FLATTEN — Phase-2 passthrough-wrapper collapse (capture-pipeline Phase 2/3).
 *
 * A layout-only container (no paint — containers carry no `xr-leaf`; one child; its box coincident
 * with that child; no margin, `position: static`, no transform) is spliced out and its child
 * hoisted into the normal-flow grandparent: the skeleton renders the same with fewer Bones. Per ADR
 * 0022 §4 Flatten is now ANNOTATE-ONLY: `flattenIR` only SETS `flattened` on the wrappers it would
 * collapse and never touches the tree; `emit` (the sole projection) splices the marked nodes out,
 * hoisting their kids. So each case asserts BOTH the annotation (`flattened` on the right
 * wrapper[s], tree structure untouched) AND the projected `{tree}` `emit` produces (wrapper gone,
 * child hoisted, no rules for the wrapper). Tested directly on a built IR — no DOM/geometry
 * stubbing is needed.
 */
import { describe, expect, it } from 'vitest'

import { flattenIR } from './distil.ts'
import {
  emit,
  EMPTY_STYLE,
  type IRBundle,
  type IRNode,
  type IRRect,
  type LiteStyleDeclaration,
} from './ir.ts'
import type { PlateNode, PlateRule } from './plate.ts'

const BOX: IRRect = { x: 0, y: 0, width: 100, height: 20 }

/** A `LiteStyleDeclaration` from a partial override, the rest empty strings (EMPTY_STYLE). */
function style(over: Partial<LiteStyleDeclaration> = {}): LiteStyleDeclaration {
  return { ...EMPTY_STYLE, ...over }
}

// A passthrough wrapper's computed style: block flow, no margin, static, no transform.
const WRAPPER_STYLE: LiteStyleDeclaration = style({
  display: 'block',
  margin: '0px',
  position: 'static',
  transform: 'none',
})

function leaf(id: number): IRNode {
  return {
    id,
    el: null,
    kind: 'media',
    kids: [],
    depth: 0,
    decls: { fallback: [] },
    style: style(),
    box: BOX,
  }
}

function wrapper(id: number, kids: IRNode[], over: Partial<IRNode> = {}): IRNode {
  return {
    id,
    el: null,
    kind: 'container',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: WRAPPER_STYLE,
    box: BOX,
    ...over,
  }
}

function root(kids: IRNode[], display = 'block'): IRNode {
  return {
    id: 0,
    el: null,
    kind: 'root',
    kids,
    depth: 0,
    decls: { fallback: [] },
    style: style({ display }),
  }
}

/** Project an IR root through `emit` exactly as the capture path does. */
function project(rootNode: IRNode): { tree: PlateNode; rules: PlateRule[] } {
  const bundle: IRBundle = { root: rootNode, extraRules: [] }
  return emit(bundle)
}

/** The ids referenced by the emitted rules (so we can assert a wrapper contributes none). */
function ruleIds(rules: readonly PlateRule[]): Set<number> {
  const ids = new Set<number>()
  for (const rule of rules) for (const id of rule.ids) ids.add(id)
  return ids
}

describe('flattenIR — passthrough wrapper collapse (annotate-only, ADR 0022 §4)', () => {
  it('marks a chain of coincident, no-margin, static wrappers; emit splices them, hoisting the leaf', () => {
    const img = leaf(3)
    const inner = wrapper(2, [img])
    const outer = wrapper(1, [inner])
    const tree = root([outer])
    flattenIR(tree)
    // Annotate-only: every wrapper in the chain is marked, the tree is untouched.
    expect(outer.flattened).toBe(true)
    expect(inner.flattened).toBe(true)
    expect(img.flattened).toBeUndefined()
    expect(tree.kids[0]).toBe(outer) // structure intact — flattenIR never restructures
    expect(outer.kids[0]).toBe(inner)
    expect(inner.kids[0]).toBe(img)
    // Projection: both wrappers gone, leaf hoisted into the flow root, no wrapper rules.
    const { tree: out, rules } = project(tree)
    expect(out.kids).toHaveLength(1)
    expect(out.kids?.[0]?.id).toBe(img.id)
    expect(ruleIds(rules).has(1)).toBe(false)
    expect(ruleIds(rules).has(2)).toBe(false)
  })

  it('keeps a wrapper with a non-zero margin (its offset would be lost)', () => {
    const img = leaf(2)
    const w = wrapper(1, [img], { style: style({ ...WRAPPER_STYLE, margin: '10px' }) })
    const tree = root([w])
    flattenIR(tree)
    expect(w.flattened).toBeUndefined()
    const { tree: out } = project(tree)
    expect(out.kids?.[0]?.id).toBe(w.id)
    expect(out.kids?.[0]?.kids?.[0]?.id).toBe(img.id)
  })

  it('keeps a wrapper whose box differs from its child (padding/border insets it)', () => {
    const img = leaf(2)
    const w = wrapper(1, [img], { box: { x: 0, y: 0, width: 116, height: 36 } })
    const tree = root([w])
    flattenIR(tree)
    expect(w.flattened).toBeUndefined()
    expect(project(tree).tree.kids?.[0]?.id).toBe(w.id)
  })

  it('keeps a wrapper anchoring a carried token def (a var() reads it)', () => {
    const img = leaf(2)
    const w = wrapper(1, [img], {
      decls: { fallback: [], carried: [{ ids: [1], decls: ['--gap: 8px'], spec: 1, order: 1 }] },
    })
    const tree = root([w])
    flattenIR(tree)
    expect(w.flattened).toBeUndefined()
    expect(project(tree).tree.kids?.[0]?.id).toBe(w.id)
  })

  it('does not flatten into a flex/grid parent (the survivor needs the wrapper flex sizing)', () => {
    const img = leaf(2)
    const w = wrapper(1, [img])
    const tree = root([w], 'flex')
    flattenIR(tree)
    expect(w.flattened).toBeUndefined() // flex parent → wrapper not marked
    expect(project(tree).tree.kids?.[0]?.id).toBe(w.id)
  })

  it('never crosses a stitch (a stitch child has no box, so it is not coincident)', () => {
    const stitch: IRNode = {
      id: 2,
      el: null,
      kind: 'stitch',
      kids: [],
      depth: 0,
      decls: { fallback: [] },
      style: style(),
      ref: 'avatar',
    }
    const w = wrapper(1, [stitch])
    const tree = root([w])
    flattenIR(tree)
    expect(w.flattened).toBeUndefined() // wrapper around a stitch is conservatively kept
    expect(project(tree).tree.kids?.[0]?.id).toBe(w.id)
  })
})
