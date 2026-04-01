/**
 * Types for the Agent Daemon system.
 *
 * The daemon is the long-running background process that owns all watchers,
 * routes events to handlers, and manages a priority queue of deferred actions.
 */

import type { WatcherEvent, WatcherEventType } from '../watcher/types.js'

// ---------------------------------------------------------------------------
// Daemon status
// ---------------------------------------------------------------------------

export type DaemonState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

/** Snapshot of daemon health returned by `AgentDaemon.status()`. */
export interface DaemonStatus {
  state: DaemonState
  pid: number
  uptimeMs: number
  startedAt: string
  eventsProcessed: number
  queueDepth: number
  activeWatchers: string[]
  lastError?: string
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

/**
 * An event handler receives a watcher event and returns a (possibly empty)
 * list of deferred actions to enqueue.
 */
export type EventHandler = (event: WatcherEvent) => Promise<DeferredAction[]>

// ---------------------------------------------------------------------------
// Deferred action queue
// ---------------------------------------------------------------------------

export type ActionPriority = 'low' | 'normal' | 'high' | 'critical'

/** An action that the daemon should execute at a later time. */
export interface DeferredAction {
  /** Unique identifier. */
  id: string
  /** Human-readable description. */
  description: string
  /** Priority determines ordering in the queue. */
  priority: ActionPriority
  /** ISO-8601 timestamp of when the action was enqueued. */
  createdAt: string
  /** The event that triggered this action, if any. */
  sourceEvent?: WatcherEvent
  /**
   * The work to perform.  The daemon will `await` this function and catch
   * any errors so a single failing action cannot crash the process.
   */
  execute: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Daemon configuration
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  /** Directory for runtime state (PID file, logs, queue). Defaults to ~/.claude2 */
  stateDir: string
  /** How often (ms) to process the deferred-action queue. */
  queueProcessInterval: number
  /** How often (ms) to write a health-check log line. */
  healthCheckInterval: number
  /** Maximum consecutive crash restarts before giving up. */
  maxRestartAttempts: number
  /** Base delay (ms) for exponential backoff between restarts. */
  restartBackoffBase: number
  /** Per-watcher overrides keyed by watcher name. */
  watcherOverrides: Record<string, Partial<{ enabled: boolean; interval: number }>>
}

/** Sensible defaults for daemon configuration. */
export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  stateDir: `${process.env.HOME ?? '~'}/.claude2`,
  queueProcessInterval: 5_000,
  healthCheckInterval: 60_000,
  maxRestartAttempts: 5,
  restartBackoffBase: 1_000,
  watcherOverrides: {},
}
