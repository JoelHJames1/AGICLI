/**
 * WhatsApp Channel for Claude2.
 *
 * Connects Claude2 to WhatsApp via Baileys (reverse-engineered WhatsApp Web).
 * Users scan a QR code to link their WhatsApp, then can chat with Claude2
 * from their phone.
 *
 * Features:
 * - QR code authentication (like OpenClaw)
 * - Send/receive text messages
 * - Media support (images, audio, video, documents)
 * - Typing indicators
 * - Read receipts
 * - Message debouncing (batch rapid messages)
 * - Multi-account support
 * - Credential persistence and recovery
 *
 * Based on patterns from OpenClaw's WhatsApp integration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type {
	Channel,
	ChannelMessage,
	MediaAttachment,
	OutboundMessage,
	WhatsAppChannelConfig,
} from '../types.js'
import { chunkMessage } from '../types.js'

// ============================================================================
// Types
// ============================================================================

type MessageHandler = (message: ChannelMessage) => Promise<void>

interface ActiveLogin {
	qrDataUrl: string | null
	connected: boolean
	startedAt: number
	socket: any
}

// ============================================================================
// WhatsApp Channel
// ============================================================================

export class WhatsAppChannel implements Channel {
	readonly type = 'whatsapp' as const
	readonly name = 'WhatsApp'

	private config: WhatsAppChannelConfig
	private socket: any = null
	private connected = false
	private messageHandlers: MessageHandler[] = []
	private authDir: string
	private selfId: string | null = null
	private activeLogin: ActiveLogin | null = null

	/** Credential save queue to prevent corruption. */
	private credsSaveQueue: Promise<void> = Promise.resolve()

	/** QR code event handlers. */
	private qrHandlers: Array<(qr: string) => void> = []
	/** Connection update handlers. */
	private connectionHandlers: Array<(status: string) => void> = []

	/** Debounce state for rapid messages. */
	private debounceTimers = new Map<string, NodeJS.Timeout>()
	private debounceBuffers = new Map<string, ChannelMessage[]>()

	constructor(config: WhatsAppChannelConfig = { enabled: true }) {
		this.config = {
			sendReadReceipts: true,
			debounceMs: 1500,
			maxMediaSize: 50 * 1024 * 1024, // 50MB
			...config,
		}

		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp'
		this.authDir = config.authDir || join(homeDir, '.claude2', 'whatsapp', 'auth')

		if (!existsSync(this.authDir)) {
			mkdirSync(this.authDir, { recursive: true })
		}
	}

	// ========================================================================
	// Channel Interface
	// ========================================================================

	isConnected(): boolean {
		return this.connected
	}

	async connect(): Promise<void> {
		if (this.connected) return

		// Check if we have saved credentials
		const hasAuth = existsSync(join(this.authDir, 'creds.json'))

		if (hasAuth) {
			// Try to reconnect with saved credentials
			await this.createSocket()
		} else {
			// No saved auth — start QR login flow
			await this.startQRLogin()
		}
	}

	async disconnect(): Promise<void> {
		if (this.socket) {
			try {
				await this.socket.end(undefined)
			} catch {
				// Ignore disconnect errors
			}
			this.socket = null
		}
		this.connected = false
		this.activeLogin = null
	}

	async sendMessage(chatId: string, message: OutboundMessage): Promise<void> {
		if (!this.socket || !this.connected) {
			throw new Error('WhatsApp not connected. Scan QR code first.')
		}

		const jid = this.toWhatsAppJid(chatId)

		// Send typing indicator
		await this.sendTypingIndicator(jid)

		// Chunk long messages (WhatsApp limit: ~4000 chars)
		const chunks = chunkMessage(message.text, 4000)

		for (const chunk of chunks) {
			if (message.media && message.media.length > 0) {
				// Send first chunk with media
				for (const media of message.media) {
					await this.sendMediaMessage(jid, media, chunk)
				}
			} else {
				await this.socket.sendMessage(jid, {
					text: chunk,
					...(message.replyTo ? { quoted: { key: { id: message.replyTo } } } : {}),
				})
			}

			// Small delay between chunks for natural feel
			if (chunks.length > 1) {
				await new Promise((resolve) => setTimeout(resolve, 500))
			}
		}
	}

	onMessage(handler: MessageHandler): void {
		this.messageHandlers.push(handler)
	}

	getTextChunkLimit(): number {
		return 4000
	}

	/**
	 * Register a handler for raw QR strings (for terminal rendering).
	 */
	onQR(handler: (qr: string) => void): void {
		this.qrHandlers.push(handler)
	}

	/**
	 * Register a handler for connection status changes.
	 */
	onConnectionUpdate(handler: (status: string) => void): void {
		this.connectionHandlers.push(handler)
	}

	// ========================================================================
	// QR Code Authentication
	// ========================================================================

	/**
	 * Start the QR code login flow.
	 * Returns a QR code data URL that the user scans in WhatsApp → Linked Devices.
	 */
	async startQRLogin(options?: {
		force?: boolean
		timeoutMs?: number
	}): Promise<{
		qrDataUrl: string
		message: string
	}> {
		const force = options?.force ?? false
		const timeoutMs = options?.timeoutMs ?? 180_000 // 3 minutes

		// Reuse active login if fresh
		if (
			this.activeLogin &&
			!force &&
			this.activeLogin.qrDataUrl &&
			Date.now() - this.activeLogin.startedAt < timeoutMs
		) {
			return {
				qrDataUrl: this.activeLogin.qrDataUrl,
				message: 'QR code already active. Scan it in WhatsApp → Linked Devices.',
			}
		}

		// Dynamic import of Baileys
		const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } =
			await import('@whiskeysockets/baileys')

		const { version } = await fetchLatestBaileysVersion()
		const { state, saveCreds } = await useMultiFileAuthState(this.authDir)

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('QR code login timed out. Try again.'))
			}, timeoutMs)

			const socket = makeWASocket({
				version,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
				},
				browser: ['Claude2', 'CLI', '1.0.0'],
				printQRInTerminal: true, // Also print to terminal
				generateHighQualityLinkPreview: false,
			})

			this.activeLogin = {
				qrDataUrl: null,
				connected: false,
				startedAt: Date.now(),
				socket,
			}

			// Handle QR code
			socket.ev.on('connection.update', async (update: any) => {
				const { connection, lastDisconnect, qr } = update

				if (qr) {
					// Notify QR handlers (for terminal rendering)
					for (const handler of this.qrHandlers) {
						handler(qr)
					}

					// Generate QR code as data URL
					try {
						const qrcode = await import('qrcode')
						const qrDataUrl = await qrcode.toDataURL(qr, {
							width: 300,
							margin: 2,
						})

						this.activeLogin!.qrDataUrl = qrDataUrl

						resolve({
							qrDataUrl,
							message: 'Scan this QR code in WhatsApp → Linked Devices → Link a Device',
						})
					} catch {
						// Fallback: return raw QR string
						resolve({
							qrDataUrl: `data:text/plain;base64,${Buffer.from(qr).toString('base64')}`,
							message: 'QR code generated. Scan in WhatsApp → Linked Devices.',
						})
					}
				}

				if (connection === 'open') {
					clearTimeout(timeout)
					this.socket = socket
					this.connected = true
					if (this.activeLogin) this.activeLogin.connected = true

					// Read self ID
					this.selfId = this.readSelfId(state.creds)

					// Start monitoring inbox
					this.monitorInbox(socket)

					// Notify connection handlers
					for (const handler of this.connectionHandlers) {
						handler('open')
					}

					console.log(`✓ WhatsApp connected as ${this.selfId || 'unknown'}`)
				}

				if (connection === 'close') {
					const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
					const shouldReconnect = statusCode !== DisconnectReason.loggedOut

					// Notify connection handlers
					for (const handler of this.connectionHandlers) {
						handler('close')
					}

					if (shouldReconnect) {
						// Auto-reconnect
						for (const handler of this.connectionHandlers) {
							handler('connecting')
						}
						setTimeout(() => this.connect(), 3000)
					} else {
						this.connected = false
						this.socket = null
						console.log('WhatsApp logged out. Scan QR code again to reconnect.')
					}
				}
			})

			// Save credentials with queue (prevent corruption)
			socket.ev.on('creds.update', () => {
				this.enqueueSaveCreds(saveCreds)
			})
		})
	}

	/**
	 * Wait for the QR login to complete.
	 */
	async waitForConnection(timeoutMs: number = 180_000): Promise<boolean> {
		const start = Date.now()
		while (Date.now() - start < timeoutMs) {
			if (this.connected) return true
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
		return false
	}

	/**
	 * Check if WhatsApp auth credentials exist on disk.
	 */
	hasStoredAuth(): boolean {
		return existsSync(join(this.authDir, 'creds.json'))
	}

	/**
	 * Get the connected phone number / WhatsApp ID.
	 */
	getSelfId(): string | null {
		return this.selfId
	}

	// ========================================================================
	// Private: Socket Management
	// ========================================================================

	private async createSocket(): Promise<void> {
		try {
			const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } =
				await import('@whiskeysockets/baileys')

			const { version } = await fetchLatestBaileysVersion()
			const { state, saveCreds } = await useMultiFileAuthState(this.authDir)

			const socket = makeWASocket({
				version,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
				},
				browser: ['Claude2', 'CLI', '1.0.0'],
				printQRInTerminal: false,
				generateHighQualityLinkPreview: false,
			})

			socket.ev.on('connection.update', async (update: any) => {
				const { connection, lastDisconnect } = update

				if (connection === 'open') {
					this.socket = socket
					this.connected = true
					this.selfId = this.readSelfId(state.creds)
					this.monitorInbox(socket)
					console.log(`✓ WhatsApp reconnected as ${this.selfId || 'unknown'}`)
				}

				if (connection === 'close') {
					const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
					if (statusCode !== DisconnectReason.loggedOut) {
						setTimeout(() => this.createSocket(), 5000)
					} else {
						this.connected = false
						this.socket = null
					}
				}
			})

			socket.ev.on('creds.update', () => {
				this.enqueueSaveCreds(saveCreds)
			})
		} catch (error) {
			console.error('Failed to create WhatsApp socket:', error)
			throw error
		}
	}

	// ========================================================================
	// Private: Inbox Monitoring
	// ========================================================================

	private monitorInbox(socket: any): void {
		socket.ev.on('messages.upsert', async (update: any) => {
			if (update.type !== 'notify') return

			for (const msg of update.messages) {
				// Skip own messages
				if (msg.key.fromMe) continue

				// Skip old messages
				const msgTime = (msg.messageTimestamp as number) * 1000
				if (Date.now() - msgTime > 60_000) continue // Ignore messages older than 1 minute

				// Extract message content
				const channelMsg = this.extractMessage(msg)
				if (!channelMsg) continue

				// Check access control
				if (!this.checkAccess(channelMsg.senderId)) {
					if (this.config.unknownSenderReply) {
						await this.sendMessage(channelMsg.chatId, {
							text: this.config.unknownSenderReply,
						})
					}
					continue
				}

				// Send read receipt
				if (this.config.sendReadReceipts) {
					try {
						await socket.readMessages([msg.key])
					} catch {
						// Ignore read receipt errors
					}
				}

				// Debounce or dispatch immediately
				if (this.config.debounceMs && this.config.debounceMs > 0) {
					this.debounceMessage(channelMsg)
				} else {
					await this.dispatchMessage(channelMsg)
				}
			}
		})
	}

	private extractMessage(msg: any): ChannelMessage | null {
		const conversation = msg.message?.conversation
		const extendedText = msg.message?.extendedTextMessage?.text
		const imageCaption = msg.message?.imageMessage?.caption
		const text = conversation || extendedText || imageCaption || ''

		if (!text && !msg.message?.imageMessage && !msg.message?.audioMessage) {
			return null // Skip non-text, non-media messages
		}

		const chatId = msg.key.remoteJid || ''
		const isGroup = chatId.endsWith('@g.us')
		const senderId = isGroup
			? msg.key.participant || ''
			: chatId

		// Extract media
		const media: MediaAttachment[] = []
		if (msg.message?.imageMessage) {
			media.push({
				type: 'image',
				mimeType: msg.message.imageMessage.mimetype || 'image/jpeg',
				caption: msg.message.imageMessage.caption,
			})
		}
		if (msg.message?.audioMessage) {
			media.push({
				type: 'audio',
				mimeType: msg.message.audioMessage.mimetype || 'audio/ogg',
			})
		}
		if (msg.message?.videoMessage) {
			media.push({
				type: 'video',
				mimeType: msg.message.videoMessage.mimetype || 'video/mp4',
				caption: msg.message.videoMessage.caption,
			})
		}
		if (msg.message?.documentMessage) {
			media.push({
				type: 'document',
				mimeType: msg.message.documentMessage.mimetype || 'application/octet-stream',
				fileName: msg.message.documentMessage.fileName,
			})
		}

		return {
			id: msg.key.id || `wa_${Date.now()}`,
			channel: 'whatsapp',
			senderId: this.fromJid(senderId),
			senderName: msg.pushName || undefined,
			chatId,
			text,
			timestamp: new Date((msg.messageTimestamp as number) * 1000),
			media: media.length > 0 ? media : undefined,
			isGroup,
			raw: msg,
		}
	}

	// ========================================================================
	// Private: Debouncing
	// ========================================================================

	private debounceMessage(msg: ChannelMessage): void {
		const key = `${msg.chatId}:${msg.senderId}`

		// Add to buffer
		const buffer = this.debounceBuffers.get(key) || []
		buffer.push(msg)
		this.debounceBuffers.set(key, buffer)

		// Reset timer
		const existing = this.debounceTimers.get(key)
		if (existing) clearTimeout(existing)

		this.debounceTimers.set(
			key,
			setTimeout(async () => {
				const messages = this.debounceBuffers.get(key) || []
				this.debounceBuffers.delete(key)
				this.debounceTimers.delete(key)

				if (messages.length === 0) return

				if (messages.length === 1) {
					await this.dispatchMessage(messages[0]!)
				} else {
					// Combine rapid messages into one
					const combined: ChannelMessage = {
						...messages[messages.length - 1]!,
						text: messages.map((m) => m.text).join('\n'),
					}
					await this.dispatchMessage(combined)
				}
			}, this.config.debounceMs),
		)
	}

	private async dispatchMessage(msg: ChannelMessage): Promise<void> {
		for (const handler of this.messageHandlers) {
			try {
				await handler(msg)
			} catch (error) {
				console.error('Error handling WhatsApp message:', error)
			}
		}
	}

	// ========================================================================
	// Private: Helpers
	// ========================================================================

	private checkAccess(senderId: string): boolean {
		if (!this.config.allowedSenders || this.config.allowedSenders.length === 0) {
			return true // Allow all
		}
		return this.config.allowedSenders.includes(senderId)
	}

	private toWhatsAppJid(phoneOrJid: string): string {
		if (phoneOrJid.includes('@')) return phoneOrJid
		// Strip non-numeric characters and add @s.whatsapp.net
		const cleaned = phoneOrJid.replace(/[^\d]/g, '')
		return `${cleaned}@s.whatsapp.net`
	}

	private fromJid(jid: string): string {
		return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '')
	}

	private readSelfId(creds: any): string | null {
		try {
			const me = creds?.me
			if (me?.id) {
				return me.id.replace(/:.*@/, '@').replace('@s.whatsapp.net', '')
			}
		} catch {
			// Ignore
		}
		return null
	}

	private enqueueSaveCreds(saveCreds: () => Promise<void>): void {
		this.credsSaveQueue = this.credsSaveQueue
			.then(async () => {
				// Backup before save
				const credsPath = join(this.authDir, 'creds.json')
				if (existsSync(credsPath)) {
					try {
						const data = readFileSync(credsPath, 'utf-8')
						writeFileSync(`${credsPath}.backup`, data)
					} catch {
						// Ignore backup errors
					}
				}
				await saveCreds()
			})
			.catch((error) => {
				console.error('Error saving WhatsApp credentials:', error)
			})
	}

	private async sendTypingIndicator(jid: string): Promise<void> {
		try {
			await this.socket?.sendPresenceUpdate('composing', jid)
			await new Promise((resolve) => setTimeout(resolve, 500))
			await this.socket?.sendPresenceUpdate('paused', jid)
		} catch {
			// Ignore presence errors
		}
	}

	private async sendMediaMessage(
		jid: string,
		media: MediaAttachment,
		caption?: string,
	): Promise<void> {
		const payload: Record<string, any> = {}

		if (media.type === 'image') {
			payload.image = media.buffer || { url: media.url }
			payload.mimetype = media.mimeType
			if (caption) payload.caption = caption
		} else if (media.type === 'audio') {
			payload.audio = media.buffer || { url: media.url }
			payload.mimetype = media.mimeType
			payload.ptt = true // Push-to-talk
		} else if (media.type === 'video') {
			payload.video = media.buffer || { url: media.url }
			payload.mimetype = media.mimeType
			if (caption) payload.caption = caption
		} else {
			payload.document = media.buffer || { url: media.url }
			payload.mimetype = media.mimeType
			payload.fileName = media.fileName || 'document'
			if (caption) payload.caption = caption
		}

		await this.socket.sendMessage(jid, payload)
	}
}
