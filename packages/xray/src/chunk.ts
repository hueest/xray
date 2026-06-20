import {
  type Chunk,
  LEAF_CLASS,
  type GatedPlate,
  NODE_CLASS,
  type Plate,
  type RenderNode,
} from './plate.ts'

/**
 * Serialize a merged plate's RenderNode tree into the shipped `Plate` (ADR 0008). This is the
 * framework-neutral half of rendering: a skeleton is static, text-free DOM, so the structure is
 * flattened to HTML strings here, at build, once — instead of every adapter walking a tree on the
 * latency-critical first paint. The adapter only injects the strings and mounts a child plate at
 * each stitch (see the React adapters). No escaping risk: bones carry only the content-addressed
 * class tokens (ADR 0007), never user content.
 */

function nodeClass(node: RenderNode): string {
  // A leaf carries the base leaf class plus a kind modifier (`xr-leaf-text-line` etc.)
  // so defaults and consumer themes can treat text bars, media, and boxes
  // differently (ADR 0011).
  const leaf = node.leaf ? ` ${LEAF_CLASS} ${LEAF_CLASS}-${node.leaf}` : ''
  return NODE_CLASS + leaf + (node.cls ? ` ${node.cls}` : '')
}

/**
 * Whether this subtree holds a render-time DYNAMIC node anywhere — a stitch (`ref`, a mount point
 * resolved to a child plate) or a template (`count`, a cell the adapter repeats). Either keeps the
 * subtree from collapsing to one flat string, since both are expanded at render rather than baked
 * into the markup.
 */
function hasDynamic(node: RenderNode): boolean {
  return (
    node.ref !== undefined || node.count !== undefined || (node.kids?.some(hasDynamic) ?? false)
  )
}

/** Serialize a stitch-free subtree to one HTML string (caller guarantees no `ref` below). */
function toHtml(node: RenderNode): string {
  const kids = node.kids ? node.kids.map(toHtml).join('') : ''
  return `<div class="${nodeClass(node)}">${kids}</div>`
}

/**
 * Serialize a node list into chunks: each maximal run with no render-time dynamic node becomes one
 * HTML `string`; a `ref` node becomes `{ r }`; a `count` node becomes `{ t: html, n }` (its cell's
 * HTML once + the repeat count); a node that isn't itself dynamic but holds one deeper stays a real
 * element (`{ c, k }`) and recurses. Mirrors the element shape the runtime renderer would otherwise
 * build per node. A `count` cell is guaranteed stitch-free by the capture pass, so its `toHtml` is
 * a plain string the adapter repeats.
 */
export function toChunks(nodes: readonly RenderNode[]): Chunk[] {
  const out: Chunk[] = []
  let buf = ''
  const flush = () => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }
  for (const node of nodes) {
    if (!hasDynamic(node)) {
      buf += toHtml(node)
      continue
    }
    flush()
    if (node.ref !== undefined) out.push({ r: node.ref })
    else if (node.count !== undefined) out.push({ t: toHtml(node), n: node.count })
    else out.push({ c: nodeClass(node), k: toChunks(node.kids ?? []) })
  }
  flush()
  return out
}

/**
 * Turn a merged plate (RenderNode tree) into the shipped plate (chunks). The root's own content
 * classes travel as `rootCls` (the adapter puts them on the root element); its children become
 * `chunks`. A capture-less plate has null chunks and renders the fallback.
 *
 * Two-artifact contract (ADR 0026): the returned `Plate` is the TREE artifact only; the input's
 * `css` is deliberately NOT copied onto it. The css string stays the producer's
 * (`GatedPlate`/`StoredPlate`) field, and each lowering site decides independently how its css
 * travels: the plugin's virtual `.css` modules + `export const css`, `captureElement`'s `{ plate,
 * css }` pair, or the `xray:plate` dev event, which ships no css.
 */
export function serializePlate(merged: GatedPlate): Plate {
  const { v, name, tree } = merged
  if (!tree) return { v, name, chunks: null }
  const chunks = toChunks(tree.kids ?? [])
  return tree.cls ? { v, name, chunks, rootCls: tree.cls } : { v, name, chunks }
}

/**
 * Distinct plate names referenced by the tree's stitches, in first-seen order. Walks a `RenderNode`
 * tree (the stored, post-classify shape), so it drives the gen-side stitch import graph straight
 * off a `StoredPlate.tree` (`renderPlateModule`, index.ts). The one node-side primitive needed at
 * build time; multi-View gating happens in the in-browser `serializePlateIR` (serialize.ts, ADR
 * 0022).
 */
export function collectRefs(tree: RenderNode | null): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const visit = (node: RenderNode) => {
    if (node.ref !== undefined && !seen.has(node.ref)) {
      seen.add(node.ref)
      names.push(node.ref)
    }
    for (const kid of node.kids ?? []) visit(kid)
  }
  if (tree) visit(tree)
  return names
}
