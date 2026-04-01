/**
 * Skill Evolver for Claude2.
 *
 * Tracks individual skill performance over time and proposes improvements
 * based on failure analysis. Skills that improve are promoted; those that
 * degrade are flagged for attention.
 *
 * Data is persisted to ~/.claude2/skills/evolution.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { CategoryMetrics, SkillComparison, SkillEvolutionRecord } from './types.js'

// ============================================================================
// Internal Types
// ============================================================================

/** Raw usage event stored per skill. */
interface SkillUsageEvent {
	success: boolean
	tokens: number
	duration: number
	timestamp: string
}

/** Full persisted state for the evolver. */
interface EvolverState {
	/** Usage events by skill name. */
	usage: Record<string, SkillUsageEvent[]>
	/** Evolution records by skill name (version history). */
	evolution: Record<string, SkillEvolutionRecord[]>
}

// ============================================================================
// Constants
// ============================================================================

/** Minimum usage events before a skill can be evaluated. */
const MIN_EVENTS_FOR_EVALUATION = 5

/** Success rate threshold below which a skill is "underperforming". */
const UNDERPERFORM_THRESHOLD = 0.6

/** Success rate improvement required to promote a new version. */
const PROMOTION_THRESHOLD = 0.05

// ============================================================================
// SkillEvolver
// ============================================================================

export class SkillEvolver {
	private filePath: string
	private state: EvolverState = { usage: {}, evolution: {} }
	private loaded = false

	constructor(baseDir?: string) {
		const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
		const dir = baseDir ?? join(home, '.claude2', 'skills')
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true })
		}
		this.filePath = join(dir, 'evolution.json')
	}

	// ========================================================================
	// Track skill usage
	// ========================================================================

	/**
	 * Record a usage event for a skill.
	 * @param skillName - Name of the skill.
	 * @param outcome - The outcome of using the skill.
	 */
	trackSkillUsage(
		skillName: string,
		outcome: { success: boolean; tokens: number; duration: number },
	): void {
		this.ensureLoaded()
		if (!this.state.usage[skillName]) {
			this.state.usage[skillName] = []
		}
		this.state.usage[skillName]!.push({
			...outcome,
			timestamp: new Date().toISOString(),
		})
		this.persist()
	}

	// ========================================================================
	// Identify underperforming skills
	// ========================================================================

	/**
	 * Returns skills whose success rate is below the threshold.
	 */
	getUnderperformingSkills(): Array<{ name: string; successRate: number; suggestion: string }> {
		this.ensureLoaded()
		const results: Array<{ name: string; successRate: number; suggestion: string }> = []

		for (const [name, events] of Object.entries(this.state.usage)) {
			if (events.length < MIN_EVENTS_FOR_EVALUATION) continue
			const metrics = this.computeMetrics(events)
			if (metrics.successRate < UNDERPERFORM_THRESHOLD) {
				results.push({
					name,
					successRate: metrics.successRate,
					suggestion: this.generateSuggestion(name, metrics),
				})
			}
		}

		return results.sort((a, b) => a.successRate - b.successRate)
	}

	// ========================================================================
	// Propose improvement
	// ========================================================================

	/**
	 * Generate an improved version of a skill's content based on failure analysis.
	 * Returns a proposed new version of the skill content with improvements applied.
	 *
	 * @param skillName - The skill to improve.
	 * @param currentContent - The current skill definition/prompt/code.
	 * @param failureAnalysis - Analysis of why the skill is failing.
	 * @returns The proposed improved content.
	 */
	proposeImprovement(
		skillName: string,
		currentContent: string,
		failureAnalysis: string,
	): string {
		this.ensureLoaded()
		const events = this.state.usage[skillName] || []
		const metrics = this.computeMetrics(events)

		// Build improvement header
		const improvements: string[] = []

		// Analyze failure patterns
		const failureEvents = events.filter((e) => !e.success)
		const avgFailTokens = failureEvents.length > 0
			? failureEvents.reduce((s, e) => s + e.tokens, 0) / failureEvents.length
			: 0

		if (avgFailTokens > 3000) {
			improvements.push('Reduce token usage by being more direct and concise.')
		}
		if (metrics.errorRate > 0.5) {
			improvements.push('Add explicit error-checking steps before producing output.')
		}
		if (metrics.avgDuration > 30000) {
			improvements.push('Break into smaller sub-tasks to reduce overall duration.')
		}

		// Apply the failure analysis as a key improvement
		improvements.push(`Address identified failure pattern: ${failureAnalysis}`)

		// Record the evolution
		const version = this.getNextVersion(skillName)
		const record: SkillEvolutionRecord = {
			skillName,
			version,
			metrics,
			changelog: improvements,
			createdAt: new Date().toISOString(),
		}

		if (!this.state.evolution[skillName]) {
			this.state.evolution[skillName] = []
		}
		this.state.evolution[skillName]!.push(record)
		this.persist()

		// Generate improved content
		const improvementBlock = improvements.map((i) => `- ${i}`).join('\n')
		return [
			`# Skill: ${skillName} (v${version})`,
			`# Improvements applied:`,
			improvementBlock,
			'',
			currentContent,
			'',
			'# Additional safeguards based on failure analysis:',
			`# ${failureAnalysis}`,
			'# Always verify output correctness before returning.',
		].join('\n')
	}

	// ========================================================================
	// Compare versions
	// ========================================================================

	/**
	 * Compare the current (promoted) version against the latest candidate.
	 */
	compareVersions(skillName: string): SkillComparison {
		this.ensureLoaded()
		const history = this.state.evolution[skillName] || []

		if (history.length < 2) {
			const current = history[0] ?? this.makeEmptyRecord(skillName, 0)
			return {
				skillName,
				currentVersion: current.version,
				candidateVersion: current.version,
				currentMetrics: current.metrics,
				candidateMetrics: current.metrics,
				shouldPromote: false,
				reason: 'Not enough versions to compare.',
			}
		}

		// Find the most recent promoted version and the latest candidate
		const promoted = history.filter((r) => r.promotedAt).pop()
		const candidate = history[history.length - 1]!
		const current = promoted ?? history[history.length - 2]!

		const delta = candidate.metrics.successRate - current.metrics.successRate
		const shouldPromote = delta >= PROMOTION_THRESHOLD

		return {
			skillName,
			currentVersion: current.version,
			candidateVersion: candidate.version,
			currentMetrics: current.metrics,
			candidateMetrics: candidate.metrics,
			shouldPromote,
			reason: shouldPromote
				? `Candidate v${candidate.version} improves success rate by ${Math.round(delta * 100)}%.`
				: `Candidate v${candidate.version} does not meet the ${PROMOTION_THRESHOLD * 100}% improvement threshold (delta: ${Math.round(delta * 100)}%).`,
		}
	}

	// ========================================================================
	// Promote a version
	// ========================================================================

	/**
	 * Promote the latest candidate version if it outperforms the current.
	 * @returns true if the promotion happened.
	 */
	promoteIfBetter(skillName: string): boolean {
		this.ensureLoaded()
		const comparison = this.compareVersions(skillName)
		if (!comparison.shouldPromote) return false

		const history = this.state.evolution[skillName] || []
		const candidate = history.find((r) => r.version === comparison.candidateVersion)
		if (candidate) {
			candidate.promotedAt = new Date().toISOString()
			// Reset usage events so the new version gets a clean slate
			this.state.usage[skillName] = []
			this.persist()
		}
		return true
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	private ensureLoaded(): void {
		if (this.loaded) return
		if (existsSync(this.filePath)) {
			try {
				this.state = JSON.parse(readFileSync(this.filePath, 'utf-8'))
			} catch {
				this.state = { usage: {}, evolution: {} }
			}
		}
		this.loaded = true
	}

	private persist(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(this.state, null, 2))
		} catch {
			// Best-effort
		}
	}

	private computeMetrics(events: SkillUsageEvent[]): CategoryMetrics {
		if (events.length === 0) {
			return { successRate: 0, avgTokens: 0, avgDuration: 0, totalTasks: 0, errorRate: 0 }
		}
		const successes = events.filter((e) => e.success).length
		const totalTokens = events.reduce((s, e) => s + e.tokens, 0)
		const totalDuration = events.reduce((s, e) => s + e.duration, 0)
		return {
			successRate: successes / events.length,
			avgTokens: totalTokens / events.length,
			avgDuration: totalDuration / events.length,
			totalTasks: events.length,
			errorRate: 1 - successes / events.length,
		}
	}

	private getNextVersion(skillName: string): number {
		const history = this.state.evolution[skillName] || []
		if (history.length === 0) return 1
		return Math.max(...history.map((r) => r.version)) + 1
	}

	private makeEmptyRecord(skillName: string, version: number): SkillEvolutionRecord {
		return {
			skillName,
			version,
			metrics: { successRate: 0, avgTokens: 0, avgDuration: 0, totalTasks: 0, errorRate: 0 },
			changelog: [],
			createdAt: new Date().toISOString(),
		}
	}

	private generateSuggestion(name: string, metrics: CategoryMetrics): string {
		if (metrics.successRate < 0.3) {
			return `Skill "${name}" critically underperforming (${Math.round(metrics.successRate * 100)}%). Consider a full rewrite with failure analysis.`
		}
		if (metrics.avgTokens > 5000) {
			return `Skill "${name}" is token-heavy. Optimize for conciseness.`
		}
		return `Skill "${name}" succeeds ${Math.round(metrics.successRate * 100)}% of the time. Analyze recent failures to target specific weaknesses.`
	}
}
