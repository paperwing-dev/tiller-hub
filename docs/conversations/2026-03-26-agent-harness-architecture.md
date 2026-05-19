# Agent Harness Architecture Design

**Date**: 2026-03-26/27
**Topic**: Designing a model-agnostic agent harness for tiller-hub on Cloudflare Workers

---

## Summary

Started from "how do we extend the research agent's chat.ts harness?" and arrived at a four-layer architecture for building generalized agents on Cloudflare Workers. The conversation covered the full landscape of available tools, frameworks, and Cloudflare primitives before converging on a design.

---

## Starting Point

The research agent in `api/chat.ts` is a ~588-line monolith: tool definitions, tool execution, chat history, SSE parsing, Codex API integration, and the tool loop all in one file. It has 4 tools (read_file, write_file, list_files, glob) and is hardcoded to the OpenAI Codex Responses API.

The Workspace API (`agents/experimental/workspace`) already has `bash()`, `diff()`, `createBashSession()` available but not wired as tools.

---

## Key Questions Explored

### What is a harness?

Three clearly separated concerns:

- **The model** — a stateless function. Receives messages + tool definitions, returns text and/or tool calls. All intelligent decisions happen here.
- **The harness** — the mechanical loop. Sends messages to model, reads response, executes tool calls, feeds results back, repeats. Zero intelligence. Also owns streaming, history management, token counting, max steps.
- **The tools** — pure functions that interact with the outside world. Don't know they're being called by an AI.

### What frameworks exist for the harness?

| Framework | Workers? | Has loop? | Claude? | Verdict |
|---|---|---|---|---|
| Vercel AI SDK (`ai`) | Yes | Yes | Yes | Cloudflare ecosystem builds on it |
| Cloudflare `agents` | Yes | No (infra only) | N/A | Keep for DO/WebSocket/MCP/Workspace |
| `@cloudflare/ai-utils` | Yes | Yes (runWithTools) | No | Too narrow, only env.AI |
| Anthropic Agent SDK | No (needs containers) | Yes | Yes | Not viable in Workers |
| LangChain/LangGraph | Yes but heavy | Yes | Yes | Overkill, large bundle |
| Mastra | Partially | Yes | Yes | Immature, 18.8MB |
| OpenAI Agents SDK | Partially | Yes | Practically no | Wrong ecosystem |

### What does Cloudflare provide?

**For capabilities/tools**: `Workspace` has all the implementations (readFile, writeFile, bash, diff, glob, readDir). You just wrap them.

**For the loop**: Nothing built-in. `@cloudflare/ai-utils` `runWithTools` only works with `env.AI.run()`. AI SDK `streamText` with `stopWhen`/`prepareStep` is what Cloudflare's own templates use.

**For state**: `Session` (agents SDK) for conversation messages with compaction. `Agent.state`/`setState()` for UI-facing state. `Workspace` for file-based persistence.

**For handoff**: Nothing. No primitive exists.

**For code execution**: `@cloudflare/codemode` + Dynamic Workers. Model writes TypeScript against typed API, executes in V8 isolate (~5ms startup). Capability calls proxy back via RPC.

### Provider strategy

User wants model-agnostic. Two paths to models:
- `env.AI.run()` for Workers AI models (Llama, Mistral, Kimi) — no network hop
- `fetch()` to any OpenAI-compatible endpoint for external models (Codex, OpenRouter, etc.)
- `env.AI.gateway("name")` can also route to external providers

Decision: standardize on OpenAI-compatible format. One loop handles both paths with a thin normalizer for `env.AI.run()` response shape differences.

---

## Architecture: Four Layers

The realization was that the stable abstraction is not "provider" — it is **capabilities, runtime, state, handoff**.

### Layer 1: Capabilities

Host-owned operations the agent can perform. Defined once, exposed two ways:
- `toAiSdkTools()` for direct tool-calling runtimes
- `toCodeModeTool()` for Code Mode runtimes (via `@cloudflare/codemode`)

Each capability has metadata: `sideEffects`, `requiresApproval`, `cost`.

All backed by Workspace API:

| Capability | Backed by | Side effects |
|---|---|---|
| readFile | workspace.readFile() | no |
| writeFile | workspace.writeFile() | yes |
| editFile | read + string replace + write | yes |
| listDir | workspace.readDir() | no |
| glob | workspace.glob() | no |
| grep | workspace.bash("grep ...") | no |
| bash | workspace.bash() | depends |
| diff | workspace.diffContent() | no |
| saveMemory | workspace.writeFile("/.tiller/memory/...") | yes |
| recallMemory | read from /.tiller/memory/ | no |
| emitPlan | workspace.writeFile("/.tiller/handoffs/...") | yes |
| fetchPage | fetch() | no |

### Layer 2: Runtime

How the model uses capabilities. Two types:

**direct-tools**: Model calls tools one at a time. AI SDK `streamText` + `stopWhen` + `prepareStep` manages the loop. Each tool call is one model round-trip.

**codemode**: Model writes TypeScript against typed capability API. Executes in Dynamic Worker (V8 isolate). Multiple capability calls in one model invocation — with conditionals, loops, error handling. Uses `@cloudflare/codemode` `createCodeTool()`.

Code Mode is better for complex operations (model writes a 10-line script instead of 6 sequential tool calls). Direct tools better for simple single-step work.

An agent config picks its runtime:
```ts
interface AgentConfig {
  name: string;
  model: string;
  capabilities: string[];
  runtime: "direct-tools" | "codemode";
  systemPrompt: string;
  maxSteps: number;
}
```

### Layer 3: State

Two primitives cover everything:

| State kind | Primitive | Where |
|---|---|---|
| Conversation messages | `Session` (agents SDK) | DO SQLite, auto-compaction |
| Agent UI state | `Agent.state` / `setState()` | DO SQLite, auto-broadcast |
| Session metadata | Custom (HubDO sessions table) | DO SQLite, versioned |
| Memories | `Workspace` files | `/.tiller/memory/*.md` |
| Artifacts | `Workspace` files | `/.tiller/handoffs/*.json` |

Memories and artifacts are file conventions, not separate storage systems.

### Layer 4: Handoff

Structured output passed between agents. No Cloudflare primitive exists.

Lightest approach: JSON files with a schema:
```ts
interface Handoff {
  id: string;
  from: string;        // "research"
  to: string;          // "container" | "reviewer"
  type: string;        // "plan" | "review-request"
  payload: unknown;
  context: string[];   // relevant file paths
  createdAt: string;
}
```

Adjacent primitives: `subAgent()` for co-located child DO, AI SDK agents-as-tools for delegation, Cloudflare Workflows for durable sequences.

---

## Library Decisions

| Library | Role | Action |
|---|---|---|
| `agents` (0.7.7) | Workspace, Session memory, Agent base, MCP, subAgent | Keep (already installed) |
| AI SDK (`ai` 6.0.116) | Model loop, tool defs, UIMessage types | Decision pending — user initially resistant but ecosystem requires it |
| `@cloudflare/codemode` | Code Mode runtime | Add when ready (experimental v0.3.2) |
| `workers-ai-provider` | AI SDK adapter for env.AI | Keep if using AI SDK |
| `@cloudflare/ai-chat` | AIChatAgent with persistent messages | Optional, evaluate later |
| `@anthropic-ai/sdk` | Direct Anthropic calls | REMOVE (switched to OpenAI format) |
| `@cloudflare/ai-utils` | runWithTools for env.AI | DON'T ADD (redundant with own loop) |

---

## Open Questions

1. **AI SDK dependency**: User initially said "Vercel is buggy." But Cloudflare ecosystem is built on it, Code Mode's `createCodeTool()` returns an AI SDK tool. Unresolved.

2. **Scope/phasing**: Build all 4 layers now or incrementally? Code Mode is experimental, Dynamic Workers just entered open beta (2026-03-24).

3. **Research agent scope**: Should it have bash? Workspace.bash() is sandboxed in the DO, not a real shell. Or keep research read-only + memory + handoff?

4. **Internal message format**: Should NOT be OpenAI Responses API items (too coupled to Codex). Options: UIMessage (AI SDK), or neutral custom schema.

---

## Proposed File Structure

```
api/agent-core/
  types.ts            — AgentSpec, Capability, RuntimeKind, HandoffArtifact, AgentEvent
  capabilities.ts     — host capability registry, approval/persistence metadata
  runtimes/
    direct-tools.ts   — AI SDK streamText, direct tool calling, multi-step loop
    codemode.ts       — DynamicWorkerExecutor, createCodeTool, typed capability exposure
  models.ts           — Workers AI, OpenAI-compatible, AI Gateway later
  state.ts            — session messages, memory, handoff artifacts
  handoffs.ts         — structured handoff schema
  events.ts           — internal event model, adapter to current SSE contract
```

---

## Key Insights

1. The harness is the least interesting piece — it's a mechanical loop. The value is in tool/capability quality and prompt quality.
2. "Tools" are the wrong abstraction if Code Mode exists. "Capabilities" that project into both tools and typed APIs is the right center.
3. Cloudflare provides primitives for everything except handoff and capability registry — those are thin custom layers.
4. Handoffs between agents matter more than shared conversation history.
5. The model quality determines how well multi-step tool use works. Llama 70B is fine for 2-3 turns; Claude/GPT-4o sustains 10-20.
6. One loop implementation is better than two. Normalize Workers AI responses to match OpenAI format.
7. Don't use OpenAI Responses items as internal format — too coupled to one provider's API shape.
