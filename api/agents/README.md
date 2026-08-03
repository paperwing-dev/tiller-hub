# Agents

This folder contains hosted chat agent classes retained by Tiller.

## Retained Agents

- `reviewer-chat-agent.ts` is the legacy hosted Plan Reviewer. Its Durable Object
  export and binding remain for deployment-topology compatibility, but no Worker
  route dispatches requests to it. Current reviewer tabs use provider-neutral
  planner runs and Tiller-owned threads.

## Boundaries

- `agent-core/` contains shared model, prompt, workspace, and hosted-tool helpers.
- `agents/` contains retained Durable Object agent classes. `/agents/*` returns
  `410 Gone` and does not invoke these classes.
- Plan writer behavior lives under `api/planner/` and persists through the repo-scoped artifact store.
- Wrangler bindings may remain for compatibility with already-installed Durable
  Object topology even when the corresponding class is no longer routed.

## Removed Agents

The older `plan-chat`, `planner-chat`, `research-chat`, and `cartographer-chat` agents were removed because the product UI no longer uses them. Their historical Durable Object class names remain only in Wrangler migrations so Cloudflare can delete the old classes safely during deploy.
