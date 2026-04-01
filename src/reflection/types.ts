/**
 * Types for the Claude2 Reflection & Self-Improvement System.
 *
 * The reflection system enables the agent to:
 * 1. Evaluate the outcome of each action
 * 2. Detect and classify errors
 * 3. Track what strategies work and which don't
 * 4. Learn from failures across sessions
 * 5. Improve prompts and approaches over time
 */

// ============================================================================
// Reflection Events
// ============================================================================

/** An observation about a completed action. */
export interface ReflectionEvent {
	id: string
	timestamp: string
	sessionId: string

	/** What action was taken. */
	action: ActionRecord

	/** What happened. */
	outcome: ActionOutcome

	/** What was learned. */
	insight?: string

	/** Tags for categorization. */
	tags: string[]
}

/** Record of an action the agent took. */
export interface ActionRecord {
	/** Tool name or action type. */
	toolName: string

	/** What the agent was trying to accomplish. */
	intent: string

	/** Key parameters (sanitized — no secrets). */
	params: Record<string, unknown>

	/** Context: what task/goal this was part of. */
	goalId?: string
	taskId?: string
}

/** Outcome of an action. */
export interface ActionOutcome {
	/** Whether the action succeeded. */
	success: boolean

	/** Error message if failed. */
	error?: string

	/** Error classification. */
	errorType?: ErrorType

	/** How long the action took (ms). */
	durationMs: number

	/** Tokens consumed. */
	tokensUsed?: number

	/** Whether the user approved/rejected (for permission-gated actions). */
	userApproved?: boolean

	/** Whether this was a retry of a previous failed action. */
	isRetry?: boolean

	/** ID of the previous attempt if this is a retry. */
	previousAttemptId?: string
}

// ============================================================================
// Error Classification
// ============================================================================

export type ErrorType =
	| 'syntax_error'       // Code syntax mistake
	| 'type_error'         // Type mismatch
	| 'runtime_error'      // Runtime crash
	| 'test_failure'       // Tests didn't pass
	| 'build_failure'      // Build/compile error
	| 'permission_denied'  // User denied action
	| 'api_error'          // External API failure
	| 'timeout'            // Action timed out
	| 'resource_limit'     // Token/budget exceeded
	| 'wrong_approach'     // Strategy fundamentally wrong
	| 'partial_success'    // Partially completed
	| 'unknown'

// ============================================================================
// Error Patterns (Learned)
// ============================================================================

/** A pattern the agent has learned from repeated errors. */
export interface ErrorPattern {
	id: string

	/** Signature to match against (regex string or error hash). */
	errorSignature: string

	/** What kind of task triggers this error. */
	context: string

	/** What the agent tried that didn't work. */
	failedApproach: string

	/** What worked instead. */
	successfulApproach: string

	/** How many times this pattern has been confirmed. */
	confidence: number

	/** When this pattern was last seen. */
	lastSeen: string

	/** When this pattern was first observed. */
	firstSeen: string
}

// ============================================================================
// Strategy Tracking
// ============================================================================

/** Tracks the effectiveness of different approaches for a task type. */
export interface StrategyRecord {
	id: string

	/** Category of task (e.g., "fix-test-failure", "add-feature", "refactor"). */
	taskCategory: string

	/** The approach used. */
	strategy: string

	/** Success rate (0-1). */
	successRate: number

	/** Number of times attempted. */
	attempts: number

	/** Average tokens consumed. */
	avgTokens: number

	/** Average time to completion (ms). */
	avgDurationMs: number

	/** When last used. */
	lastUsed: string
}

// ============================================================================
// Reflection Summary (for Dream Mode integration)
// ============================================================================

/** Summary of reflections for dream/consolidation. */
export interface ReflectionSummary {
	sessionId: string
	timestamp: string

	/** Total actions taken. */
	totalActions: number

	/** Success rate. */
	successRate: number

	/** Most common error types. */
	topErrors: Array<{ type: ErrorType; count: number }>

	/** New patterns discovered. */
	newPatterns: ErrorPattern[]

	/** Strategy performance updates. */
	strategyUpdates: StrategyRecord[]

	/** Key learnings (natural language). */
	keyLearnings: string[]
}

// ============================================================================
// Reflection Store Interface
// ============================================================================

/** Interface for persisting reflection data. */
export interface ReflectionStore {
	/** Save a reflection event. */
	saveEvent(event: ReflectionEvent): Promise<void>

	/** Get recent events for the current session. */
	getSessionEvents(sessionId: string): Promise<ReflectionEvent[]>

	/** Get all error patterns. */
	getErrorPatterns(): Promise<ErrorPattern[]>

	/** Save/update an error pattern. */
	saveErrorPattern(pattern: ErrorPattern): Promise<void>

	/** Get strategy records for a task category. */
	getStrategies(taskCategory: string): Promise<StrategyRecord[]>

	/** Save/update a strategy record. */
	saveStrategy(record: StrategyRecord): Promise<void>

	/** Get the most recent reflection summary. */
	getLatestSummary(): Promise<ReflectionSummary | null>

	/** Save a reflection summary. */
	saveSummary(summary: ReflectionSummary): Promise<void>
}
