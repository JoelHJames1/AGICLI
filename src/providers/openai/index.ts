/**
 * OpenAI provider for Claude2.
 *
 * Translates between the internal (Anthropic-style) message format
 * and OpenAI's Chat Completion API. Supports streaming via SSE.
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
	InternalStreamEvent,
} from '../types.js'
import { ProviderAPIError } from '../types.js'
import {
	OpenAIStreamAdapter,
	internalToOpenAIMessages,
	internalToolsToOpenAI,
	openAIResponseToInternal,
} from './messageAdapter.js'

export class OpenAIProvider implements LLMProvider {
	readonly name = 'OpenAI'
	readonly providerType: ProviderType = 'openai'

	protected config: ProviderConfig | null = null
	private lastResponseHeaders: Record<string, string> | undefined

	async initialize(config: ProviderConfig): Promise<void> {
		this.config = config
	}

	async *createMessageStream(
		params: CreateMessageParams,
		signal?: AbortSignal,
	): AsyncIterable<InternalStreamEvent> {
		const url = this.getBaseUrl() + '/chat/completions'
		const body = this.buildRequestBody(params, true)

		const response = await fetch(url, {
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal,
		})

		this.lastResponseHeaders = Object.fromEntries(response.headers.entries())

		if (!response.ok) {
			const errorText = await response.text()
			throw new ProviderAPIError(
				`OpenAI API error: ${response.status} ${errorText}`,
				response.status,
				this.name,
				response.status === 429 || response.status >= 500,
				this.lastResponseHeaders,
			)
		}

		if (!response.body) {
			throw new ProviderAPIError(
				'OpenAI API returned empty body for streaming request',
				undefined,
				this.name,
				true,
			)
		}

		const adapter = new OpenAIStreamAdapter()
		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() || ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || !trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') continue

					try {
						const chunk = JSON.parse(data)
						for (const event of adapter.processChunk(chunk)) {
							yield event
						}
					} catch {
						// Skip malformed chunks
					}
				}
			}
		} finally {
			reader.releaseLock()
		}
	}

	async createMessage(
		params: CreateMessageParams,
		signal?: AbortSignal,
	): Promise<InternalMessage> {
		const url = this.getBaseUrl() + '/chat/completions'
		const body = this.buildRequestBody(params, false)

		const response = await fetch(url, {
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify(body),
			signal,
		})

		this.lastResponseHeaders = Object.fromEntries(response.headers.entries())

		if (!response.ok) {
			const errorText = await response.text()
			throw new ProviderAPIError(
				`OpenAI API error: ${response.status} ${errorText}`,
				response.status,
				this.name,
				response.status === 429 || response.status >= 500,
				this.lastResponseHeaders,
			)
		}

		const json = await response.json()
		return openAIResponseToInternal(json)
	}

	getCapabilities(model: string): ProviderCapabilities {
		return resolveCapabilities(this.providerType, model)
	}

	getLastResponseHeaders(): Record<string, string> | undefined {
		return this.lastResponseHeaders
	}

	// ========================================================================
	// Protected methods (overridable by subclasses like OpenAI-Compatible)
	// ========================================================================

	protected getBaseUrl(): string {
		return this.config?.baseUrl || 'https://api.openai.com/v1'
	}

	protected getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}

		const apiKey = this.config?.apiKey || process.env.OPENAI_API_KEY
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`
		}

		if (this.config?.customHeaders) {
			Object.assign(headers, this.config.customHeaders)
		}

		return headers
	}

	protected buildRequestBody(
		params: CreateMessageParams,
		stream: boolean,
	): Record<string, unknown> {
		const messages = internalToOpenAIMessages(params.messages, params.system)

		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			max_tokens: params.max_tokens,
			stream,
		}

		if (stream) {
			// Request usage info in streaming mode
			body.stream_options = { include_usage: true }
		}

		if (params.temperature !== undefined) {
			body.temperature = params.temperature
		}

		if (params.stop_sequences && params.stop_sequences.length > 0) {
			body.stop = params.stop_sequences
		}

		if (params.tools && params.tools.length > 0) {
			body.tools = internalToolsToOpenAI(params.tools)
		}

		if (params.tool_choice) {
			switch (params.tool_choice.type) {
				case 'auto':
					body.tool_choice = 'auto'
					break
				case 'none':
					body.tool_choice = 'none'
					break
				case 'any':
					body.tool_choice = 'required'
					break
				case 'tool':
					body.tool_choice = {
						type: 'function',
						function: { name: params.tool_choice.name },
					}
					break
			}
		}

		if (params.output_format?.type === 'json') {
			body.response_format = params.output_format.schema
				? { type: 'json_schema', json_schema: { schema: params.output_format.schema, strict: true } }
				: { type: 'json_object' }
		}

		return body
	}
}

/**
 * Factory function for the provider registry.
 */
export async function createOpenAIProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	const provider = new OpenAIProvider()
	return provider
}
