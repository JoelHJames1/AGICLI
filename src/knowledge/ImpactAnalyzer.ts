/**
 * ImpactAnalyzer — predicts the blast radius of code changes.
 *
 * Given a set of changed node IDs, it walks the dependency graph to find
 * directly and transitively affected nodes, estimates a risk level, suggests
 * relevant tests, and formats a human-readable report.
 */

import * as path from 'path'
import type { CodeGraph } from './CodeGraph.js'
import type { CodeNode, ImpactReport, RiskLevel } from './types.js'

// ---------------------------------------------------------------------------
// Risk thresholds
// ---------------------------------------------------------------------------

/** Total affected count (direct + transitive) mapped to risk levels. */
const RISK_THRESHOLDS: Array<{ max: number; level: RiskLevel }> = [
  { max: 2, level: 'low' },
  { max: 10, level: 'medium' },
  { max: 50, level: 'high' },
  { max: Infinity, level: 'critical' },
]

// ---------------------------------------------------------------------------
// ImpactAnalyzer
// ---------------------------------------------------------------------------

export class ImpactAnalyzer {
  // -----------------------------------------------------------------------
  // Core analysis
  // -----------------------------------------------------------------------

  /**
   * Analyze the impact of changing one or more nodes.
   *
   * Walks the reverse-dependency graph (dependents) outward from the changed
   * nodes to find everything directly or transitively affected.
   */
  analyzeImpact(graph: CodeGraph, changedNodes: string[]): ImpactReport {
    const changedSet = new Set(changedNodes)

    // Direct dependents (depth 1)
    const directSet = new Set<string>()
    for (const id of changedNodes) {
      for (const dep of graph.getDependents(id)) {
        if (!changedSet.has(dep.id)) {
          directSet.add(dep.id)
        }
      }
    }

    // Transitive dependents (BFS from direct, excluding changed & direct)
    const transitiveSet = new Set<string>()
    const visited = new Set<string>([...changedSet, ...directSet])
    const queue = Array.from(directSet)

    while (queue.length > 0) {
      const current = queue.shift()!
      for (const dep of graph.getDependents(current)) {
        if (!visited.has(dep.id)) {
          visited.add(dep.id)
          transitiveSet.add(dep.id)
          queue.push(dep.id)
        }
      }
    }

    const directlyAffected = Array.from(directSet)
      .map((id) => graph.getNode(id))
      .filter((n): n is CodeNode => n !== undefined)

    const transitivelyAffected = Array.from(transitiveSet)
      .map((id) => graph.getNode(id))
      .filter((n): n is CodeNode => n !== undefined)

    const totalAffected = directlyAffected.length + transitivelyAffected.length
    const riskLevel = this.computeRiskLevel(totalAffected)

    return {
      changedNodes,
      directlyAffected,
      transitivelyAffected,
      riskLevel,
    }
  }

  // -----------------------------------------------------------------------
  // Risk estimation
  // -----------------------------------------------------------------------

  /**
   * Estimate risk from a completed ImpactReport. Useful when re-evaluating
   * a report without re-running the full analysis.
   */
  estimateRisk(impact: ImpactReport): RiskLevel {
    const total =
      impact.directlyAffected.length + impact.transitivelyAffected.length
    return this.computeRiskLevel(total)
  }

  // -----------------------------------------------------------------------
  // Test suggestions
  // -----------------------------------------------------------------------

  /**
   * Suggest test files to run based on the affected nodes.
   *
   * Heuristic: for each affected file, look for a sibling or nearby test
   * file following common naming conventions:
   * - `foo.test.ts`, `foo.spec.ts`
   * - `__tests__/foo.ts`
   * - `tests/foo.test.ts`
   */
  suggestTests(impact: ImpactReport): string[] {
    const allAffected = [
      ...impact.directlyAffected,
      ...impact.transitivelyAffected,
    ]

    const testFiles = new Set<string>()

    // Collect files from changed nodes too (they're IDs, not necessarily in affected)
    const affectedFiles = new Set<string>()
    for (const node of allAffected) {
      affectedFiles.add(node.filePath)
    }

    for (const filePath of affectedFiles) {
      const dir = path.dirname(filePath)
      const ext = path.extname(filePath)
      const base = path.basename(filePath, ext)

      // Skip files that are themselves tests
      if (this.isTestFile(filePath)) {
        testFiles.add(filePath)
        continue
      }

      // Common test file patterns
      const candidates = [
        path.join(dir, `${base}.test${ext}`),
        path.join(dir, `${base}.spec${ext}`),
        path.join(dir, `${base}.test.tsx`),
        path.join(dir, `${base}.spec.tsx`),
        path.join(dir, '__tests__', `${base}${ext}`),
        path.join(dir, '__tests__', `${base}.test${ext}`),
        path.join(path.dirname(dir), 'tests', `${base}.test${ext}`),
        path.join(path.dirname(dir), '__tests__', `${base}.test${ext}`),
      ]

      for (const candidate of candidates) {
        testFiles.add(candidate)
      }
    }

    return Array.from(testFiles).sort()
  }

  // -----------------------------------------------------------------------
  // Report formatting
  // -----------------------------------------------------------------------

  /**
   * Generate a human-readable impact summary suitable for display in a
   * terminal or inclusion in a PR comment.
   */
  formatReport(impact: ImpactReport): string {
    const lines: string[] = []
    const riskEmoji = this.riskIndicator(impact.riskLevel)

    lines.push(`=== Impact Analysis Report ===`)
    lines.push('')
    lines.push(`Risk Level: ${impact.riskLevel.toUpperCase()} ${riskEmoji}`)
    lines.push(`Changed nodes: ${impact.changedNodes.length}`)
    lines.push(`Directly affected: ${impact.directlyAffected.length}`)
    lines.push(`Transitively affected: ${impact.transitivelyAffected.length}`)

    if (impact.directlyAffected.length > 0) {
      lines.push('')
      lines.push('--- Directly Affected ---')
      for (const node of impact.directlyAffected.slice(0, 30)) {
        lines.push(`  ${node.name} [${node.kind}] - ${node.filePath}:${node.line}`)
      }
      if (impact.directlyAffected.length > 30) {
        lines.push(
          `  ... and ${impact.directlyAffected.length - 30} more`,
        )
      }
    }

    if (impact.transitivelyAffected.length > 0) {
      lines.push('')
      lines.push('--- Transitively Affected ---')
      for (const node of impact.transitivelyAffected.slice(0, 20)) {
        lines.push(`  ${node.name} [${node.kind}] - ${node.filePath}:${node.line}`)
      }
      if (impact.transitivelyAffected.length > 20) {
        lines.push(
          `  ... and ${impact.transitivelyAffected.length - 20} more`,
        )
      }
    }

    // Affected files summary
    const affectedFiles = new Set<string>()
    for (const n of [
      ...impact.directlyAffected,
      ...impact.transitivelyAffected,
    ]) {
      affectedFiles.add(n.filePath)
    }
    lines.push('')
    lines.push(`Total affected files: ${affectedFiles.size}`)

    // Test suggestions
    const tests = this.suggestTests(impact)
    if (tests.length > 0) {
      lines.push('')
      lines.push('--- Suggested Tests ---')
      for (const t of tests.slice(0, 15)) {
        lines.push(`  ${t}`)
      }
      if (tests.length > 15) {
        lines.push(`  ... and ${tests.length - 15} more`)
      }
    }

    return lines.join('\n')
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private computeRiskLevel(totalAffected: number): RiskLevel {
    for (const { max, level } of RISK_THRESHOLDS) {
      if (totalAffected <= max) return level
    }
    return 'critical'
  }

  private isTestFile(filePath: string): boolean {
    const base = path.basename(filePath)
    return (
      base.includes('.test.') ||
      base.includes('.spec.') ||
      filePath.includes('__tests__') ||
      filePath.includes('/tests/')
    )
  }

  private riskIndicator(level: RiskLevel): string {
    switch (level) {
      case 'low':
        return '[OK]'
      case 'medium':
        return '[WARN]'
      case 'high':
        return '[HIGH]'
      case 'critical':
        return '[CRITICAL]'
    }
  }
}
