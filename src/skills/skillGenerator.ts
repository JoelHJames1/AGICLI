import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recorded tool invocation with its inputs and outputs. */
export type ToolHistoryEntry = {
  /** Tool name (e.g. "Bash", "Read", "Edit"). */
  toolName: string
  /** Serialised tool input. */
  input: Record<string, unknown>
  /** Serialised tool output (may be truncated). */
  output?: string
  /** ISO-8601 timestamp of invocation. */
  timestamp: string
}

/** A repeating sequence of tool calls detected in the history. */
export type DetectedPattern = {
  /** Unique id for the pattern (deterministic hash of tool name sequence). */
  id: string
  /** Ordered tool names that form the pattern. */
  toolSequence: string[]
  /** How many times the pattern was observed. */
  occurrences: number
  /** Representative parameter templates extracted from the occurrences. */
  parameterTemplates: Record<string, unknown>[]
  /** Human-readable summary of what the pattern does. */
  description: string
  /** Suggested skill name (kebab-case). */
  suggestedName: string
}

/** Suggestion surfaced to the user when a pattern is detected. */
export type SkillSuggestion = {
  pattern: DetectedPattern
  /** Pre-rendered skill markdown that would be saved. */
  skillContent: string
  /** Why the suggestion was triggered. */
  reason: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic hash for a tool-name sequence (FNV-1a-ish, returns hex).
 * Not crypto-grade — just for dedup ids.
 */
function hashSequence(seq: string[]): string {
  let h = 0x811c9dc5
  for (const s of seq) {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = (h * 0x01000193) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * Generate a kebab-case name from a sequence of tool names.
 */
function suggestName(seq: string[]): string {
  const unique = [...new Set(seq)]
  return unique.map(n => n.toLowerCase()).join('-then-')
}

/**
 * Summarise a tool sequence as a human-readable sentence.
 */
function summariseSequence(seq: string[]): string {
  const steps = seq.map((name, i) => `${i + 1}. ${name}`)
  return `Multi-step workflow: ${steps.join(' → ')}`
}

/**
 * Extract generalised parameter templates from multiple occurrences.
 * Values that differ across occurrences are replaced with a `{{placeholder}}`.
 */
function extractTemplates(
  occurrences: ToolHistoryEntry[][],
): Record<string, unknown>[] {
  if (occurrences.length === 0) return []
  const reference = occurrences[0]!
  return reference.map((entry, stepIdx) => {
    const template: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entry.input)) {
      const allSame = occurrences.every(occ => {
        const step = occ[stepIdx]
        return step && JSON.stringify(step.input[key]) === JSON.stringify(value)
      })
      template[key] = allSame ? value : `{{${key}}}`
    }
    return template
  })
}

// ---------------------------------------------------------------------------
// SkillGenerator
// ---------------------------------------------------------------------------

/**
 * Analyses tool-call history to detect repeating multi-step patterns and
 * offers to persist them as reusable skill files compatible with the
 * existing `loadSkillsDir` loader.
 */
export class SkillGenerator {
  /** Minimum number of consecutive tool calls to consider a pattern. */
  private readonly minSequenceLength: number
  /** Minimum number of occurrences before a pattern is surfaced. */
  private readonly minOccurrences: number

  constructor(
    opts: { minSequenceLength?: number; minOccurrences?: number } = {},
  ) {
    this.minSequenceLength = opts.minSequenceLength ?? 3
    this.minOccurrences = opts.minOccurrences ?? 2
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Scan tool history and return all detected repeating patterns.
   *
   * The algorithm slides a window of lengths `minSequenceLength` through
   * `maxWindow` over the history, hashing tool-name subsequences. When a
   * subsequence hash appears at least `minOccurrences` times it is
   * returned as a `DetectedPattern`.
   */
  detectPatterns(toolHistory: ToolHistoryEntry[]): DetectedPattern[] {
    if (toolHistory.length < this.minSequenceLength * this.minOccurrences) {
      return []
    }

    const maxWindow = Math.min(8, Math.floor(toolHistory.length / 2))
    // Map: sequenceHash -> list of start indices
    const seenSequences = new Map<string, number[]>()

    for (let len = this.minSequenceLength; len <= maxWindow; len++) {
      for (let start = 0; start <= toolHistory.length - len; start++) {
        const seq = toolHistory.slice(start, start + len).map(e => e.toolName)
        const h = hashSequence(seq)
        const indices = seenSequences.get(h) ?? []
        indices.push(start)
        seenSequences.set(h, indices)
      }
    }

    const patterns: DetectedPattern[] = []
    const seenIds = new Set<string>()

    for (const [h, indices] of seenSequences) {
      // Filter overlapping occurrences — keep non-overlapping ones.
      const nonOverlapping = this.filterOverlapping(indices, this.minSequenceLength)
      if (nonOverlapping.length < this.minOccurrences) continue
      if (seenIds.has(h)) continue
      seenIds.add(h)

      const firstIdx = nonOverlapping[0]!
      const seqLen = this.sequenceLengthForHash(toolHistory, h)
      const seq = toolHistory
        .slice(firstIdx, firstIdx + seqLen)
        .map(e => e.toolName)

      const occurrences = nonOverlapping.map(idx =>
        toolHistory.slice(idx, idx + seqLen),
      )

      patterns.push({
        id: h,
        toolSequence: seq,
        occurrences: nonOverlapping.length,
        parameterTemplates: extractTemplates(occurrences),
        description: summariseSequence(seq),
        suggestedName: suggestName(seq),
      })
    }

    // Sort by occurrence count descending, then by sequence length descending.
    patterns.sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        b.toolSequence.length - a.toolSequence.length,
    )

    return patterns
  }

  /**
   * Generate a skill markdown file (with YAML frontmatter) from a detected
   * pattern. The output is compatible with `loadSkillsDir`.
   */
  generateSkillFile(pattern: DetectedPattern): string {
    const frontmatter = [
      '---',
      `name: ${pattern.suggestedName}`,
      `description: "${pattern.description}"`,
      `whenToUse: "When the user wants to ${pattern.description.toLowerCase()}"`,
      `allowedTools:`,
      ...pattern.toolSequence
        .filter((v, i, a) => a.indexOf(v) === i)
        .map(t => `  - ${t}`),
      '---',
    ].join('\n')

    const steps = pattern.toolSequence.map((toolName, i) => {
      const tmpl = pattern.parameterTemplates[i]
      const paramBlock = tmpl
        ? Object.entries(tmpl)
            .map(([k, v]) => `   - **${k}**: \`${JSON.stringify(v)}\``)
            .join('\n')
        : '   (no parameters)'
      return `${i + 1}. Use **${toolName}**\n${paramBlock}`
    })

    const body = [
      `# ${pattern.suggestedName}`,
      '',
      pattern.description,
      '',
      '## Steps',
      '',
      ...steps,
      '',
      '## Notes',
      '',
      '- This skill was auto-generated from repeated usage patterns.',
      '- Review and customise the parameter templates above before relying on this skill.',
    ].join('\n')

    return `${frontmatter}\n\n${body}\n`
  }

  /**
   * Write a skill file to the skills directory.
   *
   * @param name  Kebab-case skill name (used as filename).
   * @param content  Full markdown content including frontmatter.
   * @param scope  `'user'` saves to `~/.claude2/skills/`, `'project'` saves
   *               to `.claude2/skills/` relative to cwd.
   * @returns The absolute path of the written file.
   */
  async saveSkill(
    name: string,
    content: string,
    scope: 'user' | 'project',
  ): Promise<string> {
    const dir =
      scope === 'user'
        ? join(getClaudeConfigHomeDir() ?? join(process.env.HOME ?? '~', '.claude2'), 'skills')
        : join(process.cwd(), '.claude2', 'skills')

    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${name}.md`)
    await writeFile(filePath, content, 'utf8')
    logForDebugging(`Saved skill to ${filePath}`)
    return filePath
  }

  /**
   * High-level helper: detect patterns and return actionable suggestions.
   */
  getSuggestions(toolHistory: ToolHistoryEntry[]): SkillSuggestion[] {
    const patterns = this.detectPatterns(toolHistory)
    return patterns.map(pattern => ({
      pattern,
      skillContent: this.generateSkillFile(pattern),
      reason: `Detected ${pattern.occurrences} occurrences of a ${pattern.toolSequence.length}-step workflow (${pattern.toolSequence.join(' → ')}).`,
    }))
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * From a list of start indices, return only non-overlapping ones (greedy
   * left-to-right).
   */
  private filterOverlapping(indices: number[], seqLen: number): number[] {
    const sorted = [...indices].sort((a, b) => a - b)
    const kept: number[] = []
    let lastEnd = -1
    for (const idx of sorted) {
      if (idx >= lastEnd) {
        kept.push(idx)
        lastEnd = idx + seqLen
      }
    }
    return kept
  }

  /**
   * Recover the sequence length for a given hash by scanning possible
   * lengths. Falls back to `minSequenceLength`.
   */
  private sequenceLengthForHash(
    history: ToolHistoryEntry[],
    targetHash: string,
  ): number {
    const maxWindow = Math.min(8, Math.floor(history.length / 2))
    for (let len = maxWindow; len >= this.minSequenceLength; len--) {
      for (let start = 0; start <= history.length - len; start++) {
        const seq = history.slice(start, start + len).map(e => e.toolName)
        if (hashSequence(seq) === targetHash) return len
      }
    }
    return this.minSequenceLength
  }
}
