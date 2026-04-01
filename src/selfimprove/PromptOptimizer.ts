/**
 * Prompt Optimizer for Claude2.
 *
 * Uses a multi-armed bandit approach (epsilon-greedy) to A/B test prompt
 * variants and evolve the best-performing ones over time.
 *
 * Prompt variants are stored in ~/.claude2/prompts/ as JSON files,
 * one file per prompt group (name).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ABTestResult, PromptVariant, VariantMetrics } from './types.js'

// ============================================================================
// Constants
// ============================================================================

/** Exploration probability (epsilon in epsilon-greedy). */
const EPSILON = 0.1

/** Minimum trials before a variant can be declared "best". */
const MIN_TRIALS_FOR_SIGNIFICANCE = 10

// ============================================================================
// PromptOptimizer
// ============================================================================

export class PromptOptimizer {
	private promptDir: string

	/** In-memory cache: promptName -> variants. */
	private variantCache: Map<string, PromptVariant[]> = new Map()

	constructor(baseDir?: string) {
		const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
		this.promptDir = baseDir ?? join(home, '.claude2', 'prompts')
		if (!existsSync(this.promptDir)) {
			mkdirSync(this.promptDir, { recursive: true })
		}
	}

	// ========================================================================
	// Register a new variant
	// ========================================================================

	/**
	 * Register a new prompt variant for A/B testing.
	 * @param name - The prompt group name (e.g. "system-prompt", "code-gen-prompt").
	 * @param content - The prompt text.
	 * @returns The created PromptVariant.
	 */
	registerVariant(name: string, content: string): PromptVariant {
		const variants = this.loadVariants(name)
		const maxGen = variants.reduce((m, v) => Math.max(m, v.generation), -1)

		const variant: PromptVariant = {
			id: `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			name,
			content,
			metrics: { successes: 0, failures: 0, totalTokens: 0, trials: 0 },
			generation: maxGen + 1,
			createdAt: new Date().toISOString(),
		}

		variants.push(variant)
		this.saveVariants(name, variants)
		return variant
	}

	// ========================================================================
	// Epsilon-greedy variant selection
	// ========================================================================

	/**
	 * Select which variant to use for the next interaction.
	 * Uses epsilon-greedy: explore with probability EPSILON, exploit otherwise.
	 * @param name - The prompt group name.
	 * @returns The selected variant, or a new default if none exist.
	 */
	selectVariant(name: string): PromptVariant {
		const variants = this.loadVariants(name)
		if (variants.length === 0) {
			throw new Error(`No variants registered for prompt "${name}"`)
		}
		if (variants.length === 1) {
			return variants[0]!
		}

		// Epsilon-greedy selection
		if (Math.random() < EPSILON) {
			// Explore: pick a random variant
			return variants[Math.floor(Math.random() * variants.length)]!
		}

		// Exploit: pick the variant with the highest success rate
		// For variants with zero trials, give them optimistic prior (100% success)
		// to encourage initial exploration.
		return this.bestBySuccessRate(variants)
	}

	// ========================================================================
	// Record outcomes
	// ========================================================================

	/**
	 * Record the outcome of using a specific variant.
	 * @param variantId - The variant that was used.
	 * @param success - Whether the task succeeded.
	 * @param tokens - Tokens consumed.
	 */
	recordOutcome(variantId: string, success: boolean, tokens: number): void {
		// Find which prompt group this variant belongs to
		for (const file of this.listPromptFiles()) {
			const name = file.replace('.json', '')
			const variants = this.loadVariants(name)
			const variant = variants.find((v) => v.id === variantId)
			if (variant) {
				variant.metrics.trials++
				variant.metrics.totalTokens += tokens
				if (success) {
					variant.metrics.successes++
				} else {
					variant.metrics.failures++
				}
				this.saveVariants(name, variants)
				return
			}
		}
	}

	// ========================================================================
	// Best variant
	// ========================================================================

	/**
	 * Get the current best-performing variant for a prompt group.
	 * Returns null if no variant has enough data.
	 */
	getBestVariant(name: string): PromptVariant | null {
		const variants = this.loadVariants(name)
		const withEnoughTrials = variants.filter(
			(v) => v.metrics.trials >= MIN_TRIALS_FOR_SIGNIFICANCE,
		)
		if (withEnoughTrials.length === 0) return null
		return this.bestBySuccessRate(withEnoughTrials)
	}

	// ========================================================================
	// Prompt evolution
	// ========================================================================

	/**
	 * Evolve the best prompt by creating a mutated variant.
	 * Uses simple rule-based mutations. For richer evolution, pass a mutationHint
	 * describing what to change.
	 *
	 * @param name - The prompt group name.
	 * @param mutationHint - Optional hint describing how to mutate.
	 * @returns The newly created variant.
	 */
	evolvePrompt(name: string, mutationHint?: string): PromptVariant {
		const variants = this.loadVariants(name)
		if (variants.length === 0) {
			throw new Error(`No variants registered for prompt "${name}"`)
		}

		// Pick the best variant as parent (or the first if none have data)
		const parent = this.getBestVariant(name) ?? variants[0]!
		const mutated = this.mutateContent(parent.content, mutationHint)

		const child: PromptVariant = {
			id: `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			name,
			content: mutated,
			metrics: { successes: 0, failures: 0, totalTokens: 0, trials: 0 },
			generation: parent.generation + 1,
			parentId: parent.id,
			createdAt: new Date().toISOString(),
		}

		variants.push(child)
		this.saveVariants(name, variants)
		return child
	}

	// ========================================================================
	// A/B test results
	// ========================================================================

	/**
	 * Get detailed A/B test results for a prompt group.
	 */
	getTestResults(name: string): ABTestResult {
		const variants = this.loadVariants(name)
		const variantResults = variants.map((v) => {
			const rate = v.metrics.trials > 0
				? v.metrics.successes / v.metrics.trials
				: 0
			const avgTokens = v.metrics.trials > 0
				? v.metrics.totalTokens / v.metrics.trials
				: 0
			return {
				id: v.id,
				successRate: rate,
				avgTokens,
				trials: v.metrics.trials,
				confidence: this.wilsonLowerBound(v.metrics.successes, v.metrics.trials),
			}
		})

		// Sort by Wilson lower bound (conservative estimate of success rate)
		variantResults.sort((a, b) => b.confidence - a.confidence)

		const significanceReached = variantResults.some(
			(v) => v.trials >= MIN_TRIALS_FOR_SIGNIFICANCE,
		)

		return {
			name,
			variants: variantResults,
			bestVariantId: significanceReached ? (variantResults[0]?.id ?? null) : null,
			significanceReached,
		}
	}

	// ========================================================================
	// Private helpers
	// ========================================================================

	private loadVariants(name: string): PromptVariant[] {
		const cached = this.variantCache.get(name)
		if (cached) return cached

		const file = join(this.promptDir, `${name}.json`)
		if (!existsSync(file)) {
			this.variantCache.set(name, [])
			return []
		}
		try {
			const data: PromptVariant[] = JSON.parse(readFileSync(file, 'utf-8'))
			this.variantCache.set(name, data)
			return data
		} catch {
			this.variantCache.set(name, [])
			return []
		}
	}

	private saveVariants(name: string, variants: PromptVariant[]): void {
		this.variantCache.set(name, variants)
		try {
			const file = join(this.promptDir, `${name}.json`)
			writeFileSync(file, JSON.stringify(variants, null, 2))
		} catch {
			// Best-effort persistence
		}
	}

	private listPromptFiles(): string[] {
		try {
			return readdirSync(this.promptDir).filter((f) => f.endsWith('.json'))
		} catch {
			return []
		}
	}

	/**
	 * Pick the variant with the highest success rate.
	 * Variants with zero trials get an optimistic prior of 1.0.
	 */
	private bestBySuccessRate(variants: PromptVariant[]): PromptVariant {
		let best = variants[0]!
		let bestRate = this.effectiveRate(best)

		for (let i = 1; i < variants.length; i++) {
			const rate = this.effectiveRate(variants[i]!)
			if (rate > bestRate) {
				best = variants[i]!
				bestRate = rate
			}
		}
		return best
	}

	/**
	 * Effective success rate: optimistic prior for untested variants.
	 */
	private effectiveRate(v: PromptVariant): number {
		if (v.metrics.trials === 0) return 1.0 // optimistic prior
		return v.metrics.successes / v.metrics.trials
	}

	/**
	 * Wilson score lower bound — a conservative estimate of the true success
	 * rate that accounts for sample size. Used for ranking variants fairly.
	 */
	private wilsonLowerBound(successes: number, trials: number): number {
		if (trials === 0) return 0
		const z = 1.96 // 95% confidence
		const p = successes / trials
		const denominator = 1 + (z * z) / trials
		const center = p + (z * z) / (2 * trials)
		const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * trials)) / trials)
		return (center - spread) / denominator
	}

	/**
	 * Apply simple rule-based mutations to a prompt.
	 * If a hint is given, append it as an instruction. Otherwise apply
	 * structural mutations (add emphasis, reorder, etc.).
	 */
	private mutateContent(content: string, hint?: string): string {
		if (hint) {
			return `${content}\n\n[Improvement: ${hint}]`
		}

		// Simple mutation strategies
		const mutations: Array<(c: string) => string> = [
			// Add explicit step-by-step instruction
			(c) => `${c}\n\nIMPORTANT: Think step-by-step before acting.`,
			// Add error-checking instruction
			(c) => `${c}\n\nBefore finalizing, verify your output for correctness.`,
			// Add brevity instruction
			(c) => `${c}\n\nBe concise and efficient — minimize unnecessary steps.`,
			// Add planning instruction
			(c) => `${c}\n\nStart by outlining your plan before executing.`,
		]

		const mutation = mutations[Math.floor(Math.random() * mutations.length)]!
		return mutation(content)
	}
}
