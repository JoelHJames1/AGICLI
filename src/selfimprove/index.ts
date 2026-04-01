/**
 * Claude2 Self-Improvement Pipeline — Main Entry Point
 *
 * Builds on top of the Reflection Engine to create a compound learning loop:
 * - PerformanceTracker: track and analyze task outcomes over time
 * - PromptOptimizer: A/B test and evolve system prompts
 * - SkillEvolver: improve individual skills based on performance data
 * - BenchmarkRunner: run self-evaluation benchmarks
 * - ImprovementEngine: orchestrate the full improvement cycle
 */

export { PerformanceTracker } from './PerformanceTracker.js'
export { PromptOptimizer } from './PromptOptimizer.js'
export { SkillEvolver } from './SkillEvolver.js'
export { BenchmarkRunner, BUILTIN_BENCHMARKS } from './BenchmarkRunner.js'
export { ImprovementEngine } from './ImprovementEngine.js'

export type {
	ABTestResult,
	BenchmarkComparison,
	BenchmarkDefinition,
	BenchmarkResult,
	BenchmarkTestCase,
	CategoryMetrics,
	DateRange,
	ImprovementReport,
	MetricsComparison,
	PerformanceMetrics,
	PromptVariant,
	SkillComparison,
	SkillEvolutionRecord,
	TaskOutcome,
	VariantMetrics,
} from './types.js'
