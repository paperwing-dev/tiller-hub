# Tiller vs Competitors

This document compares Tiller's architectural direction (see
[`north-star-architecture.md`](./north-star-architecture.md)) against other
agent harnesses in the space.

The goal is not feature-for-feature scorekeeping. All serious systems can
eventually ship sessions, approvals, artifacts, and orchestration. The more
important question is where the durable system of record lives, and what that
makes easy.

For Tiller the answer is: the hub owns the workflow, and runtimes are selected
per step as disposable executors.

## Anthropic / Claude Code

**Center of gravity**

- local machine sessions
- Anthropic-managed cloud sessions
- vendor-defined session and workflow surfaces

**What this makes natural**

- a strong shell-first agent experience
- remote/local session continuity inside one vendor ecosystem
- rich vendor-native orchestration features

**What this makes harder**

- hub-style routing, because the durable workflow record is not primarily
  vendor-neutral or runtime-neutral
- cross-runtime and cross-vendor orchestration — it can exist, but it tends to
  be layered around vendor-owned session models rather than falling out of a
  shared workflow abstraction

**How Tiller differs**

Tiller keeps the durable workflow record outside any one vendor's session
format. Claude sessions are extremely capable as sessions, but a session is not
the same object as a workflow. Tiller's bet is that once the workflow is the
primary durable object, per-step routing across runtimes (including runtimes
outside Anthropic's ecosystem) becomes scheduling rather than a product-level
state transition.

## Scion

**Center of gravity**

- containerized agents
- isolated worktrees
- agent runtime orchestration around deep shell execution

**What this makes natural**

- multi-agent shell workflows
- container isolation
- worktree-centric execution
- telemetry around deep agent runtimes

**What this makes harder**

- no-shell hosted work — the worktree and container remain close to the center
  of the system, so lightweight tasks still tend to pay container cost
- workflow-level vendor neutrality
- hub-owned artifacts that survive executor replacement

**How Tiller differs**

Scion optimizes the heavy executor. Tiller's north star is explicitly that the
heavy executor should be an implementation detail of a step, not the center of
the system. That implies a real lightweight runtime tier that can complete
meaningful work before any container boots, and a hub-owned artifact model that
is not coupled to a worktree's lifecycle.

## LangAlpha (ginlix-ai/langalpha)

LangAlpha is a vertical finance-focused agent harness. Reviewing it is useful
because it sits architecturally between Claude Code and Tiller: it has strong
durable state, but that state is anchored to a long-lived sandbox rather than
to a hub-owned workflow record.

**Where LangAlpha and Tiller agree**

- Both explicitly call themselves an *agent harness* and separate durable
  state from live compute. LangAlpha uses PostgreSQL plus Redis for state and
  Daytona for the sandbox; Tiller uses a hub for state and treats runtimes as
  replaceable executors.
- Both decouple workflow from transport. LangAlpha runs workflows behind
  `asyncio.shield()` with SSE reconnect replay, which is architecturally very
  close to Tiller's claim that executors should be disposable.
- Both have a cheap-vs-heavy tier. LangAlpha's **Flash** mode (secretary,
  orchestration, quick lookups) vs **PTC** mode (deep Python-in-sandbox
  analysis) parallels Tiller's **hosted lightweight runtime** vs **shell
  runtime** split.
- Multi-provider LLM abstraction with automatic failover, plan-mode
  human-in-the-loop, skills, middleware, and parallel subagent dispatch appear
  in both systems.

**Where they diverge**

1. **Primary durable object.** LangAlpha anchors on a **workspace**: one
   long-lived Daytona sandbox plus an `agent.md` persistent memory file
   injected into every model call. Tiller's north star explicitly rejects this
   shape. Tiller wants the hub-owned workflow to be primary and the sandbox to
   be disposable. LangAlpha's "sandbox survives sessions" is the
   session/executor-centric pattern Tiller is arguing against.
2. **Runtime routing granularity.** LangAlpha picks mode per agent (Flash or
   PTC). Tiller wants per-*step* capability-based routing: does this step need
   git? private network? write access? can it run read-only? The answer drives
   runtime choice, with escalation and de-escalation happening inside a single
   workflow.
3. **Vendor neutrality.** LangAlpha is tightly coupled to LangGraph, Daytona,
   the LangGraph Postgres checkpointer, and specific financial data providers.
   Tiller's north star is explicit that workflow records, artifacts, and
   approvals should not live inside any one vendor's session abstraction.
4. **Domain posture.** LangAlpha is vertical: finance-first, with deep
   integration into FMP, SEC EDGAR, TradingView, Polygon, and its own
   ginlix-data feed. Tiller treats coding as the *first* application of a
   general hub-first control plane, not its permanent boundary.
5. **Artifact authority.** LangAlpha's context-management middleware offloads
   oversized tool output to the workspace filesystem, i.e. inside the sandbox.
   Tiller wants artifacts hub-owned and runtime-neutral so they survive
   executor replacement without a migration step.

**Summary**

LangAlpha is a capable session- and sandbox-centric harness with excellent
persistence inside one runtime class. Tiller's north star is the step past
that: make the hub — not the sandbox — the system of record, so workflows can
hop runtime classes mid-flight without losing identity. They share the
instinct that cheap work should stay off the container, but disagree on where
the durable truth lives.

## Cross-cutting comparison

| Dimension | Claude Code | Scion | LangAlpha | Tiller (north star) |
| --- | --- | --- | --- | --- |
| Primary durable object | Vendor session | Container / worktree | Workspace (sandbox + `agent.md`) | Hub-owned workflow |
| Runtime model | Local or vendor cloud session | Containerized deep agents | One long-lived sandbox per workspace | Multiple runtime classes, per-step routing |
| Cheap no-shell tier | Limited | Limited | Flash mode (LLM-only orchestration) | First-class hosted lightweight runtime |
| Executor disposability | Low — session carries state | Low — worktree carries state | Low — workspace carries state | High — executors are disposable |
| Vendor neutrality at workflow layer | Low | Medium | Low (LangGraph + Daytona) | High (explicit goal) |
| Optimizes for | Shell-first single-agent UX | Multi-agent shell workflows | Finance research compounding over time | Mixed-runtime workflow routing |

## When Tiller's architecture pays off

Per the north-star doc, Tiller's bet is justified when the product needs:

- meaningful tasks completed without shell boot
- centralized routing across runtime classes
- durable workflow artifacts independent of one executor
- centralized policy, approvals, and observability
- orchestration that survives executor replacement
- org-level surfaces built over one durable state model

It is the wrong bet when the product mostly wants a great single-agent shell
experience with minimal architectural surface area. In that case a
Claude-Code-style or Scion-style system is a better fit.
