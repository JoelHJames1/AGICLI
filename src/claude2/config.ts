/**
 * Claude2 Configuration System.
 *
 * Manages the Claude2-specific configuration that extends
 * the base Claude Code settings with AGI capabilities.
 *
 * Config file: ~/.claude2/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderType } from '../providers/LLMProvider.js'

// ============================================================================
// Config Types
// ============================================================================

export interface Claude2Config {
	/** Active LLM provider. Auto-detected if not set. */
	provider?: ProviderType

	/** Model overrides per task category. */
	modelRouting?: {
		enabled: boolean
		coding?: { provider: ProviderType; model: string }
		reasoning?: { provider: ProviderType; model: string }
		fast?: { provider: ProviderType; model: string }
		longContext?: { provider: ProviderType; model: string }
		local?: { provider: ProviderType; model: string }
	}

	/** Reflection system settings. */
	reflection?: {
		enabled: boolean
		/** Max error patterns to store. */
		maxPatterns?: number
		/** Max reflection events per session. */
		maxEventsPerSession?: number
	}

	/** Planner settings. */
	planner?: {
		enabled: boolean
		/** Max active goals. */
		maxActiveGoals?: number
		/** Auto-checkpoint after each subtask completion. */
		autoCheckpoint?: boolean
	}

	/** Watcher/daemon settings. */
	watchers?: {
		file?: { enabled: boolean; patterns?: string[]; interval?: number }
		git?: { enabled: boolean; interval?: number }
		ci?: { enabled: boolean; interval?: number }
		issues?: { enabled: boolean; interval?: number }
	}

	/** Self-improvement settings. */
	selfImprove?: {
		enabled: boolean
		/** Run benchmark suite automatically. */
		autoBenchmark?: boolean
		/** Auto-evolve prompts. */
		promptEvolution?: boolean
		/** Improvement cycle interval in hours. */
		cycleIntervalHours?: number
	}

	/** Knowledge graph settings. */
	knowledge?: {
		enabled: boolean
		/** Auto-build on session start. */
		autoBuild?: boolean
		/** Max graph nodes to cache. */
		maxNodes?: number
	}
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: Claude2Config = {
	reflection: { enabled: true, maxPatterns: 100, maxEventsPerSession: 500 },
	planner: { enabled: true, maxActiveGoals: 10, autoCheckpoint: true },
	watchers: {
		file: { enabled: false, patterns: ['**/*.ts', '**/*.tsx', '**/*.js'], interval: 5000 },
		git: { enabled: false, interval: 60000 },
		ci: { enabled: false, interval: 120000 },
		issues: { enabled: false, interval: 300000 },
	},
	selfImprove: {
		enabled: false,
		autoBenchmark: false,
		promptEvolution: false,
		cycleIntervalHours: 24,
	},
	knowledge: { enabled: true, autoBuild: false, maxNodes: 10000 },
}

// ============================================================================
// Config Management
// ============================================================================

let cachedConfig: Claude2Config | null = null

/**
 * Get the Claude2 config directory.
 */
export function getClaude2Dir(): string {
	const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp'
	return join(homeDir, '.claude2')
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
	return join(getClaude2Dir(), 'config.json')
}

/**
 * Load the Claude2 configuration. Merges with defaults.
 */
export function loadConfig(): Claude2Config {
	if (cachedConfig) return cachedConfig

	const configPath = getConfigPath()

	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
			cachedConfig = deepMerge(DEFAULT_CONFIG, raw)
		} catch {
			cachedConfig = { ...DEFAULT_CONFIG }
		}
	} else {
		cachedConfig = { ...DEFAULT_CONFIG }
	}

	return cachedConfig
}

/**
 * Save the Claude2 configuration.
 */
export function saveConfig(config: Claude2Config): void {
	const dir = getClaude2Dir()
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
	cachedConfig = config
}

/**
 * Update specific config fields (merge).
 */
export function updateConfig(updates: Partial<Claude2Config>): Claude2Config {
	const current = loadConfig()
	const updated = deepMerge(current, updates)
	saveConfig(updated)
	return updated
}

/**
 * Reset config to defaults.
 */
export function resetConfig(): Claude2Config {
	const config = { ...DEFAULT_CONFIG }
	saveConfig(config)
	return config
}

/**
 * Clear the config cache (for testing).
 */
export function clearConfigCache(): void {
	cachedConfig = null
}

// ============================================================================
// Helpers
// ============================================================================

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
	const result = { ...base }

	for (const key of Object.keys(override) as Array<keyof T>) {
		const overrideValue = override[key]
		const baseValue = base[key]

		if (
			overrideValue !== null &&
			overrideValue !== undefined &&
			typeof overrideValue === 'object' &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === 'object' &&
			!Array.isArray(baseValue) &&
			baseValue !== null
		) {
			result[key] = deepMerge(baseValue as any, overrideValue as any)
		} else if (overrideValue !== undefined) {
			result[key] = overrideValue as any
		}
	}

	return result
}
