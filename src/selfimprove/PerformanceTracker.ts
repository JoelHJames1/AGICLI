/**
 * Performance Tracker for Claude2.
 *
 * Tracks success/failure rates and efficiency metrics over time.
 * Data is stored as JSONL in ~/.claude2/metrics/performance.jsonl
 * and supports aggregation by time windows (day, week, month, all).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
	CategoryMetrics,
	DateRange,
	MetricsComparison,
	PerformanceMetrics,
	TaskOutcome,
} from './types.js'

// ============================================================================
// Internal Types
// ============================================================================

/** A single persisted task record (one JSONL line). */
interface TaskRecord {
	category: string
	outcome: TaskOutcome
}

// ============================================================================
// PerformanceTracker
// ============================================================================

export class PerformanceTracker {
	private filePath: string
	private records: TaskRecord[] = []
	private loaded = false

	constructor(baseDir?: string) {
		const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
		const dir = baseDir ?? join(home, '.claude2', 'metrics')
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
		this.filePath = join(dir, 'performance.jsonl')
	}

	// ========================================================================
	// Record a task outcome
	// ========================================================================

	/**
	 * Record the outcome of a completed task.
	 * @param category - The task category (e.g. "code-gen", "bug-fix").
	 * @param outcome - The outcome details.
	 */
	recordTask(category: string, outcome: TaskOutcome): void {
		const record: TaskRecord = { category, outcome }
		this.records.push(record)
		// Append to file immediately for durability
		try {
			writeFileSync(this.filePath, JSON.stringify(record) + '\n', { flag: 'a' })
		} catch {
			// Swallow write errors — metrics are best-effort
		}
	}

	// ========================================================================
	// Metrics aggregation
	// ========================================================================

	/**
	 * Get aggregated metrics for a given time period.
	 */
	getMetrics(period: 'day' | 'week' | 'month' | 'all'): PerformanceMetrics {
		this.ensureLoaded()
		const cutoff = this.periodCutoff(period)
		const filtered = this.recordsSince(cutoff)
		return this.aggregate(filtered)
	}

	/**
	 * Get the performance trend for a specific category.
	 * Compares the most recent half of data to the older half.
	 */
	getTrend(category: string): 'improving' | 'stable' | 'degrading' {
		this.ensureLoaded()
		const catRecords = this.records.filter((r) => r.category === category)
		if (catRecords.length < 4) return 'stable'

		const mid = Math.floor(catRecords.length / 2)
		const older = catRecords.slice(0, mid)
		const newer = catRecords.slice(mid)

		const olderRate = this.successRate(older)
		const newerRate = this.successRate(newer)
		const delta = newerRate - olderRate

		if (delta > 0.05) return 'improving'
		if (delta < -0.05) return 'degrading'
		return 'stable'
	}

	/**
	 * Compare performance between two explicit date ranges.
	 */
	comparePerformance(period1: DateRange, period2: DateRange): MetricsComparison {
		this.ensureLoaded()
		const r1 = this.recordsInRange(period1)
		const r2 = this.recordsInRange(period2)
		const m1 = this.aggregate(r1)
		const m2 = this.aggregate(r2)

		return {
			period1: m1,
			period2: m2,
			successRateDelta: m2.successRate - m1.successRate,
			tokensDelta: m2.avgTokensPerTask - m1.avgTokensPerTask,
			durationDelta: m2.avgDurationPerTask - m1.avgDurationPerTask,
		}
	}

	/**
	 * Identify the worst-performing task categories with suggestions.
	 */
	getWeakAreas(): Array<{ category: string; successRate: number; suggestion: string }> {
		this.ensureLoaded()
		const metrics = this.getMetrics('all')
		const areas: Array<{ category: string; successRate: number; suggestion: string }> = []

		for (const [category, cm] of Object.entries(metrics.byCategory)) {
			if (cm.totalTasks < 3) continue // not enough data
			if (cm.successRate < 0.7) {
				areas.push({
					category,
					successRate: cm.successRate,
					suggestion: this.suggestImprovement(category, cm),
				})
			}
		}

		return areas.sort((a, b) => a.successRate - b.successRate)
	}

	// ========================================================================
	// Persistence
	// ========================================================================

	/** Persist all in-memory records to disk (full rewrite). */
	async save(): Promise<void> {
		try {
			const lines = this.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
			writeFileSync(this.filePath, lines)
		} catch {
			// Best-effort
		}
	}

	/** Load records from disk. */
	async load(): Promise<void> {
		this.records = []
		if (!existsSync(this.filePath)) return
		try {
			const content = readFileSync(this.filePath, 'utf-8')
			for (const line of content.split('\n')) {
				if (!line.trim()) continue
				try {
					this.records.push(JSON.parse(line))
				} catch {
					// Skip malformed lines
				}
			}
		} catch {
			// File unreadable — start fresh
		}
		this.loaded = true
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	private ensureLoaded(): void {
		if (!this.loaded) {
			// Synchronous fallback for getMetrics / getTrend calls
			this.records = []
			if (existsSync(this.filePath)) {
				try {
					const content = readFileSync(this.filePath, 'utf-8')
					for (const line of content.split('\n')) {
						if (!line.trim()) continue
						try {
							this.records.push(JSON.parse(line))
						} catch { /* skip */ }
					}
				} catch { /* empty */ }
			}
			this.loaded = true
		}
	}

	private periodCutoff(period: 'day' | 'week' | 'month' | 'all'): Date {
		const now = new Date()
		switch (period) {
			case 'day': return new Date(now.getTime() - 24 * 60 * 60 * 1000)
			case 'week': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
			case 'month': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
			case 'all': return new Date(0)
		}
	}

	private recordsSince(cutoff: Date): TaskRecord[] {
		return this.records.filter(
			(r) => new Date(r.outcome.timestamp).getTime() >= cutoff.getTime(),
		)
	}

	private recordsInRange(range: DateRange): TaskRecord[] {
		const start = new Date(range.start).getTime()
		const end = new Date(range.end).getTime()
		return this.records.filter((r) => {
			const t = new Date(r.outcome.timestamp).getTime()
			return t >= start && t <= end
		})
	}

	private aggregate(records: TaskRecord[]): PerformanceMetrics {
		if (records.length === 0) {
			return {
				successRate: 0,
				avgTokensPerTask: 0,
				avgDurationPerTask: 0,
				errorRate: 0,
				totalTasks: 0,
				byCategory: {},
			}
		}

		const successes = records.filter((r) => r.outcome.success).length
		const totalTokens = records.reduce((s, r) => s + r.outcome.tokensUsed, 0)
		const totalDuration = records.reduce((s, r) => s + r.outcome.durationMs, 0)

		// Group by category
		const groups = new Map<string, TaskRecord[]>()
		for (const r of records) {
			const arr = groups.get(r.category) || []
			arr.push(r)
			groups.set(r.category, arr)
		}

		const byCategory: Record<string, CategoryMetrics> = {}
		for (const [cat, recs] of groups) {
			const catSuccesses = recs.filter((r) => r.outcome.success).length
			const catTokens = recs.reduce((s, r) => s + r.outcome.tokensUsed, 0)
			const catDuration = recs.reduce((s, r) => s + r.outcome.durationMs, 0)
			byCategory[cat] = {
				successRate: catSuccesses / recs.length,
				avgTokens: catTokens / recs.length,
				avgDuration: catDuration / recs.length,
				totalTasks: recs.length,
				errorRate: 1 - catSuccesses / recs.length,
			}
		}

		return {
			successRate: successes / records.length,
			avgTokensPerTask: totalTokens / records.length,
			avgDurationPerTask: totalDuration / records.length,
			errorRate: 1 - successes / records.length,
			totalTasks: records.length,
			byCategory,
		}
	}

	private successRate(records: TaskRecord[]): number {
		if (records.length === 0) return 0
		return records.filter((r) => r.outcome.success).length / records.length
	}

	private suggestImprovement(category: string, metrics: CategoryMetrics): string {
		if (metrics.errorRate > 0.5) {
			return `Category "${category}" fails more than half the time. Consider evolving prompts or adding specialized error handling.`
		}
		if (metrics.avgTokens > 5000) {
			return `Category "${category}" uses excessive tokens (avg ${Math.round(metrics.avgTokens)}). Consider more focused prompts or chunking.`
		}
		if (metrics.avgDuration > 60000) {
			return `Category "${category}" is slow (avg ${Math.round(metrics.avgDuration / 1000)}s). Consider caching or simpler strategies.`
		}
		return `Category "${category}" has a ${Math.round(metrics.successRate * 100)}% success rate. Review recent failures for patterns.`
	}
}
