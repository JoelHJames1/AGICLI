/**
 * Reflection Engine for Claude2.
 *
 * The central component of the self-improvement system. Observes actions,
 * evaluates outcomes, updates the knowledge base, and provides guidance
 * for future actions.
 *
 * Integration points:
 * - QueryEngine: Called after each tool execution to record outcomes
 * - Dream mode: Generates reflection summaries for memory consolidation
 * - Planning mode: Provides strategy recommendations before execution
 * - Memory system: Stores learned patterns in persistent memory
 */

import { classifyError, createErrorSignature, findMatchingPatterns, learnFromResolution, suggestRecovery } from './errorAnalyzer.js'
import { detectTaskCategory, rankStrategies, recommendStrategy, updateStrategy } from './strategyTracker.js'
import type {
	ActionOutcome,
	ActionRecord,
	ErrorPattern,
	ReflectionEvent,
	ReflectionStore,
	ReflectionSummary,
	StrategyRecord,
} from './types.js'

// ============================================================================
// Reflection Engine
// ============================================================================

export class ReflectionEngine {
	private store: ReflectionStore
	private sessionId: string

	/** In-memory cache of error patterns for fast lookup. */
	private errorPatterns: ErrorPattern[] = []

	/** In-memory cache of strategy records. */
	private strategies: Map<string, StrategyRecord[]> = new Map()

	/** Events from the current session. */
	private sessionEvents: ReflectionEvent[] = []

	/** Track consecutive failures for the same action type. */
	private consecutiveFailures: Map<string, number> = new Map()

	constructor(store: ReflectionStore, sessionId: string) {
		this.store = store
		this.sessionId = sessionId
	}

	/**
	 * Initialize by loading persisted knowledge.
	 */
	async initialize(): Promise<void> {
		this.errorPatterns = await this.store.getErrorPatterns()
	}

	// ========================================================================
	// Core: Record an action outcome
	// ========================================================================

	/**
	 * Record the outcome of an action and update knowledge base.
	 * Called after each tool execution in the query loop.
	 */
	async recordOutcome(
		action: ActionRecord,
		outcome: ActionOutcome,
	): Promise<{
		/** Suggestions for recovery if the action failed. */
		recoverySuggestions?: string[]
		/** Whether the agent should try a different approach. */
		shouldPivot: boolean
		/** The best alternative approach, if known. */
		alternativeApproach?: string
	}> {
		// Create reflection event
		const event: ReflectionEvent = {
			id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date().toISOString(),
			sessionId: this.sessionId,
			action,
			outcome,
			tags: [action.toolName, outcome.success ? 'success' : 'failure'],
		}

		this.sessionEvents.push(event)
		await this.store.saveEvent(event)

		// Track consecutive failures
		const failureKey = `${action.toolName}:${action.intent}`
		if (!outcome.success) {
			const count = (this.consecutiveFailures.get(failureKey) || 0) + 1
			this.consecutiveFailures.set(failureKey, count)
		} else {
			this.consecutiveFailures.delete(failureKey)
		}

		// If successful, no recovery needed
		if (outcome.success) {
			return { shouldPivot: false }
		}

		// Analyze failure
		const errorMsg = outcome.error || 'Unknown error'
		const recovery = suggestRecovery(errorMsg, this.errorPatterns)
		const consecutiveCount = this.consecutiveFailures.get(failureKey) || 1

		return {
			recoverySuggestions: recovery.learnedApproach
				? [recovery.learnedApproach, ...recovery.builtInStrategies]
				: recovery.builtInStrategies,
			shouldPivot: consecutiveCount >= 3 || recovery.errorType === 'wrong_approach',
			alternativeApproach: recovery.learnedApproach ?? undefined,
		}
	}

	// ========================================================================
	// Learn from a resolved error
	// ========================================================================

	/**
	 * Record that an error was resolved with a specific approach.
	 * Called when a retry succeeds after a failure.
	 */
	async learnFromResolution(
		errorMessage: string,
		failedApproach: string,
		successfulApproach: string,
	): Promise<void> {
		const pattern = learnFromResolution(
			errorMessage,
			failedApproach,
			successfulApproach,
			this.errorPatterns,
		)

		// Update in-memory cache
		const existingIndex = this.errorPatterns.findIndex(
			(p) => p.id === pattern.id,
		)
		if (existingIndex >= 0) {
			this.errorPatterns[existingIndex] = pattern
		} else {
			this.errorPatterns.push(pattern)
		}

		// Persist
		await this.store.saveErrorPattern(pattern)
	}

	// ========================================================================
	// Strategy guidance
	// ========================================================================

	/**
	 * Get strategy recommendations before starting a task.
	 * Provides the agent with learned knowledge about what works.
	 */
	async getRecommendation(taskDescription: string): Promise<{
		category: string
		recommended: StrategyRecord | null
		alternatives: StrategyRecord[]
		shouldExplore: boolean
		relevantPatterns: ErrorPattern[]
	}> {
		const category = detectTaskCategory(taskDescription)

		// Load strategies for this category if not cached
		if (!this.strategies.has(category)) {
			const strategies = await this.store.getStrategies(category)
			this.strategies.set(category, strategies)
		}

		const strategies = this.strategies.get(category) || []
		const recommendation = recommendStrategy(category, strategies)

		// Find any error patterns that might be relevant
		const relevantPatterns = this.errorPatterns.filter(
			(p) => p.context === category || p.context === 'unclassified',
		)

		return {
			category,
			recommended: recommendation.recommended,
			alternatives: recommendation.alternatives,
			shouldExplore: recommendation.exploration,
			relevantPatterns: relevantPatterns.slice(0, 5),
		}
	}

	/**
	 * Record the outcome of a strategy for a task.
	 */
	async recordStrategyOutcome(
		taskDescription: string,
		strategy: string,
		outcome: {
			success: boolean
			tokensUsed: number
			durationMs: number
		},
	): Promise<void> {
		const category = detectTaskCategory(taskDescription)

		const strategies = this.strategies.get(category) || []
		const existing = strategies.find((s) => s.strategy === strategy)
		const updated = updateStrategy(existing, strategy, category, outcome)

		// Update cache
		if (existing) {
			const index = strategies.indexOf(existing)
			strategies[index] = updated
		} else {
			strategies.push(updated)
		}
		this.strategies.set(category, strategies)

		// Persist
		await this.store.saveStrategy(updated)
	}

	// ========================================================================
	// Session summary (for Dream mode)
	// ========================================================================

	/**
	 * Generate a summary of this session's reflections.
	 * Used by Dream mode for memory consolidation.
	 */
	async generateSessionSummary(): Promise<ReflectionSummary> {
		const events = this.sessionEvents
		const totalActions = events.length
		const successCount = events.filter((e) => e.outcome.success).length
		const successRate = totalActions > 0 ? successCount / totalActions : 1

		// Count error types
		const errorCounts = new Map<string, number>()
		for (const event of events) {
			if (!event.outcome.success && event.outcome.errorType) {
				const count = errorCounts.get(event.outcome.errorType) || 0
				errorCounts.set(event.outcome.errorType, count + 1)
			}
		}

		const topErrors = [...errorCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([type, count]) => ({ type: type as any, count }))

		// Collect new patterns discovered this session
		const sessionPatternIds = new Set(
			events
				.filter((e) => !e.outcome.success)
				.map((e) => createErrorSignature(e.outcome.error || '')),
		)
		const newPatterns = this.errorPatterns.filter(
			(p) => sessionPatternIds.has(p.errorSignature) && p.confidence === 1,
		)

		// Key learnings (natural language)
		const keyLearnings: string[] = []
		if (successRate < 0.5) {
			keyLearnings.push(
				`Low success rate (${Math.round(successRate * 100)}%) — consider using plan mode for complex tasks`,
			)
		}
		if (topErrors.length > 0) {
			keyLearnings.push(
				`Most common error: ${topErrors[0]!.type} (${topErrors[0]!.count} occurrences)`,
			)
		}
		if (newPatterns.length > 0) {
			keyLearnings.push(
				`Discovered ${newPatterns.length} new error pattern(s) this session`,
			)
		}

		const summary: ReflectionSummary = {
			sessionId: this.sessionId,
			timestamp: new Date().toISOString(),
			totalActions,
			successRate,
			topErrors,
			newPatterns,
			strategyUpdates: [...this.strategies.values()].flat(),
			keyLearnings,
		}

		await this.store.saveSummary(summary)
		return summary
	}

	// ========================================================================
	// Prompt augmentation
	// ========================================================================

	/**
	 * Generate a reflection context string to inject into the system prompt.
	 * Gives the agent awareness of past learnings before acting.
	 */
	async getPromptContext(taskDescription?: string): Promise<string> {
		const parts: string[] = []

		parts.push('## Reflection Context (Learned from past sessions)')

		// Recent error patterns
		if (this.errorPatterns.length > 0) {
			const recentPatterns = this.errorPatterns
				.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
				.slice(0, 5)

			parts.push('\n### Known Error Patterns:')
			for (const pattern of recentPatterns) {
				parts.push(
					`- When seeing "${pattern.errorSignature.slice(0, 80)}..." → ` +
					`Try: ${pattern.successfulApproach} (confidence: ${pattern.confidence})`,
				)
			}
		}

		// Strategy recommendations for the task
		if (taskDescription) {
			const rec = await this.getRecommendation(taskDescription)
			if (rec.recommended) {
				parts.push(
					`\n### Recommended approach for ${rec.category}: ` +
					`"${rec.recommended.strategy}" ` +
					`(${Math.round(rec.recommended.successRate * 100)}% success rate, ${rec.recommended.attempts} attempts)`,
				)
			}
		}

		// Session stats
		if (this.sessionEvents.length > 0) {
			const successCount = this.sessionEvents.filter((e) => e.outcome.success).length
			parts.push(
				`\n### Current session: ${successCount}/${this.sessionEvents.length} actions successful`,
			)
		}

		return parts.join('\n')
	}
}

// ============================================================================
// File-based Reflection Store
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * File-based implementation of ReflectionStore.
 * Stores data in ~/.claude2/reflection/ directory.
 */
export class FileReflectionStore implements ReflectionStore {
	private baseDir: string

	constructor(projectSlug: string) {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp'
		this.baseDir = join(homeDir, '.claude2', 'projects', projectSlug, 'reflection')
		this.ensureDir()
	}

	private ensureDir(): void {
		if (!existsSync(this.baseDir)) {
			mkdirSync(this.baseDir, { recursive: true })
		}
	}

	async saveEvent(event: ReflectionEvent): Promise<void> {
		const file = join(this.baseDir, 'events.jsonl')
		const line = JSON.stringify(event) + '\n'
		writeFileSync(file, line, { flag: 'a' })
	}

	async getSessionEvents(sessionId: string): Promise<ReflectionEvent[]> {
		const file = join(this.baseDir, 'events.jsonl')
		if (!existsSync(file)) return []

		return readFileSync(file, 'utf-8')
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				try { return JSON.parse(line) } catch { return null }
			})
			.filter((e): e is ReflectionEvent => e?.sessionId === sessionId)
	}

	async getErrorPatterns(): Promise<ErrorPattern[]> {
		const file = join(this.baseDir, 'error_patterns.json')
		if (!existsSync(file)) return []
		try {
			return JSON.parse(readFileSync(file, 'utf-8'))
		} catch {
			return []
		}
	}

	async saveErrorPattern(pattern: ErrorPattern): Promise<void> {
		const patterns = await this.getErrorPatterns()
		const index = patterns.findIndex((p) => p.id === pattern.id)
		if (index >= 0) {
			patterns[index] = pattern
		} else {
			patterns.push(pattern)
		}
		// Keep only the 100 most confident patterns
		patterns.sort((a, b) => b.confidence - a.confidence)
		const trimmed = patterns.slice(0, 100)
		writeFileSync(
			join(this.baseDir, 'error_patterns.json'),
			JSON.stringify(trimmed, null, 2),
		)
	}

	async getStrategies(taskCategory: string): Promise<StrategyRecord[]> {
		const file = join(this.baseDir, 'strategies.json')
		if (!existsSync(file)) return []
		try {
			const all: StrategyRecord[] = JSON.parse(readFileSync(file, 'utf-8'))
			return all.filter((s) => s.taskCategory === taskCategory)
		} catch {
			return []
		}
	}

	async saveStrategy(record: StrategyRecord): Promise<void> {
		const file = join(this.baseDir, 'strategies.json')
		let all: StrategyRecord[] = []
		if (existsSync(file)) {
			try {
				all = JSON.parse(readFileSync(file, 'utf-8'))
			} catch {
				// Ignore corrupt file
			}
		}
		const index = all.findIndex((s) => s.id === record.id)
		if (index >= 0) {
			all[index] = record
		} else {
			all.push(record)
		}
		writeFileSync(file, JSON.stringify(all, null, 2))
	}

	async getLatestSummary(): Promise<ReflectionSummary | null> {
		const file = join(this.baseDir, 'latest_summary.json')
		if (!existsSync(file)) return null
		try {
			return JSON.parse(readFileSync(file, 'utf-8'))
		} catch {
			return null
		}
	}

	async saveSummary(summary: ReflectionSummary): Promise<void> {
		writeFileSync(
			join(this.baseDir, 'latest_summary.json'),
			JSON.stringify(summary, null, 2),
		)
	}
}
