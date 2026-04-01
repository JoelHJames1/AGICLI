/**
 * Message format adapter between Google Gemini API and internal types.
 *
 * Key differences from Anthropic format:
 * - Messages use "parts" array instead of "content" blocks
 * - Tool calls use "functionCall" parts in responses
 * - Tool results use "functionResponse" parts in input
 * - System prompt via "systemInstruction" parameter
 * - Roles: "user" and "model" (not "assistant")
 * - Images use inline_data with base64
 */

import type {
	InternalContentBlock,
	InternalInputContentBlock,
	InternalMessage,
	InternalMessageParam,
	InternalResponseContentBlock,
	InternalStopReason,
	InternalStreamEvent,
	InternalTextBlock,
	InternalToolResultBlock,
	InternalToolSchema,
	InternalToolUseBlock,
} from '../types.js'

// ============================================================================
// Gemini API Types (minimal, to avoid SDK dependency)
// ============================================================================

interface GeminiContent {
	role: 'user' | 'model'
	parts: GeminiPart[]
}

type GeminiPart =
	| { text: string }
	| { inlineData: { mimeType: string; data: string } }
	| { functionCall: { name: string; args: Record<string, unknown> } }
	| { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiFunctionDeclaration {
	name: string
	description: string
	parameters: Record<string, unknown>
}

interface GeminiGenerateResponse {
	candidates: Array<{
		content: GeminiContent
		finishReason: string
	}>
	usageMetadata?: {
		promptTokenCount: number
		candidatesTokenCount: number
		totalTokenCount: number
	}
}

// ============================================================================
// Request Mapping (Internal → Gemini)
// ============================================================================

/**
 * Convert internal messages to Gemini content format.
 */
export function internalToGeminiContents(
	messages: InternalMessageParam[],
): GeminiContent[] {
	const result: GeminiContent[] = []

	for (const msg of messages) {
		const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
		const parts = convertToParts(msg.content, msg.role)

		if (parts.length > 0) {
			result.push({ role, parts })
		}
	}

	return result
}

function convertToParts(
	content: string | InternalContentBlock[],
	role: string,
): GeminiPart[] {
	if (typeof content === 'string') {
		return [{ text: content }]
	}

	const parts: GeminiPart[] = []

	for (const block of content) {
		switch (block.type) {
			case 'text':
				parts.push({ text: block.text })
				break

			case 'image': {
				const imgBlock = block as InternalInputContentBlock & { type: 'image' }
				if ('data' in imgBlock.source) {
					parts.push({
						inlineData: {
							mimeType: imgBlock.source.media_type,
							data: imgBlock.source.data,
						},
					})
				}
				break
			}

			case 'tool_use': {
				const tu = block as InternalToolUseBlock
				parts.push({
					functionCall: {
						name: tu.name,
						args: tu.input,
					},
				})
				break
			}

			case 'tool_result': {
				const tr = block as InternalToolResultBlock
				const responseContent = typeof tr.content === 'string'
					? { result: tr.content }
					: {
						result: (tr.content as InternalTextBlock[])
							.filter((b) => b.type === 'text')
							.map((b) => b.text)
							.join('\n'),
					}

				// Find the tool name from the tool_use_id
				// Gemini requires functionResponse to reference the function name
				parts.push({
					functionResponse: {
						name: tr.tool_use_id, // Will be resolved by the provider
						response: responseContent,
					},
				})
				break
			}

			case 'thinking':
				// Include thinking as text with markers
				parts.push({ text: `<thinking>${(block as any).thinking}</thinking>` })
				break

			default:
				parts.push({ text: `[${block.type} content]` })
		}
	}

	return parts
}

/**
 * Convert internal tool schemas to Gemini function declarations.
 */
export function internalToolsToGemini(
	tools: InternalToolSchema[],
): GeminiFunctionDeclaration[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.input_schema,
	}))
}

/**
 * Convert system prompt to Gemini's systemInstruction format.
 */
export function internalSystemToGemini(
	system?: string | Array<{ type: 'text'; text: string }>,
): GeminiContent | undefined {
	if (!system) return undefined

	const text = typeof system === 'string'
		? system
		: system.map((s) => s.text).join('\n\n')

	return {
		role: 'user',
		parts: [{ text }],
	}
}

// ============================================================================
// Response Mapping (Gemini → Internal)
// ============================================================================

/**
 * Convert a Gemini generate response to an InternalMessage.
 */
export function geminiResponseToInternal(
	response: GeminiGenerateResponse,
	messageId: string,
	model: string,
): InternalMessage {
	const candidate = response.candidates[0]
	const content: InternalResponseContentBlock[] = []
	let toolUseIndex = 0

	if (candidate?.content?.parts) {
		for (const part of candidate.content.parts) {
			if ('text' in part) {
				content.push({ type: 'text', text: part.text })
			} else if ('functionCall' in part) {
				content.push({
					type: 'tool_use',
					id: `toolu_gemini_${messageId}_${toolUseIndex++}`,
					name: part.functionCall.name,
					input: part.functionCall.args,
				})
			}
		}
	}

	if (content.length === 0) {
		content.push({ type: 'text', text: '' })
	}

	const hasToolUse = content.some((b) => b.type === 'tool_use')

	return {
		id: messageId,
		type: 'message',
		role: 'assistant',
		content,
		model,
		stop_reason: mapGeminiFinishReason(candidate?.finishReason, hasToolUse),
		usage: {
			input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
			output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
		},
	}
}

// ============================================================================
// Streaming (Gemini → Internal events)
// ============================================================================

/**
 * State tracker for converting Gemini streaming responses to internal events.
 *
 * Gemini sends complete candidate content in each chunk (accumulated),
 * unlike OpenAI which sends deltas. We need to diff between chunks
 * to produce incremental events.
 */
export class GeminiStreamAdapter {
	private messageStarted = false
	private lastTextLength = 0
	private contentIndex = -1
	private seenFunctionCalls = 0
	private messageId: string
	private model: string

	constructor(messageId: string, model: string) {
		this.messageId = messageId
		this.model = model
	}

	*processChunk(response: GeminiGenerateResponse): Generator<InternalStreamEvent> {
		if (!this.messageStarted) {
			this.messageStarted = true
			yield {
				type: 'message_start',
				message: {
					id: this.messageId,
					type: 'message',
					role: 'assistant',
					content: [],
					model: this.model,
					stop_reason: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}
		}

		const candidate = response.candidates?.[0]
		if (!candidate?.content?.parts) return

		for (const part of candidate.content.parts) {
			if ('text' in part) {
				const newText = part.text.slice(this.lastTextLength)
				if (newText) {
					if (this.lastTextLength === 0) {
						this.contentIndex++
						yield {
							type: 'content_block_start',
							index: this.contentIndex,
							content_block: { type: 'text', text: '' },
						}
					}
					yield {
						type: 'content_block_delta',
						index: this.contentIndex,
						delta: { type: 'text_delta', text: newText },
					}
					this.lastTextLength = part.text.length
				}
			} else if ('functionCall' in part) {
				// Gemini sends complete function calls (not streamed)
				this.seenFunctionCalls++
				if (this.lastTextLength > 0) {
					yield { type: 'content_block_stop', index: this.contentIndex }
					this.lastTextLength = 0
				}

				this.contentIndex++
				const toolId = `toolu_gemini_${this.messageId}_${this.seenFunctionCalls}`
				yield {
					type: 'content_block_start',
					index: this.contentIndex,
					content_block: {
						type: 'tool_use',
						id: toolId,
						name: part.functionCall.name,
						input: {},
					},
				}
				yield {
					type: 'content_block_delta',
					index: this.contentIndex,
					delta: {
						type: 'input_json_delta',
						partial_json: JSON.stringify(part.functionCall.args),
					},
				}
				yield { type: 'content_block_stop', index: this.contentIndex }
			}
		}

		// Check for finish
		if (candidate.finishReason && candidate.finishReason !== 'NONE') {
			if (this.lastTextLength > 0) {
				yield { type: 'content_block_stop', index: this.contentIndex }
			}

			const hasToolUse = this.seenFunctionCalls > 0
			yield {
				type: 'message_delta',
				delta: {
					stop_reason: mapGeminiFinishReason(candidate.finishReason, hasToolUse),
				},
				usage: response.usageMetadata
					? { output_tokens: response.usageMetadata.candidatesTokenCount }
					: undefined,
			}
			yield { type: 'message_stop' }
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function mapGeminiFinishReason(
	reason: string | undefined,
	hasToolUse: boolean,
): InternalStopReason {
	if (hasToolUse) return 'tool_use'
	switch (reason) {
		case 'STOP':
			return 'end_turn'
		case 'MAX_TOKENS':
			return 'max_tokens'
		case 'SAFETY':
		case 'RECITATION':
		case 'OTHER':
			return 'end_turn'
		default:
			return 'end_turn'
	}
}
