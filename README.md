<div align="center">

# Claude2 — AGI-Oriented Autonomous Agent CLI

**A next-generation autonomous coding agent that learns, plans, self-improves, and operates across multiple LLM providers.**

[![TypeScript](https://img.shields.io/badge/TypeScript-580K%2B_lines-3178C6?logo=typescript&logoColor=white)](#tech-stack)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f472b6?logo=bun&logoColor=white)](#tech-stack)
[![Claude Opus 4.6](https://img.shields.io/badge/Default_Model-Claude_Opus_4.6-cc785c?logo=anthropic&logoColor=white)](#multi-llm-provider-system)
[![Multi-LLM](https://img.shields.io/badge/Providers-5%2B_LLMs-green)](#multi-llm-provider-system)
[![WhatsApp](https://img.shields.io/badge/Channel-WhatsApp-25D366?logo=whatsapp&logoColor=white)](#whatsapp-integration)
</div>

---

## What is Claude2?

Claude2 is a fork of Claude Code transformed into an **AGI-oriented autonomous agent**. It goes beyond any existing coding CLI by adding self-improvement, multi-model orchestration, autonomous operation, strategic planning with backtracking, and dynamic capability expansion.

While tools like Claude Code, Cursor, and Copilot are reactive (you ask, they answer), Claude2 is **proactive** — it watches your codebase, learns from its mistakes, creates its own tools, and gets better over time without human intervention.

### What Makes It Different

| Capability | Claude Code | Cursor / Copilot | Claude2 |
|---|:---:|:---:|:---:|
| Multi-LLM routing (best model per task) | - | - | Yes |
| Learns from its own errors | - | - | Yes |
| Creates its own tools/skills | - | - | Yes |
| Strategic planning with backtracking | - | - | Yes |
| Autonomous background operation | - | - | Yes |
| Self-improvement pipeline | - | - | Yes |
| WhatsApp integration | - | - | Yes |
| Code knowledge graph | - | - | Yes |
| Cross-session strategy learning | - | - | Yes |

---

## Table of Contents

- [Architecture](#architecture)
- [Multi-LLM Provider System](#1-multi-llm-provider-system)
- [Reflection Engine](#2-reflection-engine)
- [Strategic Planner](#3-strategic-planner)
- [Dynamic Skill & Tool Creation](#4-dynamic-skill--tool-creation)
- [Watcher & Daemon System](#5-watcher--daemon-system)
- [Code Knowledge Graph](#6-code-knowledge-graph)
- [Self-Improvement Pipeline](#7-self-improvement-pipeline)
- [WhatsApp Integration](#whatsapp-integration)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [New Files Created](#new-files-created)
- [Tech Stack](#tech-stack)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 USER / WHATSAPP / WATCHERS                   │
└──────────────────────┬──────────────────────────────────────┘
                       │ task / message / event
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    AGI Agent Core                            │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Router   │  │ Planner   │  │ Executor │  │ Reflector │  │
│  │ (model)  │  │ (strategy)│  │ (action) │  │ (learn)   │  │
│  └─────┬────┘  └─────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│        └──────────────┴─────────────┴──────────────┘        │
├─────────────────────────────────────────────────────────────┤
│  Multi-Model Router (best model per task)                    │
│  ┌─────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌───────────────┐  │
│  │Anthropic│ │OpenAI│ │Gemini│ │Ollama│ │OpenAI-Compat  │  │
│  │Opus 4.6 │ │GPT-4o│ │Flash │ │Local │ │Groq/Together  │  │
│  └─────────┘ └──────┘ └──────┘ └──────┘ └───────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Capability Layer                                            │
│  Tools | Skills | MCP | Browser | LSP | Bash | Memory       │
├─────────────────────────────────────────────────────────────┤
│  Channels                                                    │
│  CLI | WhatsApp | (Telegram, Discord, Slack — planned)       │
└─────────────────────────────────────────────────────────────┘
```

### The AGI Loop

Every task flows through this cycle:

```
Task arrives
  → Smart Model Router: "Which AI handles this best?"
    → Strategic Planner: "Break into subtask DAG, check existing goals"
      → Reflection Engine: "What worked last time? Inject learned context"
        → Execute (LLM + Tools)
          → Reflect on outcome: Success? Learn. Fail? Pivot.
            → Self-Improvement: Track metrics, evolve prompts, generate skills
```

---

## AGI Subsystems

### 1. Multi-LLM Provider System

> `src/providers/` — 18 files, ~3,400 lines

Not locked to one model. Routes each task to the **optimal model** based on what it needs:

| Task Type | Default Model | Why |
|---|---|---|
| Coding | Claude Opus 4.6 | Best code generation and tool use |
| Reasoning | Claude Opus 4.6 / o3 | Strongest logical reasoning |
| Fast response | Claude Haiku 4.5 | Speed and cost |
| Long context | Gemini 2.5 Flash | 1M token context window |
| Local/private | Ollama (any) | Data never leaves machine |
| Cost-optimized | Haiku / GPT-4o-mini | Cheapest capable model |

**Supported providers:**

| Provider | Adapter | Features |
|---|---|---|
| **Anthropic** | `src/providers/anthropic/` | Passthrough (native format), Bedrock/Vertex/Foundry variants |
| **OpenAI** | `src/providers/openai/` | SSE streaming, tool_calls translation, tool_choice mapping |
| **Gemini** | `src/providers/gemini/` | REST API, functionCall/functionResponse translation |
| **Ollama** | `src/providers/ollama/` | Extends OpenAI-compatible, auto-appends /v1, model listing |
| **OpenAI-Compatible** | `src/providers/openai-compatible/` | Groq, Together, LiteLLM, vLLM, Fireworks |

Each provider has a **message adapter** that translates between provider-specific formats and Claude2's internal format (which mirrors Anthropic's for minimal refactor of the existing 30+ tool files).

**Key files:**
- `src/providers/LLMProvider.ts` — Core interface: `createMessage()`, `createMessageStream()`, `getCapabilities()`
- `src/providers/router.ts` — Smart routing with task classification and provider ranking
- `src/providers/registry.ts` — Auto-detection from env vars with priority chain
- `src/providers/capabilities.ts` — Per-provider capability matrix with model-specific overrides

---

### 2. Reflection Engine

> `src/reflection/` — 5 files, ~1,100 lines

The agent **learns from every action it takes**. After each tool execution:

```
Action: Ran "npm test"
Result: Failed — "TypeError: Cannot read property 'map' of undefined"

Reflection Engine:
  1. Creates error signature (normalized hash)
  2. Checks learned error patterns: "Have I seen this before?"
     → YES: "Last time, fix was: check if array is initialized before mapping"
     → NO: Records for future learning
  3. Tracks consecutive failures — after 3, says "PIVOT to different approach"
  4. When retry succeeds: stores the resolution permanently
```

**Error pattern learning** — When a retry succeeds after a failure, `learnFromResolution()` stores:
- Error signature (normalized, paths/UUIDs stripped)
- What failed
- What worked instead
- Confidence score (increments with each confirmation)

**Strategy tracking** — Classifies tasks into 12 categories and tracks which approaches work best:
- Composite score: 70% success rate + 20% efficiency + 10% recency
- Before each task, recommends the best-known strategy
- Occasionally explores new approaches (exploration vs exploitation)

**Prompt augmentation** — Before each task, `getPromptContext()` injects learned knowledge into the system prompt:
```
## Reflection Context (Learned from past sessions)
### Known Error Patterns:
- When seeing "ENOENT: no such file..." → Try: check path exists (confidence: 5)
### Recommended approach for bug-fix: "read-test-fix-test" (87% success, 23 attempts)
```

**Key files:**
- `src/reflection/ReflectionEngine.ts` — Core engine with `recordOutcome()`, `learnFromResolution()`, `getPromptContext()`
- `src/reflection/errorAnalyzer.ts` — 12 error classifiers, signature normalization, recovery suggestions
- `src/reflection/strategyTracker.ts` — Task categorization, strategy ranking, exploration flag

---

### 3. Strategic Planner

> `src/planner/` — 4 files, ~600 lines

For complex goals, Claude2 doesn't just wing it — it creates a **dependency graph** and executes with checkpoints:

```
User: "Build a REST API with auth and tests"

Planner creates DAG:
  task_1: Set up Express + TypeScript     [no deps]        → coding-agent
  task_2: Implement JWT auth              [depends: 1]     → coding-agent
  task_3: Create database models          [depends: 1]     → coding-agent
  task_4: Write integration tests         [depends: 2, 3]  → testing-agent
  task_5: Add CI pipeline                 [depends: 4]     → devops-agent
```

**How it knows what's next:** `getReadyTasks()` walks the DAG and returns tasks whose dependencies are all completed. Tasks 2 and 3 can run in parallel after task 1 completes.

**Backtracking:** Each completed subtask creates a checkpoint (git commit hash). When a task fails:
1. Checks for **alternative approaches** defined for that task
2. If available → resets to pending, tries the next approach
3. If all exhausted → finds nearest checkpoint, calculates downstream impact, suggests rollback

**Cross-session persistence:** Goals are saved as JSON in `~/.claude2/projects/{slug}/goals/`. Close your terminal, come back tomorrow, and Claude2 picks up exactly where it left off.

**Key files:**
- `src/planner/StrategicPlanner.ts` — `createGoal()`, `decomposeGoal()`, `failSubtask()` with backtracking
- `src/planner/taskGraph.ts` — DAG operations: `topologicalSort()`, `getCriticalPath()`, `getDownstreamImpact()`

---

### 4. Dynamic Skill & Tool Creation

> `src/skills/skillGenerator.ts`, `src/skills/mcpAutoDiscovery.ts`, `src/tools/ComposeTool/`

Claude2 **creates its own tools** when it detects patterns or needs capabilities it doesn't have:

**Auto-generated skills:** The `SkillGenerator` watches tool-call history with a sliding window. When it sees the same multi-step sequence repeated (e.g., Grep → Read → Edit → Bash 3 times), it offers to save it as a reusable skill file:

```markdown
---
name: search-then-fix
description: "Multi-step workflow: 1. Grep → 2. Read → 3. Edit → 4. Bash"
whenToUse: "When the user wants to find and fix code patterns"
allowedTools:
  - Grep
  - Read
  - Edit  
  - Bash
---
```

**MCP auto-discovery:** When Claude2 needs a capability (like database access), it searches a registry of 15+ known MCP servers, auto-installs the right one, and wires it into `~/.claude2/mcp.json`.

**Composite tools:** The `ComposeTool` chains existing tools together at runtime with inter-step data passing via `$steps[i].dotpath` references.

---

### 5. Watcher & Daemon System

> `src/watcher/` — 7 files | `src/daemon/` — 3 files | ~1,400 lines total

This is how Claude2 **works without being asked**:

| Watcher | What It Monitors | Events |
|---|---|---|
| `FileWatcher` | Filesystem changes (native `fs.watch` + polling fallback) | `file_changed` |
| `GitWatcher` | New commits, PRs, CI failures via `git`/`gh` CLI | `new_commit`, `new_pr`, `ci_failure` |
| `CIWatcher` | GitHub Actions failures with failing job/step extraction | `ci_failure` |
| `IssueWatcher` | New GitHub issues with auto-priority classification | `issue_created` |

**Event flow:**
```
Watcher detects event
  → WatcherManager routes to AgentDaemon
    → Daemon dispatches to registered handlers
      → Handlers return DeferredActions (with priority: critical/high/normal/low)
        → Priority queue processes them (critical first)
```

**Example autonomous scenario:**
1. `CIWatcher` detects a failing GitHub Actions run
2. Handler creates a DeferredAction: "Analyze failure, find fix, create PR"
3. Action is enqueued with priority `high`
4. Daemon processes it using the Reflection Engine to check past fixes

**AgentDaemon features:**
- PID file management with stale-PID detection
- SIGTERM/SIGINT graceful shutdown
- Exponential backoff auto-restart (`startWithAutoRestart()`)
- Health-check logging
- Wildcard (`*`) handler registration for cross-cutting concerns

---

### 6. Code Knowledge Graph

> `src/knowledge/` — 5 files, ~1,700 lines

Builds a **dependency graph of your entire codebase** by parsing imports, exports, classes, and functions:

| Component | Purpose |
|---|---|
| `CodeGraph` | Regex-based TS/JS parser, incremental rebuilds via mtime tracking, BFS path finding |
| `ArchitectureModel` | Layer detection, key module ranking by degree, Tarjan's SCC for circular deps |
| `ImpactAnalyzer` | BFS reverse-dependency walk, risk scoring (low/medium/high/critical), test file suggestions |

**Before making any change**, Claude2 can answer: "If I modify this function, what 47 files might break?" with risk-level classification.

Also includes a **BrowserTool** (`src/tools/BrowserTool/`) — headless Playwright for navigating docs, testing web apps, taking screenshots, and extracting content.

---

### 7. Self-Improvement Pipeline

> `src/selfimprove/` — 7 files, ~2,000 lines

Claude2 **gets measurably better over time** through a 6-step automated cycle:

```
Step 1: Gather metrics      → "How did I do this week?"
Step 2: Identify weak areas  → "Bug fixes at 60% success, refactoring at 90%"
Step 3: Evolve prompts       → A/B test new prompt variants for weak categories
Step 4: Run benchmarks       → Self-evaluate against 5 built-in test suites
Step 5: Promote improvements → If new approach scores better, promote it
Step 6: Generate report      → "Performance improved 8% this cycle"
```

**Components:**

| Component | How It Works |
|---|---|
| `PerformanceTracker` | Records outcomes to JSONL, aggregates by time window, identifies weak areas below 70% |
| `PromptOptimizer` | Epsilon-greedy multi-armed bandit (epsilon=0.1), Wilson score ranking, prompt mutation |
| `SkillEvolver` | Tracks per-skill success, proposes improvements for <60% skills, promotes with 5% gate |
| `BenchmarkRunner` | 5 built-in benchmarks: code gen, bug fix, code understanding, planning, tool use |
| `ImprovementEngine` | Orchestrates the full cycle, schedulable via `scheduleAutoCycle(hours)` |

---

## WhatsApp Integration

> `src/channels/` — 4 files, ~700 lines

Chat with Claude2 from your phone via WhatsApp. Built with `@whiskeysockets/baileys` (reverse-engineered WhatsApp Web protocol):

```bash
claude2 --whatsapp                     # Start bridge, show QR code
claude2 --whatsapp --qr-only           # Just authenticate, then exit
claude2 --whatsapp --model gpt-4o      # Use specific model
claude2 --whatsapp --allow 1234567890  # Restrict to specific numbers
```

**Features:**
- QR code authentication displayed in terminal (scan with WhatsApp → Linked Devices)
- Per-chat session persistence in `~/.claude2/whatsapp/sessions/`
- Message debouncing (batches rapid messages)
- Access control via allowed sender list
- Media support (images, audio, video, documents)
- Typing indicators while thinking
- Commands: `/help`, `/status`, `/reset`, `/model`
- Credential save queue preventing corruption (pattern from OpenClaw)
- Auto-reconnect on non-logout disconnects
- WhatsApp-specific system prompt (concise responses, WA formatting)

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.1.0
- At least one API key (Anthropic recommended)

### Install

```bash
git clone https://github.com/JoelHJames1/AGICLI.git
cd AGICLI
bun install
```

### Configure

```bash
cp .env.claude2.example .env.claude2
# Edit .env.claude2 and add your API key(s)
```

### Run

```bash
# CLI mode (default)
bun src/entrypoints/cli.tsx

# WhatsApp mode
bun src/entrypoints/cli.tsx --whatsapp

# With a specific provider
ANTHROPIC_API_KEY=sk-ant-... bun src/entrypoints/cli.tsx
```

---

## Configuration

All configuration is via environment variables. Copy `.env.claude2.example` for the full reference.

### Provider Keys

```bash
# Anthropic (default — Claude Opus 4.6)
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
OPENAI_API_KEY=sk-...

# Google Gemini
GOOGLE_GEMINI_API_KEY=...

# Ollama (local)
OLLAMA_BASE_URL=http://localhost:11434

# OpenAI-Compatible (Groq, Together, etc.)
OPENAI_COMPATIBLE_BASE_URL=https://api.together.xyz/v1
OPENAI_COMPATIBLE_API_KEY=...
```

### Smart Model Router

```bash
CLAUDE2_MODEL_ROUTER=true

# Override per-task routing
AGENT_CODING_MODEL=claude-opus-4-6
AGENT_REASONING_MODEL=o3
AGENT_FAST_MODEL=claude-haiku-4-5
AGENT_LOCAL_MODEL=ollama/codestral
AGENT_LONG_CONTEXT_MODEL=gemini-2.5-flash
```

### AGI Features

```bash
CLAUDE2_REFLECTION=true          # Error learning & strategy tracking
CLAUDE2_PLANNER=true             # Strategic goal planning
CLAUDE2_WATCHERS=true            # Autonomous file/git/CI monitoring
CLAUDE2_SELF_IMPROVE=true        # Self-improvement pipeline
CLAUDE2_KNOWLEDGE_GRAPH=true     # Code dependency analysis
```

---

## New Files Created

57 new files, ~12,000 lines of AGI infrastructure built on top of the existing Claude Code foundation:

### Provider System (`src/providers/`)
| File | Purpose |
|---|---|
| `types.ts` | Provider-neutral message/event types |
| `LLMProvider.ts` | Core provider interface |
| `registry.ts` | Provider factory + auto-detection |
| `capabilities.ts` | Per-provider capability matrix |
| `router.ts` | Smart model routing |
| `index.ts` | Registration + re-exports |
| `anthropic/index.ts` | Anthropic adapter (+ Bedrock/Vertex/Foundry) |
| `anthropic/messageAdapter.ts` | Near-identity message translation |
| `openai/index.ts` | OpenAI adapter with SSE streaming |
| `openai/messageAdapter.ts` | tool_calls ↔ tool_use translation |
| `gemini/index.ts` | Gemini REST API adapter |
| `gemini/messageAdapter.ts` | functionCall ↔ tool_use translation |
| `ollama/index.ts` | Ollama adapter (extends OpenAI-compatible) |
| `openai-compatible/index.ts` | Generic OpenAI-compatible adapter |

### Reflection System (`src/reflection/`)
| File | Purpose |
|---|---|
| `types.ts` | Reflection event/pattern/strategy types |
| `ReflectionEngine.ts` | Core engine + file-based store |
| `errorAnalyzer.ts` | 12 error classifiers, signature normalization |
| `strategyTracker.ts` | Task categorization, strategy ranking |

### Strategic Planner (`src/planner/`)
| File | Purpose |
|---|---|
| `types.ts` | Goal, SubTask, Checkpoint, DAG types |
| `StrategicPlanner.ts` | Goal management + backtracking |
| `taskGraph.ts` | DAG operations, topological sort, critical path |

### Dynamic Skills (`src/skills/`)
| File | Purpose |
|---|---|
| `skillGenerator.ts` | Pattern detection, skill file generation |
| `mcpAutoDiscovery.ts` | MCP server registry + auto-install |
| `index.ts` | Barrel exports |

### Composite Tools (`src/tools/`)
| File | Purpose |
|---|---|
| `ComposeTool/ComposeTool.ts` | Chain tools with inter-step data passing |
| `BrowserTool/BrowserTool.ts` | Headless Playwright browser |

### Watcher System (`src/watcher/`)
| File | Purpose |
|---|---|
| `types.ts` | Watcher interface, event types |
| `FileWatcher.ts` | Filesystem monitoring |
| `GitWatcher.ts` | Git/PR/CI polling |
| `CIWatcher.ts` | GitHub Actions failure monitoring |
| `IssueWatcher.ts` | Issue monitoring + priority classification |
| `WatcherManager.ts` | Central registry + event routing |
| `index.ts` | Barrel exports |

### Daemon (`src/daemon/`)
| File | Purpose |
|---|---|
| `types.ts` | Daemon state, config, deferred actions |
| `AgentDaemon.ts` | Background process with priority queue |
| `index.ts` | Barrel exports |

### Knowledge Graph (`src/knowledge/`)
| File | Purpose |
|---|---|
| `types.ts` | Node, edge, graph types |
| `CodeGraph.ts` | Regex-based parser, incremental rebuilds |
| `ArchitectureModel.ts` | Layer detection, Tarjan's SCC |
| `ImpactAnalyzer.ts` | Blast radius analysis |
| `index.ts` | Barrel exports |

### Self-Improvement (`src/selfimprove/`)
| File | Purpose |
|---|---|
| `types.ts` | Metrics, benchmark, report types |
| `PerformanceTracker.ts` | JSONL metrics, trend analysis |
| `PromptOptimizer.ts` | Multi-armed bandit A/B testing |
| `SkillEvolver.ts` | Skill versioning + promotion |
| `BenchmarkRunner.ts` | 5 built-in self-evaluation benchmarks |
| `ImprovementEngine.ts` | Orchestrates full improvement cycle |
| `index.ts` | Barrel exports |

### WhatsApp Channel (`src/channels/`)
| File | Purpose |
|---|---|
| `types.ts` | Channel interface, message types, chunking |
| `whatsapp/WhatsAppChannel.ts` | Baileys integration, QR auth |
| `whatsapp/WhatsAppBridge.ts` | WhatsApp ↔ LLM bridge |
| `whatsapp/cli.ts` | CLI entry point for WhatsApp mode |
| `whatsapp/index.ts` | Barrel exports |
| `index.ts` | Channel barrel exports |

### Bootstrap (`src/claude2/`)
| File | Purpose |
|---|---|
| `bootstrap.ts` | Unified initialization of all subsystems |
| `config.ts` | Config persistence + deep merge |
| `index.ts` | Re-exports |

### Modified Files
| File | Change |
|---|---|
| `package.json` | Name → "claude2", added openai, gemini, playwright, baileys deps |
| `.env.claude2.example` | Full configuration reference |
| `src/entrypoints/cli.tsx` | Added `--whatsapp` fast-path |

---

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict) |
| Default Model | Claude Opus 4.6 |
| Terminal UI | [React](https://react.dev) + [Ink](https://github.com/vadimdemedes/ink) |
| CLI Parsing | [Commander.js](https://github.com/tj/commander.js) |
| LLM SDKs | Anthropic SDK, OpenAI SDK, Google Generative AI |
| WhatsApp | [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) |
| Browser | [Playwright](https://playwright.dev) |
| Protocols | MCP SDK, LSP |
| Telemetry | OpenTelemetry |
| Schema | Zod |
| Search | ripgrep |

---

## AGI Properties

| Property | How Claude2 Addresses It |
|---|---|
| **Generalization** | Multi-model routing — uses the best model per task, not locked to one |
| **Self-improvement** | Reflection + benchmarks + prompt evolution → measurably improves over time |
| **Autonomy** | Daemon + watchers + goals → works without prompting |
| **Planning** | Strategic planner with DAG decomposition, checkpoints, and backtracking |
| **Tool creation** | Auto-generates skills from patterns, auto-discovers MCP servers |
| **Memory** | Persistent cross-session memory + structured reflection storage |
| **Multi-modal** | Vision + web browsing + WhatsApp + media handling |
| **Collaboration** | Team system + coordinator → multi-agent parallel work |

This is not true AGI (nothing is yet), but it pushes the CLI toward the most capable autonomous coding agent possible with current technology.

---

## License

MIT

---

<div align="center">

**Built with Claude Opus 4.6**

</div>
