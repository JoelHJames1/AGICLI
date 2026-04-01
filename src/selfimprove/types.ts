/**
 * Types for the Claude2 Self-Improvement Pipeline.
 *
 * Builds on top of the Reflection Engine to provide:
 * 1. Performance tracking and trend analysis
 * 2. Prompt A/B testing and evolution
 * 3. Skill-level performance monitoring
 * 4. Self-evaluation benchmarks
 * 5. Orchestrated improvement cycles
 */

import type { ErrorType } from '../reflection/types.js'

// ============================================================================
// Task Outcomes
// ============================================================================

/** Outcome of a single task execution. */
export interface TaskOutcome {
	/** Whether the task completed successfully. */
	success: boolean
	/** Tokens consumed during execution. */
	tokensUsed: number
	/** Duration in milliseconds. */
	durationMs: number
	/** Error type if failed. */
	errorType?: ErrorType
	/** Timestamp of completion. */
	timestamp: string
	/** Free-form metadata. */
	metadata?: Record<string, unknown>
}

// ============================================================================
// Performance Metrics
// ============================================================================

/** Aggregated performance metrics for a time period. */
export interface PerformanceMetrics {
	/** Overall success rate (0-1). */
	successRate: number
	/** Average tokens consumed per task. */
	avgTokensPerTask: number
	/** Average duration per task in milliseconds. */
	avgDurationPerTask: number
	/** Overall error rate (0-1). */
	errorRate: number
	/** Total number of tasks in this period. */
	totalTasks: number
	/** Metrics broken down by task category. */
	byCategory: Record<string, CategoryMetrics>
}

/** Metrics for a single task category. */
export interface CategoryMetrics {
	successRate: number
	avgTokens: number
	avgDuration: number
	totalTasks: number
	errorRate: number
}

/** A date range for period comparisons. */
export interface DateRange {
	start: string
	end: string
}

/** Comparison between two time periods. */
export interface MetricsComparison {
	period1: PerformanceMetrics
	period2: PerformanceMetrics
	successRateDelta: number
	tokensDelta: number
	durationDelta: number
}

// ============================================================================
// Prompt Optimization
// ============================================================================

/** A variant of a prompt being tested. */
export interface PromptVariant {
	/** Unique identifier. */
	id: string
	/** The prompt group this belongs to. */
	name: string
	/** The actual prompt text. */
	content: string
	/** Performance metrics for this variant. */
	metrics: VariantMetrics
	/** Generation number (0 = original, 1+ = evolved). */
	generation: number
	/** ID of the parent variant this was evolved from. */
	parentId?: string
	/** When this variant was created. */
	createdAt: string
}

/** Performance metrics for a single prompt variant. */
export interface VariantMetrics {
	successes: number
	failures: number
	totalTokens: number
	trials: number
}

/** Results of an A/B test between prompt variants. */
export interface ABTestResult {
	name: string
	variants: Array<{
		id: string
		successRate: number
		avgTokens: number
		trials: number
		confidence: number
	}>
	bestVariantId: string | null
	significanceReached: boolean
}

// ============================================================================
// Benchmarks
// ============================================================================

/** Result of running a single benchmark. */
export interface BenchmarkResult {
	/** Unique run ID. */
	runId: string
	/** Which benchmark was run. */
	benchmarkId: string
	/** Score (0-100). */
	score: number
	/** When the benchmark was run. */
	timestamp: string
	/** Model used (for tracking across model changes). */
	model: string
	/** Detailed sub-scores and notes. */
	details: Record<string, unknown>
}

/** Comparison between two benchmark runs. */
export interface BenchmarkComparison {
	benchmarkId: string
	run1: BenchmarkResult
	run2: BenchmarkResult
	scoreDelta: number
	improved: boolean
}

/** Definition of a benchmark test. */
export interface BenchmarkDefinition {
	id: string
	name: string
	description: string
	/** Set up the benchmark environment and return test cases. */
	setup: () => Promise<BenchmarkTestCase[]>
	/** Evaluate a single test case result. */
	evaluate: (testCase: BenchmarkTestCase, result: string) => Promise<number>
	/** Scoring rubric description. */
	rubric: string
}

/** A single test case within a benchmark. */
export interface BenchmarkTestCase {
	id: string
	input: string
	expectedOutput?: string
	metadata?: Record<string, unknown>
}

// ============================================================================
// Skill Evolution
// ============================================================================

/** Record of a skill's performance over time. */
export interface SkillEvolutionRecord {
	skillName: string
	version: number
	metrics: CategoryMetrics
	changelog: string[]
	createdAt: string
	promotedAt?: string
}

/** Comparison between two versions of a skill. */
export interface SkillComparison {
	skillName: string
	currentVersion: number
	candidateVersion: number
	currentMetrics: CategoryMetrics
	candidateMetrics: CategoryMetrics
	shouldPromote: boolean
	reason: string
}

// ============================================================================
// Improvement Reports
// ============================================================================

/** Report generated at the end of an improvement cycle. */
export interface ImprovementReport {
	/** When this cycle ran. */
	timestamp: string
	/** Period covered by the report. */
	period: DateRange
	/** How metrics changed during this period. */
	metricsChange: MetricsComparison
	/** New skills or skill improvements discovered. */
	newSkills: SkillEvolutionRecord[]
	/** Prompt changes made during this cycle. */
	promptChanges: Array<{ name: string; oldVariantId: string; newVariantId: string }>
	/** Benchmark results from this cycle. */
	benchmarkResults: BenchmarkResult[]
	/** Human-readable summary of improvements. */
	summary: string
}
