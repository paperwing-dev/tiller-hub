# Plan Review Flow

This document describes how the hosted `Plan` workflow handles draft review and integration inside `tiller-hub`.

## Goals

- Keep the visible planning experience as one primary `Plan` conversation.
- Let cheaper review models critique drafts without silently overriding the main planner.
- Prevent generic or unsupported review feedback from polluting the planner’s synthesis step.
- Keep review provenance visible to the user.
- Keep the visible product surface as one `Plan` agent, while moving internal orchestration into dedicated backend stages.

## Current flow

### 1. Drafting

- The visible `Plan` chat remains the drafting surface.
- Draft plans are saved as handoffs with:
  - `kind: "plan"`
  - `artifactType: "draft"`
  - `status: "draft"`
  - `repoUrl`
  - the selected planner `model`

### 2. Review round

- `Run review round` creates one review artifact per fixed review model.
- Review orchestration lives in `/packages/hub/api/plan/review-service.ts`, not directly in the route layer.
- Reviewers inspect the repo's canonical workspace state, not env-local dirty changes.
- Review runs are code-aware by default:
  - reviewers get read-only repository tools
  - reviewers are expected to inspect files before finalizing feedback
  - tool use is scoped to the draft’s `relevantFiles`, nearest package roots, and a small set of repo-level config/context paths such as `/package.json`, `/configs`, `/CLAUDE.md`, and `/.tiller/CLAUDE.md`
- The reviewer is not a separate user-facing agent. It is an internal stage behind the visible `Plan` workflow.
- Reviewers are prompted to return JSON only:
  - `summary`
  - `issues[]`
- Each issue must include:
  - `issue`
  - `evidenceQuote`
  - `recommendedChange`

If the model returns malformed JSON, the backend runs one repair pass to coerce the output into the required shape before filtering.
If the model does not inspect code on the first pass, the backend retries once with a stronger “use tools first” instruction.

### 3. Deterministic filtering

Before a review artifact is stored, every issue is filtered with hard rules:

- missing `recommendedChange` -> drop
- missing `evidenceQuote` -> drop
- `evidenceQuote` is not an exact substring of the current draft -> drop
- `evidenceQuote` only restates the issue or recommendation -> drop
- duplicate issue / evidence pair -> drop

The saved review artifact stores:

- `reviewIssues`: only the grounded issues that survived filtering
- `reviewIssueStats`: total / kept / dropped counts
- `reviewMeta`:
  - `toolCallCount`
  - `finishReason`
  - `truncated`
  - `warningCount`
  - `repaired`
  - `retriedForToolUse`
- `proposedPlan`: the raw reviewer response for inspection, even if a repair pass was needed for parsing

This means the sidebar can still show the full reviewer output, while the planner only consumes grounded review issues later.

### 4. Isolated integration

`Integrate reviews` no longer asks the live plan chat to do the synthesis.

Instead, the backend:

1. loads the current draft
2. loads review artifacts for that draft
3. gathers the grounded `reviewIssues`
4. runs a fresh isolated planner call with:
   - the current draft inline
   - the filtered review issues inline
   - no prior plan chat history
   - no memory injection
   - no recent-handoff injection
   - no repository tools

This reduces context pollution from long drafting threads and keeps integration focused on the specific draft and review round.

If the planner returns malformed JSON for integration, the backend runs one repair pass before deciding whether to save a revised draft.

### 5. Integration result

The isolated planner must return JSON only with:

- `accepted[]`
- `rejected[]`
- `updatedSummary`
- `revisedPlan`

The backend then:

- saves a new draft only if the draft materially changed
- returns an assistant-style reply for the Plan UI with these sections:
  - `Reviewed by`
  - `Accepted`
  - `Rejected`
  - `Updated draft`

If no grounded issues survive filtering, or if the draft remains materially unchanged, no new draft is saved.

## Why this is safer

The old integration path reused the accumulated `Plan` chat transcript. That made it easier for weak review feedback to leak into synthesis because the planner saw:

- the full drafting conversation
- recent handoffs
- memories
- workspace summary

The new path narrows integration to the exact artifacts involved in the review round.

The review path is also narrower now. Review models no longer get a broad repo workspace by default; they get a read-only, file-scoped view based on the draft’s cited files.

Review-round persistence is also two-phase now: all model outputs are generated first, then artifacts are saved. If the save phase fails partway through, the partially written reviews are discarded so they do not reappear in the UI or get integrated later.

## Architecture

- Visible planner:
  - `/packages/hub/api/agents/plan-chat-agent.ts`
  - rich repo-aware drafting surface for the user
- Internal review runner:
  - `/packages/hub/api/plan/review-service.ts`
  - code-aware, read-only, scoped tool usage
- Internal integration runner:
  - `/packages/hub/api/plan/review-service.ts`
  - isolated planner synthesis with blank history
- Route layer:
  - `/packages/hub/api/workspace/routes.ts`
  - validates requests, loads repo-scoped drafts, delegates orchestration

This keeps the product UX simple while making the internal stages easier to inspect and reason about in code.

## Known limitations

- Review models are still weaker than the main planner. Filtering reduces noise, but does not make a weak reviewer strong.
- Reviewers are code-aware, but they still review the saved draft as the primary artifact. Tool use improves grounding, but does not turn weaker models into expert judges.
- The integration summary injected into the UI is assistant-style client state; the durable artifact is still the revised draft handoff itself.
- Reviewer finish reasons and truncation are surfaced to the UI, but the stored raw response is still whatever the model returned or whatever the repair pass normalized.
