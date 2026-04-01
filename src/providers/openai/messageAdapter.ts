/**
 * Message format adapter between OpenAI Chat Completion API and internal types.
 *
 * Key differences from Anthropic format:
 * - System prompt is a message with role "system" (not a separate field)
 * - Tool calls are on the assistant message (not content blocks)
 * - Tool results are messages with role "tool" (not content blocks)
 * - Images use { type: "image_url" } format
 * - No native "thinking" support (o-series uses different mechanism)
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
	InternalUsage,
} from '../types.js'

// ============================================================================
// Types for OpenAI API (minimal, to avoid requiring the full SDK as dep)
// ============================================================================

interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: string | OpenAIContentPart[] | null
	tool_calls?: OpenAIToolCall[]
	tool_call_id?: string
	name?: string
}

interface OpenAIContentPart {
	type: 'text' | 'image_url'
	text?: string
	image_url?: { url: string; detail?: 'low' | 'high' | 'auto' }
}

interface OpenAIToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

interface OpenAITool {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

interface OpenAIChatCompletion {
	id: string
	object: 'chat.completion'
	model: string
	choices: Array<{
		index: number
		message: OpenAIChatMessage
		finish_reason: string | null
	}>
	usage?: {
		prompt_tokens: number
		completion_tokens: number
		total_tokens: number
	}
}

interface OpenAIChatCompletionChunk {
	id: string
	object: 'chat.completion.chunk'
	model: string
	choices: Array<{
		index: number
		delta: {
			role?: string
			content?: string | null
			tool_calls?: Array<{
				index: number
				id?: string
				type?: 'function'
				function?: {
					name?: string
					arguments?: string
				}
			}>
		}
		finish_reason: string | null
	}>
	usage?: {
		prompt_tokens: number
		completion_tokens: number
		total_tokens: number
	}
}

// ============================================================================
// Request Mapping (Internal → OpenAI)
// ============================================================================

/**
 * Convert internal messages + system prompt to OpenAI chat messages.
 */
export function internalToOpenAIMessages(
	messages: InternalMessageParam[],
	system?: string | Array<{ type: 'text'; text: string }>,
): OpenAIChatMessage[] {
	const result: OpenAIChatMessage[] = []

	// System prompt becomes a system message
	if (system) {
		const systemText = typeof system === 'string'
			? system
			: system.map((s) => s.text).join('\n\n')
		result.push({ role: 'system', content: systemText })
	}

	for (const msg of messages) {
		if (msg.role === 'user') {
			result.push(...convertUserMessage(msg))
		} else {
			result.push(...convertAssistantMessage(msg))
		}
	}

	return result
}

function convertUserMessage(msg: InternalMessageParam): OpenAIChatMessage[] {
	if (typeof msg.content === 'string') {
		return [{ role: 'user', content: msg.content }]
	}

	const result: OpenAIChatMessage[] = []
	const contentParts: OpenAIContentPart[] = []
	const toolResults: OpenAIChatMessage[] = []

	for (const block of msg.content) {
		switch (block.type) {
			case 'text':
				contentParts.push({ type: 'text', text: block.text })
				break
			case 'image': {
				const imgBlock = block as InternalInputContentBlock & { type: 'image' }
				const url =
					'url' in imgBlock.source
						? imgBlock.source.url
						: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`
				contentParts.push({
					type: 'image_url',
					image_url: { url },
				})
				break
			}
			case 'tool_result': {
				const tr = block as InternalToolResultBlock
				const content = typeof tr.content === 'string'
					? tr.content
					: tr.content
						.filter((b): b is InternalTextBlock => b.type === 'text')
						.map((b) => b.text)
						.join('\n')
				toolResults.push({
					role: 'tool',
					tool_call_id: tr.tool_use_id,
					content,
				})
				break
			}
			default:
				// Documents and other blocks → convert to text representation
				contentParts.push({
					type: 'text',
					text: `[${block.type} content]`,
				})
		}
	}

	// Tool results must come before user content in OpenAI's format
	result.push(...toolResults)

	if (contentParts.length > 0) {
		result.push({ role: 'user', content: contentParts })
	}

	return result
}

function convertAssistantMessage(msg: InternalMessageParam): OpenAIChatMessage[] {
	if (typeof msg.content === 'string') {
		return [{ role: 'assistant', content: msg.content }]
	}

	const textParts: string[] = []
	const toolCalls: OpenAIToolCall[] = []

	for (const block of msg.content) {
		switch (block.type) {
			case 'text':
				textParts.push(block.text)
				break
			case 'tool_use': {
				const tu = block as InternalToolUseBlock
				toolCalls.push({
					id: tu.id,
					type: 'function',
					function: {
						name: tu.name,
						arguments: JSON.stringify(tu.input),
					},
				})
				break
			}
			case 'thinking':
				// OpenAI doesn't have thinking blocks; include as text prefix
				textParts.push(`<thinking>\n${(block as any).thinking}\n</thinking>`)
				break
			default:
				break
		}
	}

	const message: OpenAIChatMessage = {
		role: 'assistant',
		content: textParts.join('\n') || null,
	}

	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls
	}

	return [message]
}

/**
 * Convert internal tool schemas to OpenAI function tool format.
 */
export function internalToolsToOpenAI(tools: InternalToolSchema[]): OpenAITool[] {
	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema,
		},
	}))
}

// ============================================================================
// Response Mapping (OpenAI → Internal)
// ============================================================================

/**
 * Convert an OpenAI chat completion response to an InternalMessage.
 */
export function openAIResponseToInternal(
	response: OpenAIChatCompletion,
): InternalMessage {
	const choice = response.choices[0]
	if (!choice) {
		return {
			id: response.id,
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text: '' }],
			model: response.model,
			stop_reason: 'end_turn',
			usage: {
				input_tokens: response.usage?.prompt_tokens ?? 0,
				output_tokens: response.usage?.completion_tokens ?? 0,
			},
		}
	}

	const content: InternalResponseContentBlock[] = []

	// Text content
	if (choice.message.content) {
		content.push({ type: 'text', text: choice.message.content })
	}

	// Tool calls → tool_use blocks
	if (choice.message.tool_calls) {
		for (const tc of choice.message.tool_calls) {
			content.push({
				type: 'tool_use',
				id: tc.id,
				name: tc.function.name,
				input: safeParseJSON(tc.function.arguments),
			})
		}
	}

	// Ensure at least one content block
	if (content.length === 0) {
		content.push({ type: 'text', text: '' })
	}

	return {
		id: response.id,
		type: 'message',
		role: 'assistant',
		content,
		model: response.model,
		stop_reason: mapFinishReason(choice.finish_reason),
		usage: {
			input_tokens: response.usage?.prompt_tokens ?? 0,
			output_tokens: response.usage?.completion_tokens ?? 0,
		},
	}
}

// ============================================================================
// Streaming Mapping (OpenAI chunks → Internal events)
// ============================================================================

/**
 * State tracker for converting OpenAI streaming chunks to internal events.
 *
 * OpenAI's streaming format differs from Anthropic's:
 * - No explicit message_start/message_stop events
 * - No explicit content_block_start/stop events
 * - Tool call arguments arrive incrementally across chunks
 * - Text content arrives as delta.content strings
 *
 * This class synthesizes the missing events to produce a stream
 * compatible with the internal event format.
 */
export class OpenAIStreamAdapter {
	private messageStarted = false
	private currentContentIndex = -1
	private activeToolCalls = new Map<number, {
		id: string
		name: string
		argumentsBuffer: string
	}>()
	private hasTextContent = false
	private model = ''
	private messageId = ''

	/**
	 * Process an OpenAI chunk and yield internal stream events.
	 */
	*processChunk(chunk: OpenAIChatCompletionChunk): Generator<InternalStreamEvent> {
		this.model = chunk.model
		this.messageId = chunk.id

		// Synthesize message_start on first chunk
		if (!this.messageStarted) {
			this.messageStarted = true
			yield {
				type: 'message_start',
				message: {
					id: chunk.id,
					type: 'message',
					role: 'assistant',
					content: [],
					model: chunk.model,
					stop_reason: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			}
		}

		const choice = chunk.choices[0]
		if (!choice) {
			// Usage-only chunk (OpenAI sends these at the end)
			if (chunk.usage) {
				yield {
					type: 'message_delta',
					delta: { stop_reason: 'end_turn' },
					usage: { output_tokens: chunk.usage.completion_tokens },
				}
			}
			return
		}

		const { delta, finish_reason } = choice

		// Handle text content
		if (delta.content) {
			if (!this.hasTextContent) {
				this.hasTextContent = true
				this.currentContentIndex++
				yield {
					type: 'content_block_start',
					index: this.currentContentIndex,
					content_block: { type: 'text', text: '' },
				}
			}
			yield {
				type: 'content_block_delta',
				index: this.currentContentIndex,
				delta: { type: 'text_delta', text: delta.content },
			}
		}

		// Handle tool calls
		if (delta.tool_calls) {
			for (const tc of delta.tool_calls) {
				const existing = this.activeToolCalls.get(tc.index)

				if (!existing && tc.id) {
					// New tool call starting
					// Close text block if open
					if (this.hasTextContent) {
						yield {
							type: 'content_block_stop',
							index: this.currentContentIndex,
						}
						this.hasTextContent = false
					}

					this.currentContentIndex++
					const toolCall = {
						id: tc.id,
						name: tc.function?.name || '',
						argumentsBuffer: tc.function?.arguments || '',
					}
					this.activeToolCalls.set(tc.index, toolCall)

					yield {
						type: 'content_block_start',
						index: this.currentContentIndex,
						content_block: {
							type: 'tool_use',
							id: tc.id,
							name: toolCall.name,
							input: {},
						},
					}

					if (tc.function?.arguments) {
						yield {
							type: 'content_block_delta',
							index: this.currentContentIndex,
							delta: {
								type: 'input_json_delta',
								partial_json: tc.function.arguments,
							},
						}
					}
				} else if (existing && tc.function?.arguments) {
					// Continuing tool call arguments
					existing.argumentsBuffer += tc.function.arguments
					yield {
						type: 'content_block_delta',
						index: this.currentContentIndex,
						delta: {
							type: 'input_json_delta',
							partial_json: tc.function.arguments,
						},
					}
				}
			}
		}

		// Handle finish
		if (finish_reason) {
			// Close any open blocks
			if (this.hasTextContent || this.activeToolCalls.size > 0) {
				yield {
					type: 'content_block_stop',
					index: this.currentContentIndex,
				}
			}

			yield {
				type: 'message_delta',
				delta: { stop_reason: mapFinishReason(finish_reason) },
				usage: chunk.usage
					? { output_tokens: chunk.usage.completion_tokens }
					: undefined,
			}

			yield { type: 'message_stop' }
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function mapFinishReason(reason: string | null): InternalStopReason {
	switch (reason) {
		case 'stop':
			return 'end_turn'
		case 'tool_calls':
			return 'tool_use'
		case 'length':
			return 'max_tokens'
		case 'content_filter':
			return 'end_turn'
		default:
			return reason as InternalStopReason
	}
}

function safeParseJSON(json: string): Record<string, unknown> {
	try {
		return JSON.parse(json)
	} catch {
		return {}
	}
}
