# Agents

This folder contains the live hosted chat agents for Tiller.

## Live Agents

- `reviewer-chat-agent.ts` is the legacy hosted Plan Reviewer. New planning reviewer tabs use provider-neutral planner runs and Tiller-owned threads.

## Boundaries

- `agent-core/` contains shared model, prompt, workspace, and hosted-tool helpers.
- `agents/` contains product-facing Durable Object agent classes that are still exposed through `/agents/*`.
- Plan writer behavior lives under `api/planner/` and persists through the repo-scoped artifact store.
- Wrangler bindings should exist only for live agent classes exported from `api/index.ts`.

## Removed Agents

The older `plan-chat`, `planner-chat`, `research-chat`, and `cartographer-chat` agents were removed because the product UI no longer uses them. Their historical Durable Object class names remain only in Wrangler migrations so Cloudflare can delete the old classes safely during deploy.
