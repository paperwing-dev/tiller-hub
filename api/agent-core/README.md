# Agent Core

This folder contains the reusable hosted-agent harness code for Tiller.

## Purpose

`agent-core/` is the shared layer underneath the concrete agents in `api/agents/`.

It owns things like:

- agent specs
- model selection
- Codex language model resolution
- tool definitions
- prompt/context building
- artifact persistence

## Why this folder exists

The old Research implementation was centered around one large Codex-specific file. That made it hard to:

- add more agents
- experiment with agent implementations
- reuse tools and context logic
- separate stable harness pieces from product-specific prompts

The design decision here is:

- concrete agents live in `agents/`
- reusable harness logic lives in `agent-core/`

This keeps the architecture open for multiple hosted-agent styles:

- Think and AI SDK tool-calling agents
- Codemode experiments
- future non-chat agents that still reuse the same tool, context, and artifact layers

## Notes

- AI SDK tools are the main shared surface.
- Codemode remains experimental and is intentionally contained as a runtime, not treated as the default for every agent.
