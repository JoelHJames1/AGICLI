/**
 * Ollama provider for Claude2.
 *
 * Extends the OpenAI-compatible provider since Ollama exposes an
 * OpenAI-compatible API at /v1/chat/completions.
 *
 * Key differences from standard OpenAI:
 * - Default base URL: http://localhost:11434/v1
 * - No API key required
 * - Tool use support depends on the loaded model
 * - Some models support vision (e.g., llava, llama3.2-vision)
 */

import type {
	LLMProvider,
	ProviderCapabilities,
	ProviderConfig,
	ProviderType,
} from '../LLMProvider.js'
import { resolveCapabilities } from '../capabilities.js'
import { OpenAICompatibleProvider } from '../openai-compatible/index.js'

export class OllamaProvider extends OpenAICompatibleProvider {
	override readonly name = 'Ollama'
	override readonly providerType: ProviderType = 'ollama'

	protected override getBaseUrl(): string {
		const base =
			this.config?.baseUrl ||
			process.env.OLLAMA_BASE_URL ||
			'http://localhost:11434'

		// Ollama's OpenAI-compatible endpoint is at /v1
		return base.endsWith('/v1') ? base : `${base}/v1`
	}

	protected override getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		}

		// Ollama doesn't require auth, but support it if provided
		const apiKey = this.config?.apiKey || process.env.OLLAMA_API_KEY
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`
		}

		return headers
	}

	override getCapabilities(model: string): ProviderCapabilities {
		return resolveCapabilities('ollama', model)
	}

	/**
	 * List models available in the local Ollama installation.
	 */
	async listModels(): Promise<string[]> {
		const baseUrl =
			this.config?.baseUrl ||
			process.env.OLLAMA_BASE_URL ||
			'http://localhost:11434'

		try {
			const response = await fetch(`${baseUrl}/api/tags`)
			if (!response.ok) return []

			const data = (await response.json()) as {
				models?: Array<{ name: string }>
			}
			return data.models?.map((m) => m.name) ?? []
		} catch {
			return []
		}
	}

	/**
	 * Validate that Ollama is running and accessible.
	 */
	async validate(): Promise<boolean> {
		const baseUrl =
			this.config?.baseUrl ||
			process.env.OLLAMA_BASE_URL ||
			'http://localhost:11434'

		try {
			const response = await fetch(`${baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(5000),
			})
			return response.ok
		} catch {
			return false
		}
	}
}

/**
 * Factory function for the provider registry.
 */
export async function createOllamaProvider(
	config: ProviderConfig,
): Promise<LLMProvider> {
	const provider = new OllamaProvider()
	return provider
}
