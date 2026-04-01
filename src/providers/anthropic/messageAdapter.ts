/**
 * Message format adapter between Anthropic SDK types and internal types.
 *
 * Since InternalMessage was designed to mirror Anthropic's BetaMessage,
 * these mappings are near-identity transformations. They exist to provide
 * a clean boundary and make the type system explicit.
 */

import type {
	InternalContentBlock,
	InternalMessage,
	InternalMessageParam,
	InternalResponseContentBlock,
	InternalStreamEvent,
	InternalStopReason,
	InternalToolSchema,
	InternalUsage,
} from '../types.js'

// ============================================================================
// Response Mapping (Anthropic SDK → Internal)
// ============================================================================

/**
 * Convert an Anthropic BetaMessage to an InternalMessage.
 * Near-identity since our types mirror Anthropic's format.
 */
export function anthropicMessageToInternal(msg: any): InternalMessage {
	return {
		id: msg.id,
		type: 'message',
		role: 'assistant',
		content: msg.content as InternalResponseContentBlock[],
		model: msg.model,
		stop_reason: msg.stop_reason as InternalStopReason,
		usage: {
			input_tokens: msg.usage.input_tokens,
			output_tokens: msg.usage.output_tokens,
			cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
			cache_read_input_tokens: msg.usage.cache_read_input_tokens,
		},
	}
}

/**
 * Convert an Anthropic stream event to an InternalStreamEvent.
 * Direct passthrough — our event types were designed to match.
 */
export function anthropicStreamEventToInternal(event: any): InternalStreamEvent {
	return event as InternalStreamEvent
}

// ============================================================================
// Request Mapping (Internal → Anthropic SDK)
// ============================================================================

/**
 * Convert internal messages to Anthropic's message param format.
 * Near-identity for Anthropic — content blocks are already compatible.
 */
export function internalMessagesToAnthropic(
	messages: InternalMessageParam[],
): any[] {
	return messages.map((msg) => ({
		role: msg.role,
		content: msg.content,
	}))
}

/**
 * Convert internal tool schemas to Anthropic's tool format.
 * Direct mapping — both use { name, description, input_schema }.
 */
export function internalToolsToAnthropic(
	tools: InternalToolSchema[],
): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.input_schema,
	}))
}

// ============================================================================
// Usage Mapping
// ============================================================================

/**
 * Convert Anthropic usage to internal format.
 */
export function anthropicUsageToInternal(usage: any): InternalUsage {
	return {
		input_tokens: usage.input_tokens ?? 0,
		output_tokens: usage.output_tokens ?? 0,
		cache_creation_input_tokens: usage.cache_creation_input_tokens,
		cache_read_input_tokens: usage.cache_read_input_tokens,
	}
}
