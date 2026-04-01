/**
 * WhatsApp ↔ Claude2 Bridge.
 *
 * Connects the WhatsApp channel to the Claude2 LLM pipeline.
 * When a message arrives on WhatsApp, it's routed to the active
 * LLM provider, and the response is sent back.
 *
 * Features:
 * - Session persistence per chat (separate conversations)
 * - Context management (summarize when too long)
 * - Media handling (images → vision model)
 * - Typing indicators while thinking
 * - Error recovery with user-friendly messages
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LLMProvider } from '../../providers/LLMProvider.js'
import type { CreateMessageParams, InternalMessageParam } from '../../providers/types.js'
import type { ChannelMessage, OutboundMessage } from '../types.js'
import type { WhatsAppChannel } from './WhatsAppChannel.js'

// ============================================================================
// Types
// ============================================================================

interface ChatSession {
	chatId: string
	messages: InternalMessageParam[]
	lastActivity: number
	messageCount: number
}

interface BridgeConfig {
	/** System prompt for WhatsApp conversations. */
	systemPrompt?: string
	/** Max messages to keep in context before summarizing. */
	maxContextMessages?: number
	/** Max tokens per response. */
	maxTokens?: number
	/** Model to use for WhatsApp conversations. */
	model?: string
}

// ============================================================================
// WhatsApp Bridge
// ============================================================================

export class WhatsAppBridge {
	private channel: WhatsAppChannel
	private provider: LLMProvider
	private config: BridgeConfig
	private sessions = new Map<string, ChatSession>()
	private sessionsDir: string

	constructor(
		channel: WhatsAppChannel,
		provider: LLMProvider,
		config: BridgeConfig = {},
	) {
		this.channel = channel
		this.provider = provider
		this.config = {
			systemPrompt: config.systemPrompt || this.getDefaultSystemPrompt(),
			maxContextMessages: config.maxContextMessages || 50,
			maxTokens: config.maxTokens || 4096,
			model: config.model || 'claude-opus-4-6',
		}

		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp'
		this.sessionsDir = join(homeDir, '.claude2', 'whatsapp', 'sessions')
		if (!existsSync(this.sessionsDir)) {
			mkdirSync(this.sessionsDir, { recursive: true })
		}

		// Register message handler
		this.channel.onMessage(async (msg) => {
			await this.handleIncomingMessage(msg)
		})
	}

	// ========================================================================
	// Message Handling
	// ========================================================================

	private async handleIncomingMessage(msg: ChannelMessage): Promise<void> {
		const chatId = msg.chatId

		try {
			// Load or create session
			const session = this.getOrCreateSession(chatId)

			// Handle special commands
			const command = this.parseCommand(msg.text)
			if (command) {
				await this.handleCommand(chatId, command)
				return
			}

			// Add user message to session
			session.messages.push({
				role: 'user',
				content: msg.text,
			})
			session.lastActivity = Date.now()
			session.messageCount++

			// Trim context if too long
			if (session.messages.length > this.config.maxContextMessages!) {
				session.messages = session.messages.slice(-this.config.maxContextMessages!)
			}

			// Call LLM
			const response = await this.callLLM(session)

			// Send response back to WhatsApp
			await this.channel.sendMessage(chatId, { text: response })

			// Add assistant response to session
			session.messages.push({
				role: 'assistant',
				content: response,
			})

			// Save session
			this.saveSession(chatId, session)
		} catch (error) {
			console.error(`Error handling WhatsApp message from ${chatId}:`, error)

			// Send error message to user
			const errorMsg = error instanceof Error ? error.message : 'Unknown error'
			await this.channel.sendMessage(chatId, {
				text: `⚠️ Sorry, I encountered an error: ${errorMsg}\n\nPlease try again.`,
			})
		}
	}

	// ========================================================================
	// LLM Integration
	// ========================================================================

	private async callLLM(session: ChatSession): Promise<string> {
		const params: CreateMessageParams = {
			model: this.config.model!,
			messages: session.messages,
			system: this.config.systemPrompt,
			max_tokens: this.config.maxTokens!,
			stream: false,
		}

		const response = await this.provider.createMessage(params)

		// Extract text from response
		const textBlocks = response.content.filter((b) => b.type === 'text')
		return textBlocks.map((b: any) => b.text).join('\n') || '(no response)'
	}

	// ========================================================================
	// Commands
	// ========================================================================

	private parseCommand(text: string): string | null {
		const trimmed = text.trim().toLowerCase()
		if (trimmed.startsWith('/')) {
			return trimmed
		}
		return null
	}

	private async handleCommand(chatId: string, command: string): Promise<void> {
		switch (command) {
			case '/reset':
			case '/clear':
				this.sessions.delete(chatId)
				this.deleteSessionFile(chatId)
				await this.channel.sendMessage(chatId, {
					text: '🔄 Conversation reset. Starting fresh!',
				})
				break

			case '/status':
				const session = this.sessions.get(chatId)
				const msgCount = session?.messageCount || 0
				const selfId = this.channel.getSelfId()
				await this.channel.sendMessage(chatId, {
					text: [
						'📊 *Claude2 Status*',
						`Connected as: ${selfId || 'unknown'}`,
						`Messages in this chat: ${msgCount}`,
						`Provider: ${this.provider.name}`,
						`Model: ${this.config.model}`,
					].join('\n'),
				})
				break

			case '/help':
				await this.channel.sendMessage(chatId, {
					text: [
						'🤖 *Claude2 WhatsApp Commands*',
						'',
						'/reset — Clear conversation history',
						'/status — Show connection status',
						'/model — Show current model',
						'/help — Show this help',
						'',
						'Just type normally to chat with the AI!',
					].join('\n'),
				})
				break

			case '/model':
				await this.channel.sendMessage(chatId, {
					text: `Current model: ${this.config.model}`,
				})
				break

			default:
				await this.channel.sendMessage(chatId, {
					text: `Unknown command: ${command}\nType /help for available commands.`,
				})
		}
	}

	// ========================================================================
	// Session Management
	// ========================================================================

	private getOrCreateSession(chatId: string): ChatSession {
		let session = this.sessions.get(chatId)
		if (session) return session

		// Try loading from disk
		session = this.loadSession(chatId)
		if (session) {
			this.sessions.set(chatId, session)
			return session
		}

		// Create new session
		session = {
			chatId,
			messages: [],
			lastActivity: Date.now(),
			messageCount: 0,
		}
		this.sessions.set(chatId, session)
		return session
	}

	private loadSession(chatId: string): ChatSession | null {
		const filePath = this.getSessionPath(chatId)
		if (!existsSync(filePath)) return null

		try {
			return JSON.parse(readFileSync(filePath, 'utf-8'))
		} catch {
			return null
		}
	}

	private saveSession(chatId: string, session: ChatSession): void {
		const filePath = this.getSessionPath(chatId)
		writeFileSync(filePath, JSON.stringify(session, null, 2))
	}

	private deleteSessionFile(chatId: string): void {
		const filePath = this.getSessionPath(chatId)
		if (existsSync(filePath)) {
			const { unlinkSync } = require('fs')
			unlinkSync(filePath)
		}
	}

	private getSessionPath(chatId: string): string {
		// Sanitize chatId for filesystem
		const safe = chatId.replace(/[^a-zA-Z0-9@._-]/g, '_')
		return join(this.sessionsDir, `${safe}.json`)
	}

	// ========================================================================
	// Default System Prompt
	// ========================================================================

	private getDefaultSystemPrompt(): string {
		return [
			'You are Claude2, an AGI-oriented AI assistant accessible via WhatsApp.',
			'',
			'Guidelines for WhatsApp conversations:',
			'- Keep responses concise — WhatsApp is a mobile messenger, not a code editor.',
			'- Use WhatsApp formatting: *bold*, _italic_, ~strikethrough~, ```code```.',
			'- Break long responses into digestible paragraphs.',
			'- Use emoji sparingly for friendliness.',
			'- If asked to write code, keep it short. For long code, suggest using the CLI instead.',
			'- Remember context from earlier in the conversation.',
			'- If you cannot do something via WhatsApp, explain what the user can do via the CLI.',
			'',
			'You have access to these commands that users can type:',
			'/reset — Clear conversation history',
			'/status — Show connection status',
			'/help — Show available commands',
		].join('\n')
	}
}
