/**
 * IssueWatcher — monitors GitHub issues for newly created items.
 *
 * Polls `gh issue list` on a configurable interval, detects issues that
 * appeared since the last check, auto-classifies priority based on labels
 * and content, and emits structured events.
 */

import { execSync } from 'node:child_process'
import type {
  IssueCreatedPayload,
  Watcher,
  WatcherConfig,
  WatcherEvent,
  WatcherEventCallback,
} from './types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface IssueWatcherConfig extends WatcherConfig {
  /** Path to the git repository root. */
  repoDir: string
  /** Maximum number of issues to fetch per poll. */
  fetchLimit: number
  /** Label substrings that map to priorities. */
  priorityLabels: Record<IssueCreatedPayload['priority'], string[]>
}

export const DEFAULT_ISSUE_WATCHER_CONFIG: IssueWatcherConfig = {
  enabled: true,
  interval: 120_000, // 2 minutes
  filters: [],
  repoDir: process.cwd(),
  fetchLimit: 50,
  priorityLabels: {
    critical: ['critical', 'P0', 'severity/critical', 'security'],
    high: ['high', 'P1', 'severity/high', 'urgent'],
    medium: ['medium', 'P2', 'severity/medium'],
    low: ['low', 'P3', 'severity/low', 'good first issue', 'enhancement'],
  },
}

// ---------------------------------------------------------------------------
// Raw JSON shapes returned by `gh`
// ---------------------------------------------------------------------------

interface GHIssue {
  number: number
  title: string
  url: string
  createdAt: string
  labels: Array<{ name: string }>
  author: { login: string }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class IssueWatcher implements Watcher {
  readonly name = 'IssueWatcher'

  private config: IssueWatcherConfig
  private callback: WatcherEventCallback | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** Issue numbers we have already seen. */
  private knownIssues = new Set<number>()
  private seeded = false

  constructor(config: Partial<IssueWatcherConfig> = {}) {
    this.config = { ...DEFAULT_ISSUE_WATCHER_CONFIG, ...config }
  }

  // -- Watcher interface ----------------------------------------------------

  onEvent(callback: WatcherEventCallback): void {
    this.callback = callback
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    this.seed()

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[IssueWatcher] poll error: ${String(err)}`)
      })
    }, this.config.interval)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // -- Helpers --------------------------------------------------------------

  private exec(cmd: string): string | null {
    try {
      return execSync(cmd, {
        cwd: this.config.repoDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch {
      return null
    }
  }

  private emit(event: WatcherEvent): void {
    if (!this.callback) return
    try {
      this.callback(event)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[IssueWatcher] handler error: ${String(err)}`)
    }
  }

  // -- Priority classification ----------------------------------------------

  /**
   * Derive a priority from the issue's labels and title.
   * Scans from highest to lowest; first match wins.
   */
  private classifyPriority(
    labels: string[],
    title: string,
  ): IssueCreatedPayload['priority'] {
    const text = [...labels, title].map((s) => s.toLowerCase())

    const priorities: IssueCreatedPayload['priority'][] = [
      'critical',
      'high',
      'medium',
      'low',
    ]

    for (const prio of priorities) {
      const patterns = this.config.priorityLabels[prio]
      for (const pattern of patterns) {
        if (text.some((t) => t.includes(pattern.toLowerCase()))) {
          return prio
        }
      }
    }

    // Default
    return 'medium'
  }

  // -- Seeding --------------------------------------------------------------

  private seed(): void {
    const issues = this.fetchIssues()
    for (const issue of issues) {
      this.knownIssues.add(issue.number)
    }
    this.seeded = true
  }

  // -- Polling --------------------------------------------------------------

  private fetchIssues(): GHIssue[] {
    const raw = this.exec(
      `gh issue list --state open --json number,title,url,createdAt,labels,author --limit ${this.config.fetchLimit}`,
    )
    if (!raw) return []
    try {
      return JSON.parse(raw) as GHIssue[]
    } catch {
      return []
    }
  }

  private async poll(): Promise<void> {
    if (!this.seeded) return

    const issues = this.fetchIssues()

    for (const issue of issues) {
      if (this.knownIssues.has(issue.number)) continue
      this.knownIssues.add(issue.number)

      const labelNames = issue.labels.map((l) => l.name)
      const priority = this.classifyPriority(labelNames, issue.title)

      const payload: IssueCreatedPayload = {
        number: issue.number,
        title: issue.title,
        labels: labelNames,
        author: issue.author?.login ?? 'unknown',
        url: issue.url,
        priority,
      }

      this.emit({
        type: 'issue_created',
        source: this.name,
        payload,
        timestamp: new Date().toISOString(),
      })
    }

    // Prune stale entries to prevent unbounded memory growth
    if (this.knownIssues.size > 1_000) {
      const currentNumbers = new Set(issues.map((i) => i.number))
      for (const num of this.knownIssues) {
        if (!currentNumbers.has(num)) this.knownIssues.delete(num)
      }
    }
  }
}
