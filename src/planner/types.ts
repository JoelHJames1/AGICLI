/**
 * Types for the Claude2 Strategic Planner.
 *
 * The planner enables long-horizon, multi-session goal pursuit with:
 * - DAG-based task decomposition
 * - Checkpointing for safe rollback
 * - Alternative approach tracking for backtracking
 * - Cross-session progress persistence
 */

// ============================================================================
// Goal Types
// ============================================================================

export type GoalStatus =
	| 'pending'        // Not started
	| 'planning'       // Being decomposed into subtasks
	| 'in_progress'    // Active work
	| 'blocked'        // Waiting on external dependency
	| 'completed'      // Successfully finished
	| 'failed'         // Failed after exhausting alternatives
	| 'abandoned'      // Manually abandoned by user

export interface Goal {
	id: string
	description: string
	status: GoalStatus
	created: string
	updated: string

	/** High-level success criteria. */
	successCriteria: string[]

	/** Decomposed subtasks (DAG). */
	subtasks: SubTask[]

	/** Checkpoints for rollback. */
	checkpoints: Checkpoint[]

	/** Total estimated complexity (1-10). */
	estimatedComplexity: number

	/** Session IDs that have worked on this goal. */
	sessionHistory: string[]

	/** Parent goal ID (for nested goals). */
	parentGoalId?: string

	/** Tags for categorization. */
	tags: string[]
}

// ============================================================================
// SubTask Types
// ============================================================================

export type SubTaskStatus =
	| 'pending'
	| 'in_progress'
	| 'completed'
	| 'failed'
	| 'skipped'

export interface SubTask {
	id: string
	description: string
	status: SubTaskStatus

	/** IDs of subtasks that must complete before this one. */
	dependsOn: string[]

	/** IDs of subtasks that are blocked by this one. */
	blocks: string[]

	/** Which agent type should handle this (coding, testing, reviewing). */
	agentType: AgentType

	/** Which model/provider is best for this subtask. */
	preferredModel?: string

	/** Estimated complexity (1-10). */
	estimatedComplexity: number

	/** Alternative approaches to try if this fails. */
	alternatives: AlternativeApproach[]

	/** Current approach being used. */
	currentApproachIndex: number

	/** Result/output when completed. */
	result?: string

	/** Error details when failed. */
	error?: string

	/** Checkpoint created after completion. */
	checkpointId?: string

	/** The session that last worked on this. */
	lastSessionId?: string
}

export type AgentType =
	| 'coding'
	| 'testing'
	| 'reviewing'
	| 'debugging'
	| 'researching'
	| 'documenting'
	| 'general'

export interface AlternativeApproach {
	description: string
	estimatedComplexity: number
	tried: boolean
	outcome?: 'success' | 'failure'
	failureReason?: string
}

// ============================================================================
// Checkpoint Types
// ============================================================================

export interface Checkpoint {
	id: string
	created: string

	/** Which subtask this checkpoint is after. */
	afterSubtaskId: string

	/** Git commit hash for rollback. */
	gitCommitHash?: string

	/** Git branch name. */
	gitBranch?: string

	/** Snapshot of relevant state. */
	stateSnapshot: Record<string, unknown>

	/** Human-readable description. */
	description: string
}

// ============================================================================
// Task Graph (DAG)
// ============================================================================

export interface TaskGraph {
	/** All nodes (subtasks). */
	nodes: Map<string, SubTask>

	/** Adjacency list: task ID → IDs it depends on. */
	dependencies: Map<string, Set<string>>

	/** Reverse adjacency: task ID → IDs that depend on it. */
	dependents: Map<string, Set<string>>
}

// ============================================================================
// Planner Store Interface
// ============================================================================

export interface PlannerStore {
	saveGoal(goal: Goal): Promise<void>
	getGoal(goalId: string): Promise<Goal | null>
	listGoals(filter?: { status?: GoalStatus[] }): Promise<Goal[]>
	deleteGoal(goalId: string): Promise<void>

	/** Get the active (in-progress) goals. */
	getActiveGoals(): Promise<Goal[]>
}
