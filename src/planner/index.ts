/**
 * Claude2 Strategic Planner — Main Entry Point
 *
 * Provides long-horizon goal management:
 * - Goal creation and decomposition
 * - DAG-based task dependencies
 * - Checkpoint and rollback
 * - Backtracking with alternative approaches
 * - Cross-session progress tracking
 */

export { StrategicPlanner, FilePlannerStore } from './StrategicPlanner.js'

export {
	buildTaskGraph,
	detectCycles,
	getBlockedTasks,
	getCriticalPath,
	getDownstreamImpact,
	getReadyTasks,
	topologicalSort,
	visualizeGraph,
} from './taskGraph.js'

export type {
	AgentType,
	AlternativeApproach,
	Checkpoint,
	Goal,
	GoalStatus,
	PlannerStore,
	SubTask,
	SubTaskStatus,
	TaskGraph,
} from './types.js'
