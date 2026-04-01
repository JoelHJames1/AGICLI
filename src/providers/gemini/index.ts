/**
 * Google Gemini provider for Claude2.
 *
 * Implements the LLM provider interface using Google's Gemini API.
 * Supports streaming via generateContentStream.
 *
 * Key features:
 * - 1M token context window (largest available)
 * - Native tool/function calling
 * - Vision support
 * - Thinking mode (Gemini 2.5+)
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
	GeminiStreamAdapter,
	geminiResponseToInternal,
	internalSystemToGemini,
	internalToGeminiContents,
	internalToolsToGemini,
} from './messageAdapter.js'

export class GeminiProvider implements LLMProvider {
	readonly name = 'Google Gemini'
	readonly providerType: ProviderType = 'gemini'

	private config: ProviderConfig | null = null
	private lastResponseHeaders: Record<string, string> | undefined

	async initialize(config: ProviderConfig): Promise<void> {
		this.config = config
	}

	async *createMessageStream(
		params: CreateMessageParams,
		signal?: AbortSignal,
	): AsyncIterable<InternalStreamEvent> {
		const apiKey = this.getApiKey()
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:streamGenerateContent?alt=sse&key=${apiKey}`

		const body = this.buildRequestBody(params)

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		})

		this.lastResponseHeaders = Object.fromEntries(response.headers.entries())

		if (!response.ok) {
			const errorText = await response.text()
			throw new ProviderAPIError(
				`Gemini API error: ${response.status} ${errorText}`,
				response.status,
				this.name,
				response.status === 429 || response.status >= 500,
				this.lastResponseHeaders,
			)
		}

		if (!response.body) {
			throw new ProviderAPIError(
				'Gemini API returned empty body for streaming request',
				undefined,
				this.name,
				true,
			)
		}

		const messageId = `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`
		const adapter = new GeminiStreamAdapter(messageId, params.model)
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
		const apiKey = this.getApiKey()
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${apiKey}`

		const body = this.buildRequestBody(params)

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		})

		this.lastResponseHeaders = Object.fromEntries(response.headers.entries())

		if (!response.ok) {
			const errorText = await response.text()
			throw new ProviderAPIError(
				`Gemini API error: ${response.status} ${errorText}`,
				response.status,
				this.name,
				response.status === 429 || response.status >= 500,
				this.lastResponseHeaders,
			)
		}

		const json = await response.json()
		const messageId = `gemini_${Date.now()}_${Math.random().toString(36).slice(2)}`
		return geminiResponseToInternal(json, messageId, params.model)
	}

	getCapabilities(model: string): ProviderCapabilities {
		return resolveCapabilities(this.providerType, model)
	}

	getLastResponseHeaders(): Record<string, string> | undefined {
		return this.lastResponseHeaders
	}

	async listModels(): Promise<string[]> {
		const apiKey = this.getApiKey()
		try {
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
			)
			if (!response.ok) return []

			const data = (await response.json()) as {
				models?: Array<{ name: string }>
			}
			return data.models?.map((m) => m.name.replace('models/', '')) ?? []
		} catch {
			return []
		}
	}

	// ========================================================================
	// Private
	// ========================================================================

	private getApiKey(): string {
		const key =
			this.config?.apiKey ||
			process.env.GOOGLE_GEMINI_API_KEY ||
			process.env.GEMINI_API_KEY

		if (!key) {
			throw new ProviderAPIError(
				'Gemini API key not configured. Set GOOGLE_GEMINI_API_KEY or GEMINI_API_KEY.',
				undefined,
				this.name,
				false,
			)
		}

		return key
	}

	private buildRequestBody(
		params: CreateMessageParams,
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			contents: internalToGeminiContents(params.messages),
			generationConfig: {
				maxOutputTokens: params.max_tokens,
			},
		}

		// System instruction
		const systemInstruction = internalSystemToGemini(params.system)
		if (systemInstruction) {
			body.systemInstruction = systemInstruction
		}

		// Temperature
		if (params.temperature !== undefined) {
			(body.generationConfig as any).temperature = params.temperature
		}

		// Stop sequences
		if (params.stop_sequences && params.stop_sequences.length > 0) {
			(body.generationConfig as any).stopSequences = params.stop_sequences
		}

		// Tools
		if (params.tools && params.tools.length > 0) {
			body.tools = [
				{
					functionDeclarations: internalToolsToGemini(params.tools),
				},
			]
		}

		// Tool choice
		if (params.tool_choice) {
			switch (params.tool_choice.type) {
				case 'auto':
					body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
					break
				case 'any':
					body.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
					break
				case 'none':
					body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
					break
				case 'tool':
					body.toolConfig = {
						functionCallingConfig: {
							mode: 'ANY',
							allowedFunctionNames: [params.tool_choice.name],
						},
					}
					break
			}
		}

		// JSON output
		if (params.output_format?.type === 'json') {
			(body.generationConfig as any).responseMimeType = 'application/json'
			if (params.output_format.schema) {
				(body.generationConfig as any).responseSchema = params.output_format.schema
			}
		}

		return body
	}
}

/**
 * Factory function for the provider registry.
 */
export async function createGeminiProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	const provider = new GeminiProvider()
	return provider
}
