/**
 * FileWatcher — monitors the filesystem for changes and emits structured events.
 *
 * Supports two modes:
 *   1. Native `fs.watch` (default, low-latency)
 *   2. Polling at a configurable interval (safer across network mounts)
 *
 * Changes are debounced so rapid saves don't flood the event bus.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  FileChangedPayload,
  Watcher,
  WatcherConfig,
  WatcherEvent,
  WatcherEventCallback,
  FileChangeKind,
} from './types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FileWatcherConfig extends WatcherConfig {
  /** Root directory to watch. */
  rootDir: string
  /** Glob-style include patterns (relative to rootDir). Empty = everything. */
  includePatterns: string[]
  /** Glob-style ignore patterns. Matched against the relative path. */
  ignorePatterns: string[]
  /** Debounce window in milliseconds (default 300). */
  debounceMs: number
  /** Use polling instead of native fs.watch (default false). */
  usePolling: boolean
}

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '*.swp',
  '*.swo',
  '*~',
]

export const DEFAULT_FILE_WATCHER_CONFIG: FileWatcherConfig = {
  enabled: true,
  interval: 1_000,
  filters: [],
  rootDir: process.cwd(),
  includePatterns: [],
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  debounceMs: 300,
  usePolling: false,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FileWatcher implements Watcher {
  readonly name = 'FileWatcher'

  private config: FileWatcherConfig
  private callback: WatcherEventCallback | null = null
  private nativeWatcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** Pending changes waiting to be flushed after debounce. */
  private pendingChanges = new Map<string, FileChangeKind>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  /** Snapshot of mtimes used by the polling strategy. */
  private snapshot = new Map<string, number>()

  constructor(config: Partial<FileWatcherConfig> = {}) {
    this.config = { ...DEFAULT_FILE_WATCHER_CONFIG, ...config }
  }

  // -- Watcher interface ----------------------------------------------------

  onEvent(callback: WatcherEventCallback): void {
    this.callback = callback
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    if (this.config.usePolling) {
      this.snapshot = this.buildSnapshot(this.config.rootDir)
      this.pollTimer = setInterval(() => this.poll(), this.config.interval)
    } else {
      try {
        this.nativeWatcher = fs.watch(
          this.config.rootDir,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return
            const rel = filename.toString()
            if (this.isIgnored(rel)) return
            const kind: FileChangeKind = eventType === 'rename' ? 'create' : 'modify'
            this.enqueueChange(path.join(this.config.rootDir, rel), kind)
          },
        )
        this.nativeWatcher.on('error', (err) => {
          // eslint-disable-next-line no-console
          console.error(`[FileWatcher] fs.watch error: ${String(err)}`)
        })
      } catch {
        // Fallback to polling if native watch fails
        // eslint-disable-next-line no-console
        console.warn('[FileWatcher] fs.watch unavailable, falling back to polling')
        this.snapshot = this.buildSnapshot(this.config.rootDir)
        this.pollTimer = setInterval(() => this.poll(), this.config.interval)
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.nativeWatcher) {
      this.nativeWatcher.close()
      this.nativeWatcher = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    // Flush remaining changes
    this.flushChanges()
  }

  // -- Internal -------------------------------------------------------------

  /** Check whether a relative path matches any ignore pattern. */
  private isIgnored(relPath: string): boolean {
    const segments = relPath.split(path.sep)
    return this.config.ignorePatterns.some((pattern) => {
      // Simple segment match (e.g. "node_modules", ".git")
      if (segments.includes(pattern)) return true
      // Wildcard suffix match (e.g. "*.swp")
      if (pattern.startsWith('*') && relPath.endsWith(pattern.slice(1))) return true
      return false
    })
  }

  /** Enqueue a pending change and (re)start the debounce timer. */
  private enqueueChange(absPath: string, kind: FileChangeKind): void {
    this.pendingChanges.set(absPath, kind)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.flushChanges(), this.config.debounceMs)
  }

  /** Emit events for all pending changes and clear the buffer. */
  private flushChanges(): void {
    if (!this.callback || this.pendingChanges.size === 0) return

    for (const [filePath, kind] of this.pendingChanges) {
      const event: WatcherEvent<FileChangedPayload> = {
        type: 'file_changed',
        source: this.name,
        payload: { path: filePath, kind },
        timestamp: new Date().toISOString(),
      }
      try {
        this.callback(event)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[FileWatcher] handler error: ${String(err)}`)
      }
    }
    this.pendingChanges.clear()
  }

  // -- Polling strategy -----------------------------------------------------

  /** Build an mtime snapshot of all tracked files under `dir`. */
  private buildSnapshot(dir: string): Map<string, number> {
    const snap = new Map<string, number>()
    try {
      this.walkDir(dir, (absPath) => {
        try {
          const stat = fs.statSync(absPath)
          snap.set(absPath, stat.mtimeMs)
        } catch {
          // file may have been removed between readdir and stat
        }
      })
    } catch {
      // root dir might be inaccessible
    }
    return snap
  }

  /** Recursively walk a directory, skipping ignored paths. */
  private walkDir(dir: string, visitor: (abs: string) => void): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = path.relative(this.config.rootDir, path.join(dir, entry.name))
      if (this.isIgnored(rel)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        this.walkDir(abs, visitor)
      } else if (entry.isFile()) {
        visitor(abs)
      }
    }
  }

  /** Single poll cycle: compare current state against snapshot. */
  private poll(): void {
    const current = this.buildSnapshot(this.config.rootDir)

    // Detect creates & modifications
    for (const [filePath, mtime] of current) {
      const prev = this.snapshot.get(filePath)
      if (prev === undefined) {
        this.enqueueChange(filePath, 'create')
      } else if (mtime !== prev) {
        this.enqueueChange(filePath, 'modify')
      }
    }

    // Detect deletions
    for (const filePath of this.snapshot.keys()) {
      if (!current.has(filePath)) {
        this.enqueueChange(filePath, 'delete')
      }
    }

    this.snapshot = current
  }
}
