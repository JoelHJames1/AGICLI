/**
 * Strategic Planner for Claude2.
 *
 * Handles high-level goal decomposition, task DAG management,
 * checkpoint creation, and backtracking when approaches fail.
 *
 * This is a core AGI component: the ability to pursue complex,
 * multi-step goals with planning, execution, and adaptation.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildTaskGraph, getCriticalPath, getDownstreamImpact, getReadyTasks, visualizeGraph } from './taskGraph.js'
import type {
	AlternativeApproach,
	Checkpoint,
	Goal,
	GoalStatus,
	PlannerStore,
	SubTask,
	SubTaskStatus,
} from './types.js'

// ============================================================================
// Strategic Planner
// ============================================================================

export class StrategicPlanner {
	private store: PlannerStore

	constructor(store: PlannerStore) {
		this.store = store
	}

	// ========================================================================
	// Goal Management
	// ========================================================================

	/**
	 * Create a new goal from a high-level description.
	 */
	async createGoal(description: string, successCriteria: string[]): Promise<Goal> {
		const goal: Goal = {
			id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			description,
			status: 'pending',
			created: new Date().toISOString(),
			updated: new Date().toISOString(),
			successCriteria,
			subtasks: [],
			checkpoints: [],
			estimatedComplexity: 5, // Default, refined during planning
			sessionHistory: [],
			tags: [],
		}

		await this.store.saveGoal(goal)
		return goal
	}

	/**
	 * Decompose a goal into subtasks.
	 * Called with a pre-computed list of subtasks (from LLM planning).
	 */
	async decomposeGoal(
		goalId: string,
		subtasks: Array<{
			description: string
			dependsOn: string[]
			agentType: SubTask['agentType']
			estimatedComplexity: number
			alternatives?: string[]
		}>,
	): Promise<Goal> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) throw new Error(`Goal not found: ${goalId}`)

		// Create subtask objects
		const taskObjects: SubTask[] = subtasks.map((st, index) => ({
			id: `task_${goalId}_${index}`,
			description: st.description,
			status: 'pending' as SubTaskStatus,
			dependsOn: st.dependsOn,
			blocks: [],
			agentType: st.agentType,
			estimatedComplexity: st.estimatedComplexity,
			alternatives: (st.alternatives || []).map((desc) => ({
				description: desc,
				estimatedComplexity: st.estimatedComplexity,
				tried: false,
			})),
			currentApproachIndex: 0,
		}))

		// Compute reverse dependencies (blocks)
		for (const task of taskObjects) {
			for (const depId of task.dependsOn) {
				const depTask = taskObjects.find((t) => t.id === depId)
				if (depTask && !depTask.blocks.includes(task.id)) {
					depTask.blocks.push(task.id)
				}
			}
		}

		// Validate DAG (no cycles)
		const graph = buildTaskGraph(taskObjects)
		const readyTasks = getReadyTasks(graph)
		if (readyTasks.length === 0 && taskObjects.length > 0) {
			throw new Error('Task decomposition has circular dependencies — no tasks are ready to start')
		}

		goal.subtasks = taskObjects
		goal.status = 'in_progress'
		goal.estimatedComplexity = Math.ceil(
			taskObjects.reduce((sum, t) => sum + t.estimatedComplexity, 0) / Math.max(taskObjects.length, 1),
		)
		goal.updated = new Date().toISOString()

		await this.store.saveGoal(goal)
		return goal
	}

	// ========================================================================
	// Execution
	// ========================================================================

	/**
	 * Get the next tasks that are ready to be executed.
	 */
	async getNextTasks(goalId: string): Promise<SubTask[]> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) return []

		const graph = buildTaskGraph(goal.subtasks)
		return getReadyTasks(graph)
	}

	/**
	 * Mark a subtask as in-progress.
	 */
	async startSubtask(goalId: string, subtaskId: string, sessionId: string): Promise<void> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) return

		const task = goal.subtasks.find((t) => t.id === subtaskId)
		if (!task) return

		task.status = 'in_progress'
		task.lastSessionId = sessionId

		if (!goal.sessionHistory.includes(sessionId)) {
			goal.sessionHistory.push(sessionId)
		}
		goal.updated = new Date().toISOString()

		await this.store.saveGoal(goal)
	}

	/**
	 * Mark a subtask as completed, optionally creating a checkpoint.
	 */
	async completeSubtask(
		goalId: string,
		subtaskId: string,
		result: string,
		gitCommitHash?: string,
	): Promise<void> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) return

		const task = goal.subtasks.find((t) => t.id === subtaskId)
		if (!task) return

		task.status = 'completed'
		task.result = result

		// Create checkpoint
		const checkpoint: Checkpoint = {
			id: `cp_${subtaskId}_${Date.now()}`,
			created: new Date().toISOString(),
			afterSubtaskId: subtaskId,
			gitCommitHash,
			stateSnapshot: {},
			description: `After completing: ${task.description}`,
		}
		task.checkpointId = checkpoint.id
		goal.checkpoints.push(checkpoint)

		// Check if all subtasks are complete
		const allComplete = goal.subtasks.every(
			(t) => t.status === 'completed' || t.status === 'skipped',
		)
		if (allComplete) {
			goal.status = 'completed'
		}

		goal.updated = new Date().toISOString()
		await this.store.saveGoal(goal)
	}

	/**
	 * Mark a subtask as failed and handle backtracking.
	 */
	async failSubtask(
		goalId: string,
		subtaskId: string,
		error: string,
	): Promise<{
		/** Whether an alternative approach is available. */
		hasAlternative: boolean
		/** The alternative to try, if available. */
		alternative?: AlternativeApproach
		/** Tasks impacted by this failure. */
		impactedTasks: SubTask[]
		/** Whether to rollback to a checkpoint. */
		shouldRollback: boolean
		/** Checkpoint to rollback to, if applicable. */
		rollbackCheckpoint?: Checkpoint
	}> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) {
			return {
				hasAlternative: false,
				impactedTasks: [],
				shouldRollback: false,
			}
		}

		const task = goal.subtasks.find((t) => t.id === subtaskId)
		if (!task) {
			return {
				hasAlternative: false,
				impactedTasks: [],
				shouldRollback: false,
			}
		}

		// Mark current approach as failed
		if (task.currentApproachIndex < task.alternatives.length) {
			task.alternatives[task.currentApproachIndex]!.tried = true
			task.alternatives[task.currentApproachIndex]!.outcome = 'failure'
			task.alternatives[task.currentApproachIndex]!.failureReason = error
		}

		// Check for untried alternatives
		const nextAlternative = task.alternatives.find((a) => !a.tried)

		// Get downstream impact
		const graph = buildTaskGraph(goal.subtasks)
		const impacted = getDownstreamImpact(graph, subtaskId)

		if (nextAlternative) {
			// Try alternative approach
			task.currentApproachIndex = task.alternatives.indexOf(nextAlternative)
			task.status = 'pending' // Reset to pending for retry
			task.error = error
			goal.updated = new Date().toISOString()
			await this.store.saveGoal(goal)

			return {
				hasAlternative: true,
				alternative: nextAlternative,
				impactedTasks: impacted,
				shouldRollback: false,
			}
		}

		// No alternatives left — fail the task
		task.status = 'failed'
		task.error = error

		// Find the most recent checkpoint before this task
		const rollbackCheckpoint = goal.checkpoints
			.filter((cp) => cp.afterSubtaskId !== subtaskId)
			.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())[0]

		// If more than half of impacted tasks are pending, consider goal failure
		const totalTasks = goal.subtasks.length
		const failedOrImpacted = 1 + impacted.length
		if (failedOrImpacted > totalTasks / 2) {
			goal.status = 'failed'
		}

		goal.updated = new Date().toISOString()
		await this.store.saveGoal(goal)

		return {
			hasAlternative: false,
			impactedTasks: impacted,
			shouldRollback: !!rollbackCheckpoint,
			rollbackCheckpoint,
		}
	}

	// ========================================================================
	// Progress & Visualization
	// ========================================================================

	/**
	 * Get progress summary for a goal.
	 */
	async getProgress(goalId: string): Promise<{
		total: number
		completed: number
		inProgress: number
		failed: number
		pending: number
		percentage: number
		criticalPath: SubTask[]
		visualization: string
	}> {
		const goal = await this.store.getGoal(goalId)
		if (!goal) {
			return {
				total: 0, completed: 0, inProgress: 0, failed: 0, pending: 0,
				percentage: 0, criticalPath: [], visualization: 'Goal not found',
			}
		}

		const graph = buildTaskGraph(goal.subtasks)

		const completed = goal.subtasks.filter((t) => t.status === 'completed').length
		const inProgress = goal.subtasks.filter((t) => t.status === 'in_progress').length
		const failed = goal.subtasks.filter((t) => t.status === 'failed').length
		const pending = goal.subtasks.filter((t) => t.status === 'pending').length
		const total = goal.subtasks.length

		return {
			total,
			completed,
			inProgress,
			failed,
			pending,
			percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
			criticalPath: getCriticalPath(graph),
			visualization: visualizeGraph(graph),
		}
	}

	/**
	 * List all active goals with brief status.
	 */
	async listActiveGoals(): Promise<Array<{
		goal: Goal
		percentage: number
		nextTasks: SubTask[]
	}>> {
		const goals = await this.store.getActiveGoals()
		const results = []

		for (const goal of goals) {
			const graph = buildTaskGraph(goal.subtasks)
			const completed = goal.subtasks.filter((t) => t.status === 'completed').length
			const total = goal.subtasks.length

			results.push({
				goal,
				percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
				nextTasks: getReadyTasks(graph),
			})
		}

		return results
	}
}

// ============================================================================
// File-based Planner Store
// ============================================================================

export class FilePlannerStore implements PlannerStore {
	private baseDir: string

	constructor(projectSlug: string) {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp'
		this.baseDir = join(homeDir, '.claude2', 'projects', projectSlug, 'goals')
		this.ensureDir()
	}

	private ensureDir(): void {
		if (!existsSync(this.baseDir)) {
			mkdirSync(this.baseDir, { recursive: true })
		}
	}

	async saveGoal(goal: Goal): Promise<void> {
		const file = join(this.baseDir, `${goal.id}.json`)
		writeFileSync(file, JSON.stringify(goal, null, 2))
	}

	async getGoal(goalId: string): Promise<Goal | null> {
		const file = join(this.baseDir, `${goalId}.json`)
		if (!existsSync(file)) return null
		try {
			return JSON.parse(readFileSync(file, 'utf-8'))
		} catch {
			return null
		}
	}

	async listGoals(filter?: { status?: GoalStatus[] }): Promise<Goal[]> {
		const goals: Goal[] = []

		if (!existsSync(this.baseDir)) return goals

		for (const file of readdirSync(this.baseDir)) {
			if (!file.endsWith('.json')) continue
			try {
				const goal: Goal = JSON.parse(
					readFileSync(join(this.baseDir, file), 'utf-8'),
				)
				if (!filter?.status || filter.status.includes(goal.status)) {
					goals.push(goal)
				}
			} catch {
				// Skip corrupt files
			}
		}

		return goals.sort(
			(a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime(),
		)
	}

	async deleteGoal(goalId: string): Promise<void> {
		const file = join(this.baseDir, `${goalId}.json`)
		if (existsSync(file)) {
			const { unlinkSync } = await import('fs')
			unlinkSync(file)
		}
	}

	async getActiveGoals(): Promise<Goal[]> {
		return this.listGoals({ status: ['in_progress', 'planning', 'blocked'] })
	}
}
