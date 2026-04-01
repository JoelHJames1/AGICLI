/**
 * ArchitectureModel — high-level architectural analysis of a CodeGraph.
 *
 * Detects layers from directory structure, identifies key modules by
 * connectivity, finds circular dependencies, and generates human-readable
 * architecture summaries.
 */

import * as path from 'path'
import type { CodeGraph } from './CodeGraph.js'
import type { ArchitectureLayer, CodeNode } from './types.js'

// ---------------------------------------------------------------------------
// ArchitectureModel
// ---------------------------------------------------------------------------

export class ArchitectureModel {
  // -----------------------------------------------------------------------
  // Layer detection
  // -----------------------------------------------------------------------

  /**
   * Detect architectural layers by grouping nodes by their top-level
   * directory relative to the graph root. Each unique first directory
   * segment becomes a layer. Dependencies between layers are derived from
   * edges crossing layer boundaries.
   */
  detectLayers(graph: CodeGraph): ArchitectureLayer[] {
    const nodes = graph.getAllNodes()
    const edges = graph.getAllEdges()

    // Determine rootDir from the metadata (fallback: common prefix)
    const rootDir = this.inferRootDir(nodes)

    // Group nodes by first directory segment under root
    const layerMap = new Map<string, Set<string>>()
    const nodeToLayer = new Map<string, string>()

    for (const node of nodes) {
      const rel = path.relative(rootDir, node.filePath)
      const firstSegment = rel.split(path.sep)[0] ?? '<root>'
      const layerName = firstSegment

      let ids = layerMap.get(layerName)
      if (!ids) {
        ids = new Set()
        layerMap.set(layerName, ids)
      }
      ids.add(node.id)
      nodeToLayer.set(node.id, layerName)
    }

    // Derive inter-layer dependencies
    const layerDeps = new Map<string, Set<string>>()
    for (const [layerName] of layerMap) {
      layerDeps.set(layerName, new Set())
    }

    for (const edge of edges) {
      const srcLayer = nodeToLayer.get(edge.source)
      const tgtLayer = nodeToLayer.get(edge.target)
      if (srcLayer && tgtLayer && srcLayer !== tgtLayer) {
        layerDeps.get(srcLayer)!.add(tgtLayer)
      }
    }

    // Assemble result
    const layers: ArchitectureLayer[] = []
    for (const [name, moduleIds] of layerMap) {
      layers.push({
        name,
        modules: Array.from(moduleIds),
        dependencies: Array.from(layerDeps.get(name) ?? []),
      })
    }

    // Sort by number of dependencies (most fundamental layers first)
    layers.sort((a, b) => a.dependencies.length - b.dependencies.length)
    return layers
  }

  // -----------------------------------------------------------------------
  // Key modules
  // -----------------------------------------------------------------------

  /**
   * Identify the most connected nodes (combined in-degree + out-degree).
   * Returns the top `n` nodes sorted by connectivity descending.
   */
  identifyKeyModules(graph: CodeGraph, top = 10): CodeNode[] {
    const nodes = graph.getAllNodes()
    const edges = graph.getAllEdges()

    const degree = new Map<string, number>()
    for (const node of nodes) {
      degree.set(node.id, 0)
    }
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
    }

    // Sort by degree descending, then take top N
    const sorted = nodes.slice().sort((a, b) => {
      return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
    })
    return sorted.slice(0, top)
  }

  // -----------------------------------------------------------------------
  // Circular dependency detection
  // -----------------------------------------------------------------------

  /**
   * Find all strongly connected components of size > 1 (circular
   * dependencies) using Tarjan's algorithm.
   */
  findCircularDeps(graph: CodeGraph): Array<CodeNode[]> {
    const nodes = graph.getAllNodes()
    const edges = graph.getAllEdges()

    // Build adjacency list
    const adj = new Map<string, string[]>()
    for (const node of nodes) {
      adj.set(node.id, [])
    }
    for (const edge of edges) {
      const list = adj.get(edge.source)
      if (list) list.push(edge.target)
    }

    // Tarjan's SCC
    let index = 0
    const stack: string[] = []
    const onStack = new Set<string>()
    const indices = new Map<string, number>()
    const lowlinks = new Map<string, number>()
    const sccs: string[][] = []

    const strongConnect = (v: string) => {
      indices.set(v, index)
      lowlinks.set(v, index)
      index++
      stack.push(v)
      onStack.add(v)

      for (const w of adj.get(v) ?? []) {
        if (!indices.has(w)) {
          strongConnect(w)
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!))
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!))
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const scc: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== v)
        if (scc.length > 1) {
          sccs.push(scc)
        }
      }
    }

    for (const node of nodes) {
      if (!indices.has(node.id)) {
        strongConnect(node.id)
      }
    }

    // Map IDs back to nodes
    return sccs.map((ids) =>
      ids
        .map((id) => graph.getNode(id))
        .filter((n): n is CodeNode => n !== undefined),
    )
  }

  // -----------------------------------------------------------------------
  // Summary generation
  // -----------------------------------------------------------------------

  /**
   * Generate a human-readable architecture summary including layers, key
   * modules, circular dependencies, and basic stats.
   */
  generateSummary(graph: CodeGraph): string {
    const stats = graph.getStats()
    const layers = this.detectLayers(graph)
    const keyModules = this.identifyKeyModules(graph, 10)
    const cycles = this.findCircularDeps(graph)

    const lines: string[] = []
    lines.push('=== Architecture Summary ===')
    lines.push('')
    lines.push(
      `Graph: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.orphans} orphan nodes`,
    )

    lines.push('')
    lines.push(`--- Layers (${layers.length}) ---`)
    for (const layer of layers) {
      const depStr =
        layer.dependencies.length > 0
          ? ` -> depends on: ${layer.dependencies.join(', ')}`
          : ''
      lines.push(`  ${layer.name} (${layer.modules.length} modules)${depStr}`)
    }

    lines.push('')
    lines.push(`--- Key Modules (top ${keyModules.length}) ---`)
    for (const mod of keyModules) {
      const deps = graph.getDependencies(mod.id).length
      const dependents = graph.getDependents(mod.id).length
      lines.push(
        `  ${mod.name} [${mod.kind}] (${deps} deps, ${dependents} dependents) - ${mod.filePath}`,
      )
    }

    lines.push('')
    if (cycles.length === 0) {
      lines.push('--- Circular Dependencies: none detected ---')
    } else {
      lines.push(`--- Circular Dependencies (${cycles.length} cycles) ---`)
      for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i]!
        const names = cycle.map((n) => n.name).join(' -> ')
        lines.push(`  Cycle ${i + 1}: ${names}`)
      }
    }

    return lines.join('\n')
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Infer the root directory from node file paths (longest common prefix). */
  private inferRootDir(nodes: CodeNode[]): string {
    if (nodes.length === 0) return '/'
    const paths = nodes.map((n) => n.filePath)
    let common = paths[0]!
    for (let i = 1; i < paths.length; i++) {
      while (!paths[i]!.startsWith(common)) {
        common = path.dirname(common)
        if (common === '/' || common === '.') return common
      }
    }
    // Ensure it's a directory, not a file
    if (common.includes('.') && !common.endsWith(path.sep)) {
      common = path.dirname(common)
    }
    return common
  }
}
