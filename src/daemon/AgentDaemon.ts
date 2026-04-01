/**
 * AgentDaemon — the long-running autonomous background process.
 *
 * The daemon owns a WatcherManager, receives all watcher events, dispatches
 * them to registered handlers, and manages a priority queue of deferred
 * actions that are executed asynchronously.
 *
 * Lifecycle:
 *   1. `start()` — writes PID file, installs signal handlers, starts watchers
 *   2. Events flow: Watcher -> WatcherManager -> AgentDaemon -> EventHandler
 *   3. Handlers return DeferredActions which are enqueued and processed
 *   4. `stop()` — graceful shutdown: drain queue, stop watchers, remove PID
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Watcher, WatcherEvent, WatcherEventType } from '../watcher/types.js'
import { WatcherManager } from '../watcher/WatcherManager.js'
import type {
  ActionPriority,
  DaemonConfig,
  DaemonStatus,
  DaemonState,
  DeferredAction,
  EventHandler,
} from './types.js'
import { DEFAULT_DAEMON_CONFIG } from './types.js'

// ---------------------------------------------------------------------------
// Priority ordering (higher number = process first)
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<ActionPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AgentDaemon {
  private config: DaemonConfig
  private state: DaemonState = 'stopped'
  private startedAt: Date | null = null
  private eventsProcessed = 0
  private lastError: string | undefined

  private watcherManager = new WatcherManager()
  private handlers = new Map<string, EventHandler[]>()
  private queue: DeferredAction[] = []

  private queueTimer: ReturnType<typeof setInterval> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private signalHandlers: Array<{ signal: string; handler: () => void }> = []

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { ...DEFAULT_DAEMON_CONFIG, ...config }
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /** Start the daemon: write PID, install signals, start watchers & timers. */
  async start(): Promise<void> {
    if (this.state === 'running') return
    this.state = 'starting'
    this.startedAt = new Date()
    this.lastError = undefined

    try {
      this.ensureStateDir()
      this.writePidFile()
      this.installSignalHandlers()

      // Wire watcher events into our dispatch method
      this.watcherManager.onEvent((event) => this.dispatch(event))
      await this.watcherManager.startAll()

      // Periodic queue processing
      this.queueTimer = setInterval(
        () => this.processQueue().catch((e) => this.recordError(e)),
        this.config.queueProcessInterval,
      )

      // Periodic health-check log
      this.healthTimer = setInterval(() => this.logHealth(), this.config.healthCheckInterval)

      this.state = 'running'
      // eslint-disable-next-line no-console
      console.log(`[AgentDaemon] started (pid ${process.pid})`)
    } catch (err) {
      this.state = 'error'
      this.recordError(err)
      throw err
    }
  }

  /** Graceful shutdown: drain queue, stop watchers, clean up. */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') return
    this.state = 'stopping'

    // eslint-disable-next-line no-console
    console.log('[AgentDaemon] shutting down...')

    // Clear timers
    if (this.queueTimer) { clearInterval(this.queueTimer); this.queueTimer = null }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }

    // Process remaining queued actions
    await this.processQueue()

    // Stop all watchers
    await this.watcherManager.stopAll()

    // Remove signal handlers
    this.removeSignalHandlers()

    // Remove PID file
    this.removePidFile()

    this.state = 'stopped'
    // eslint-disable-next-line no-console
    console.log('[AgentDaemon] stopped')
  }

  /** Return a snapshot of daemon health. */
  status(): DaemonStatus {
    const uptimeMs = this.startedAt
      ? Date.now() - this.startedAt.getTime()
      : 0

    return {
      state: this.state,
      pid: process.pid,
      uptimeMs,
      startedAt: this.startedAt?.toISOString() ?? '',
      eventsProcessed: this.eventsProcessed,
      queueDepth: this.queue.length,
      activeWatchers: this.watcherManager.listWatchers(),
      lastError: this.lastError,
    }
  }

  // -- Watcher registration -------------------------------------------------

  /** Register a watcher with the internal WatcherManager. */
  registerWatcher(watcher: Watcher): void {
    this.watcherManager.register(watcher)
  }

  // -- Handler registration -------------------------------------------------

  /**
   * Register a handler for a specific event type.
   * Multiple handlers can be registered for the same type.
   */
  registerHandler(eventType: string, handler: EventHandler): void {
    const list = this.handlers.get(eventType) ?? []
    list.push(handler)
    this.handlers.set(eventType, list)
  }

  // -- Action queue ---------------------------------------------------------

  /** Enqueue a deferred action. The queue is sorted by priority. */
  enqueue(action: DeferredAction): void {
    this.queue.push(action)
    // Sort descending by priority
    this.queue.sort(
      (a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority],
    )
  }

  /** Process all actions currently in the queue (highest priority first). */
  async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const action = this.queue.shift()!
      try {
        await action.execute()
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[AgentDaemon] action "${action.description}" failed: ${String(err)}`,
        )
      }
    }
  }

  // ========================================================================
  // Internal
  // ========================================================================

  // -- Event dispatch -------------------------------------------------------

  /** Route a watcher event to all matching handlers. */
  private async dispatch(event: WatcherEvent): Promise<void> {
    this.eventsProcessed++

    const handlers = this.handlers.get(event.type) ?? []
    // Also invoke wildcard handlers registered under "*"
    const wildcards = this.handlers.get('*') ?? []

    for (const handler of [...handlers, ...wildcards]) {
      try {
        const actions = await handler(event)
        for (const action of actions) {
          this.enqueue(action)
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[AgentDaemon] handler error for ${event.type}: ${String(err)}`,
        )
      }
    }
  }

  // -- PID file management --------------------------------------------------

  private get pidFilePath(): string {
    return path.join(this.config.stateDir, 'daemon.pid')
  }

  private ensureStateDir(): void {
    fs.mkdirSync(this.config.stateDir, { recursive: true })
  }

  private writePidFile(): void {
    // Check for stale PID file
    if (fs.existsSync(this.pidFilePath)) {
      const oldPid = parseInt(fs.readFileSync(this.pidFilePath, 'utf-8').trim(), 10)
      if (!isNaN(oldPid) && this.isProcessAlive(oldPid)) {
        throw new Error(
          `Another daemon is already running (pid ${oldPid}). ` +
          `Remove ${this.pidFilePath} if this is stale.`,
        )
      }
      // Stale file — remove it
      fs.unlinkSync(this.pidFilePath)
    }

    fs.writeFileSync(this.pidFilePath, String(process.pid), 'utf-8')
  }

  private removePidFile(): void {
    try {
      if (fs.existsSync(this.pidFilePath)) {
        fs.unlinkSync(this.pidFilePath)
      }
    } catch {
      // best-effort
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0) // signal 0 = existence check
      return true
    } catch {
      return false
    }
  }

  // -- Signal handling ------------------------------------------------------

  private installSignalHandlers(): void {
    const shutdown = (): void => {
      this.stop().catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[AgentDaemon] error during shutdown: ${String(err)}`)
        process.exit(1)
      })
    }

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const handler = (): void => shutdown()
      process.on(signal, handler)
      this.signalHandlers.push({ signal, handler })
    }
  }

  private removeSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler)
    }
    this.signalHandlers = []
  }

  // -- Health & errors ------------------------------------------------------

  private logHealth(): void {
    const s = this.status()
    // eslint-disable-next-line no-console
    console.log(
      `[AgentDaemon] health: state=${s.state} uptime=${Math.round(s.uptimeMs / 1000)}s ` +
      `events=${s.eventsProcessed} queue=${s.queueDepth} watchers=${s.activeWatchers.join(',')}`,
    )
  }

  private recordError(err: unknown): void {
    this.lastError = String(err)
    // eslint-disable-next-line no-console
    console.error(`[AgentDaemon] ${this.lastError}`)
  }

  // ========================================================================
  // Static helper: start with auto-restart
  // ========================================================================

  /**
   * Start a daemon with automatic restart on crash (exponential backoff).
   * Returns the daemon instance. Callers should hold a reference to it.
   */
  static async startWithAutoRestart(
    config: Partial<DaemonConfig> = {},
    setupWatchers?: (daemon: AgentDaemon) => void,
  ): Promise<AgentDaemon> {
    const merged = { ...DEFAULT_DAEMON_CONFIG, ...config }
    let attempts = 0

    const launch = async (): Promise<AgentDaemon> => {
      const daemon = new AgentDaemon(merged)
      if (setupWatchers) setupWatchers(daemon)

      try {
        await daemon.start()
        attempts = 0 // reset on successful start
        return daemon
      } catch (err) {
        attempts++
        if (attempts >= merged.maxRestartAttempts) {
          // eslint-disable-next-line no-console
          console.error(
            `[AgentDaemon] exceeded max restart attempts (${merged.maxRestartAttempts}), giving up`,
          )
          throw err
        }

        const delay = merged.restartBackoffBase * Math.pow(2, attempts - 1)
        // eslint-disable-next-line no-console
        console.warn(
          `[AgentDaemon] restart attempt ${attempts}/${merged.maxRestartAttempts} in ${delay}ms`,
        )

        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        return launch()
      }
    }

    return launch()
  }
}
