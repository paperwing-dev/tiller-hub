# Agents

This folder contains the live hosted chat agents for Tiller.

## Live Agents

- `plan-chat-agent.ts` is the Plan Writer. It uses Cloudflare Think, the hosted Codex/OpenAI Responses route, read-only repo tools, artifact tools, and the versioned `save_plan` workflow.
- `reviewer-chat-agent.ts` is the Plan Reviewer. It uses Workers AI models to inspect a specific plan and produce reviewer feedback without modifying the plan or workspace.

## PlanChat Support

- `plan-chat-support.ts` owns the PlanChat V2 policy, `get_plan_context`, active tool lists, server-side tool gating, and bounded repo search helpers.
- `plan-chat-workspace.ts` is the read-only workspace proxy used by PlanChat. Workspace mutation must stay unavailable; plan changes go through `save_plan`.

## Boundaries

- `agent-core/` contains shared model, prompt, workspace, and hosted-tool helpers.
- `agents/` contains product-facing Durable Object agent classes plus PlanChat-specific support modules.
- Wrangler bindings should exist only for live agent classes exported from `api/index.ts`.

## Removed Agents

The older `planner-chat`, `research-chat`, and `cartographer-chat` agents were removed because the product UI no longer uses them. Their historical Durable Object class names remain only in Wrangler migrations so Cloudflare can delete the old classes safely during deploy.
