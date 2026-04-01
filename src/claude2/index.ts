/**
 * Claude2 — AGI-Oriented Autonomous Agent CLI
 *
 * Built on the Claude Code foundation, Claude2 adds:
 * - Multi-LLM provider support (Anthropic, OpenAI, Gemini, Ollama)
 * - Smart model routing (best model per task)
 * - Reflection & self-correction (learn from mistakes)
 * - Strategic planning (long-horizon goals with backtracking)
 * - Dynamic skill creation (auto-generate reusable workflows)
 * - Proactive watchers (monitor files, git, CI, issues)
 * - Code knowledge graph (impact analysis before changes)
 * - Self-improvement pipeline (compound learning over time)
 */

// Core bootstrap
export {
	getClaude2,
	getClaude2Info,
	initializeClaude2,
	isClaude2Initialized,
} from './bootstrap.js'

// Configuration
export {
	clearConfigCache,
	getClaude2Dir,
	getConfigPath,
	loadConfig,
	resetConfig,
	saveConfig,
	updateConfig,
} from './config.js'

export type { Claude2Config } from './config.js'

// Re-export key subsystem entry points
export * from '../providers/index.js'
export * from '../reflection/index.js'
export * from '../planner/index.js'
