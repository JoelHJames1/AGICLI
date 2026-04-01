/**
 * Claude2 Provider System — Main Entry Point
 *
 * Registers all available providers and exports the public API.
 *
 * Usage:
 *   import { resolveActiveProvider, routeTask } from './providers'
 *
 *   const { provider } = await resolveActiveProvider()
 *   const stream = provider.createMessageStream(params)
 */

import { createAnthropicProvider, createBedrockProvider, createFoundryProvider, createVertexProvider } from './anthropic/index.js'
import { createGeminiProvider } from './gemini/index.js'
import { createOllamaProvider } from './ollama/index.js'
import { createOpenAICompatibleProvider } from './openai-compatible/index.js'
import { createOpenAIProvider } from './openai/index.js'
import { registerProvider } from './registry.js'

// ============================================================================
// Provider Registration
// ============================================================================

let registered = false

/**
 * Register all built-in providers. Safe to call multiple times.
 */
export function registerAllProviders(): void {
	if (registered) return
	registered = true

	// Anthropic variants
	registerProvider('anthropic', createAnthropicProvider)
	registerProvider('anthropic-bedrock', createBedrockProvider)
	registerProvider('anthropic-vertex', createVertexProvider)
	registerProvider('anthropic-foundry', createFoundryProvider)

	// OpenAI
	registerProvider('openai', createOpenAIProvider)

	// OpenAI-compatible (Together, Groq, LiteLLM, vLLM, etc.)
	registerProvider('openai-compatible', createOpenAICompatibleProvider)

	// Ollama (local models)
	registerProvider('ollama', createOllamaProvider)

	// Google Gemini
	registerProvider('gemini', createGeminiProvider)
}

// ============================================================================
// Re-exports
// ============================================================================

// Types
export type {
	LLMProvider,
	ModelRoute,
	ProviderCapabilities,
	ProviderConfig,
	ProviderType,
	TaskProfile,
} from './LLMProvider.js'

export type {
	CreateMessageParams,
	InternalContentBlock,
	InternalContentDelta,
	InternalMessage,
	InternalMessageParam,
	InternalResponseContentBlock,
	InternalStreamEvent,
	InternalStopReason,
	InternalToolChoice,
	InternalToolSchema,
	InternalUsage,
} from './types.js'

export { ProviderAPIError } from './types.js'

// Registry
export {
	clearProviderCache,
	detectProviderType,
	getProvider,
	getRegisteredProviders,
	resolveActiveProvider,
	resolveProviderConfig,
} from './registry.js'

// Capabilities
export {
	MODEL_CAPABILITY_OVERRIDES,
	PROVIDER_DEFAULTS,
	resolveCapabilities,
} from './capabilities.js'

// Router
export {
	createRouterConfig,
	detectAvailableProviders,
	routeTask,
} from './router.js'
