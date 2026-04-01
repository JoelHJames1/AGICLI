/**
 * Smart Model Router for Claude2.
 *
 * Routes tasks to the optimal model based on task characteristics,
 * available providers, and user preferences. This is a key AGI feature:
 * using the best tool for each sub-task.
 *
 * Routing strategy:
 * - coding: Claude Opus/Sonnet (best tool use + code quality)
 * - reasoning: Claude Opus or o3 (strongest reasoning)
 * - fast-response: Haiku, GPT-4o-mini, or Groq (lowest latency)
 * - long-context: Gemini (1M tokens)
 * - local-private: Ollama (no data leaves machine)
 * - cost-optimized: cheapest model that meets requirements
 */

import type { ModelRoute, ProviderType, TaskProfile } from './LLMProvider.js'
import { PROVIDER_DEFAULTS } from './capabilities.js'
import { detectProviderType, resolveProviderConfig } from './registry.js'

// ============================================================================
// Router Configuration
// ============================================================================

interface RouterConfig {
	/** User-configured model preferences per task category. */
	preferences: Partial<Record<TaskProfile['category'], {
		provider: ProviderType
		model: string
	}>>

	/** Which providers are available (have valid API keys). */
	availableProviders: Set<ProviderType>

	/** Whether routing is enabled (false = always use default provider). */
	enabled: boolean
}

// ============================================================================
// Default Routing Table
// ============================================================================

const DEFAULT_ROUTES: Record<TaskProfile['category'], Array<{
	provider: ProviderType
	model: string
	reason: string
}>> = {
	'coding': [
		{ provider: 'anthropic', model: 'claude-opus-4-6', reason: 'Best code generation and tool use' },
		{ provider: 'openai', model: 'gpt-4o', reason: 'Strong code generation alternative' },
		{ provider: 'gemini', model: 'gemini-2.5-pro', reason: 'Good code generation with large context' },
		{ provider: 'ollama', model: 'qwen2.5-coder', reason: 'Local code model' },
	],
	'reasoning': [
		{ provider: 'anthropic', model: 'claude-opus-4-6', reason: 'Strongest reasoning capabilities' },
		{ provider: 'openai', model: 'o3', reason: 'Advanced reasoning with chain-of-thought' },
		{ provider: 'gemini', model: 'gemini-2.5-pro', reason: 'Strong reasoning with large context' },
		{ provider: 'anthropic', model: 'claude-opus-4-6', reason: 'Good reasoning, lower cost' },
	],
	'fast-response': [
		{ provider: 'anthropic', model: 'claude-haiku-4-5', reason: 'Fast and cost-effective' },
		{ provider: 'openai', model: 'gpt-4o-mini', reason: 'Fast OpenAI model' },
		{ provider: 'openai-compatible', model: 'default', reason: 'Groq/Together fast inference' },
		{ provider: 'ollama', model: 'llama3.1', reason: 'Local fast inference' },
	],
	'long-context': [
		{ provider: 'gemini', model: 'gemini-2.5-flash', reason: '1M token context window' },
		{ provider: 'anthropic', model: 'claude-opus-4-6', reason: '200K context with caching' },
		{ provider: 'openai', model: 'gpt-4o', reason: '128K context' },
	],
	'local-private': [
		{ provider: 'ollama', model: 'llama3.1', reason: 'Data stays on machine' },
		{ provider: 'ollama', model: 'codestral', reason: 'Local code-focused model' },
		{ provider: 'ollama', model: 'deepseek-coder-v2', reason: 'Local code model' },
	],
	'cost-optimized': [
		{ provider: 'ollama', model: 'llama3.1', reason: 'Free (local)' },
		{ provider: 'anthropic', model: 'claude-haiku-4-5', reason: 'Cheapest cloud model' },
		{ provider: 'openai', model: 'gpt-4o-mini', reason: 'Low-cost OpenAI' },
		{ provider: 'gemini', model: 'gemini-2.5-flash', reason: 'Cost-effective with huge context' },
	],
	'general': [
		{ provider: 'anthropic', model: 'claude-opus-4-6', reason: 'Best general-purpose model' },
		{ provider: 'openai', model: 'gpt-4o', reason: 'Strong general-purpose alternative' },
		{ provider: 'gemini', model: 'gemini-2.5-flash', reason: 'Fast general-purpose with large context' },
		{ provider: 'ollama', model: 'llama3.1', reason: 'Local general-purpose' },
	],
}

// ============================================================================
// Router Implementation
// ============================================================================

/**
 * Route a task to the best available model.
 */
export function routeTask(
	task: TaskProfile,
	config: RouterConfig,
): ModelRoute {
	// If routing is disabled, use the default provider
	if (!config.enabled) {
		const defaultType = detectProviderType()
		const defaultConfig = resolveProviderConfig(defaultType)
		return {
			provider: defaultType,
			model: defaultConfig.model,
			reason: 'Model routing disabled; using default provider',
		}
	}

	// Check user preferences first
	const userPref = config.preferences[task.category]
	if (userPref && config.availableProviders.has(userPref.provider)) {
		return {
			provider: userPref.provider,
			model: userPref.model,
			reason: `User preference for ${task.category} tasks`,
		}
	}

	// Check env var overrides
	const envRoute = getEnvRouteForCategory(task.category)
	if (envRoute && config.availableProviders.has(envRoute.provider)) {
		return envRoute
	}

	// Fall through default routing table
	const routes = DEFAULT_ROUTES[task.category] || DEFAULT_ROUTES['general']
	for (const route of routes) {
		if (config.availableProviders.has(route.provider)) {
			// Check capability requirements
			const caps = PROVIDER_DEFAULTS[route.provider]

			if (task.requiresToolUse && !caps.toolUse) continue
			if (task.requiresVision && !caps.vision) continue
			if (task.benefitsFromThinking && !caps.thinking) continue
			if (task.requiresLocal && route.provider !== 'ollama') continue
			if (
				task.estimatedInputTokens &&
				task.estimatedInputTokens > caps.maxInputTokens
			) {
				continue
			}

			return route
		}
	}

	// Absolute fallback: whatever provider is available
	const fallbackType = detectProviderType()
	const fallbackConfig = resolveProviderConfig(fallbackType)
	return {
		provider: fallbackType,
		model: fallbackConfig.model,
		reason: 'Fallback: no optimal route found, using default provider',
	}
}

/**
 * Detect which providers are available based on environment.
 */
export function detectAvailableProviders(): Set<ProviderType> {
	const available = new Set<ProviderType>()

	// Anthropic
	if (
		process.env.ANTHROPIC_API_KEY ||
		process.env.CLAUDE_CODE_USE_BEDROCK ||
		process.env.CLAUDE_CODE_USE_VERTEX ||
		process.env.CLAUDE_CODE_USE_FOUNDRY
	) {
		available.add('anthropic')
		if (process.env.CLAUDE_CODE_USE_BEDROCK) available.add('anthropic-bedrock')
		if (process.env.CLAUDE_CODE_USE_VERTEX) available.add('anthropic-vertex')
		if (process.env.CLAUDE_CODE_USE_FOUNDRY) available.add('anthropic-foundry')
	}

	// OpenAI
	if (process.env.OPENAI_API_KEY) {
		available.add('openai')
	}

	// Gemini
	if (process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY) {
		available.add('gemini')
	}

	// Ollama (assumed available if env var set, or we could ping)
	if (process.env.OLLAMA_MODEL || process.env.OLLAMA_BASE_URL) {
		available.add('ollama')
	}

	// OpenAI-compatible
	if (process.env.OPENAI_COMPATIBLE_BASE_URL) {
		available.add('openai-compatible')
	}

	return available
}

/**
 * Create a router config from environment and settings.
 */
export function createRouterConfig(
	userPreferences?: RouterConfig['preferences'],
): RouterConfig {
	return {
		preferences: userPreferences ?? {},
		availableProviders: detectAvailableProviders(),
		enabled: process.env.CLAUDE2_MODEL_ROUTER === 'true' ||
			process.env.AGENT_MODEL_ROUTER === 'true',
	}
}

// ============================================================================
// Helpers
// ============================================================================

function getEnvRouteForCategory(
	category: TaskProfile['category'],
): ModelRoute | null {
	const envMap: Record<string, { providerEnv: string; modelEnv: string }> = {
		coding: {
			providerEnv: 'AGENT_CODING_PROVIDER',
			modelEnv: 'AGENT_CODING_MODEL',
		},
		reasoning: {
			providerEnv: 'AGENT_REASONING_PROVIDER',
			modelEnv: 'AGENT_REASONING_MODEL',
		},
		'fast-response': {
			providerEnv: 'AGENT_FAST_PROVIDER',
			modelEnv: 'AGENT_FAST_MODEL',
		},
		'long-context': {
			providerEnv: 'AGENT_LONG_CONTEXT_PROVIDER',
			modelEnv: 'AGENT_LONG_CONTEXT_MODEL',
		},
		'local-private': {
			providerEnv: 'AGENT_LOCAL_PROVIDER',
			modelEnv: 'AGENT_LOCAL_MODEL',
		},
		'cost-optimized': {
			providerEnv: 'AGENT_COST_PROVIDER',
			modelEnv: 'AGENT_COST_MODEL',
		},
	}

	const entry = envMap[category]
	if (!entry) return null

	const model = process.env[entry.modelEnv]
	if (!model) return null

	const provider = (process.env[entry.providerEnv] || detectProviderFromModel(model)) as ProviderType

	return {
		provider,
		model,
		reason: `Environment variable ${entry.modelEnv}`,
	}
}

function detectProviderFromModel(model: string): ProviderType {
	if (model.startsWith('claude-')) return 'anthropic'
	if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai'
	if (model.startsWith('gemini-')) return 'gemini'
	if (model.includes('/')) return 'openai-compatible' // e.g., "meta-llama/Llama-3-70b"
	return 'ollama' // assume local model
}
