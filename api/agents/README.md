# Agents

This folder contains the user-facing hosted chat agents for Tiller.

## Purpose

- Keep each concrete agent entry point in one place.
- Separate agent personalities and transport bindings from shared harness code.
- Make it easy to scan which agents actually exist in the product.

Current agents include:

- `cartographer-chat-agent.ts`
- `research-chat-agent.ts`
- `planner-chat-agent.ts`
- `reviewer-chat-agent.ts`

## Why this folder exists

These files were originally mixed into the `api/` root. That made it harder to distinguish:

- shared harness logic
- route wiring
- concrete agent implementations

The `agents/` folder makes the boundary explicit:

- `agent-core/` contains reusable harness pieces
- `agents/` contains the specific agents built on top of that core

That split matters because the long-term goal is a reusable hosted-agent harness, not a pile of one-off chat endpoints.
