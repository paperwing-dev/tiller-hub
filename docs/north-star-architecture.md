# Tiller North Star Architecture

This document records the current architectural direction for `tiller-hub`.
It is normative for new planning work.

Where this document conflicts with older exploration docs, this document should
be treated as the current default decision basis.

## Thesis

Tiller should be a hub-first control plane for agents.

Today the primary workload is software work:

- planning against repos
- review over repo state
- shell-based execution
- coding agents in containers

That is the first major application of the architecture, not its permanent
boundary.

Future harnesses may target other kinds of work while still fitting the same
hub-first model.

The architectural claim is:

- durable workflow state belongs in the hub
- executor-local state should be treated as disposable
- route each step of work to the cheapest sufficient runtime
- avoid paying for heavy compute when light compute can do the job
- preserve one coherent workflow record even when execution changes runtime

This is not primarily about "supporting many backends."
It is about making the hub the system of record and treating runtimes as
replaceable executors attached to hub-owned state.

Tiller should be judged by whether this architecture makes mixed-runtime
workflow routing easier, cheaper, and more coherent.

## Architectural Shape

Tiller should be:

- a workflow scheduler for agent work
- a durable control plane for agent execution
- a hosted coordination layer for mixed runtime classes
- a product with first-class planning, review, and handoff artifacts

Tiller should not be defined primarily as:

- a better remote shell
- a better container manager
- a git host
- a thin wrapper around one agent vendor

## Terms

Tiller should treat `harness` as the primary architectural unit.

### Harness

A harness is the reusable workflow implementation that binds together:

- model behavior and prompting
- tool and capability surface
- runtime assumptions
- state and artifact contract
- handoff and approval behavior
- recovery and stop conditions

A harness is not tied to one compute model.
The same harness may have different runtime implementations when that makes
sense.

Examples:

- a coding harness may run in a shell runtime for git, tests, and package managers
- a planning harness may run in a hosted runtime over hub-owned durable state
- a future harness may run in a Durable Worker for cheap background orchestration

### Agent

An agent is a live execution of a harness for a particular task, session, or
workflow step.

### Runtime

A runtime is the compute environment executing the harness instance.

That means:

- `harness` = the reusable execution pattern
- `agent` = one running instance of that pattern
- `runtime` = the compute environment currently executing it

This lines up reasonably well with broader ecosystem usage, even though many
systems use `agent` as the primary product word and treat the harness as an
implementation detail.

Tiller should be more explicit because the architecture depends on separating:

- reusable workflow behavior
- live execution
- compute environment

## Runtime Classes

Tiller should think in runtime classes, not just runner implementations.

### 1. Hosted lightweight runtime

Best for:

- inspection and analysis over hub-owned durable state
- planning
- review
- triage
- orchestration
- handoff generation
- policy checks
- background automation over hosted state

Properties:

- fast start
- low cost
- no shell
- no local package manager or git process
- operates directly on hub-owned durable state

Examples:

- direct hosted tools
- Dynamic Workers
- Codemode-style structured hosted execution

The exact hosted runtime may change over time.
What matters is that Tiller has a real lightweight execution tier that can act
on hub-owned durable state without booting a shell runtime.

### 2. Shell runtime

Best for:

- git operations when the workload is code-related
- tests and package managers when the workload is code-related
- dev servers and build debugging when the workload is code-related
- long-running shell-centric execution
- arbitrary CLI workflows

Properties:

- slower start
- higher cost
- real filesystem
- real process model
- real shell semantics

Examples from the current software-oriented product:

- Cloudflare container
- local Docker container via Tiller Host
- short-lived sandbox for merge/test/build tasks

Tiller may support multiple implementations of a runtime class, but the
important distinction is the class itself, not the exact backend.

Future harnesses may add more specialized executors, but they should still fit
under the same hub-owned workflow model.

## Why This Architecture Exists

This architecture is only worth the cost if it enables things that are hard in
execution-first systems.

The main benefits are these.

### 1. Runtime disposal

If compute does not own durable workflow state, runtimes can be treated as
disposable.

That makes it easier to:

- recover from runtime failure
- move work between machines
- retry on a different executor
- terminate stuck compute without losing the product record
- keep durable context while changing runtime class

The value is not abstract pluggability.
The value is disposability.

### 2. Cheap no-shell work

A large amount of useful work should happen before a shell starts.

Examples:

- classify a new task
- inspect durable workspace or artifact state
- find relevant files
- generate a plan
- run a review round
- summarize a failed execution
- draft a result artifact
- check policy or approval requirements

If the hub already owns the needed state, those tasks do not need a container.

This is one of the strongest reasons to keep state in the hub.

### 3. Per-step runtime selection

The hub should not have to pin an entire workflow to one runtime class.

A workflow may legitimately look like:

1. hosted planner reads durable workflow state and drafts a plan
2. hosted reviewer narrows the relevant working set
3. shell runtime executes the step that genuinely needs shell capabilities
4. hosted summarizer writes the final result artifact

That is a meaningful architectural advantage.
The system is choosing the runtime per step, not per session.

### 4. Cross-runtime workflows

Cross-runtime does not mean "different harnesses."
It means one workflow can move across execution environments with different:

- capability envelopes
- startup costs
- latency
- locality
- trust boundaries

Examples:

- hosted review -> shell execution -> hosted summary
- cloud shell -> local shell when private network access is required
- hosted planner -> short-lived git sandbox for merge simulation
- hosted triage -> no shell at all because the task can be resolved by artifacts and metadata alone

This is a central part of the north star.

### 5. One policy and observability plane

If all meaningful workflow state passes through the hub, then:

- approvals are centralized
- replay is centralized
- audit trail is centralized
- attachment and intervention are centralized
- multi-client visibility is centralized

The hub can keep one coherent record across unlike runtimes:

- task input
- planning
- approvals
- handoffs
- execution steps
- logs and summaries
- final status

Claude and Scion can both grow features in this direction.
The difference here is architectural: the hub is meant to be the system of
record, so those surfaces fall out of the same durable workflow model rather
than being layered around executor-owned state.

### 6. Policy before escalation

The hub can decide whether heavy compute is actually needed before paying for
it.

Examples:

- reject a dangerous action before any shell starts
- require human approval before a write-capable runtime boots
- route read-only questions to hosted tools only
- send trivial formatting or review work to a cheap runtime

This is a real cost and latency advantage.

### 7. Vendor independence at the workflow layer

This is subtle but real.

Claude's ecosystem is increasingly rich, but it is still Anthropic's stack.
Scion is increasingly rich, but it is still centered on containerized deep
agents and worktrees.

A hub-owned artifact and state model gives Tiller a chance to keep:

- repo state
- handoffs
- approvals
- session metadata
- orchestration

independent of any one vendor's session format or execution model.

That only matters if Tiller actually wants multi-vendor or mixed-runtime
operation.
If not, this benefit is theoretical.

### 8. Org-level product surfaces

A hub-first system is better suited for:

- team dashboards
- queueing and assignment
- scheduled and background work
- approvals by another user
- supervisor and operator views
- workflow-level SLAs and auditability

Those features can be added to execution-first systems too.
They are simply easier to make coherent when the durable truth already lives in
the hub instead of being spread across local terminals, worktrees, and
vendor-managed sessions.

## Concrete Examples

The architecture should make workflows like these natural.

### Example 1: Triage without a container

1. user pastes an error or issue
2. hosted runtime reads durable state and prior artifacts
3. hosted runtime identifies the likely next action
4. hosted runtime decides whether reproduction is required
5. only then does the hub boot a shell runtime if needed

If reproduction is not needed, the workflow ends without paying for shell
compute.

### Example 2: Plan first, execute later

1. hosted planner inspects canonical durable state
2. hosted review narrows the plan and validates risk
3. hub writes a durable handoff artifact
4. shell runtime is started only when the user actually chooses execution

This separates cognition and orchestration from shell execution.

### Example 3: Escalate from cloud to local

1. hosted runtime or cloud shell begins work
2. task hits a capability boundary such as private network access, local device
   access, or subscription-only routing
3. hub transfers durable workflow state to a local shell runtime
4. local shell continues execution
5. results return to hub artifacts and summaries

The workflow survives the runtime change because the runtime was never the
system of record.

### Example 4: Use the shell only for the shell parts

1. hosted runtime maps the current durable state and decides the task is real
2. shell runtime performs the part that truly needs shell capabilities
3. hosted runtime performs final review and writes the final artifact

The expensive runtime does only the part that truly needs it.

## Why This Is Different From Anthropic And Scion

All three systems can eventually ship many of the same visible features.
The architectural difference is where durable state lives and what that makes
easy.

### Anthropic / Claude Code style

Center of gravity:

- local machine sessions
- Anthropic-managed cloud sessions
- vendor-defined session and workflow surfaces

This makes it natural to optimize:

- a strong shell-first agent experience
- remote/local session continuity inside one vendor ecosystem
- rich vendor-native orchestration features

It makes hub-style routing harder because the durable workflow record is not
primarily vendor-neutral or runtime-neutral.
Cross-runtime and cross-vendor orchestration can exist, but it is more likely
to be layered around vendor-owned session models.

### Scion style

Center of gravity:

- containerized agents
- isolated worktrees
- agent runtime orchestration around deep shell execution

This makes it natural to optimize:

- multi-agent shell workflows
- container isolation
- worktree-centric execution
- telemetry around deep agent runtimes

It makes no-shell hosted work, workflow-level vendor neutrality, and hub-owned
artifacts harder because the worktree and container remain close to the center
of the system.

### Tiller style

Center of gravity:

- hub-owned workflow state
- hub-owned artifacts
- runtime-class routing
- disposable executors

This makes it easier to build:

- policy and observability once across unlike runtimes
- per-step escalation and de-escalation
- hosted work that avoids shell boot entirely
- runtime-neutral workflow records
- org-level control surfaces over mixed execution

This is the main architectural difference.
The claim is not that Tiller can have more features.
The claim is that this architecture makes a certain class of features easier to
make coherent.

## Why Workflow-Centric Is More Interesting

The important distinction is not whether a system can have sessions,
approvals, artifacts, or orchestration.
All serious systems can eventually add those features.

The more important question is:

- what is the primary durable object?

If the primary durable object is the session, then many higher-level features
end up being layered around executor state.

If the primary durable object is the workflow, then sessions become one view of
the work rather than the work itself.

That makes several things easier.

### 1. One work record can span many runtimes

The same work can move across:

- hosted runtime
- cloud shell
- local shell
- future specialized executors

without changing its identity.

That means runtime switching is just scheduling.
It is not a product-level state transition.

### 2. One policy and observability plane can cover everything

If the workflow is primary, then:

- approvals attach to the work, not the current executor
- replay attaches to the work, not the current terminal
- audit trail attaches to the work, not the current vendor session
- intervention and multi-client visibility attach to the work, not the current runtime

This is a cleaner foundation than stitching those surfaces around whichever
session happens to be alive.

### 3. Heavy compute becomes an implementation detail

If the workflow is primary, then a shell/container runtime is just one step in
the plan.

That makes it easier to:

- keep lightweight work at the edge
- escalate only when shell capabilities are actually needed
- de-escalate back to cheap hosted work after execution

The system is optimizing the workflow, not centering the heaviest executor.

### 4. Org-level surfaces grow more naturally

Dashboards, queues, assignment, approvals, scheduled work, SLA tracking, and
supervisor views are easier to build when they operate over workflow records
instead of over a pile of runtime-specific sessions.

The feature may still exist in session-centric systems, but here it is closer to
the center of the model.

### 5. Vendor independence becomes more realistic

If the workflow record is hub-owned, Tiller can keep:

- artifacts
- handoffs
- approvals
- routing history
- orchestration state

out of any one vendor's session abstraction.

That does not matter if Tiller only ever wants one vendor and one runtime
shape.
It matters a lot if Tiller wants mixed runtimes or mixed vendors later.

## What This Architecture Is Better At

This architecture is stronger when the product needs:

- many useful tasks to complete without shell boot
- centralized routing across runtime classes
- durable workflow artifacts independent of one executor
- centralized policy, approvals, and observability
- orchestration that survives executor replacement
- future vendor flexibility at the workflow layer
- org-level workflow surfaces built over one durable state model

It is weaker when the product mostly wants:

- a great single-agent shell experience
- local-first developer ergonomics
- minimal architectural surface area
- git/worktree behavior to come directly from git without app-owned mediation

This tradeoff should be accepted explicitly.

## Dynamic Workers And Hosted Runtimes

Dynamic Workers matter because they make the lightweight runtime class real.

Without a good hosted runtime tier, the architecture collapses toward:

- everything important eventually needs a shell
- the hub becomes mostly a relay around shell execution

With a good hosted runtime tier, the hub can:

- answer many questions without shell boot
- prepare structured work before shell escalation
- run cheap background workflows
- do orchestration and review without paying container startup cost

Dynamic Workers are not valuable because they replace containers.
They are valuable because they reduce unnecessary container usage.

## Latency

This architecture should be meaningfully better for latency on lightweight,
fast-turn workflows.

The strongest latency claim is not:

- "Tiller makes heavy compute fast"

The stronger claim is:

- Tiller keeps heavy compute off the critical path whenever possible

That matters most for workloads where the first useful result is more important
than raw shell throughput.

Examples:

- voice interactions
- lightweight planning
- triage
- review
- routing
- approvals
- artifact inspection

In those workflows, the ideal path is:

1. user input reaches the hub quickly
2. the hub already has the durable workflow state
3. a lightweight hosted runtime starts immediately
4. the system produces a useful first result or partial result
5. heavier compute is invoked only if needed

This is where the combination of:

- edge-hosted routing
- hub-owned durable state
- lightweight runtimes
- optional escalation

should produce a real latency advantage.

The architecture is especially well-suited for workloads like voice, where the
user experience depends heavily on:

- fast acknowledgement
- low-latency turn-taking
- rapid intent classification
- quick access to current workflow state
- immediate routing to the next action

Very little of that requires a shell runtime.

For those cases, Tiller should optimize for:

- low time to first useful work
- low end-to-end workflow latency
- low escalation rate into heavy compute

This is not the same as claiming the system will always beat shell-first
systems on heavy execution.
For shell-heavy or long-running tasks, the latency advantage may disappear.

The point is narrower and more important:

- when a workflow can begin and often finish inside the lightweight runtime
  tier, the hub-first architecture should be faster because it does not need to
  wait for heavy compute to become useful

## What This Architecture Does Not Mean

It does not mean:

- every backend is equally important
- Tiller needs endless runtime implementations
- Dynamic Workers should replace shell execution
- the hub should become a full git host
- executor-local state never exists

Executor-local state will always exist.
The point is that it should be subordinate, reconstructable, or disposable when
possible.

## The Cost Of This Decision

This architecture is expensive.
The system gives up many things that shell-first systems get naturally.

Tiller must explicitly own:

- workflow state models
- artifact formats
- approvals and policy
- lifecycle and replay contracts
- runtime routing
- escalation and de-escalation logic
- hosted-tool capability surfaces

Today many of those surfaces are code-oriented.
Over time they should be allowed to generalize beyond coding without changing
the hub-first architecture.

This is real complexity.
The architecture is only justified if Tiller actually exploits the benefits.

## Signs The Architecture Is Worth It

The architecture is worth it if Tiller can regularly do these things well:

- complete meaningful tasks with no shell boot
- choose runtimes per step rather than per long-lived session
- move work between runtime classes without losing workflow context
- preserve one coherent trace across hosted and shell execution
- apply approvals and policy centrally
- route work based on capability, cost, and latency rather than convenience

## Signs Tiller Is Just Rebuilding The Hard Way

The architecture is not paying off if most workflows still look like:

- boot one shell
- do all real work there
- store most meaningful state there
- use the hub mainly for terminal relay and status badges

If that is the dominant pattern, then Tiller is carrying control-plane
complexity without getting control-plane benefits.

## Durable Authorities

The north-star authority split should be:

### Hub-owned workflow state

Authoritative for:

- workflow identity
- task and handoff artifacts
- approvals and policy decisions
- session metadata and replay
- durable summaries and execution records

### Repo state

Authoritative for:

- canonical repo planning inputs for the current software product
- hosted review and browsing inputs for the current software product
- repo-level artifacts under `/.tiller/**` where applicable

### Env state

Authoritative for:

- the portable isolated working copy for the current software product
- env-local durable files that must survive runtime changes

### Executors

Authoritative only for:

- in-flight computation
- local process state
- temporary filesystem state
- ephemeral runtime-local caches

Executors should not be treated as the durable system of record.

## Implications For Future Work

New plans should generally follow these rules.

### 1. Model work as steps, not just sessions

The hub should be able to reason about:

- task type
- required capabilities
- read-only vs write
- latency sensitivity
- approval requirements
- escalation paths

### 2. Prefer capability-based routing

Routing should ask:

- does this step need git?
- does it need bash?
- does it need package managers?
- does it need private network access?
- can it run read-only?
- can it run async?

The answer should drive runtime choice.

### 3. Keep workflow records runtime-neutral

Artifacts, handoffs, approvals, and workflow metadata should not assume one
runtime class.

### 4. Keep hosted state strong

Hosted planning, review, and orchestration only work if the hub-owned state is
good enough to support them without booting a shell.

For the current product that mostly means repo and env state.
For future harnesses it may mean different durable state shapes, but the same
principle applies.

### 5. Treat shell compute as expensive and valuable

A shell runtime should be reserved for work that genuinely needs it.
Do not casually turn every question into a container boot.

### 6. Keep shared collaboration separate if it ships

Shared workspace collaboration is still a plausible future mode.
If it is built, it should remain a separate product mode with its own
authority and coordination semantics.

## Current Recommendation

Tiller should continue toward this architecture:

- hub-first control plane
- hub-owned durable workflow state
- hosted lightweight runtime for cheap and fast work
- shell runtime for heavy execution only
- per-step runtime routing based on capability, latency, and cost
- disposable executors
- centralized replay, policy, approvals, and artifacts

Coding is the first major application of this model, not its limit.

Tiller should not currently optimize around:

- making one shell runtime perfect at the expense of the hub model
- treating backend pluggability as the product thesis
- making Dynamic Workers replace shell execution
- turning the hub into a full git host

The north star is:

the hub owns the work, and runtimes are selected per step as disposable
executors.
