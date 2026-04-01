/**
 * WatcherManager — central registry that owns all watchers.
 *
 * Responsibilities:
 *   - Register / unregister watchers by name
 *   - Start / stop all (or individual) watchers
 *   - Route every emitted event to a shared callback
 *   - Track aggregate event statistics
 */

import type { Watcher, WatcherEvent, WatcherEventCallback, WatcherEventType } from './types.js'

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface WatcherStats {
  totalEventsReceived: number
  eventsByType: Record<string, number>
  eventsBySource: Record<string, number>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class WatcherManager {
  private watchers = new Map<string, Watcher>()
  private eventCallback: WatcherEventCallback | null = null

  private stats: WatcherStats = {
    totalEventsReceived: 0,
    eventsByType: {},
    eventsBySource: {},
  }

  // -- Registration ---------------------------------------------------------

  /** Register a watcher. Overwrites any existing watcher with the same name. */
  register(watcher: Watcher): void {
    // If one already exists with this name, stop it first
    const existing = this.watchers.get(watcher.name)
    if (existing) {
      existing.stop().catch(() => {})
    }

    // Wire up the event callback so events flow through the manager
    watcher.onEvent((event) => this.handleEvent(event))
    this.watchers.set(watcher.name, watcher)
  }

  /** Unregister (and stop) a watcher by name. */
  async unregister(name: string): Promise<void> {
    const watcher = this.watchers.get(name)
    if (!watcher) return
    await watcher.stop()
    this.watchers.delete(name)
  }

  /** Set the callback that will receive all events from all watchers. */
  onEvent(callback: WatcherEventCallback): void {
    this.eventCallback = callback
  }

  // -- Lifecycle ------------------------------------------------------------

  /** Start all registered watchers. */
  async startAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const watcher of this.watchers.values()) {
      promises.push(
        watcher.start().catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[WatcherManager] failed to start ${watcher.name}: ${String(err)}`)
        }),
      )
    }
    await Promise.all(promises)
  }

  /** Stop all registered watchers. */
  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = []
    for (const watcher of this.watchers.values()) {
      promises.push(
        watcher.stop().catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[WatcherManager] failed to stop ${watcher.name}: ${String(err)}`)
        }),
      )
    }
    await Promise.all(promises)
  }

  /** Start a single watcher by name. */
  async start(name: string): Promise<void> {
    const watcher = this.watchers.get(name)
    if (!watcher) throw new Error(`Unknown watcher: ${name}`)
    await watcher.start()
  }

  /** Stop a single watcher by name. */
  async stop(name: string): Promise<void> {
    const watcher = this.watchers.get(name)
    if (!watcher) throw new Error(`Unknown watcher: ${name}`)
    await watcher.stop()
  }

  // -- Introspection --------------------------------------------------------

  /** Return the names of all registered watchers. */
  listWatchers(): string[] {
    return [...this.watchers.keys()]
  }

  /** Return aggregate event statistics. */
  getStats(): Readonly<WatcherStats> {
    return { ...this.stats }
  }

  /** Reset statistics counters. */
  resetStats(): void {
    this.stats = {
      totalEventsReceived: 0,
      eventsByType: {},
      eventsBySource: {},
    }
  }

  // -- Internal event routing -----------------------------------------------

  private handleEvent(event: WatcherEvent): void {
    // Update stats
    this.stats.totalEventsReceived++
    this.stats.eventsByType[event.type] =
      (this.stats.eventsByType[event.type] ?? 0) + 1
    this.stats.eventsBySource[event.source] =
      (this.stats.eventsBySource[event.source] ?? 0) + 1

    // Forward to consumer
    if (this.eventCallback) {
      try {
        this.eventCallback(event)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[WatcherManager] event callback error: ${String(err)}`)
      }
    }
  }
}
