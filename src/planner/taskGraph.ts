/**
 * Task Graph (DAG) for Claude2 Strategic Planner.
 *
 * Manages the dependency graph of subtasks within a goal.
 * Supports topological ordering, cycle detection, and
 * identification of ready-to-execute tasks.
 */

import type { SubTask, TaskGraph } from './types.js'

// ============================================================================
// Graph Construction
// ============================================================================

/**
 * Build a TaskGraph from an array of subtasks.
 */
export function buildTaskGraph(subtasks: SubTask[]): TaskGraph {
	const nodes = new Map<string, SubTask>()
	const dependencies = new Map<string, Set<string>>()
	const dependents = new Map<string, Set<string>>()

	for (const task of subtasks) {
		nodes.set(task.id, task)
		dependencies.set(task.id, new Set(task.dependsOn))

		// Build reverse adjacency
		for (const dep of task.dependsOn) {
			if (!dependents.has(dep)) {
				dependents.set(dep, new Set())
			}
			dependents.get(dep)!.add(task.id)
		}
	}

	return { nodes, dependencies, dependents }
}

// ============================================================================
// Graph Queries
// ============================================================================

/**
 * Get tasks that are ready to execute (all dependencies satisfied).
 */
export function getReadyTasks(graph: TaskGraph): SubTask[] {
	const ready: SubTask[] = []

	for (const [id, task] of graph.nodes) {
		if (task.status !== 'pending') continue

		const deps = graph.dependencies.get(id)
		if (!deps || deps.size === 0) {
			ready.push(task)
			continue
		}

		// Check if all dependencies are completed
		const allDepsComplete = [...deps].every((depId) => {
			const depTask = graph.nodes.get(depId)
			return depTask?.status === 'completed' || depTask?.status === 'skipped'
		})

		if (allDepsComplete) {
			ready.push(task)
		}
	}

	return ready
}

/**
 * Get tasks that are blocked (waiting on incomplete dependencies).
 */
export function getBlockedTasks(graph: TaskGraph): SubTask[] {
	const blocked: SubTask[] = []

	for (const [id, task] of graph.nodes) {
		if (task.status !== 'pending') continue

		const deps = graph.dependencies.get(id)
		if (!deps || deps.size === 0) continue

		const hasIncomplete = [...deps].some((depId) => {
			const depTask = graph.nodes.get(depId)
			return depTask && depTask.status !== 'completed' && depTask.status !== 'skipped'
		})

		if (hasIncomplete) {
			blocked.push(task)
		}
	}

	return blocked
}

/**
 * Topological sort of all tasks. Returns tasks in dependency order.
 * Throws if the graph contains cycles.
 */
export function topologicalSort(graph: TaskGraph): SubTask[] {
	const visited = new Set<string>()
	const inStack = new Set<string>()
	const sorted: SubTask[] = []

	function visit(id: string): void {
		if (inStack.has(id)) {
			throw new Error(`Cycle detected in task graph involving task: ${id}`)
		}
		if (visited.has(id)) return

		inStack.add(id)

		const deps = graph.dependencies.get(id)
		if (deps) {
			for (const depId of deps) {
				visit(depId)
			}
		}

		inStack.delete(id)
		visited.add(id)

		const task = graph.nodes.get(id)
		if (task) sorted.push(task)
	}

	for (const id of graph.nodes.keys()) {
		visit(id)
	}

	return sorted
}

/**
 * Detect cycles in the task graph.
 * Returns the IDs of tasks involved in cycles, or empty array if acyclic.
 */
export function detectCycles(graph: TaskGraph): string[] {
	try {
		topologicalSort(graph)
		return []
	} catch (error) {
		if (error instanceof Error && error.message.includes('Cycle detected')) {
			// Extract task ID from error
			const match = error.message.match(/task: (.+)/)
			return match ? [match[1]] : ['unknown']
		}
		return []
	}
}

/**
 * Get the critical path — the longest chain of dependencies.
 * Returns tasks in order from start to end.
 */
export function getCriticalPath(graph: TaskGraph): SubTask[] {
	const sorted = topologicalSort(graph)
	const distances = new Map<string, number>()
	const predecessors = new Map<string, string>()

	// Initialize
	for (const task of sorted) {
		distances.set(task.id, 0)
	}

	// Forward pass: compute longest path to each node
	for (const task of sorted) {
		const currentDist = distances.get(task.id) || 0
		const deps = graph.dependents.get(task.id)
		if (!deps) continue

		for (const depId of deps) {
			const weight = 1 + (graph.nodes.get(depId)?.estimatedComplexity || 1)
			const newDist = currentDist + weight

			if (newDist > (distances.get(depId) || 0)) {
				distances.set(depId, newDist)
				predecessors.set(depId, task.id)
			}
		}
	}

	// Find the end of the critical path
	let maxDist = 0
	let endId = sorted[0]?.id || ''
	for (const [id, dist] of distances) {
		if (dist > maxDist) {
			maxDist = dist
			endId = id
		}
	}

	// Trace back
	const path: SubTask[] = []
	let currentId: string | undefined = endId
	while (currentId) {
		const task = graph.nodes.get(currentId)
		if (task) path.unshift(task)
		currentId = predecessors.get(currentId)
	}

	return path
}

/**
 * Get the downstream impact of a failed task.
 * Returns all tasks that would be blocked if the given task fails.
 */
export function getDownstreamImpact(
	graph: TaskGraph,
	taskId: string,
): SubTask[] {
	const impacted: SubTask[] = []
	const visited = new Set<string>()
	const queue = [taskId]

	while (queue.length > 0) {
		const currentId = queue.shift()!
		if (visited.has(currentId)) continue
		visited.add(currentId)

		const deps = graph.dependents.get(currentId)
		if (!deps) continue

		for (const depId of deps) {
			const task = graph.nodes.get(depId)
			if (task) {
				impacted.push(task)
				queue.push(depId)
			}
		}
	}

	return impacted
}

// ============================================================================
// Graph Visualization
// ============================================================================

/**
 * Generate a text-based visualization of the task graph.
 */
export function visualizeGraph(graph: TaskGraph): string {
	const sorted = topologicalSort(graph)
	const lines: string[] = ['Task Graph:']

	for (const task of sorted) {
		const status = statusIcon(task.status)
		const deps = graph.dependencies.get(task.id)
		const depStr = deps && deps.size > 0
			? ` ← [${[...deps].join(', ')}]`
			: ''

		lines.push(`  ${status} ${task.id}: ${task.description}${depStr}`)
	}

	return lines.join('\n')
}

function statusIcon(status: string): string {
	switch (status) {
		case 'completed': return '[x]'
		case 'in_progress': return '[~]'
		case 'failed': return '[!]'
		case 'skipped': return '[-]'
		default: return '[ ]'
	}
}
