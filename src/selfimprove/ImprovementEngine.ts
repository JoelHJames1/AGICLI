/**
 * Improvement Engine for Claude2.
 *
 * Orchestrates the full self-improvement loop by combining:
 * - PerformanceTracker: metrics and trend analysis
 * - PromptOptimizer: A/B testing and prompt evolution
 * - SkillEvolver: skill-level improvement
 * - BenchmarkRunner: self-evaluation
 *
 * Designed to be safe to run in the background — all operations are
 * non-destructive and do not affect active sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BenchmarkRunner } from './BenchmarkRunner.js'
import { PerformanceTracker } from './PerformanceTracker.js'
import { PromptOptimizer } from './PromptOptimizer.js'
import { SkillEvolver } from './SkillEvolver.js'
import type { BenchmarkResult, DateRange, ImprovementReport, SkillEvolutionRecord } from './types.js'

// ============================================================================
// ImprovementEngine
// ============================================================================

export class ImprovementEngine {
	private tracker: PerformanceTracker
	private optimizer: PromptOptimizer
	private evolver: SkillEvolver
	private benchmarks: BenchmarkRunner
	private reportDir: string
	private latestReport: ImprovementReport | null = null
	private cycleTimer: ReturnType<typeof setInterval> | null = null
	private running = false

	constructor(opts?: {
		tracker?: PerformanceTracker
		optimizer?: PromptOptimizer
		evolver?: SkillEvolver
		benchmarks?: BenchmarkRunner
		baseDir?: string
	}) {
		const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
		const baseDir = opts?.baseDir ?? join(home, '.claude2')

		this.tracker = opts?.tracker ?? new PerformanceTracker(join(baseDir, 'metrics'))
		this.optimizer = opts?.optimizer ?? new PromptOptimizer(join(baseDir, 'prompts'))
		this.evolver = opts?.evolver ?? new SkillEvolver(join(baseDir, 'skills'))
		this.benchmarks = opts?.benchmarks ?? new BenchmarkRunner(join(baseDir, 'benchmarks'))

		this.reportDir = join(baseDir, 'reports')
		if (!existsSync(this.reportDir)) {
			mkdirSync(this.reportDir, { recursive: true })
		}

		// Load the latest report if available
		this.loadLatestReport()
	}

	// ========================================================================
	// Run a full improvement cycle
	// ========================================================================

	/**
	 * Execute a complete improvement cycle.
	 *
	 * Steps:
	 * 1. Gather metrics from PerformanceTracker
	 * 2. Identify weak areas
	 * 3. Generate prompt mutations for weak areas
	 * 4. Run benchmarks on mutations
	 * 5. Promote improvements that pass benchmarks
	 * 6. Generate improvement report
	 *
	 * Safe to run in the background: no side effects on active sessions.
	 */
	async runCycle(): Promise<ImprovementReport> {
		if (this.running) {
			throw new Error('An improvement cycle is already running.')
		}
		this.running = true

		try {
			// Step 1: Gather current metrics
			await this.tracker.load()
			const currentMetrics = this.tracker.getMetrics('week')
			const previousMetrics = this.tracker.getMetrics('month')

			// Step 2: Identify weak areas
			const weakAreas = this.tracker.getWeakAreas()
			const underperformingSkills = this.evolver.getUnderperformingSkills()

			// Step 3: Generate prompt mutations for weak areas
			const promptChanges: Array<{ name: string; oldVariantId: string; newVariantId: string }> = []
			for (const area of weakAreas.slice(0, 3)) {
				try {
					const promptName = `task-${area.category}`
					const testResults = this.optimizer.getTestResults(promptName)
					const oldBest = testResults.bestVariantId

					// Only evolve if there is already a registered variant
					if (testResults.variants.length > 0) {
						const newVariant = this.optimizer.evolvePrompt(
							promptName,
							`Improve success rate for "${area.category}": ${area.suggestion}`,
						)
						if (oldBest) {
							promptChanges.push({
								name: promptName,
								oldVariantId: oldBest,
								newVariantId: newVariant.id,
							})
						}
					}
				} catch {
					// Skip if no variants exist for this category
				}
			}

			// Step 4: Run benchmarks
			let benchmarkResults: BenchmarkResult[] = []
			try {
				benchmarkResults = await this.benchmarks.runAll()
			} catch {
				// Benchmarks are optional — don't fail the cycle
			}

			// Step 5: Promote improvements that pass benchmarks
			const newSkills: SkillEvolutionRecord[] = []
			for (const skill of underperformingSkills) {
				try {
					const promoted = this.evolver.promoteIfBetter(skill.name)
					if (promoted) {
						const comparison = this.evolver.compareVersions(skill.name)
						newSkills.push({
							skillName: skill.name,
							version: comparison.candidateVersion,
							metrics: comparison.candidateMetrics,
							changelog: [`Promoted: ${comparison.reason}`],
							createdAt: new Date().toISOString(),
							promotedAt: new Date().toISOString(),
						})
					}
				} catch {
					// Skip individual skill failures
				}
			}

			// Step 6: Generate improvement report
			const now = new Date()
			const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
			const period: DateRange = {
				start: weekAgo.toISOString(),
				end: now.toISOString(),
			}

			const metricsChange = {
				period1: previousMetrics,
				period2: currentMetrics,
				successRateDelta: currentMetrics.successRate - previousMetrics.successRate,
				tokensDelta: currentMetrics.avgTokensPerTask - previousMetrics.avgTokensPerTask,
				durationDelta: currentMetrics.avgDurationPerTask - previousMetrics.avgDurationPerTask,
			}

			const summary = this.generateSummary(
				metricsChange.successRateDelta,
				weakAreas.length,
				promptChanges.length,
				benchmarkResults,
				newSkills.length,
			)

			const report: ImprovementReport = {
				timestamp: now.toISOString(),
				period,
				metricsChange,
				newSkills,
				promptChanges,
				benchmarkResults,
				summary,
			}

			this.latestReport = report
			this.persistReport(report)
			return report
		} finally {
			this.running = false
		}
	}

	// ========================================================================
	// Latest report
	// ========================================================================

	/**
	 * Get the most recent improvement report, or null if none exists.
	 */
	getLatestReport(): ImprovementReport | null {
		return this.latestReport
	}

	// ========================================================================
	// Scheduled cycles
	// ========================================================================

	/**
	 * Schedule periodic improvement cycles.
	 * Safe to call multiple times — previous schedule is replaced.
	 *
	 * @param intervalHours - Hours between cycles.
	 */
	scheduleAutoCycle(intervalHours: number): void {
		this.stopAutoCycle()
		const intervalMs = intervalHours * 60 * 60 * 1000
		this.cycleTimer = setInterval(() => {
			this.runCycle().catch(() => {
				// Swallow errors from background cycles
			})
		}, intervalMs)

		// Ensure the timer doesn't prevent Node from exiting
		if (this.cycleTimer && typeof this.cycleTimer === 'object' && 'unref' in this.cycleTimer) {
			(this.cycleTimer as NodeJS.Timeout).unref()
		}
	}

	/**
	 * Stop any scheduled auto-cycle.
	 */
	stopAutoCycle(): void {
		if (this.cycleTimer) {
			clearInterval(this.cycleTimer)
			this.cycleTimer = null
		}
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	private generateSummary(
		successDelta: number,
		weakAreaCount: number,
		promptChanges: number,
		benchmarkResults: BenchmarkResult[],
		promotedSkills: number,
	): string {
		const parts: string[] = []

		// Overall trend
		if (successDelta > 0.05) {
			parts.push(`Performance improved by ${Math.round(successDelta * 100)}% this cycle.`)
		} else if (successDelta < -0.05) {
			parts.push(`Performance degraded by ${Math.round(Math.abs(successDelta) * 100)}% this cycle. Investigation recommended.`)
		} else {
			parts.push('Performance is stable this cycle.')
		}

		// Weak areas
		if (weakAreaCount > 0) {
			parts.push(`${weakAreaCount} weak area(s) identified.`)
		}

		// Prompt changes
		if (promptChanges > 0) {
			parts.push(`${promptChanges} prompt variant(s) evolved for testing.`)
		}

		// Benchmark results
		if (benchmarkResults.length > 0) {
			const avgScore = benchmarkResults.reduce((s, r) => s + r.score, 0) / benchmarkResults.length
			parts.push(`Benchmarks: average score ${Math.round(avgScore)}/100 across ${benchmarkResults.length} benchmark(s).`)
		}

		// Skill promotions
		if (promotedSkills > 0) {
			parts.push(`${promotedSkills} skill(s) promoted to improved versions.`)
		}

		return parts.join(' ')
	}

	private persistReport(report: ImprovementReport): void {
		try {
			// Save as latest
			writeFileSync(
				join(this.reportDir, 'latest.json'),
				JSON.stringify(report, null, 2),
			)
			// Also append to history
			const historyFile = join(this.reportDir, 'history.jsonl')
			writeFileSync(historyFile, JSON.stringify(report) + '\n', { flag: 'a' })
		} catch {
			// Best-effort
		}
	}

	private loadLatestReport(): void {
		const file = join(this.reportDir, 'latest.json')
		if (!existsSync(file)) return
		try {
			this.latestReport = JSON.parse(readFileSync(file, 'utf-8'))
		} catch {
			// Ignore corrupt files
		}
	}
}
