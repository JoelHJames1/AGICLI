/**
 * Claude2 Channel System Types.
 *
 * Channels are messaging platform integrations that let users
 * interact with Claude2 from WhatsApp, Telegram, Discord, etc.
 *
 * Inspired by OpenClaw's plugin architecture but simplified
 * for Claude2's single-user, AGI-focused use case.
 */

// ============================================================================
// Channel Types
// ============================================================================

export type ChannelType =
	| 'whatsapp'
	| 'telegram'
	| 'discord'
	| 'slack'
	| 'cli'       // Terminal (default)
	| 'web'       // Web UI

export interface ChannelMessage {
	/** Unique message ID. */
	id: string
	/** Channel this message came from. */
	channel: ChannelType
	/** Sender identifier (phone number, username, etc.). */
	senderId: string
	/** Sender display name. */
	senderName?: string
	/** Chat/group identifier. */
	chatId: string
	/** Message text content. */
	text: string
	/** Timestamp. */
	timestamp: Date
	/** Media attachments. */
	media?: MediaAttachment[]
	/** Whether this is a group message. */
	isGroup: boolean
	/** Raw platform-specific message object. */
	raw?: unknown
}

export interface MediaAttachment {
	type: 'image' | 'audio' | 'video' | 'document'
	url?: string
	buffer?: Buffer
	mimeType: string
	fileName?: string
	caption?: string
}

export interface OutboundMessage {
	text: string
	media?: MediaAttachment[]
	/** Reply to a specific message ID. */
	replyTo?: string
}

// ============================================================================
// Channel Interface
// ============================================================================

export interface Channel {
	/** Channel type identifier. */
	readonly type: ChannelType

	/** Human-readable channel name. */
	readonly name: string

	/** Whether the channel is connected. */
	isConnected(): boolean

	/** Initialize and connect the channel. */
	connect(): Promise<void>

	/** Disconnect the channel. */
	disconnect(): Promise<void>

	/** Send a message to a specific chat. */
	sendMessage(chatId: string, message: OutboundMessage): Promise<void>

	/** Register a handler for incoming messages. */
	onMessage(handler: (message: ChannelMessage) => Promise<void>): void

	/** Get channel-specific text chunk limit. */
	getTextChunkLimit(): number
}

// ============================================================================
// Channel Config
// ============================================================================

export interface ChannelConfig {
	enabled: boolean
	/** Allowed sender IDs (empty = allow all). */
	allowedSenders?: string[]
	/** Auto-reply when receiving messages from unknown senders. */
	unknownSenderReply?: string
}

export interface WhatsAppChannelConfig extends ChannelConfig {
	/** Directory to store auth credentials. */
	authDir?: string
	/** Whether to send read receipts. */
	sendReadReceipts?: boolean
	/** Debounce rapid messages (ms). 0 = disabled. */
	debounceMs?: number
	/** Max media download size in bytes. */
	maxMediaSize?: number
}

// ============================================================================
// Channel Manager Types
// ============================================================================

export interface ChannelManagerConfig {
	whatsapp?: WhatsAppChannelConfig
}

// ============================================================================
// Message Chunking
// ============================================================================

/**
 * Split a long message into chunks respecting the channel's text limit.
 * Tries to break at paragraph boundaries, then sentence boundaries.
 */
export function chunkMessage(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) return [text]

	const chunks: string[] = []
	let remaining = text

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining)
			break
		}

		// Try to break at double newline (paragraph)
		let breakPoint = remaining.lastIndexOf('\n\n', maxLength)

		// Try single newline
		if (breakPoint <= 0) {
			breakPoint = remaining.lastIndexOf('\n', maxLength)
		}

		// Try sentence boundary
		if (breakPoint <= 0) {
			breakPoint = remaining.lastIndexOf('. ', maxLength)
			if (breakPoint > 0) breakPoint += 1 // Include the period
		}

		// Force break at max length
		if (breakPoint <= 0) {
			breakPoint = maxLength
		}

		chunks.push(remaining.slice(0, breakPoint).trimEnd())
		remaining = remaining.slice(breakPoint).trimStart()
	}

	return chunks
}
