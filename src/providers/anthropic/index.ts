/**
 * Anthropic provider for Claude2.
 *
 * This is a thin adapter that wraps the existing Anthropic SDK integration.
 * Since the internal types mirror Anthropic's format, this is nearly a
 * passthrough — minimizing risk during migration.
 *
 * The existing claude.ts orchestration (streaming, retry, caching, betas)
 * continues to work unchanged. This adapter exists so that the provider
 * registry can treat Anthropic as one of many backends.
 */

import type {
	LLMProvider,
	ProviderCapabilities,
	ProviderConfig,
	ProviderType,
} from '../LLMProvider.js'
import { resolveCapabilities } from '../capabilities.js'
import type {
	CreateMessageParams,
	InternalMessage,
	InternalResponseContentBlock,
	InternalStreamEvent,
	InternalStopReason,
	InternalUsage,
} from '../types.js'

export class AnthropicProvider implements LLMProvider {
	readonly name = 'Anthropic'
	readonly providerType: ProviderType

	private config: ProviderConfig | null = null

	constructor(type: ProviderType = 'anthropic') {
		this.providerType = type
	}

	async initialize(config: ProviderConfig): Promise<void> {
		this.config = config
		// The existing getAnthropicClient() in services/api/client.ts
		// handles actual SDK client creation. We don't duplicate that here.
		// This provider adapter delegates to the existing claude.ts flow.
	}

	async *createMessageStream(
		params: CreateMessageParams,
		_signal?: AbortSignal,
	): AsyncIterable<InternalStreamEvent> {
		// For the Anthropic provider, the existing claude.ts queryModel()
		// already handles streaming with all the Anthropic-specific features
		// (betas, caching, retry, etc.). This method provides a clean
		// interface for when we need to call Anthropic outside that flow,
		// or for testing.

		const { default: Anthropic } = await import('@anthropic-ai/sdk')

		const client = new Anthropic({
			apiKey: this.config?.apiKey || process.env.ANTHROPIC_API_KEY,
			baseURL: this.config?.baseUrl || process.env.ANTHROPIC_BASE_URL,
			timeout: this.config?.timeout || 600_000,
		})

		const stream = await client.messages.stream({
			model: params.model,
			messages: params.messages.map((m) => ({
				role: m.role,
				content: m.content as any,
			})),
			system: typeof params.system === 'string'
				? params.system
				: params.system as any,
			tools: params.tools as any,
			max_tokens: params.max_tokens,
			temperature: params.temperature,
			stop_sequences: params.stop_sequences,
		})

		for await (const event of stream) {
			// Anthropic SDK events map directly to our internal events
			// since we designed InternalStreamEvent to mirror them.
			yield event as unknown as InternalStreamEvent
		}
	}

	async createMessage(
		params: CreateMessageParams,
		_signal?: AbortSignal,
	): Promise<InternalMessage> {
		const { default: Anthropic } = await import('@anthropic-ai/sdk')

		const client = new Anthropic({
			apiKey: this.config?.apiKey || process.env.ANTHROPIC_API_KEY,
			baseURL: this.config?.baseUrl || process.env.ANTHROPIC_BASE_URL,
			timeout: this.config?.timeout || 600_000,
		})

		const response = await client.messages.create({
			model: params.model,
			messages: params.messages.map((m) => ({
				role: m.role,
				content: m.content as any,
			})),
			system: typeof params.system === 'string'
				? params.system
				: params.system as any,
			tools: params.tools as any,
			max_tokens: params.max_tokens,
			temperature: params.temperature,
			stop_sequences: params.stop_sequences,
		})

		return {
			id: response.id,
			type: 'message',
			role: 'assistant',
			content: response.content as InternalResponseContentBlock[],
			model: response.model,
			stop_reason: response.stop_reason as InternalStopReason,
			usage: response.usage as InternalUsage,
		}
	}

	getCapabilities(model: string): ProviderCapabilities {
		return resolveCapabilities(this.providerType, model)
	}
}

/**
 * Factory function for the provider registry.
 */
export async function createAnthropicProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	const provider = new AnthropicProvider('anthropic')
	return provider
}

export async function createBedrockProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	return new AnthropicProvider('anthropic-bedrock')
}

export async function createVertexProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	return new AnthropicProvider('anthropic-vertex')
}

export async function createFoundryProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	return new AnthropicProvider('anthropic-foundry')
}
