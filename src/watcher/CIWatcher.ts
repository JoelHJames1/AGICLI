/**
 * CIWatcher — monitors GitHub Actions CI/CD pipelines for failures.
 *
 * Polls `gh run list` on a configurable interval and emits detailed
 * failure events including the specific job and step that failed.
 */

import { execSync } from 'node:child_process'
import type {
  CIFailurePayload,
  Watcher,
  WatcherConfig,
  WatcherEvent,
  WatcherEventCallback,
} from './types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CIWatcherConfig extends WatcherConfig {
  /** Path to the git repository root. */
  repoDir: string
  /** Only track runs for this branch (empty string = all branches). */
  branch: string
  /** Maximum number of runs to fetch per poll. */
  fetchLimit: number
}

export const DEFAULT_CI_WATCHER_CONFIG: CIWatcherConfig = {
  enabled: true,
  interval: 120_000, // 2 minutes
  filters: [],
  repoDir: process.cwd(),
  branch: '',
  fetchLimit: 30,
}

// ---------------------------------------------------------------------------
// Raw JSON shapes returned by `gh`
// ---------------------------------------------------------------------------

interface GHRun {
  databaseId: number
  name: string
  headSha: string
  headBranch: string
  conclusion: string
  status: string
  url: string
  createdAt: string
}

interface GHJob {
  name: string
  conclusion: string
  steps: Array<{
    name: string
    conclusion: string
    number: number
  }>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CIWatcher implements Watcher {
  readonly name = 'CIWatcher'

  private config: CIWatcherConfig
  private callback: WatcherEventCallback | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** Run IDs we have already emitted an event for. */
  private seenFailedRuns = new Set<number>()
  /** Tracks whether we have completed the initial seed. */
  private seeded = false

  constructor(config: Partial<CIWatcherConfig> = {}) {
    this.config = { ...DEFAULT_CI_WATCHER_CONFIG, ...config }
  }

  // -- Watcher interface ----------------------------------------------------

  onEvent(callback: WatcherEventCallback): void {
    this.callback = callback
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Seed so we don't fire for pre-existing failures
    this.seed()

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[CIWatcher] poll error: ${String(err)}`)
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
      console.error(`[CIWatcher] handler error: ${String(err)}`)
    }
  }

  // -- Seeding --------------------------------------------------------------

  private seed(): void {
    const runs = this.fetchFailedRuns()
    for (const run of runs) {
      this.seenFailedRuns.add(run.databaseId)
    }
    this.seeded = true
  }

  // -- Polling --------------------------------------------------------------

  private fetchFailedRuns(): GHRun[] {
    const branchFilter = this.config.branch
      ? ` --branch ${this.config.branch}`
      : ''
    const raw = this.exec(
      `gh run list --status failure${branchFilter} --json databaseId,name,headSha,headBranch,conclusion,status,url,createdAt --limit ${this.config.fetchLimit}`,
    )
    if (!raw) return []
    try {
      return JSON.parse(raw) as GHRun[]
    } catch {
      return []
    }
  }

  /** Fetch job-level details for a specific run to identify the failing step. */
  private fetchJobDetails(runId: number): { jobName?: string; stepName?: string } {
    const raw = this.exec(
      `gh run view ${runId} --json jobs`,
    )
    if (!raw) return {}

    try {
      const data = JSON.parse(raw) as { jobs: GHJob[] }
      for (const job of data.jobs) {
        if (job.conclusion === 'failure') {
          const failedStep = job.steps.find((s) => s.conclusion === 'failure')
          return {
            jobName: job.name,
            stepName: failedStep?.name,
          }
        }
      }
    } catch { /* ignore */ }
    return {}
  }

  private async poll(): Promise<void> {
    if (!this.seeded) return

    const runs = this.fetchFailedRuns()

    for (const run of runs) {
      if (this.seenFailedRuns.has(run.databaseId)) continue
      this.seenFailedRuns.add(run.databaseId)

      // Attempt to get job/step level detail
      const details = this.fetchJobDetails(run.databaseId)

      const payload: CIFailurePayload = {
        runId: run.databaseId,
        name: run.name,
        headSha: run.headSha,
        conclusion: run.conclusion,
        url: run.url,
        jobName: details.jobName,
        stepName: details.stepName,
      }

      this.emit({
        type: 'ci_failure',
        source: this.name,
        payload,
        timestamp: new Date().toISOString(),
      })
    }

    // Prevent unbounded growth of the seen-set by pruning old entries
    if (this.seenFailedRuns.size > 500) {
      const currentIds = new Set(runs.map((r) => r.databaseId))
      for (const id of this.seenFailedRuns) {
        if (!currentIds.has(id)) this.seenFailedRuns.delete(id)
      }
    }
  }
}
