/**
 * Provider-neutral message, content block, and streaming types for Claude2.
 *
 * These types intentionally mirror the Anthropic SDK's Beta message types
 * so that the existing codebase requires minimal changes. Non-Anthropic
 * providers translate their native formats to/from these types at the edge.
 */

// ============================================================================
// Content Block Types
// ============================================================================

export interface InternalTextBlock {
	type: 'text'
	text: string
	/** Optional cache control hint (Anthropic-specific, ignored by others). */
	cache_control?: { type: 'ephemeral' } | null
}

export interface InternalThinkingBlock {
	type: 'thinking'
	thinking: string
}

export interface InternalRedactedThinkingBlock {
	type: 'redacted_thinking'
	data: string
}

export interface InternalToolUseBlock {
	type: 'tool_use'
	id: string
	name: string
	input: Record<string, unknown>
}

export interface InternalToolResultBlock {
	type: 'tool_result'
	tool_use_id: string
	content: string | InternalContentBlock[]
	is_error?: boolean
}

export interface InternalImageBlock {
	type: 'image'
	source:
		| { type: 'base64'; media_type: string; data: string }
		| { type: 'url'; url: string }
}

export interface InternalDocumentBlock {
	type: 'document'
	source: { type: 'base64'; media_type: string; data: string }
	title?: string
}

/** Union of all content block types. */
export type InternalContentBlock =
	| InternalTextBlock
	| InternalThinkingBlock
	| InternalRedactedThinkingBlock
	| InternalToolUseBlock
	| InternalToolResultBlock
	| InternalImageBlock
	| InternalDocumentBlock

/** Content blocks that can appear in assistant responses. */
export type InternalResponseContentBlock =
	| InternalTextBlock
	| InternalThinkingBlock
	| InternalRedactedThinkingBlock
	| InternalToolUseBlock

/** Content blocks that can appear in user/input messages. */
export type InternalInputContentBlock =
	| InternalTextBlock
	| InternalToolResultBlock
	| InternalImageBlock
	| InternalDocumentBlock

// ============================================================================
// Message Types
// ============================================================================

export type InternalRole = 'user' | 'assistant'

export type InternalStopReason =
	| 'end_turn'
	| 'tool_use'
	| 'max_tokens'
	| 'stop_sequence'
	| null

export interface InternalUsage {
	input_tokens: number
	output_tokens: number
	cache_creation_input_tokens?: number
	cache_read_input_tokens?: number
}

/** A complete message returned by an LLM provider. */
export interface InternalMessage {
	id: string
	type: 'message'
	role: 'assistant'
	content: InternalResponseContentBlock[]
	model: string
	stop_reason: InternalStopReason
	usage: InternalUsage
}

/** A message parameter for sending to an LLM provider. */
export interface InternalMessageParam {
	role: InternalRole
	content: string | InternalContentBlock[]
}

// ============================================================================
// Streaming Event Types
// ============================================================================

export interface InternalMessageStartEvent {
	type: 'message_start'
	message: InternalMessage
}

export interface InternalContentBlockStartEvent {
	type: 'content_block_start'
	index: number
	content_block: InternalResponseContentBlock
}

export interface InternalTextDelta {
	type: 'text_delta'
	text: string
}

export interface InternalInputJsonDelta {
	type: 'input_json_delta'
	partial_json: string
}

export interface InternalThinkingDelta {
	type: 'thinking_delta'
	thinking: string
}

export type InternalContentDelta =
	| InternalTextDelta
	| InternalInputJsonDelta
	| InternalThinkingDelta

export interface InternalContentBlockDeltaEvent {
	type: 'content_block_delta'
	index: number
	delta: InternalContentDelta
}

export interface InternalContentBlockStopEvent {
	type: 'content_block_stop'
	index: number
}

export interface InternalMessageDeltaEvent {
	type: 'message_delta'
	delta: {
		stop_reason: InternalStopReason
	}
	usage?: {
		output_tokens: number
	}
}

export interface InternalMessageStopEvent {
	type: 'message_stop'
}

/** Union of all streaming events. */
export type InternalStreamEvent =
	| InternalMessageStartEvent
	| InternalContentBlockStartEvent
	| InternalContentBlockDeltaEvent
	| InternalContentBlockStopEvent
	| InternalMessageDeltaEvent
	| InternalMessageStopEvent

// ============================================================================
// Tool Schema Types
// ============================================================================

/** Provider-neutral tool definition. */
export interface InternalToolSchema {
	name: string
	description: string
	input_schema: Record<string, unknown>
}

/** Tool choice configuration. */
export type InternalToolChoice =
	| { type: 'auto' }
	| { type: 'any' }
	| { type: 'tool'; name: string }
	| { type: 'none' }

// ============================================================================
// Request Parameters
// ============================================================================

/** Parameters for creating a message (request to LLM). */
export interface CreateMessageParams {
	model: string
	messages: InternalMessageParam[]
	system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } | null }>
	tools?: InternalToolSchema[]
	tool_choice?: InternalToolChoice
	max_tokens: number
	temperature?: number
	stream: boolean
	stop_sequences?: string[]

	/** Extended thinking configuration (Anthropic, Gemini). */
	thinking?: {
		type: 'enabled'
		budget_tokens: number
	} | {
		type: 'disabled'
	}

	/** Structured output format. */
	output_format?: {
		type: 'json'
		schema?: Record<string, unknown>
	}
}

// ============================================================================
// Error Types
// ============================================================================

/** Provider-neutral API error. */
export class ProviderAPIError extends Error {
	constructor(
		message: string,
		public readonly status: number | undefined,
		public readonly provider: string,
		public readonly retryable: boolean,
		public readonly headers?: Record<string, string>,
		public readonly rawError?: unknown,
	) {
		super(message)
		this.name = 'ProviderAPIError'
	}
}
