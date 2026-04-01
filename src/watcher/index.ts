/**
 * Proactive Autonomous Watcher system.
 *
 * Re-exports all watcher implementations, the manager, and shared types.
 */

export * from './types.js'
export { FileWatcher } from './FileWatcher.js'
export type { FileWatcherConfig } from './FileWatcher.js'
export { GitWatcher } from './GitWatcher.js'
export type { GitWatcherConfig } from './GitWatcher.js'
export { CIWatcher } from './CIWatcher.js'
export type { CIWatcherConfig } from './CIWatcher.js'
export { IssueWatcher } from './IssueWatcher.js'
export type { IssueWatcherConfig } from './IssueWatcher.js'
export { WatcherManager } from './WatcherManager.js'
export type { WatcherStats } from './WatcherManager.js'
