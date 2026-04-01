/**
 * LLM Provider interface for Claude2.
 *
 * Every LLM backend (Anthropic, OpenAI, Gemini, Ollama, etc.) implements
 * this interface. The application core only talks to this abstraction.
 */

import type {
	CreateMessageParams,
	InternalMessage,
	InternalStreamEvent,
} from './types.js'

// ============================================================================
// Provider Types
// ============================================================================

export type ProviderType =
	| 'anthropic'
	| 'anthropic-bedrock'
	| 'anthropic-vertex'
	| 'anthropic-foundry'
	| 'openai'
	| 'openai-compatible'
	| 'gemini'
	| 'ollama'

/** Capabilities that a provider + model combination supports. */
export interface ProviderCapabilities {
	streaming: boolean
	toolUse: boolean
	vision: boolean
	thinking: boolean
	systemPrompt: boolean
	promptCaching: boolean
	structuredOutputs: boolean
	maxInputTokens: number
	maxOutputTokens: number
}

/** Configuration for initializing a provider. */
export interface ProviderConfig {
	apiKey?: string
	baseUrl?: string
	model: string
	timeout?: number
	maxRetries?: number
	customHeaders?: Record<string, string>
}

// ============================================================================
// Provider Interface
// ============================================================================

export interface LLMProvider {
	/** Human-readable provider name (e.g., "Anthropic", "OpenAI"). */
	readonly name: string

	/** Provider type identifier. */
	readonly providerType: ProviderType

	/**
	 * Initialize the provider client with the given config.
	 * Called once before any messages are created.
	 */
	initialize(config: ProviderConfig): Promise<void>

	/**
	 * Create a streaming message. Returns an async iterable of stream events.
	 * The caller consumes events as they arrive for real-time UI updates.
	 */
	createMessageStream(
		params: CreateMessageParams,
		signal?: AbortSignal,
	): AsyncIterable<InternalStreamEvent>

	/**
	 * Create a non-streaming message. Returns the complete response.
	 * Use for simple queries where streaming isn't needed.
	 */
	createMessage(
		params: CreateMessageParams,
		signal?: AbortSignal,
	): Promise<InternalMessage>

	/**
	 * Get capabilities for a specific model.
	 * Used for graceful degradation (skip thinking if unsupported, etc.).
	 */
	getCapabilities(model: string): ProviderCapabilities

	/**
	 * List available models for this provider.
	 * Returns model IDs that can be passed to createMessage.
	 */
	listModels?(): Promise<string[]>

	/**
	 * Validate that the provider is configured correctly (API key works, etc.).
	 * Returns true if valid, throws with details if not.
	 */
	validate?(): Promise<boolean>

	/**
	 * Get response headers from the last API call.
	 * Used for rate limit info, request IDs, etc.
	 */
	getLastResponseHeaders?(): Record<string, string> | undefined
}

// ============================================================================
// Task Profile (for model routing)
// ============================================================================

/** Describes characteristics of a task for smart model routing. */
export interface TaskProfile {
	/** Primary type of work. */
	category:
		| 'coding'
		| 'reasoning'
		| 'fast-response'
		| 'long-context'
		| 'local-private'
		| 'cost-optimized'
		| 'general'

	/** Estimated input size in tokens (if known). */
	estimatedInputTokens?: number

	/** Whether tool use is required. */
	requiresToolUse?: boolean

	/** Whether vision/image input is needed. */
	requiresVision?: boolean

	/** Whether extended thinking is beneficial. */
	benefitsFromThinking?: boolean

	/** Whether data should stay local (privacy concern). */
	requiresLocal?: boolean
}

// ============================================================================
// Model Route Result
// ============================================================================

/** Result of model routing — which provider and model to use. */
export interface ModelRoute {
	provider: ProviderType
	model: string
	reason: string
}
