import { z } from 'zod/v4'
import {
  buildTool,
  type ToolResult,
  type ToolUseContext,
  type ToolCallProgress,
  type ToolProgressData,
  type Tools,
} from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A single step in a composite tool chain.
 *
 * `inputMapping` maps step-input keys to either:
 *   - a literal JSON value, or
 *   - a JSONPath-like reference into a previous step's output
 *     using the notation `$steps[<index>].<path>`.
 */
const StepSchema = z.object({
  /** Name of the tool to invoke (must be a registered tool). */
  tool: z.string().describe('Name of the tool to invoke'),
  /** Mapping of input parameter names to values or step references. */
  inputMapping: z
    .record(z.string(), z.unknown())
    .describe(
      'Map of input keys to literal values or "$steps[i].path" references',
    ),
})

const InputSchema = z.object({
  /** Human-readable name for this composite operation (used in logs). */
  name: z.string().describe('Human-readable name for this operation'),
  /** What this composite operation does. */
  description: z
    .string()
    .optional()
    .describe('Description of the composite operation'),
  /** Ordered list of tool steps to execute. */
  steps: z
    .array(StepSchema)
    .min(1)
    .describe('Ordered list of tool steps to execute'),
  /**
   * Error handling strategy:
   * - `"stop"` — abort on first tool error (default).
   * - `"continue"` — record the error and proceed to the next step.
   */
  onError: z
    .enum(['stop', 'continue'])
    .optional()
    .describe('Error handling strategy: stop on first error or continue'),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepResult = {
  stepIndex: number
  tool: string
  success: boolean
  output?: unknown
  error?: string
}

type Output = {
  name: string
  totalSteps: number
  completedSteps: number
  results: StepResult[]
  success: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a single value against previous step outputs.
 *
 * Supports the `$steps[<n>].<dotpath>` notation. Anything that doesn't
 * match the pattern is returned verbatim.
 */
function resolveValue(
  value: unknown,
  stepOutputs: Map<number, unknown>,
): unknown {
  if (typeof value !== 'string') return value

  const refMatch = value.match(/^\$steps\[(\d+)\](?:\.(.+))?$/)
  if (!refMatch) return value

  const stepIdx = parseInt(refMatch[1]!, 10)
  const path = refMatch[2]

  const base = stepOutputs.get(stepIdx)
  if (base === undefined) return value
  if (!path) return base

  // Walk the dot-path
  let current: unknown = base
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Build a concrete tool input by resolving all mappings.
 */
function buildStepInput(
  mapping: Record<string, unknown>,
  stepOutputs: Map<number, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mapping)) {
    resolved[key] = resolveValue(value, stepOutputs)
  }
  return resolved
}

/**
 * Look up a tool by name in the available tools list.
 */
function findTool(tools: Tools, name: string) {
  return tools.find(
    t => t.name === name || t.aliases?.includes(name),
  )
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ComposeToolName = 'ComposeTool'

export const ComposeTool = buildTool({
  name: ComposeToolName,
  searchHint: 'chain combine pipeline multi-step workflow',

  inputSchema: InputSchema,
  maxResultSizeChars: 50_000,

  async description() {
    return (
      'Chain multiple tools together into a composite operation. ' +
      'Each step can reference outputs from earlier steps via ' +
      '"$steps[i].path" in inputMapping values. ' +
      'Use onError:"continue" to keep going on failure.'
    )
  },

  async prompt() {
    return [
      'ComposeTool chains existing tools into a single atomic operation.',
      '',
      '## Input',
      '- `name` (string): a label for the composite operation.',
      '- `description` (string, optional): what it does.',
      '- `steps` (array): each element has:',
      '  - `tool` (string): the tool to call.',
      '  - `inputMapping` (object): maps input keys to literal values or',
      '    `$steps[<index>].<dotpath>` references to earlier step outputs.',
      '- `onError` ("stop" | "continue"): default "stop".',
      '',
      '## Output',
      'Returns a JSON object with results from every executed step,',
      'plus overall success/failure.',
      '',
      '## Examples',
      '```json',
      '{',
      '  "name": "read-and-search",',
      '  "steps": [',
      '    { "tool": "Read", "inputMapping": { "file_path": "/tmp/foo.ts" } },',
      '    { "tool": "Grep", "inputMapping": { "pattern": "TODO", "path": "/tmp/foo.ts" } }',
      '  ]',
      '}',
      '```',
    ].join('\n')
  },

  isReadOnly() {
    // Composite operations may include write tools.
    return false
  },

  isConcurrencySafe() {
    return false
  },

  userFacingName(input) {
    return input?.name ? `ComposeTool(${input.name})` : 'ComposeTool'
  },

  async call(
    input: z.infer<typeof InputSchema>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<ToolProgressData>,
  ): Promise<ToolResult<Output>> {
    const { name, steps, onError = 'stop' } = input
    const tools = context.options.tools
    const stepOutputs = new Map<number, unknown>()
    const results: StepResult[] = []
    let overallSuccess = true

    logForDebugging(
      `ComposeTool: starting "${name}" with ${steps.length} step(s)`,
    )

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!
      const tool = findTool(tools, step.tool)

      if (!tool) {
        const error = `Tool "${step.tool}" not found`
        logForDebugging(`ComposeTool step ${i}: ${error}`)
        results.push({ stepIndex: i, tool: step.tool, success: false, error })
        overallSuccess = false
        if (onError === 'stop') break
        continue
      }

      const resolvedInput = buildStepInput(step.inputMapping, stepOutputs)

      // Report progress
      if (onProgress) {
        onProgress({
          toolUseID: context.toolUseId ?? '',
          data: {
            type: 'task_output',
            output: `Step ${i + 1}/${steps.length}: invoking ${step.tool}`,
          } as ToolProgressData,
        })
      }

      try {
        // Validate input if the tool supports it
        if (tool.validateInput) {
          const validation = await tool.validateInput(resolvedInput, context)
          if (!validation.result) {
            const error = `Validation failed: ${validation.message}`
            results.push({
              stepIndex: i,
              tool: step.tool,
              success: false,
              error,
            })
            overallSuccess = false
            if (onError === 'stop') break
            continue
          }
        }

        const result = await tool.call(
          resolvedInput,
          context,
          canUseTool,
          parentMessage,
        )

        stepOutputs.set(i, result.data)
        results.push({
          stepIndex: i,
          tool: step.tool,
          success: true,
          output: result.data,
        })

        logForDebugging(`ComposeTool step ${i}: success`)
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err)
        logForDebugging(`ComposeTool step ${i}: error — ${errorMsg}`)
        results.push({
          stepIndex: i,
          tool: step.tool,
          success: false,
          error: errorMsg,
        })
        overallSuccess = false
        if (onError === 'stop') break
      }
    }

    return {
      data: {
        name,
        totalSteps: steps.length,
        completedSteps: results.length,
        results,
        success: overallSuccess,
      },
    }
  },
})
