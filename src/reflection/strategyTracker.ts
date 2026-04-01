/**
 * Strategy Tracker for Claude2 Reflection System.
 *
 * Tracks which approaches work best for different task types.
 * Over time, the agent builds up a knowledge base of effective
 * strategies that compound across sessions.
 */

import type { StrategyRecord } from './types.js'

// ============================================================================
// Strategy Categories
// ============================================================================

/** Well-known task categories for strategy tracking. */
export type TaskCategory =
	| 'fix-bug'
	| 'add-feature'
	| 'refactor'
	| 'write-test'
	| 'debug'
	| 'code-review'
	| 'documentation'
	| 'dependency-update'
	| 'performance-optimization'
	| 'security-fix'
	| 'ci-fix'
	| 'general'

/**
 * Detect the task category from a description/prompt.
 */
export function detectTaskCategory(description: string): TaskCategory {
	const lower = description.toLowerCase()

	if (/\b(fix|bug|error|crash|broken|issue)\b/.test(lower)) return 'fix-bug'
	if (/\b(add|implement|create|new feature|build)\b/.test(lower)) return 'add-feature'
	if (/\b(refactor|clean up|restructure|reorganize|simplify)\b/.test(lower)) return 'refactor'
	if (/\b(test|spec|coverage|assert)\b/.test(lower)) return 'write-test'
	if (/\b(debug|investigate|trace|diagnose)\b/.test(lower)) return 'debug'
	if (/\b(review|audit|check|inspect)\b/.test(lower)) return 'code-review'
	if (/\b(doc|readme|comment|explain)\b/.test(lower)) return 'documentation'
	if (/\b(update|upgrade|bump|dependency|package)\b/.test(lower)) return 'dependency-update'
	if (/\b(perf|optimize|speed|slow|fast|latency)\b/.test(lower)) return 'performance-optimization'
	if (/\b(security|vuln|cve|xss|sql injection|auth)\b/.test(lower)) return 'security-fix'
	if (/\b(ci|pipeline|workflow|action|deploy)\b/.test(lower)) return 'ci-fix'

	return 'general'
}

// ============================================================================
// Strategy Tracking
// ============================================================================

/**
 * Update a strategy record with the outcome of an attempt.
 */
export function updateStrategy(
	existing: StrategyRecord | undefined,
	strategy: string,
	taskCategory: string,
	outcome: {
		success: boolean
		tokensUsed: number
		durationMs: number
	},
): StrategyRecord {
	if (!existing) {
		return {
			id: `strat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			taskCategory,
			strategy,
			successRate: outcome.success ? 1 : 0,
			attempts: 1,
			avgTokens: outcome.tokensUsed,
			avgDurationMs: outcome.durationMs,
			lastUsed: new Date().toISOString(),
		}
	}

	const newAttempts = existing.attempts + 1
	const successCount = Math.round(existing.successRate * existing.attempts) + (outcome.success ? 1 : 0)

	return {
		...existing,
		successRate: successCount / newAttempts,
		attempts: newAttempts,
		avgTokens: Math.round(
			(existing.avgTokens * existing.attempts + outcome.tokensUsed) / newAttempts,
		),
		avgDurationMs: Math.round(
			(existing.avgDurationMs * existing.attempts + outcome.durationMs) / newAttempts,
		),
		lastUsed: new Date().toISOString(),
	}
}

/**
 * Rank strategies for a task category by effectiveness.
 *
 * Uses a composite score: success rate (70%), efficiency (20%), recency (10%).
 */
export function rankStrategies(strategies: StrategyRecord[]): StrategyRecord[] {
	if (strategies.length === 0) return []

	const now = Date.now()
	const maxTokens = Math.max(...strategies.map((s) => s.avgTokens), 1)

	return [...strategies].sort((a, b) => {
		const scoreA = computeScore(a, now, maxTokens)
		const scoreB = computeScore(b, now, maxTokens)
		return scoreB - scoreA
	})
}

function computeScore(
	strategy: StrategyRecord,
	now: number,
	maxTokens: number,
): number {
	// Success rate (0-1) weighted at 70%
	const successScore = strategy.successRate * 0.7

	// Efficiency: fewer tokens = better (0-1) weighted at 20%
	const efficiencyScore = (1 - strategy.avgTokens / maxTokens) * 0.2

	// Recency: more recent = better (0-1) weighted at 10%
	const daysSinceUse =
		(now - new Date(strategy.lastUsed).getTime()) / (1000 * 60 * 60 * 24)
	const recencyScore = Math.max(0, 1 - daysSinceUse / 30) * 0.1

	// Confidence bonus for well-tested strategies
	const confidenceBonus = Math.min(strategy.attempts / 10, 1) * 0.05

	return successScore + efficiencyScore + recencyScore + confidenceBonus
}

/**
 * Get the best strategy recommendation for a task category.
 */
export function recommendStrategy(
	taskCategory: string,
	strategies: StrategyRecord[],
): {
	recommended: StrategyRecord | null
	alternatives: StrategyRecord[]
	exploration: boolean
} {
	const relevant = strategies.filter((s) => s.taskCategory === taskCategory)
	const ranked = rankStrategies(relevant)

	if (ranked.length === 0) {
		return {
			recommended: null,
			alternatives: [],
			exploration: true, // No data — explore freely
		}
	}

	const best = ranked[0]!

	// If the best strategy has low confidence, encourage exploration
	const shouldExplore = best.attempts < 3 || best.successRate < 0.5

	return {
		recommended: best,
		alternatives: ranked.slice(1, 4),
		exploration: shouldExplore,
	}
}

// ============================================================================
// Strategy Description Templates
// ============================================================================

/** Built-in strategy descriptions for common task types. */
export const STRATEGY_TEMPLATES: Record<TaskCategory, string[]> = {
	'fix-bug': [
		'Read the error, find the source, make minimal fix',
		'Write a failing test first, then fix the code',
		'Search codebase for similar patterns, apply consistent fix',
		'Use git blame to understand the original intent before fixing',
	],
	'add-feature': [
		'Study existing patterns, implement consistently',
		'Start with types/interfaces, then implementation, then tests',
		'Prototype minimal version first, then iterate',
		'Use plan mode to design before coding',
	],
	'refactor': [
		'Ensure tests pass before and after',
		'Small incremental changes, verify at each step',
		'Extract → test → rename → clean up',
		'Use LSP to understand all references before moving code',
	],
	'write-test': [
		'Read existing tests for patterns and conventions',
		'Test behavior, not implementation',
		'Start with happy path, then edge cases',
		'Use the same test framework and helpers as existing tests',
	],
	'debug': [
		'Reproduce first, then bisect to root cause',
		'Add logging at key points to trace execution',
		'Check recent changes (git log) for likely cause',
		'Use LSP go-to-definition to trace the call chain',
	],
	'code-review': [
		'Check for security issues first',
		'Verify test coverage for changed code',
		'Look for consistency with existing patterns',
		'Focus on correctness, then readability',
	],
	'documentation': [
		'Read existing docs for style and conventions',
		'Document the why, not just the what',
		'Include examples for complex APIs',
	],
	'dependency-update': [
		'Read changelog for breaking changes',
		'Update one dependency at a time',
		'Run full test suite after each update',
	],
	'performance-optimization': [
		'Profile first to identify actual bottleneck',
		'Measure before and after to verify improvement',
		'Start with algorithmic changes before micro-optimizations',
	],
	'security-fix': [
		'Understand the vulnerability before patching',
		'Check for similar vulnerabilities in related code',
		'Add test to verify the fix prevents the attack',
	],
	'ci-fix': [
		'Check CI logs for the exact failure',
		'Reproduce locally before fixing',
		'Check if environment differences cause the failure',
	],
	'general': [
		'Understand the codebase structure first',
		'Make small, verifiable changes',
		'Test after each change',
	],
}
