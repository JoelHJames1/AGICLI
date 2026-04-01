/**
 * Claude2 Bootstrap — Initialization for the AGI Agent System.
 *
 * This module initializes all Claude2 subsystems on top of the
 * existing Claude Code infrastructure:
 *
 * 1. Multi-LLM Provider System (Anthropic, OpenAI, Gemini, Ollama)
 * 2. Reflection Engine (self-improvement through error learning)
 * 3. Strategic Planner (long-horizon goal pursuit)
 * 4. Dynamic Skill System (auto-generated skills)
 * 5. Watcher/Daemon (autonomous operation)
 * 6. Knowledge Graph (code understanding)
 * 7. Self-Improvement Pipeline (compound learning)
 *
 * Usage:
 *   import { initializeClaude2 } from './claude2/bootstrap'
 *   const claude2 = await initializeClaude2({ sessionId, projectSlug })
 */

import { registerAllProviders, resolveActiveProvider } from '../providers/index.js'
import type { LLMProvider, ProviderType } from '../providers/LLMProvider.js'
import type { ProviderConfig } from '../providers/LLMProvider.js'
import { createRouterConfig, routeTask } from '../providers/router.js'
import { FileReflectionStore, ReflectionEngine } from '../reflection/ReflectionEngine.js'
import { FilePlannerStore, StrategicPlanner } from '../planner/StrategicPlanner.js'

// ============================================================================
// Claude2 Instance
// ============================================================================

export interface Claude2Config {
	sessionId: string
	projectSlug: string

	/** Override the auto-detected provider. */
	providerOverride?: ProviderType

	/** Whether to enable the model router (uses best model per task). */
	enableModelRouter?: boolean

	/** Whether to enable the reflection system. */
	enableReflection?: boolean

	/** Whether to enable the strategic planner. */
	enablePlanner?: boolean
}

export interface Claude2Instance {
	/** The active LLM provider. */
	provider: LLMProvider

	/** Provider type identifier. */
	providerType: ProviderType

	/** Provider config. */
	providerConfig: ProviderConfig

	/** Reflection engine for self-improvement. */
	reflection: ReflectionEngine | null

	/** Strategic planner for long-horizon goals. */
	planner: StrategicPlanner | null

	/** Model router config. */
	routerConfig: ReturnType<typeof createRouterConfig>

	/** Route a task to the optimal model. */
	routeTask: typeof routeTask

	/** Shut down all subsystems gracefully. */
	shutdown(): Promise<void>
}

// ============================================================================
// Initialization
// ============================================================================

let instance: Claude2Instance | null = null

/**
 * Initialize Claude2 AGI subsystems.
 * Safe to call multiple times — returns existing instance if already initialized.
 */
export async function initializeClaude2(config: Claude2Config): Promise<Claude2Instance> {
	if (instance) return instance

	// Step 1: Register all LLM providers
	registerAllProviders()

	// Step 2: Resolve the active provider
	const { provider, config: providerConfig, type } = await resolveActiveProvider()
	await provider.initialize(providerConfig)

	// Step 3: Create model router config
	const routerConfig = createRouterConfig()
	if (config.enableModelRouter) {
		routerConfig.enabled = true
	}

	// Step 4: Initialize reflection engine
	let reflection: ReflectionEngine | null = null
	if (config.enableReflection !== false) {
		const reflectionStore = new FileReflectionStore(config.projectSlug)
		reflection = new ReflectionEngine(reflectionStore, config.sessionId)
		await reflection.initialize()
	}

	// Step 5: Initialize strategic planner
	let planner: StrategicPlanner | null = null
	if (config.enablePlanner !== false) {
		const plannerStore = new FilePlannerStore(config.projectSlug)
		planner = new StrategicPlanner(plannerStore)
	}

	instance = {
		provider,
		providerType: type,
		providerConfig,
		reflection,
		planner,
		routerConfig,
		routeTask,

		async shutdown() {
			// Generate session reflection summary before shutting down
			if (reflection) {
				try {
					await reflection.generateSessionSummary()
				} catch {
					// Don't fail shutdown on reflection errors
				}
			}
			instance = null
		},
	}

	return instance
}

/**
 * Get the current Claude2 instance.
 * Returns null if not initialized.
 */
export function getClaude2(): Claude2Instance | null {
	return instance
}

/**
 * Check if Claude2 is initialized.
 */
export function isClaude2Initialized(): boolean {
	return instance !== null
}

// ============================================================================
// Environment Info
// ============================================================================

/**
 * Get a summary of the Claude2 environment for diagnostics.
 */
export function getClaude2Info(): Record<string, string> {
	const info: Record<string, string> = {
		'Claude2 Status': instance ? 'Initialized' : 'Not initialized',
	}

	if (instance) {
		info['Provider'] = `${instance.provider.name} (${instance.providerType})`
		info['Model'] = instance.providerConfig.model
		info['Model Router'] = instance.routerConfig.enabled ? 'Enabled' : 'Disabled'
		info['Available Providers'] = [...instance.routerConfig.availableProviders].join(', ') || 'None detected'
		info['Reflection'] = instance.reflection ? 'Enabled' : 'Disabled'
		info['Planner'] = instance.planner ? 'Enabled' : 'Disabled'
	}

	return info
}
