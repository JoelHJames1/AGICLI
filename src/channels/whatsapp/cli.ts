#!/usr/bin/env bun
/**
 * Claude2 WhatsApp CLI — Start the WhatsApp bridge from the terminal.
 *
 * Usage:
 *   claude2 --whatsapp          # Start WhatsApp bridge
 *   claude2 --whatsapp --qr     # Just show QR code, don't start bridge
 *
 * On first run, displays a QR code to scan with WhatsApp.
 * Once authenticated, messages sent to the WhatsApp number
 * are routed to Claude2's active LLM provider.
 */

import { WhatsAppChannel } from './WhatsAppChannel.js'
import { WhatsAppBridge } from './WhatsAppBridge.js'
import { initializeClaude2 } from '../../claude2/bootstrap.js'
import type { WhatsAppChannelConfig } from '../types.js'

// ============================================================================
// Terminal QR Code Rendering
// ============================================================================

/**
 * Render a QR code data URL as Unicode blocks in the terminal.
 * Falls back to showing the data URL if qrcode-terminal isn't available.
 */
async function renderQRInTerminal(qrString: string): Promise<void> {
	// Use qrcode library to generate terminal-friendly output
	try {
		const QRCode = await import('qrcode')
		const terminalQR = await QRCode.toString(qrString, {
			type: 'terminal',
			small: true,
		})
		console.log('')
		console.log(terminalQR)
		console.log('')
	} catch {
		// Fallback: just show the QR string for manual handling
		console.log(`\nQR Data: ${qrString}\n`)
		console.log('Install qrcode package for terminal QR display: bun add qrcode')
	}
}

// ============================================================================
// Main
// ============================================================================

export async function startWhatsAppCLI(options: {
	qrOnly?: boolean
	allowedSenders?: string[]
	model?: string
	systemPrompt?: string
} = {}): Promise<void> {
	console.log('╔══════════════════════════════════════════════╗')
	console.log('║       Claude2 — WhatsApp Bridge              ║')
	console.log('║       AGI-Oriented Autonomous Agent          ║')
	console.log('╚══════════════════════════════════════════════╝')
	console.log('')

	// Initialize Claude2 subsystems
	console.log('⏳ Initializing Claude2...')
	const claude2 = await initializeClaude2({
		sessionId: `whatsapp-${Date.now()}`,
		projectSlug: 'whatsapp-bridge',
		enableReflection: true,
		enablePlanner: false, // Don't need planner for WhatsApp
	})
	console.log(`✅ Provider: ${claude2.provider.name} (${claude2.providerType})`)
	console.log(`✅ Model: ${claude2.providerConfig.model}`)
	console.log('')

	// Create WhatsApp channel
	const channelConfig: WhatsAppChannelConfig = {
		enabled: true,
		allowedSenders: options.allowedSenders || [],
		sendReadReceipts: true,
		debounceMs: 1500,
		maxMediaSize: 10 * 1024 * 1024, // 10MB
	}

	const channel = new WhatsAppChannel(channelConfig)

	// Set up QR handler for terminal display
	channel.onQR(async (qr: string) => {
		console.log('📱 Scan this QR code with WhatsApp:')
		console.log('   Open WhatsApp → Settings → Linked Devices → Link a Device')
		console.log('')
		await renderQRInTerminal(qr)
		console.log('⏳ Waiting for scan...')
	})

	// Set up connection handler
	channel.onConnectionUpdate((status: string) => {
		switch (status) {
			case 'open':
				console.log('')
				console.log('✅ WhatsApp connected!')
				console.log(`📞 Self ID: ${channel.getSelfId() || 'unknown'}`)
				console.log('')
				if (options.qrOnly) {
					console.log('QR-only mode — exiting.')
					process.exit(0)
				}
				console.log('🤖 Claude2 is now listening for WhatsApp messages.')
				console.log('   Send a message to start chatting!')
				console.log('   Commands: /help, /status, /reset, /model')
				console.log('')
				console.log('   Press Ctrl+C to stop.')
				console.log('')
				break
			case 'close':
				console.log('❌ WhatsApp disconnected.')
				break
			case 'connecting':
				console.log('🔄 Connecting to WhatsApp...')
				break
		}
	})

	// Create the bridge (connects WhatsApp messages to LLM)
	const bridge = new WhatsAppBridge(channel, claude2.provider, {
		model: options.model || claude2.providerConfig.model,
		systemPrompt: options.systemPrompt,
		maxContextMessages: 50,
		maxTokens: 4096,
	})

	// Connect
	console.log('🔄 Starting WhatsApp connection...')
	await channel.connect()

	// Keep alive
	const shutdown = async () => {
		console.log('\n🛑 Shutting down Claude2 WhatsApp bridge...')
		await channel.disconnect()
		await claude2.shutdown()
		console.log('👋 Goodbye!')
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	// Keep the process alive
	await new Promise(() => {}) // Never resolves — runs until killed
}

// ============================================================================
// Direct execution
// ============================================================================

if (import.meta.main) {
	startWhatsAppCLI().catch((err) => {
		console.error('Fatal error:', err)
		process.exit(1)
	})
}
