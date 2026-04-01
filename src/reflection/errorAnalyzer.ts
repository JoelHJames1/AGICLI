/**
 * Error Analyzer for Claude2 Reflection System.
 *
 * Classifies errors, detects patterns, and suggests alternative approaches
 * based on past experience. This is a key AGI capability — learning from
 * mistakes without human intervention.
 */

import type { ErrorPattern, ErrorType } from './types.js'

// ============================================================================
// Error Classification
// ============================================================================

/** Classification rules for common error patterns. */
const ERROR_CLASSIFIERS: Array<{
	pattern: RegExp
	type: ErrorType
	context: string
}> = [
	// Build/compile errors
	{ pattern: /SyntaxError|Unexpected token|Parse error/i, type: 'syntax_error', context: 'code-generation' },
	{ pattern: /TypeError|Type '.*' is not assignable|TS\d{4}/i, type: 'type_error', context: 'code-generation' },
	{ pattern: /Cannot find module|Module not found|ENOENT/i, type: 'build_failure', context: 'dependency-resolution' },
	{ pattern: /Build failed|Compilation failed|tsc.*error/i, type: 'build_failure', context: 'build-process' },

	// Runtime errors
	{ pattern: /ReferenceError|is not defined|undefined is not/i, type: 'runtime_error', context: 'code-execution' },
	{ pattern: /RangeError|Maximum call stack|out of memory/i, type: 'runtime_error', context: 'resource-management' },
	{ pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i, type: 'api_error', context: 'network' },

	// Test failures
	{ pattern: /test.*fail|expect.*received|assertion.*error|FAIL\s/i, type: 'test_failure', context: 'testing' },
	{ pattern: /jest|vitest|mocha|chai.*assert/i, type: 'test_failure', context: 'testing' },

	// Permission/access
	{ pattern: /EACCES|Permission denied|EPERM/i, type: 'permission_denied', context: 'filesystem' },
	{ pattern: /401|403|Unauthorized|Forbidden/i, type: 'permission_denied', context: 'authentication' },

	// Timeouts
	{ pattern: /timeout|timed out|ETIMEDOUT|deadline exceeded/i, type: 'timeout', context: 'performance' },

	// Resource limits
	{ pattern: /rate limit|429|quota|too many requests/i, type: 'resource_limit', context: 'api-limits' },
	{ pattern: /token.*limit|context.*length|max.*tokens/i, type: 'resource_limit', context: 'context-management' },
]

/**
 * Classify an error message into an ErrorType.
 */
export function classifyError(errorMessage: string): {
	type: ErrorType
	context: string
} {
	for (const classifier of ERROR_CLASSIFIERS) {
		if (classifier.pattern.test(errorMessage)) {
			return { type: classifier.type, context: classifier.context }
		}
	}
	return { type: 'unknown', context: 'unclassified' }
}

// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * Create a normalized signature from an error message.
 * Strips variable parts (line numbers, file paths, specific values)
 * to enable matching similar errors across different contexts.
 */
export function createErrorSignature(errorMessage: string): string {
	return errorMessage
		// Remove file paths
		.replace(/\/[\w\-./]+\.\w+/g, '<PATH>')
		// Remove line:col numbers
		.replace(/:\d+:\d+/g, ':<LINE>')
		// Remove specific variable/function names in quotes
		.replace(/'[^']{20,}'/g, "'<LONG_STRING>'")
		// Remove hex addresses
		.replace(/0x[0-9a-fA-F]+/g, '<ADDR>')
		// Remove UUIDs
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
		// Normalize whitespace
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200) // Cap length
}

/**
 * Find matching error patterns from the knowledge base.
 * Returns patterns sorted by confidence (highest first).
 */
export function findMatchingPatterns(
	errorMessage: string,
	patterns: ErrorPattern[],
): ErrorPattern[] {
	const signature = createErrorSignature(errorMessage)

	return patterns
		.filter((pattern) => {
			try {
				const regex = new RegExp(pattern.errorSignature, 'i')
				return regex.test(signature) || regex.test(errorMessage)
			} catch {
				// Treat as literal match if not valid regex
				return signature.includes(pattern.errorSignature) ||
					errorMessage.includes(pattern.errorSignature)
			}
		})
		.sort((a, b) => b.confidence - a.confidence)
}

// ============================================================================
// Alternative Approach Suggestion
// ============================================================================

/** Built-in recovery strategies for common error types. */
const RECOVERY_STRATEGIES: Record<ErrorType, string[]> = {
	syntax_error: [
		'Re-read the file to see current state before editing again',
		'Use a smaller, more targeted edit instead of rewriting the whole block',
		'Check the language syntax documentation for the specific construct',
	],
	type_error: [
		'Read the type definitions of the involved types',
		'Check if there are existing utility types or helper functions',
		'Use explicit type assertions only as last resort',
	],
	runtime_error: [
		'Add console.log or debugging output to narrow down the issue',
		'Check if variables are initialized before use',
		'Verify function signatures match the calling code',
	],
	test_failure: [
		'Read the test file to understand what is being tested',
		'Run the specific failing test in isolation',
		'Check if the test expectations match the actual implementation',
	],
	build_failure: [
		'Check if all dependencies are installed',
		'Verify import paths are correct',
		'Check tsconfig.json or build config for relevant settings',
	],
	permission_denied: [
		'Ask the user to approve the action with more context',
		'Try an alternative approach that doesn\'t require the denied permission',
		'Check if there\'s a less privileged way to accomplish the goal',
	],
	api_error: [
		'Retry the request after a brief delay',
		'Check if the API endpoint is correct',
		'Verify authentication credentials are valid',
	],
	timeout: [
		'Break the operation into smaller chunks',
		'Increase the timeout if the operation is expected to be slow',
		'Try a different approach that avoids the slow operation',
	],
	resource_limit: [
		'Reduce context size by summarizing or truncating',
		'Use a smaller/cheaper model for this sub-task',
		'Break the task into smaller pieces that fit within limits',
	],
	wrong_approach: [
		'Re-read the requirements and start with a fresh approach',
		'Search the codebase for existing patterns that solve similar problems',
		'Ask the user for clarification on the expected approach',
	],
	partial_success: [
		'Complete the remaining steps one at a time',
		'Verify the completed parts work correctly before continuing',
		'Check if the partial result can be used as-is',
	],
	unknown: [
		'Read the error message carefully for clues',
		'Search the codebase for similar patterns',
		'Try a completely different approach',
	],
}

/**
 * Suggest recovery strategies for a given error.
 * Combines learned patterns with built-in strategies.
 */
export function suggestRecovery(
	errorMessage: string,
	learnedPatterns: ErrorPattern[],
): {
	errorType: ErrorType
	learnedApproach: string | null
	builtInStrategies: string[]
	confidence: number
} {
	const { type } = classifyError(errorMessage)
	const matchingPatterns = findMatchingPatterns(errorMessage, learnedPatterns)

	const bestPattern = matchingPatterns[0]

	return {
		errorType: type,
		learnedApproach: bestPattern?.successfulApproach ?? null,
		builtInStrategies: RECOVERY_STRATEGIES[type] || RECOVERY_STRATEGIES.unknown,
		confidence: bestPattern?.confidence ?? 0,
	}
}

// ============================================================================
// Pattern Learning
// ============================================================================

/**
 * Create or update an error pattern based on a resolved error.
 */
export function learnFromResolution(
	errorMessage: string,
	failedApproach: string,
	successfulApproach: string,
	existingPatterns: ErrorPattern[],
): ErrorPattern {
	const signature = createErrorSignature(errorMessage)
	const { context } = classifyError(errorMessage)

	// Check if we already have a matching pattern
	const existing = existingPatterns.find(
		(p) => p.errorSignature === signature,
	)

	if (existing) {
		// Update existing pattern
		return {
			...existing,
			successfulApproach,
			confidence: existing.confidence + 1,
			lastSeen: new Date().toISOString(),
		}
	}

	// Create new pattern
	return {
		id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		errorSignature: signature,
		context,
		failedApproach,
		successfulApproach,
		confidence: 1,
		lastSeen: new Date().toISOString(),
		firstSeen: new Date().toISOString(),
	}
}
