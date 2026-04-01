/**
 * Types for the Code Knowledge Graph.
 *
 * Defines the node, edge, graph, impact-analysis, and architecture-layer
 * structures used by CodeGraph, ImpactAnalyzer, and ArchitectureModel.
 */

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

/** The syntactic kind of a code symbol. */
export type CodeNodeKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'module'
  | 'variable'

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** The semantic relationship an edge represents. */
export type CodeEdgeRelationship =
  | 'calls'
  | 'imports'
  | 'extends'
  | 'implements'
  | 'uses'

// ---------------------------------------------------------------------------
// CodeNode
// ---------------------------------------------------------------------------

/** A single symbol (function, class, interface, module, variable) in the graph. */
export interface CodeNode {
  /** Stable identifier — typically `filePath::name`. */
  id: string
  /** Human-readable symbol name. */
  name: string
  /** Syntactic kind. */
  kind: CodeNodeKind
  /** Absolute file path where the symbol lives. */
  filePath: string
  /** 1-based line number of the declaration. */
  line: number
  /** Whether the symbol is exported from its module. */
  exports: boolean
}

// ---------------------------------------------------------------------------
// CodeEdge
// ---------------------------------------------------------------------------

/** A directed relationship between two CodeNodes. */
export interface CodeEdge {
  /** ID of the source node. */
  source: string
  /** ID of the target node. */
  target: string
  /** Kind of relationship. */
  relationship: CodeEdgeRelationship
}

// ---------------------------------------------------------------------------
// CodeGraph (serializable shape)
// ---------------------------------------------------------------------------

/** Metadata attached to a serialized graph snapshot. */
export interface CodeGraphMetadata {
  /** ISO-8601 timestamp of last build. */
  builtAt: string
  /** Root directory the graph was built from. */
  rootDir: string
  /** Per-file mtime (epoch ms) used for incremental rebuilds. */
  fileMtimes: Record<string, number>
}

/** The serializable representation of the full knowledge graph. */
export interface CodeGraphData {
  nodes: CodeNode[]
  edges: CodeEdge[]
  metadata: CodeGraphMetadata
}

// ---------------------------------------------------------------------------
// Impact analysis
// ---------------------------------------------------------------------------

/** Risk level estimated by the ImpactAnalyzer. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** Result of an impact analysis for one or more changed nodes. */
export interface ImpactReport {
  /** IDs of nodes that were explicitly changed. */
  changedNodes: string[]
  /** Nodes directly depending on any changed node. */
  directlyAffected: CodeNode[]
  /** Nodes transitively reachable through the dependency chain. */
  transitivelyAffected: CodeNode[]
  /** Overall risk level. */
  riskLevel: RiskLevel
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

/** A high-level architectural layer detected from the code graph. */
export interface ArchitectureLayer {
  /** Layer name (e.g. "tools", "services", "utils"). */
  name: string
  /** Node IDs belonging to this layer. */
  modules: string[]
  /** Layer names that this layer depends on. */
  dependencies: string[]
}
