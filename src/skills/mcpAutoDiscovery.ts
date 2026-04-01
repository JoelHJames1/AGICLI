import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { logForDebugging } from '../utils/debug.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata for a known MCP server in the registry. */
export type MCPServerInfo = {
  /** Human-readable name (e.g. "GitHub MCP Server"). */
  name: string
  /** npm package name used to install/run the server. */
  npmPackage: string
  /** One-line description of the server. */
  description: string
  /** Capabilities/keywords the server provides. */
  capabilities: string[]
  /** Default command to start the server (npx invocation). */
  command: string
  /** Default CLI args. */
  args?: string[]
}

/** Suggestion returned to the caller with relevance info. */
export type MCPServerSuggestion = {
  server: MCPServerInfo
  /** Why this server was suggested. */
  reason: string
  /** Rough relevance score (higher is better). */
  score: number
}

// ---------------------------------------------------------------------------
// Well-known MCP server registry
// ---------------------------------------------------------------------------

/**
 * Curated list of well-known MCP servers. New entries can be added here as
 * the ecosystem grows. Capability strings are lower-cased keywords used for
 * matching against user queries.
 */
const WELL_KNOWN_SERVERS: MCPServerInfo[] = [
  {
    name: 'GitHub',
    npmPackage: '@modelcontextprotocol/server-github',
    description: 'Interact with GitHub repositories, issues, PRs, and actions.',
    capabilities: ['github', 'git', 'repository', 'issues', 'pull requests', 'code review'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    name: 'Filesystem',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    description: 'Sandboxed filesystem access for reading and writing files.',
    capabilities: ['filesystem', 'files', 'directories', 'read', 'write'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    name: 'PostgreSQL',
    npmPackage: '@modelcontextprotocol/server-postgres',
    description: 'Query and manage PostgreSQL databases.',
    capabilities: ['postgres', 'postgresql', 'database', 'sql', 'query'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
  },
  {
    name: 'Slack',
    npmPackage: '@modelcontextprotocol/server-slack',
    description: 'Send messages, read channels, and manage Slack workspaces.',
    capabilities: ['slack', 'messaging', 'chat', 'channels', 'notifications'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
  },
  {
    name: 'Google Drive',
    npmPackage: '@modelcontextprotocol/server-gdrive',
    description: 'Access and manage files in Google Drive.',
    capabilities: ['google drive', 'gdrive', 'documents', 'spreadsheets', 'cloud storage'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
  },
  {
    name: 'Brave Search',
    npmPackage: '@modelcontextprotocol/server-brave-search',
    description: 'Web search via the Brave Search API.',
    capabilities: ['search', 'web search', 'brave', 'internet', 'lookup'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
  },
  {
    name: 'Puppeteer',
    npmPackage: '@modelcontextprotocol/server-puppeteer',
    description: 'Browser automation — navigate pages, take screenshots, extract data.',
    capabilities: ['browser', 'puppeteer', 'web scraping', 'screenshot', 'automation'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },
  {
    name: 'SQLite',
    npmPackage: '@modelcontextprotocol/server-sqlite',
    description: 'Query and manage SQLite databases.',
    capabilities: ['sqlite', 'database', 'sql', 'local database'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
  },
  {
    name: 'Memory / Knowledge Graph',
    npmPackage: '@modelcontextprotocol/server-memory',
    description: 'Persistent memory via a local knowledge graph.',
    capabilities: ['memory', 'knowledge graph', 'remember', 'persistent state', 'notes'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  {
    name: 'Fetch',
    npmPackage: '@modelcontextprotocol/server-fetch',
    description: 'Fetch URLs and convert HTML to markdown for the model.',
    capabilities: ['fetch', 'http', 'url', 'download', 'web page'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  },
  {
    name: 'Sentry',
    npmPackage: '@modelcontextprotocol/server-sentry',
    description: 'Query Sentry for error tracking and performance data.',
    capabilities: ['sentry', 'errors', 'monitoring', 'crash reports', 'performance'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
  },
  {
    name: 'Linear',
    npmPackage: '@modelcontextprotocol/server-linear',
    description: 'Manage Linear issues, projects, and workflows.',
    capabilities: ['linear', 'issues', 'project management', 'tickets', 'sprints'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-linear'],
  },
  {
    name: 'Docker',
    npmPackage: '@modelcontextprotocol/server-docker',
    description: 'Manage Docker containers, images, and volumes.',
    capabilities: ['docker', 'containers', 'images', 'devops', 'deployment'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-docker'],
  },
  {
    name: 'Notion',
    npmPackage: '@modelcontextprotocol/server-notion',
    description: 'Read and write Notion pages, databases, and blocks.',
    capabilities: ['notion', 'wiki', 'documentation', 'notes', 'knowledge base'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notion'],
  },
  {
    name: 'Cloudflare',
    npmPackage: '@modelcontextprotocol/server-cloudflare',
    description: 'Manage Cloudflare Workers, KV, R2, and DNS.',
    capabilities: ['cloudflare', 'workers', 'cdn', 'dns', 'edge computing'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-cloudflare'],
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple word-level tokenisation and lowercasing. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Score a server against a set of query tokens. */
function scoreServer(server: MCPServerInfo, queryTokens: string[]): number {
  let score = 0
  const capTokens = server.capabilities.flatMap(c => tokenise(c))
  const descTokens = tokenise(server.description)
  const nameTokens = tokenise(server.name)

  for (const qt of queryTokens) {
    // Exact capability match is worth the most.
    if (capTokens.includes(qt)) score += 3
    // Name match.
    if (nameTokens.includes(qt)) score += 2
    // Description match.
    if (descTokens.includes(qt)) score += 1
  }
  return score
}

/**
 * Default path for the Claude2 MCP config file.
 */
function getMcpConfigPath(): string {
  const home = process.env.HOME ?? '~'
  return join(home, '.claude2', 'mcp.json')
}

// ---------------------------------------------------------------------------
// MCPAutoDiscovery
// ---------------------------------------------------------------------------

/**
 * Auto-discover and install MCP servers when the agent needs capabilities
 * that are not available through its current tool set.
 *
 * The class maintains a local registry of well-known servers and matches
 * them against natural-language capability descriptions. Installation
 * writes to `~/.claude2/mcp.json`.
 */
export class MCPAutoDiscovery {
  private readonly registry: MCPServerInfo[]
  private readonly configPath: string
  /** Cache of installed server names (populated on first `hasCapability` call). */
  private installedNames: Set<string> | null = null

  constructor(
    opts: { registry?: MCPServerInfo[]; configPath?: string } = {},
  ) {
    this.registry = opts.registry ?? WELL_KNOWN_SERVERS
    this.configPath = opts.configPath ?? getMcpConfigPath()
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Search the registry for servers that can satisfy a given capability
   * description. Returns matches sorted by relevance.
   *
   * @param capability  Free-text description of the needed capability
   *                    (e.g. "query a postgres database").
   */
  async searchServers(capability: string): Promise<MCPServerInfo[]> {
    const tokens = tokenise(capability)
    const scored = this.registry
      .map(server => ({ server, score: scoreServer(server, tokens) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.map(({ server }) => server)
  }

  /**
   * Install an MCP server by appending its configuration to the Claude2
   * MCP config file (`~/.claude2/mcp.json`).
   */
  async installServer(server: MCPServerInfo): Promise<void> {
    const configDir = dirname(this.configPath)
    await mkdir(configDir, { recursive: true })

    let config: Record<string, unknown> = {}
    try {
      const raw = await readFile(this.configPath, 'utf8')
      config = JSON.parse(raw) as Record<string, unknown>
    } catch {
      // File doesn't exist or is invalid — start fresh.
    }

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>
    const key = server.name.toLowerCase().replace(/\s+/g, '-')

    if (servers[key]) {
      logForDebugging(`MCP server "${server.name}" is already configured`)
      return
    }

    servers[key] = {
      command: server.command,
      args: server.args ?? [],
      description: server.description,
      npmPackage: server.npmPackage,
    }

    config.mcpServers = servers
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8')
    logForDebugging(`Installed MCP server "${server.name}" → ${this.configPath}`)

    // Invalidate cache.
    this.installedNames = null
  }

  /**
   * Check whether a capability is likely covered by an already-installed
   * MCP server.
   */
  hasCapability(capability: string): boolean {
    const installed = this.getInstalledNamesSync()
    const tokens = tokenise(capability)

    for (const server of this.registry) {
      const key = server.name.toLowerCase().replace(/\s+/g, '-')
      if (!installed.has(key)) continue
      if (scoreServer(server, tokens) > 0) return true
    }
    return false
  }

  /**
   * Given a free-text task description, suggest MCP servers that could
   * help accomplish it. Returns suggestions sorted by relevance score.
   */
  async suggestServers(taskDescription: string): Promise<MCPServerSuggestion[]> {
    const tokens = tokenise(taskDescription)
    const installed = this.getInstalledNamesSync()

    const suggestions: MCPServerSuggestion[] = []

    for (const server of this.registry) {
      const key = server.name.toLowerCase().replace(/\s+/g, '-')
      if (installed.has(key)) continue // Already installed.

      const score = scoreServer(server, tokens)
      if (score <= 0) continue

      suggestions.push({
        server,
        reason: `"${server.name}" can provide: ${server.capabilities.join(', ')}`,
        score,
      })
    }

    suggestions.sort((a, b) => b.score - a.score)
    return suggestions
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  /**
   * Synchronously return the set of installed server keys. Reads the config
   * file on first call and caches the result.
   */
  private getInstalledNamesSync(): Set<string> {
    if (this.installedNames) return this.installedNames

    const names = new Set<string>()
    try {
      // Bun supports synchronous readFileSync even though we import from
      // 'fs/promises'. Use a dynamic require to keep the rest async-clean.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs')
      const raw = fs.readFileSync(this.configPath, 'utf8')
      const config = JSON.parse(raw) as Record<string, unknown>
      const servers = (config.mcpServers ?? {}) as Record<string, unknown>
      for (const key of Object.keys(servers)) {
        names.add(key)
      }
    } catch {
      // Config file doesn't exist yet — nothing installed.
    }

    this.installedNames = names
    return names
  }
}
