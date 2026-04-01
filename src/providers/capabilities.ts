/**
 * Default capability matrices for known providers and models.
 *
 * These are baseline defaults. Providers can override via getCapabilities().
 */

import type { ProviderCapabilities, ProviderType } from './LLMProvider.js'

// ============================================================================
// Default Capabilities Per Provider
// ============================================================================

const ANTHROPIC_DEFAULTS: ProviderCapabilities = {
	streaming: true,
	toolUse: true,
	vision: true,
	thinking: true,
	systemPrompt: true,
	promptCaching: true,
	structuredOutputs: true,
	maxInputTokens: 200_000,
	maxOutputTokens: 128_000,
}

const OPENAI_DEFAULTS: ProviderCapabilities = {
	streaming: true,
	toolUse: true,
	vision: true,
	thinking: false,
	systemPrompt: true,
	promptCaching: false,
	structuredOutputs: true,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
}

const GEMINI_DEFAULTS: ProviderCapabilities = {
	streaming: true,
	toolUse: true,
	vision: true,
	thinking: true,
	systemPrompt: true,
	promptCaching: false,
	structuredOutputs: false,
	maxInputTokens: 1_000_000,
	maxOutputTokens: 8_192,
}

const OLLAMA_DEFAULTS: ProviderCapabilities = {
	streaming: true,
	toolUse: false,
	vision: false,
	thinking: false,
	systemPrompt: true,
	promptCaching: false,
	structuredOutputs: false,
	maxInputTokens: 32_000,
	maxOutputTokens: 4_096,
}

const OPENAI_COMPATIBLE_DEFAULTS: ProviderCapabilities = {
	streaming: true,
	toolUse: true,
	vision: false,
	thinking: false,
	systemPrompt: true,
	promptCaching: false,
	structuredOutputs: false,
	maxInputTokens: 32_000,
	maxOutputTokens: 4_096,
}

/** Map provider types to their default capabilities. */
export const PROVIDER_DEFAULTS: Record<ProviderType, ProviderCapabilities> = {
	'anthropic': ANTHROPIC_DEFAULTS,
	'anthropic-bedrock': ANTHROPIC_DEFAULTS,
	'anthropic-vertex': ANTHROPIC_DEFAULTS,
	'anthropic-foundry': ANTHROPIC_DEFAULTS,
	'openai': OPENAI_DEFAULTS,
	'openai-compatible': OPENAI_COMPATIBLE_DEFAULTS,
	'gemini': GEMINI_DEFAULTS,
	'ollama': OLLAMA_DEFAULTS,
}

// ============================================================================
// Model-Specific Capability Overrides
// ============================================================================

/** Known model capability overrides (keyed by model ID prefix). */
export const MODEL_CAPABILITY_OVERRIDES: Record<string, Partial<ProviderCapabilities>> = {
	// OpenAI models
	'gpt-4o': { maxInputTokens: 128_000, maxOutputTokens: 16_384, vision: true },
	'gpt-4o-mini': { maxInputTokens: 128_000, maxOutputTokens: 16_384, vision: true },
	'gpt-4-turbo': { maxInputTokens: 128_000, maxOutputTokens: 4_096, vision: true },
	'o1': { maxInputTokens: 200_000, maxOutputTokens: 100_000, thinking: true, vision: true },
	'o1-mini': { maxInputTokens: 128_000, maxOutputTokens: 65_536, thinking: true },
	'o3': { maxInputTokens: 200_000, maxOutputTokens: 100_000, thinking: true, vision: true },
	'o3-mini': { maxInputTokens: 200_000, maxOutputTokens: 100_000, thinking: true },
	'o4-mini': { maxInputTokens: 200_000, maxOutputTokens: 100_000, thinking: true, vision: true },

	// Gemini models
	'gemini-2.0-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, toolUse: true },
	'gemini-2.0-pro': { maxInputTokens: 1_000_000, maxOutputTokens: 8_192, toolUse: true },
	'gemini-2.5-pro': { maxInputTokens: 1_000_000, maxOutputTokens: 65_536, toolUse: true, thinking: true },
	'gemini-2.5-flash': { maxInputTokens: 1_000_000, maxOutputTokens: 65_536, toolUse: true, thinking: true },

	// Ollama models (common ones)
	'llama3.1': { maxInputTokens: 128_000, maxOutputTokens: 4_096, toolUse: true },
	'llama3.2': { maxInputTokens: 128_000, maxOutputTokens: 4_096, vision: true },
	'codestral': { maxInputTokens: 32_000, maxOutputTokens: 4_096 },
	'deepseek-coder-v2': { maxInputTokens: 128_000, maxOutputTokens: 4_096, toolUse: true },
	'qwen2.5-coder': { maxInputTokens: 32_000, maxOutputTokens: 4_096 },
	'mistral': { maxInputTokens: 32_000, maxOutputTokens: 4_096, toolUse: true },

	// Anthropic models
	'claude-opus-4-6': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
	'claude-sonnet-4-6': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
	'claude-haiku-4-5': { maxInputTokens: 200_000, maxOutputTokens: 8_192 },
}

/**
 * Resolve capabilities for a given provider type and model.
 * Merges provider defaults with model-specific overrides.
 */
export function resolveCapabilities(
	providerType: ProviderType,
	model: string,
): ProviderCapabilities {
	const defaults = PROVIDER_DEFAULTS[providerType]

	// Find the best matching model override
	const matchingKey = Object.keys(MODEL_CAPABILITY_OVERRIDES)
		.filter((prefix) => model.startsWith(prefix))
		.sort((a, b) => b.length - a.length)[0]

	if (matchingKey) {
		return { ...defaults, ...MODEL_CAPABILITY_OVERRIDES[matchingKey] }
	}

	return { ...defaults }
}
