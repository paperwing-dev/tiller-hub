# Agent Harness Design

## Goal

Refactor the Tiller Hub "Research" button into the first consumer of a more general hosted-agent harness.

The harness should support:

- hosted chat agents running on Cloudflare
- future Dynamic Worker / Codemode agents
- structured handoffs into container-based coding sessions
- reusable capabilities that are not tied to coding only

The first implementation target is still the existing Research experience in `tiller-hub`.

## Core Design

The harness is built around four stable concepts:

1. `tools / capabilities`
2. `runtime`
3. `state`
4. `handoff`

This is a better long-term seam than centering everything on one provider wire format.

## Runtime Split

There are three execution tiers:

### 1. Hosted direct-tools runtime

- Best for the current Research button
- Uses AI SDK style tool calling
- Reads and writes hosted workspace state
- No shell required

### 2. Hosted Codemode runtime

- Uses Cloudflare Dynamic Workers / `@cloudflare/codemode`
- Best when the model should write code against a typed API
- Still uses hosted state and hosted capabilities
- Still not a Linux shell

### 3. Container runtime

- Existing Claude / Codex container sessions
- Best for bash, git, tests, package managers, and long-running coding work
- Consumes structured handoffs from hosted agents

## Hosted State

`WorkspaceDO` remains the durable owner of project state:

- workspace files
- saved memories
- handoff artifacts
- workspace summaries and project context

Hosted agents should not treat in-memory runtime state as durable.

## Chat Surface

The Research button should migrate to a Cloudflare-native chat surface:

- `AIChatAgent` for persistence and resumable streaming
- `useAgentChat` in the frontend

This replaces the hand-rolled `ChatHistory` + SSE contract over time.

The first code extraction can keep the current route and streaming path while the core harness is separated.

## Canonical Tool Surface

The canonical hosted capability surface should be defined once and then adapted into different runtimes.

Short term:

- read file
- write file
- list files
- glob
- save memory
- recall memory

Do not start by exposing `bash` in hosted agents.

Dynamic Workers are a good fit for structured hosted execution, but not for pretending to be a shell session.

## Handoffs

Structured handoffs are a first-class part of the design.

Suggested shape:

- `id`
- `kind`
- `goal`
- `summary`
- `findings`
- `relevantFiles`
- `openQuestions`
- `proposedPlan`
- `memoryRefs`
- `createdBy`
- `createdAt`

Hosted agents produce handoffs. Container sessions consume them, including materializing a selected handoff into `/.tiller/plan.md`.

## Library Guidance

### Use

- `agents`
- `@cloudflare/ai-chat`
- `ai`
- `workers-ai-provider`
- `@cloudflare/codemode`

### Do not center the architecture on

- `@cloudflare/ai-utils`
- provider-native message schemas
- shell-style assumptions for hosted agents

## Phased Implementation

### Phase 1

Extract a small `agent-core` from the existing Research code:

- agent types
- hosted tool registry
- context builder
- handoff store
- auth routing
- agent specs

Keep the existing transport and frontend behavior for this phase.

### Phase 2

Move Research onto `AIChatAgent` and `useAgentChat`.

### Phase 3

Expose the same hosted tool surface to both:

- direct tool-calling
- Codemode

### Phase 4

Add structured handoffs into container sessions.

### Phase 5

Introduce additional hosted agents such as:

- reviewer
- planner
- future non-coding agents

## Why this approach

This keeps the first migration practical while still steering toward a Cloudflare-native architecture:

- `AIChatAgent` for chat
- Dynamic Workers / Codemode for hosted agent execution
- `WorkspaceDO` for durable state
- container sessions for shell-heavy work

That matches the current Research button use case without overfitting the harness to coding only.
