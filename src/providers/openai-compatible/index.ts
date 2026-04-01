/**
 * OpenAI-Compatible provider for Claude2.
 *
 * Extends the OpenAI provider to work with any API that implements
 * the OpenAI Chat Completion API format. Supports:
 * - Together AI
 * - Groq
 * - LiteLLM
 * - vLLM
 * - Fireworks AI
 * - Perplexity
 * - Any other OpenAI-compatible endpoint
 */

import type { LLMProvider, ProviderConfig, ProviderType } from '../LLMProvider.js'
import { OpenAIProvider } from '../openai/index.js'

export class OpenAICompatibleProvider extends OpenAIProvider {
	override readonly name = 'OpenAI-Compatible'
	override readonly providerType: ProviderType = 'openai-compatible'

	protected override getBaseUrl(): string {
		return (
			this.config?.baseUrl ||
			process.env.OPENAI_COMPATIBLE_BASE_URL ||
			'http://localhost:8000/v1'
		)
	}

	protected override getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}

		const apiKey =
			this.config?.apiKey ||
			process.env.OPENAI_COMPATIBLE_API_KEY

		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`
		}

		if (this.config?.customHeaders) {
			Object.assign(headers, this.config.customHeaders)
		}

		return headers
	}
}

/**
 * Factory function for the provider registry.
 */
export async function createOpenAICompatibleProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	const provider = new OpenAICompatibleProvider()
	return provider
}
