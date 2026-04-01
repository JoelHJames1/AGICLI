/**
 * Types for the Proactive Autonomous Watcher system.
 *
 * Watchers monitor external sources (filesystem, git, CI, issues) and emit
 * structured events that the daemon can route to registered handlers.
 */

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/** Discriminated union of all event types the watcher system can produce. */
export type WatcherEventType =
  | 'file_changed'
  | 'git_push'
  | 'new_commit'
  | 'new_pr'
  | 'ci_failure'
  | 'issue_created'
  | 'pr_review'
  | 'pr_review_requested'
  | 'dependency_vulnerability'

/** The kind of filesystem change detected by the FileWatcher. */
export type FileChangeKind = 'create' | 'modify' | 'delete'

// ---------------------------------------------------------------------------
// Core event
// ---------------------------------------------------------------------------

/** A structured event emitted by any watcher. */
export interface WatcherEvent<T = unknown> {
  /** Discriminated event type. */
  type: WatcherEventType
  /** Human-readable source identifier, e.g. "FileWatcher" or "CIWatcher". */
  source: string
  /** Arbitrary payload whose shape depends on `type`. */
  payload: T
  /** ISO-8601 timestamp of when the event was created. */
  timestamp: string
}

// ---------------------------------------------------------------------------
// Typed payloads
// ---------------------------------------------------------------------------

export interface FileChangedPayload {
  path: string
  kind: FileChangeKind
}

export interface NewCommitPayload {
  sha: string
  message: string
  author: string
  branch: string
}

export interface NewPRPayload {
  number: number
  title: string
  author: string
  url: string
}

export interface CIFailurePayload {
  runId: number
  name: string
  headSha: string
  conclusion: string
  url: string
  jobName?: string
  stepName?: string
}

export interface IssueCreatedPayload {
  number: number
  title: string
  labels: string[]
  author: string
  url: string
  priority: 'low' | 'medium' | 'high' | 'critical'
}

export interface PRReviewPayload {
  prNumber: number
  reviewer: string
  state: string
}

// ---------------------------------------------------------------------------
// Watcher configuration & interface
// ---------------------------------------------------------------------------

/** Per-watcher configuration. */
export interface WatcherConfig {
  /** Whether this watcher is active. */
  enabled: boolean
  /** Poll / check interval in milliseconds. */
  interval: number
  /** Optional list of event types to emit (empty = all). */
  filters: WatcherEventType[]
}

/** Callback signature for watcher consumers. */
export type WatcherEventCallback = (event: WatcherEvent) => void

/** The contract every watcher must satisfy. */
export interface Watcher {
  /** Unique name, e.g. "FileWatcher". */
  readonly name: string
  /** Start monitoring. Resolves once the watcher is running. */
  start(): Promise<void>
  /** Gracefully stop monitoring. */
  stop(): Promise<void>
  /** Register the callback that receives emitted events. */
  onEvent(callback: WatcherEventCallback): void
}
