# Agent Runtime Experiments

## Purpose

This note tracks the hosted-agent runtime experiments behind the `Research` pane.
It is intentionally separate from the README because it is about architecture evaluation, not operator setup.

The main question is:

- What should be the default hosted harness for small scoped agents in `tiller-hub`?
- Where does `Codemode` fit, and where does it not?
- Which agents should share the high-quality external Codex path versus cheaper or more experimental hosted runtimes?

## Current Agent Roles

### Research

- Goal: high-quality codebase understanding and general hosted assistance
- Runtime pattern: hosted direct tools
- Model path: external Codex / `gpt-5.4`
- What it is testing:
  - `AIChatAgent` as the primary hosted chat surface
  - hosted file and memory tools without requiring a container
  - handoff creation from a strong general-purpose model

Why this exists:

- This is the quality baseline.
- If a new runtime does not match or clearly justify itself against `Research`, it should not replace `Research`.

### Reviewer

- Goal: read-only review, risk finding, bug spotting
- Runtime pattern: hosted direct tools
- Model path: Workers AI
- What it is testing:
  - a lower-cost hosted agent with a narrower persona
  - whether Workers AI is good enough for bounded review-style tasks
  - separate histories and prompts on the same workspace

Why this exists:

- Review is a good candidate for a cheaper secondary opinion.
- It does not need container execution.

### Cartographer

- Goal: repo mapping, structure exploration, and artifact creation through Code Mode
- Runtime pattern: hosted Codemode
- Model path: Workers AI
- What it is testing:
  - whether Code Mode is better for multi-file exploration than normal tool calling
  - whether a code-writing hosted runtime is useful when the task is "explore and synthesize", not "edit and execute"
  - whether structured handoffs are a better output than conversational plans for this style of agent

Why this exists:

- It gives Codemode a narrow task that actually fits its strengths.
- It avoids making Planner or Research worse while Codemode is still experimental.

### Planner

- Goal: produce implementation plans and handoffs for later execution
- Runtime pattern: hosted direct tools
- Model path: Workers AI
- What it is testing:
  - whether a planning-specific persona works better than generic research
  - whether handoff creation and `/.tiller/plan.md` materialization are enough to bridge into container sessions

Important note:

- Planner briefly used `Codemode` directly.
- That version was slower and often surfaced raw `codemode` tool payloads instead of grounded plans.
- It was intentionally reverted to direct tools.

So the current planner is **not** evidence that `Codemode` is ready as the default hosted planning runtime.

## Codemode Thoughts

### What Codemode seems good for

- multi-step orchestration where the model benefits from writing short programs
- combining many small tools with loops, branching, and aggregation
- future MCP-heavy hosted agents
- specialized agents where the code-execution abstraction is the point

### What Codemode seems bad for right now

- replacing a normal planning or research chat by default
- simple "read some files and give me a plan" requests
- any flow where raw generated code leaking into the user experience is unacceptable

### Current conclusion

`Codemode` should be treated as an experimental runtime, not the default user-facing runtime.

That means:

- keep it in the harness
- keep the seams ready for it
- do not force end users onto it until it consistently produces better outcomes than direct tools

## Architecture Patterns Being Tested

### Pattern 1: AIChatAgent-first hosted chat

Tested by:

- `Research`
- `Reviewer`
- `Planner`

What this validates:

- Cloudflare-native chat persistence
- resumable streaming
- separate hosted agent identities per workspace
- frontend integration through `useAgentChat`

### Pattern 2: Shared hosted tool surface

Tested by:

- all three current hosted agents

What this validates:

- one workspace-backed capability layer
- shared handoff, memory, and file tools
- different prompts and runtimes over the same durable state

### Pattern 3: Handoff-driven bridge to container execution

Tested by:

- `Research` and `Planner` creating handoffs
- `Use in Container` materializing a handoff into `/.tiller/plan.md`

What this validates:

- hosted agents can prepare work without starting a container
- container sessions can consume structured output instead of re-deriving context

### Pattern 4: Workers AI as a secondary hosted runtime

Tested by:

- `Reviewer`
- `Planner`

What this validates:

- which hosted tasks tolerate cheaper/faster models
- whether agent specialization can compensate for weaker reasoning

### Pattern 5: Codemode as an optional runtime

Tested by:

- `Cartographer`

What this is meant to validate later:

- whether a typed code-executing agent runtime can outperform direct tool calling for complex orchestration
- whether MCP-heavy agents benefit enough to justify the extra latency and complexity

## Working Assumptions

- `Research` should stay the highest-quality hosted path.
- `Reviewer` can be more cost-sensitive.
- `Planner` is only useful if it produces plans that are at least as coherent as `Research`.
- `Codemode` should prove itself on tasks that actually need orchestration logic, not on generic planning prompts.
- `Cartographer` is the current Codemode proving ground.

## Open Questions

- Should the best planner simply be a second `gpt-5.4` persona instead of a different model/runtime?
- Which hosted tasks truly benefit from `Codemode` enough to justify latency?
- When MCP becomes first-class, does `Codemode` become more compelling?
- Should handoffs eventually move from file-backed artifacts to Workflow-backed orchestration?

## Near-Term Direction

- Keep `Research` strong and stable.
- Keep `Planner` useful and practical, even if that means it stays on direct tools.
- Keep `Codemode` available for targeted experiments, not as the default.
- Continue treating handoffs as the main contract between hosted agents and container sessions.
