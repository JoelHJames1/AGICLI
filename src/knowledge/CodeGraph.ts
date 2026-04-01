/**
 * CodeGraph — builds and queries a code dependency graph.
 *
 * The graph is constructed by regex-based parsing of TypeScript / JavaScript
 * source files (no LSP required). It supports incremental updates based on
 * file mtime, BFS/DFS path finding, and JSON serialization for caching.
 */

import { readdir, readFile, stat, mkdir, writeFile } from 'fs/promises'
import * as path from 'path'
import type {
  CodeEdge,
  CodeEdgeRelationship,
  CodeGraphData,
  CodeGraphMetadata,
  CodeNode,
  CodeNodeKind,
} from './types.js'

// ---------------------------------------------------------------------------
// Regex patterns for extracting symbols from TS/JS files
// ---------------------------------------------------------------------------

/** Match `export (default )?(function|class|interface|const|let|var) Name` */
const EXPORT_DECL_RE =
  /^export\s+(?:default\s+)?(?:abstract\s+)?(function|class|interface|const|let|var|type|enum)\s+(\w+)/gm

/** Match non-exported declarations */
const LOCAL_DECL_RE =
  /^(?:abstract\s+)?(function|class|interface|const|let|var|type|enum)\s+(\w+)/gm

/** Match `import { Foo, Bar } from './path'` or `import Foo from './path'` */
const IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g

/** Match `extends SomeClass` or `implements SomeInterface` */
const EXTENDS_RE = /\bextends\s+([\w.]+)/g
const IMPLEMENTS_RE = /\bimplements\s+([\w,\s]+)/g

/** File extensions we parse. */
const PARSEABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.mjs',
])

/** Directories to always skip. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.turbo',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindFromKeyword(kw: string): CodeNodeKind {
  switch (kw) {
    case 'function':
      return 'function'
    case 'class':
      return 'class'
    case 'interface':
    case 'type':
      return 'interface'
    case 'const':
    case 'let':
    case 'var':
    case 'enum':
      return 'variable'
    default:
      return 'variable'
  }
}

function nodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`
}

// ---------------------------------------------------------------------------
// CodeGraph class
// ---------------------------------------------------------------------------

export class CodeGraph {
  private nodes = new Map<string, CodeNode>()
  private edges: CodeEdge[] = []
  /** outgoing adjacency: source -> edges */
  private outgoing = new Map<string, CodeEdge[]>()
  /** incoming adjacency: target -> edges */
  private incoming = new Map<string, CodeEdge[]>()
  private metadata: CodeGraphMetadata = {
    builtAt: '',
    rootDir: '',
    fileMtimes: {},
  }

  // -----------------------------------------------------------------------
  // Build
  // -----------------------------------------------------------------------

  /**
   * Build (or incrementally update) the graph from all parseable source files
   * under `dir`. Only re-parses files whose mtime has changed since the last
   * build.
   */
  async buildFromDirectory(dir: string): Promise<void> {
    const absDir = path.resolve(dir)
    this.metadata.rootDir = absDir
    const files = await this.collectFiles(absDir)

    // Determine which files need re-parsing
    const toProcess: string[] = []
    const newMtimes: Record<string, number> = {}

    for (const filePath of files) {
      try {
        const st = await stat(filePath)
        const mtime = st.mtimeMs
        newMtimes[filePath] = mtime
        if (this.metadata.fileMtimes[filePath] !== mtime) {
          toProcess.push(filePath)
        }
      } catch {
        // file disappeared between listing and stat — skip
      }
    }

    // Remove nodes/edges for deleted files
    const fileSet = new Set(files)
    for (const existingFile of Object.keys(this.metadata.fileMtimes)) {
      if (!fileSet.has(existingFile)) {
        this.removeNodesForFile(existingFile)
        delete this.metadata.fileMtimes[existingFile]
      }
    }

    // Parse changed files
    for (const filePath of toProcess) {
      this.removeNodesForFile(filePath)
      try {
        const src = await readFile(filePath, 'utf-8')
        this.parseFile(filePath, src)
      } catch {
        // unreadable file — skip
      }
    }

    // Rebuild adjacency indices after mutation
    this.rebuildAdjacency()

    this.metadata.fileMtimes = newMtimes
    this.metadata.builtAt = new Date().toISOString()
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** What does `nodeId` depend on? (outgoing edges) */
  getDependencies(id: string): CodeNode[] {
    const edges = this.outgoing.get(id) ?? []
    return edges
      .map((e) => this.nodes.get(e.target))
      .filter((n): n is CodeNode => n !== undefined)
  }

  /** What depends on `nodeId`? (incoming edges) */
  getDependents(id: string): CodeNode[] {
    const edges = this.incoming.get(id) ?? []
    return edges
      .map((e) => this.nodes.get(e.source))
      .filter((n): n is CodeNode => n !== undefined)
  }

  /** BFS shortest path from `fromId` to `toId`. Returns the edge chain or empty array. */
  findPath(fromId: string, toId: string): CodeEdge[] {
    if (fromId === toId) return []
    const visited = new Set<string>([fromId])
    const parent = new Map<string, { via: CodeEdge; from: string }>()
    const queue: string[] = [fromId]

    while (queue.length > 0) {
      const current = queue.shift()!
      const outEdges = this.outgoing.get(current) ?? []
      for (const edge of outEdges) {
        if (visited.has(edge.target)) continue
        visited.add(edge.target)
        parent.set(edge.target, { via: edge, from: current })
        if (edge.target === toId) {
          // reconstruct
          const result: CodeEdge[] = []
          let cur = toId
          while (parent.has(cur)) {
            const p = parent.get(cur)!
            result.unshift(p.via)
            cur = p.from
          }
          return result
        }
        queue.push(edge.target)
      }
    }
    return []
  }

  /** Return a node by ID, or undefined. */
  getNode(id: string): CodeNode | undefined {
    return this.nodes.get(id)
  }

  /** Return all nodes. */
  getAllNodes(): CodeNode[] {
    return Array.from(this.nodes.values())
  }

  /** Return all edges. */
  getAllEdges(): CodeEdge[] {
    return [...this.edges]
  }

  // -----------------------------------------------------------------------
  // Serialization
  // -----------------------------------------------------------------------

  /** Serialize the graph to a JSON string. */
  serialize(): string {
    const data: CodeGraphData = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      metadata: this.metadata,
    }
    return JSON.stringify(data, null, 2)
  }

  /** Reconstruct a CodeGraph from a previously serialized JSON string. */
  static deserialize(data: string): CodeGraph {
    const parsed: CodeGraphData = JSON.parse(data)
    const graph = new CodeGraph()
    for (const node of parsed.nodes) {
      graph.nodes.set(node.id, node)
    }
    graph.edges = parsed.edges
    graph.metadata = parsed.metadata
    graph.rebuildAdjacency()
    return graph
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  getStats(): { nodes: number; edges: number; orphans: number } {
    const connected = new Set<string>()
    for (const e of this.edges) {
      connected.add(e.source)
      connected.add(e.target)
    }
    const orphans = Array.from(this.nodes.keys()).filter(
      (id) => !connected.has(id),
    ).length
    return { nodes: this.nodes.size, edges: this.edges.length, orphans }
  }

  // -----------------------------------------------------------------------
  // Cache helpers
  // -----------------------------------------------------------------------

  /**
   * Save the graph to the project cache directory.
   * Path: `~/.claude2/projects/{slug}/knowledge/graph.json`
   */
  async saveToCache(projectSlug: string): Promise<string> {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
    const dir = path.join(home, '.claude2', 'projects', projectSlug, 'knowledge')
    await mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'graph.json')
    await writeFile(filePath, this.serialize(), 'utf-8')
    return filePath
  }

  /** Load the graph from the project cache, returning null if not found. */
  static async loadFromCache(projectSlug: string): Promise<CodeGraph | null> {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
    const filePath = path.join(
      home,
      '.claude2',
      'projects',
      projectSlug,
      'knowledge',
      'graph.json',
    )
    try {
      const data = await readFile(filePath, 'utf-8')
      return CodeGraph.deserialize(data)
    } catch {
      return null
    }
  }

  // -----------------------------------------------------------------------
  // Internal: file collection
  // -----------------------------------------------------------------------

  private async collectFiles(dir: string): Promise<string[]> {
    const results: string[] = []
    const walk = async (d: string) => {
      let entries
      try {
        entries = await readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            await walk(path.join(d, entry.name))
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name)
          if (PARSEABLE_EXTENSIONS.has(ext)) {
            results.push(path.join(d, entry.name))
          }
        }
      }
    }
    await walk(dir)
    return results
  }

  // -----------------------------------------------------------------------
  // Internal: parsing
  // -----------------------------------------------------------------------

  private parseFile(filePath: string, src: string): void {
    const lines = src.split('\n')

    // 1. Extract declarations (exported and local)
    const declaredNames = new Map<string, CodeNode>()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // Exported declarations
      const expMatches = [...line.matchAll(EXPORT_DECL_RE)]
      for (const m of expMatches) {
        const kind = kindFromKeyword(m[1]!)
        const name = m[2]!
        const id = nodeId(filePath, name)
        const node: CodeNode = {
          id,
          name,
          kind,
          filePath,
          line: i + 1,
          exports: true,
        }
        declaredNames.set(name, node)
        this.nodes.set(id, node)
      }
      // Local declarations (only if not already matched as export)
      if (expMatches.length === 0) {
        for (const m of line.matchAll(LOCAL_DECL_RE)) {
          // Ensure this is actually at the start of a non-exported line
          if (line.trimStart().startsWith('export')) continue
          const kind = kindFromKeyword(m[1]!)
          const name = m[2]!
          const id = nodeId(filePath, name)
          const node: CodeNode = {
            id,
            name,
            kind,
            filePath,
            line: i + 1,
            exports: false,
          }
          declaredNames.set(name, node)
          this.nodes.set(id, node)
        }
      }
    }

    // 2. Add a module node for the file itself
    const moduleName = path.basename(filePath, path.extname(filePath))
    const moduleId = nodeId(filePath, '<module>')
    this.nodes.set(moduleId, {
      id: moduleId,
      name: moduleName,
      kind: 'module',
      filePath,
      line: 1,
      exports: true,
    })

    // 3. Extract import edges
    for (const m of src.matchAll(IMPORT_RE)) {
      const namedImports = m[1] // e.g. "Foo, Bar as Baz"
      const defaultImport = m[2] // e.g. "Foo"
      const importPath = m[3]!

      // Resolve relative import to absolute path (best-effort)
      const resolvedFile = this.resolveImportPath(filePath, importPath)

      const importedNames: string[] = []
      if (namedImports) {
        for (const part of namedImports.split(',')) {
          const trimmed = part.trim().replace(/\s+as\s+\w+/, '').replace(/^type\s+/, '')
          if (trimmed) importedNames.push(trimmed)
        }
      }
      if (defaultImport) {
        importedNames.push(defaultImport)
      }

      // Create edges from this module to the imported symbols
      for (const importedName of importedNames) {
        const targetId = resolvedFile
          ? nodeId(resolvedFile, importedName)
          : `<external>::${importedName}`
        this.edges.push({
          source: moduleId,
          target: targetId,
          relationship: 'imports',
        })
      }
    }

    // 4. Extract extends / implements edges
    for (const [name, node] of declaredNames) {
      // Find the source block for this declaration (rough heuristic: next 50 lines)
      const startLine = node.line - 1
      const block = lines.slice(startLine, startLine + 50).join('\n')

      for (const m of block.matchAll(EXTENDS_RE)) {
        const parentName = m[1]!.split('.').pop()!
        if (parentName !== name) {
          this.addRelationshipEdge(node.id, parentName, filePath, 'extends')
        }
      }

      for (const m of block.matchAll(IMPLEMENTS_RE)) {
        const implList = m[1]!
        for (const part of implList.split(',')) {
          const ifaceName = part.trim().split('.').pop()
          if (ifaceName && ifaceName !== name) {
            this.addRelationshipEdge(node.id, ifaceName, filePath, 'implements')
          }
        }
      }
    }
  }

  /**
   * Add a relationship edge, resolving the target name to a node ID if
   * possible (same file first, then any file in the graph).
   */
  private addRelationshipEdge(
    sourceId: string,
    targetName: string,
    sourceFilePath: string,
    relationship: CodeEdgeRelationship,
  ): void {
    // Try same-file first
    const sameFile = nodeId(sourceFilePath, targetName)
    if (this.nodes.has(sameFile)) {
      this.edges.push({ source: sourceId, target: sameFile, relationship })
      return
    }
    // Search all nodes for a matching name
    for (const [id, node] of this.nodes) {
      if (node.name === targetName && id !== sourceId) {
        this.edges.push({ source: sourceId, target: id, relationship })
        return
      }
    }
    // Unresolved — point to a placeholder
    this.edges.push({
      source: sourceId,
      target: `<unresolved>::${targetName}`,
      relationship,
    })
  }

  /**
   * Best-effort resolution of a relative import path to an absolute file path.
   * Tries common extensions. Returns null for external (bare) imports.
   */
  private resolveImportPath(
    fromFile: string,
    importPath: string,
  ): string | null {
    if (!importPath.startsWith('.')) return null
    const dir = path.dirname(fromFile)
    const base = path.resolve(dir, importPath)
    // The actual file might have an extension or be an index file; we just
    // record the canonical base so edges can still match after rebuild.
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '']) {
      const candidate = base + ext
      if (this.nodes.has(nodeId(candidate, '<module>'))) return candidate
    }
    // Check index files
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = path.join(base, 'index' + ext)
      if (this.nodes.has(nodeId(candidate, '<module>'))) return candidate
    }
    // Return the base .ts guess even if not yet in graph (will be resolved on
    // next incremental build).
    return base.endsWith('.js') ? base.replace(/\.js$/, '.ts') : base + '.ts'
  }

  // -----------------------------------------------------------------------
  // Internal: mutation helpers
  // -----------------------------------------------------------------------

  private removeNodesForFile(filePath: string): void {
    const idsToRemove = new Set<string>()
    for (const [id, node] of this.nodes) {
      if (node.filePath === filePath) idsToRemove.add(id)
    }
    for (const id of idsToRemove) this.nodes.delete(id)
    this.edges = this.edges.filter(
      (e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target),
    )
  }

  private rebuildAdjacency(): void {
    this.outgoing.clear()
    this.incoming.clear()
    for (const edge of this.edges) {
      let out = this.outgoing.get(edge.source)
      if (!out) {
        out = []
        this.outgoing.set(edge.source, out)
      }
      out.push(edge)

      let inc = this.incoming.get(edge.target)
      if (!inc) {
        inc = []
        this.incoming.set(edge.target, inc)
      }
      inc.push(edge)
    }
  }
}
