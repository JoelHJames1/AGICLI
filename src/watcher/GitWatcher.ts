/**
 * GitWatcher — monitors a git repository for remote changes.
 *
 * Periodically polls via `git` and `gh` CLI commands to detect:
 *   - New commits on tracked remote branches
 *   - New pull requests
 *   - CI/CD run failures
 *   - PR review requests
 */

import { execSync } from 'node:child_process'
import type {
  CIFailurePayload,
  NewCommitPayload,
  NewPRPayload,
  PRReviewPayload,
  Watcher,
  WatcherConfig,
  WatcherEvent,
  WatcherEventCallback,
} from './types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface GitWatcherConfig extends WatcherConfig {
  /** Path to the git repository root. */
  repoDir: string
  /** Remote name to fetch from (default "origin"). */
  remote: string
  /** Branch to track (default "main"). */
  branch: string
}

export const DEFAULT_GIT_WATCHER_CONFIG: GitWatcherConfig = {
  enabled: true,
  interval: 60_000,
  filters: [],
  repoDir: process.cwd(),
  remote: 'origin',
  branch: 'main',
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GitWatcher implements Watcher {
  readonly name = 'GitWatcher'

  private config: GitWatcherConfig
  private callback: WatcherEventCallback | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** SHA of the last-seen remote HEAD. */
  private lastRemoteSha: string | null = null
  /** Set of known PR numbers so we only emit for new ones. */
  private knownPRs = new Set<number>()
  /** Set of known failed run IDs. */
  private knownFailedRuns = new Set<number>()

  constructor(config: Partial<GitWatcherConfig> = {}) {
    this.config = { ...DEFAULT_GIT_WATCHER_CONFIG, ...config }
  }

  // -- Watcher interface ----------------------------------------------------

  onEvent(callback: WatcherEventCallback): void {
    this.callback = callback
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Seed state so first poll doesn't fire for pre-existing items
    this.seed()

    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[GitWatcher] poll error: ${String(err)}`)
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

  /** Run a shell command in the repo directory. Returns stdout or null on failure. */
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
      console.error(`[GitWatcher] handler error: ${String(err)}`)
    }
  }

  // -- Seeding --------------------------------------------------------------

  /** Populate initial state so we only fire on *new* activity. */
  private seed(): void {
    // Current remote HEAD
    this.exec(`git fetch ${this.config.remote} ${this.config.branch} --quiet`)
    this.lastRemoteSha =
      this.exec(`git rev-parse ${this.config.remote}/${this.config.branch}`) ?? null

    // Existing PRs
    const prJson = this.exec('gh pr list --json number --limit 100')
    if (prJson) {
      try {
        const prs = JSON.parse(prJson) as Array<{ number: number }>
        for (const pr of prs) this.knownPRs.add(pr.number)
      } catch { /* ignore parse errors */ }
    }

    // Existing failed runs
    const runsJson = this.exec(
      'gh run list --status failure --json databaseId --limit 50',
    )
    if (runsJson) {
      try {
        const runs = JSON.parse(runsJson) as Array<{ databaseId: number }>
        for (const r of runs) this.knownFailedRuns.add(r.databaseId)
      } catch { /* ignore */ }
    }
  }

  // -- Polling --------------------------------------------------------------

  private async poll(): Promise<void> {
    this.checkNewCommits()
    this.checkNewPRs()
    this.checkCIFailures()
  }

  /** Detect new commits pushed to the tracked remote branch. */
  private checkNewCommits(): void {
    this.exec(`git fetch ${this.config.remote} ${this.config.branch} --quiet`)
    const currentSha = this.exec(
      `git rev-parse ${this.config.remote}/${this.config.branch}`,
    )
    if (!currentSha || currentSha === this.lastRemoteSha) return

    // Gather info about the new HEAD commit
    const msg =
      this.exec(
        `git log -1 --format=%s ${this.config.remote}/${this.config.branch}`,
      ) ?? ''
    const author =
      this.exec(
        `git log -1 --format=%an ${this.config.remote}/${this.config.branch}`,
      ) ?? 'unknown'

    const payload: NewCommitPayload = {
      sha: currentSha,
      message: msg,
      author,
      branch: this.config.branch,
    }

    this.emit({
      type: 'new_commit',
      source: this.name,
      payload,
      timestamp: new Date().toISOString(),
    })

    this.lastRemoteSha = currentSha
  }

  /** Detect newly opened pull requests. */
  private checkNewPRs(): void {
    const raw = this.exec(
      'gh pr list --json number,title,author,url --limit 50',
    )
    if (!raw) return

    let prs: Array<{ number: number; title: string; author: { login: string }; url: string }>
    try {
      prs = JSON.parse(raw)
    } catch {
      return
    }

    for (const pr of prs) {
      if (this.knownPRs.has(pr.number)) continue
      this.knownPRs.add(pr.number)

      const payload: NewPRPayload = {
        number: pr.number,
        title: pr.title,
        author: pr.author?.login ?? 'unknown',
        url: pr.url,
      }

      this.emit({
        type: 'new_pr',
        source: this.name,
        payload,
        timestamp: new Date().toISOString(),
      })
    }
  }

  /** Detect CI runs that failed since the last check. */
  private checkCIFailures(): void {
    const raw = this.exec(
      'gh run list --status failure --json databaseId,name,headSha,conclusion,url --limit 20',
    )
    if (!raw) return

    let runs: Array<{
      databaseId: number
      name: string
      headSha: string
      conclusion: string
      url: string
    }>
    try {
      runs = JSON.parse(raw)
    } catch {
      return
    }

    for (const run of runs) {
      if (this.knownFailedRuns.has(run.databaseId)) continue
      this.knownFailedRuns.add(run.databaseId)

      const payload: CIFailurePayload = {
        runId: run.databaseId,
        name: run.name,
        headSha: run.headSha,
        conclusion: run.conclusion,
        url: run.url,
      }

      this.emit({
        type: 'ci_failure',
        source: this.name,
        payload,
        timestamp: new Date().toISOString(),
      })
    }
  }
}
