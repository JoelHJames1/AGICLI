/**
 * Claude2 Reflection System — Main Entry Point
 *
 * Provides self-improvement capabilities:
 * - Error pattern recognition and learning
 * - Strategy tracking and recommendation
 * - Session reflection summaries for dream mode
 * - Prompt augmentation with learned knowledge
 */

export { ReflectionEngine, FileReflectionStore } from './ReflectionEngine.js'

export {
	classifyError,
	createErrorSignature,
	findMatchingPatterns,
	learnFromResolution,
	suggestRecovery,
} from './errorAnalyzer.js'

export {
	detectTaskCategory,
	rankStrategies,
	recommendStrategy,
	updateStrategy,
	STRATEGY_TEMPLATES,
} from './strategyTracker.js'

export type {
	ActionOutcome,
	ActionRecord,
	ErrorPattern,
	ErrorType,
	ReflectionEvent,
	ReflectionStore,
	ReflectionSummary,
	StrategyRecord,
} from './types.js'

export type { TaskCategory } from './strategyTracker.js'
