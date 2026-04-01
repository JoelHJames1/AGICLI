/**
 * Provider registry for Claude2.
 *
 * Manages provider instances, auto-detects the active provider from
 * environment variables, and provides a single entry point for
 * resolving which provider + model to use.
 */

import type { LLMProvider, ProviderConfig, ProviderType } from './LLMProvider.js'

// ============================================================================
// Registry State
// ============================================================================

type ProviderFactory = (config: ProviderConfig) => Promise<LLMProvider>

const providerFactories = new Map<ProviderType, ProviderFactory>()
const providerInstances = new Map<ProviderType, LLMProvider>()

// ============================================================================
// Registration
// ============================================================================

/**
 * Register a provider factory. Called once per provider at startup.
 */
export function registerProvider(type: ProviderType, factory: ProviderFactory): void {
	providerFactories.set(type, factory)
}

// ============================================================================
// Provider Resolution
// ============================================================================

/**
 * Get or create a provider instance for the given type.
 */
export async function getProvider(
	type: ProviderType,
	config: ProviderConfig,
): Promise<LLMProvider> {
	const existing = providerInstances.get(type)
	if (existing) {
		return existing
	}

	const factory = providerFactories.get(type)
	if (!factory) {
		throw new Error(
			`No provider registered for type "${type}". ` +
			`Available: ${[...providerFactories.keys()].join(', ')}`,
		)
	}

	const provider = await factory(config)
	await provider.initialize(config)
	providerInstances.set(type, provider)
	return provider
}

/**
 * Detect the active provider from environment variables.
 *
 * Priority:
 * 1. CLAUDE2_PROVIDER explicit setting
 * 2. Anthropic env vars (CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY, ANTHROPIC_API_KEY)
 * 3. OpenAI env vars
 * 4. Gemini env vars
 * 5. Ollama env vars
 * 6. OpenAI-compatible env vars
 * 7. Default: anthropic
 */
export function detectProviderType(): ProviderType {
	const explicit = process.env.CLAUDE2_PROVIDER
	if (explicit && isValidProviderType(explicit)) {
		return explicit
	}

	// Anthropic variants
	if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) return 'anthropic-bedrock'
	if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) return 'anthropic-vertex'
	if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) return 'anthropic-foundry'

	// OpenAI
	if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) return 'openai'

	// Gemini
	if (process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY) return 'gemini'

	// Ollama
	if (process.env.OLLAMA_MODEL) return 'ollama'

	// OpenAI-compatible
	if (process.env.OPENAI_COMPATIBLE_BASE_URL) return 'openai-compatible'

	// Default: Anthropic first-party
	return 'anthropic'
}

/**
 * Resolve provider config from environment variables.
 */
export function resolveProviderConfig(type: ProviderType): ProviderConfig {
	const timeout = process.env.API_TIMEOUT_MS
		? parseInt(process.env.API_TIMEOUT_MS, 10)
		: 600_000

	const customHeaders = parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS)

	switch (type) {
		case 'anthropic':
		case 'anthropic-bedrock':
		case 'anthropic-vertex':
		case 'anthropic-foundry':
			return {
				apiKey: process.env.ANTHROPIC_API_KEY,
				baseUrl: process.env.ANTHROPIC_BASE_URL,
				model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
				timeout,
				customHeaders,
			}

		case 'openai':
			return {
				apiKey: process.env.OPENAI_API_KEY,
				baseUrl: process.env.OPENAI_BASE_URL,
				model: process.env.OPENAI_MODEL || 'gpt-4o',
				timeout,
				customHeaders,
			}

		case 'gemini':
			return {
				apiKey: process.env.GOOGLE_GEMINI_API_KEY || process.env.GEMINI_API_KEY,
				model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
				timeout,
				customHeaders,
			}

		case 'ollama':
			return {
				baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
				model: process.env.OLLAMA_MODEL || 'llama3.1',
				timeout,
			}

		case 'openai-compatible':
			return {
				apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
				baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
				model: process.env.OPENAI_COMPATIBLE_MODEL || 'default',
				timeout,
				customHeaders,
			}
	}
}

/**
 * Convenience: detect provider, resolve config, and return a ready provider.
 */
export async function resolveActiveProvider(): Promise<{
	provider: LLMProvider
	config: ProviderConfig
	type: ProviderType
}> {
	const type = detectProviderType()
	const config = resolveProviderConfig(type)
	const provider = await getProvider(type, config)
	return { provider, config, type }
}

/**
 * Get all registered provider types.
 */
export function getRegisteredProviders(): ProviderType[] {
	return [...providerFactories.keys()]
}

/**
 * Clear all cached provider instances (for testing).
 */
export function clearProviderCache(): void {
	providerInstances.clear()
}

// ============================================================================
// Helpers
// ============================================================================

const VALID_PROVIDER_TYPES: Set<string> = new Set([
	'anthropic',
	'anthropic-bedrock',
	'anthropic-vertex',
	'anthropic-foundry',
	'openai',
	'openai-compatible',
	'gemini',
	'ollama',
])

function isValidProviderType(value: string): value is ProviderType {
	return VALID_PROVIDER_TYPES.has(value)
}

function isEnvTruthy(value: string | undefined): boolean {
	return value === '1' || value === 'true' || value === 'yes'
}

function parseCustomHeaders(
	raw: string | undefined,
): Record<string, string> | undefined {
	if (!raw) return undefined

	const headers: Record<string, string> = {}
	for (const line of raw.split('\n')) {
		const colonIndex = line.indexOf(':')
		if (colonIndex > 0) {
			const key = line.slice(0, colonIndex).trim()
			const value = line.slice(colonIndex + 1).trim()
			if (key && value) {
				headers[key] = value
			}
		}
	}

	return Object.keys(headers).length > 0 ? headers : undefined
}
