/**
 * BrowserTool — headless browser capability for web interaction.
 *
 * Uses Playwright (dynamically imported) to navigate pages, click elements,
 * type text, take screenshots, extract readable content, and execute
 * arbitrary JavaScript. Fails gracefully when Playwright is not installed.
 */

import * as path from 'path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_NAME = 'Browser'

const DESCRIPTION = [
  'Interact with web pages using a headless browser.',
  'Supports navigating to URLs, clicking elements, typing text,',
  'taking screenshots, extracting page content, and executing JavaScript.',
  'Requires Playwright to be installed (`bun add playwright`).',
].join(' ')

/** Default timeout for each browser action (ms). */
const ACTION_TIMEOUT_MS = 30_000

/** Directory for screenshot output (relative to cwd). */
const SCREENSHOT_DIR = '.claude2/screenshots'

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'navigate',
        'click',
        'type',
        'screenshot',
        'extract',
        'execute_js',
      ])
      .describe('The browser action to perform'),
    url: z
      .string()
      .optional()
      .describe('URL to navigate to (required for "navigate" action)'),
    selector: z
      .string()
      .optional()
      .describe(
        'CSS selector for the target element (required for "click" and "type" actions)',
      ),
    text: z
      .string()
      .optional()
      .describe('Text to type (required for "type" action)'),
    script: z
      .string()
      .optional()
      .describe('JavaScript code to execute (required for "execute_js" action)'),
    timeout: z
      .number()
      .optional()
      .describe(
        `Timeout in milliseconds for the action (default: ${ACTION_TIMEOUT_MS})`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// ---------------------------------------------------------------------------
// BrowserManager singleton — manages the Playwright browser lifecycle
// ---------------------------------------------------------------------------

interface PlaywrightTypes {
  chromium: {
    launch(opts?: Record<string, unknown>): Promise<unknown>
  }
}

class BrowserManager {
  private static instance: BrowserManager | null = null
  private browser: unknown = null
  private page: unknown = null
  private playwrightModule: PlaywrightTypes | null = null
  private initError: string | null = null

  static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager()
    }
    return BrowserManager.instance
  }

  /**
   * Dynamically import Playwright. Returns null and sets initError if
   * the package is not installed.
   */
  private async loadPlaywright(): Promise<PlaywrightTypes | null> {
    if (this.playwrightModule) return this.playwrightModule
    if (this.initError) return null

    try {
      // Dynamic import so the tool loads even without Playwright installed
      const pw = (await import('playwright')) as unknown as PlaywrightTypes
      this.playwrightModule = pw
      return pw
    } catch {
      this.initError =
        'Playwright is not installed. Run `bun add playwright` to enable the Browser tool.'
      return null
    }
  }

  /** Get (or launch) the browser and return the active page. */
  async getPage(): Promise<{ page: unknown; error?: string }> {
    const pw = await this.loadPlaywright()
    if (!pw) return { page: null, error: this.initError! }

    try {
      if (!this.browser) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.browser = await (pw.chromium as any).launch({ headless: true })
      }
      if (!this.page) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = await (this.browser as any).newContext({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        })
        this.page = await ctx.newPage()
      }
      return { page: this.page }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { page: null, error: `Failed to launch browser: ${msg}` }
    }
  }

  /** Close the browser and reset state. */
  async close(): Promise<void> {
    try {
      if (this.browser) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (this.browser as any).close()
      }
    } catch {
      // best-effort
    } finally {
      this.browser = null
      this.page = null
    }
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

type ActionResult = {
  success: boolean
  content?: string
  screenshotPath?: string
  error?: string
}

async function handleNavigate(
  page: unknown,
  url: string,
  timeout: number,
): Promise<ActionResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title: string = await (page as any).title()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUrl: string = (page as any).url()
    return {
      success: true,
      content: `Navigated to "${title}" (${currentUrl})`,
    }
  } catch (e) {
    return { success: false, error: `Navigation failed: ${errorMsg(e)}` }
  }
}

async function handleClick(
  page: unknown,
  selector: string,
  timeout: number,
): Promise<ActionResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).click(selector, { timeout })
    return { success: true, content: `Clicked element: ${selector}` }
  } catch (e) {
    return {
      success: false,
      error: `Click failed on "${selector}": ${errorMsg(e)}`,
    }
  }
}

async function handleType(
  page: unknown,
  selector: string,
  text: string,
  timeout: number,
): Promise<ActionResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).fill(selector, text, { timeout })
    return {
      success: true,
      content: `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" into ${selector}`,
    }
  } catch (e) {
    return {
      success: false,
      error: `Type failed on "${selector}": ${errorMsg(e)}`,
    }
  }
}

async function handleScreenshot(page: unknown): Promise<ActionResult> {
  try {
    const { mkdir } = await import('fs/promises')
    const dir = path.resolve(getCwd(), SCREENSHOT_DIR)
    await mkdir(dir, { recursive: true })

    const filename = `screenshot-${Date.now()}.png`
    const filePath = path.join(dir, filename)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (page as any).screenshot({ path: filePath, fullPage: true })
    return {
      success: true,
      content: `Screenshot saved`,
      screenshotPath: filePath,
    }
  } catch (e) {
    return { success: false, error: `Screenshot failed: ${errorMsg(e)}` }
  }
}

async function handleExtract(page: unknown): Promise<ActionResult> {
  try {
    // Extract readable text content from the page
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: string = await (page as any).evaluate(() => {
      // Remove script and style elements, then grab text
      const clone = document.cloneNode(true) as Document
      for (const el of clone.querySelectorAll(
        'script, style, noscript, svg, nav, footer, header',
      )) {
        el.remove()
      }
      const body = clone.querySelector('body')
      if (!body) return document.title || ''
      // Collapse whitespace
      return (body.textContent ?? '')
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })

    // Truncate to a reasonable length
    const maxLen = 50_000
    const truncated = text.length > maxLen ? text.slice(0, maxLen) + '\n[truncated]' : text
    return { success: true, content: truncated }
  } catch (e) {
    return { success: false, error: `Content extraction failed: ${errorMsg(e)}` }
  }
}

async function handleExecuteJs(
  page: unknown,
  script: string,
  timeout: number,
): Promise<ActionResult> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await Promise.race([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (page as any).evaluate(script),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Script execution timed out')), timeout),
      ),
    ])
    const serialized =
      typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    return { success: true, content: serialized ?? '(undefined)' }
  } catch (e) {
    return { success: false, error: `JS execution failed: ${errorMsg(e)}` }
  }
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const BrowserTool = buildTool({
  name: BROWSER_TOOL_NAME,
  searchHint: 'headless browser web page navigate click screenshot',

  async description() {
    return DESCRIPTION
  },

  userFacingName() {
    return 'Browser'
  },

  getToolUseSummary(input) {
    if (input.action === 'navigate' && input.url) {
      return `navigate to ${input.url}`
    }
    return input.action
  },

  getActivityDescription(input) {
    switch (input.action) {
      case 'navigate':
        return `Navigating to ${input.url ?? 'URL'}`
      case 'click':
        return `Clicking ${input.selector ?? 'element'}`
      case 'type':
        return `Typing into ${input.selector ?? 'element'}`
      case 'screenshot':
        return 'Taking screenshot'
      case 'extract':
        return 'Extracting page content'
      case 'execute_js':
        return 'Executing JavaScript'
      default:
        return 'Browser action'
    }
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isReadOnly(input) {
    return input.action === 'screenshot' || input.action === 'extract'
  },

  isEnabled() {
    return true
  },

  isConcurrencySafe() {
    // Browser actions are sequential by nature (single page)
    return false
  },

  async validateInput(input): Promise<{ result: true } | { result: false; message: string; errorCode: number }> {
    const { action, url, selector, text, script } = input
    switch (action) {
      case 'navigate':
        if (!url) {
          return {
            result: false,
            message: 'The "url" field is required for the "navigate" action.',
            errorCode: 1,
          }
        }
        break
      case 'click':
        if (!selector) {
          return {
            result: false,
            message:
              'The "selector" field is required for the "click" action.',
            errorCode: 2,
          }
        }
        break
      case 'type':
        if (!selector || text === undefined) {
          return {
            result: false,
            message:
              'Both "selector" and "text" fields are required for the "type" action.',
            errorCode: 3,
          }
        }
        break
      case 'execute_js':
        if (!script) {
          return {
            result: false,
            message:
              'The "script" field is required for the "execute_js" action.',
            errorCode: 4,
          }
        }
        break
    }
    return { result: true }
  },

  async call(input) {
    const { action, url, selector, text, script, timeout } = input
    const effectiveTimeout = timeout ?? ACTION_TIMEOUT_MS
    const manager = BrowserManager.getInstance()

    const { page, error } = await manager.getPage()
    if (!page || error) {
      return {
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: error ?? 'Failed to initialize browser.',
          },
        ],
      }
    }

    let result: ActionResult

    switch (action) {
      case 'navigate':
        result = await handleNavigate(page, url!, effectiveTimeout)
        break
      case 'click':
        result = await handleClick(page, selector!, effectiveTimeout)
        break
      case 'type':
        result = await handleType(page, selector!, text!, effectiveTimeout)
        break
      case 'screenshot':
        result = await handleScreenshot(page)
        break
      case 'extract':
        result = await handleExtract(page)
        break
      case 'execute_js':
        result = await handleExecuteJs(page, script!, effectiveTimeout)
        break
      default:
        result = { success: false, error: `Unknown action: ${action}` }
    }

    const parts: string[] = []
    if (result.success) {
      if (result.content) parts.push(result.content)
      if (result.screenshotPath) parts.push(`Path: ${result.screenshotPath}`)
    } else {
      parts.push(`Error: ${result.error}`)
    }

    return {
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text: parts.join('\n') }],
    }
  },
})

// ---------------------------------------------------------------------------
// Cleanup hook — close the browser on process exit
// ---------------------------------------------------------------------------

if (typeof process !== 'undefined') {
  const cleanup = () => {
    BrowserManager.getInstance()
      .close()
      .catch(() => {})
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
