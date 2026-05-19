# Workflow Architecture

This document explains the workflow concept for `tiller-hub` in concrete terms.

It is not a proposal for a generic workflow engine.
It is a way of making the current architecture easier to reason about.

The key distinction is:

- `shared context`
- `concrete effort`
- `execution`

That distinction is what makes the workflow object useful.

## Core Idea

Tiller should distinguish between:

### 1. Shared context

This is the long-lived project surface that exists regardless of what anyone is
currently doing.

Examples:

- repo identity
- hosted workspace files
- canonical main state
- reusable plans
- long-lived artifacts
- saved memories and project context

Shared context answers questions like:

- what project is this?
- what files exist?
- what plans already exist?
- what is the canonical repo state?

### 2. Concrete effort

This is one specific attempt, investigation, or active piece of work against
that shared context.

Examples:

- execute a specific plan
- investigate a bug
- review a proposed change
- resume yesterday's coding effort

Concrete effort answers questions like:

- what are we trying to do right now?
- who is participating in this effort?
- which outputs belong to this attempt?
- is this effort active, blocked, completed, or abandoned?
- are these two sessions collaborating or are they separate attempts?

### 3. Execution

This is the live runtime attachment currently acting on the concrete effort.

Examples:

- a shell session
- a hosted agent run
- a voice session
- an env container

Execution answers questions like:

- who is doing the work right now?
- where is it running?
- what runtime capabilities are available?

## The Workflow Object

A `workflow` is the durable object that represents one concrete effort.

It is not:

- the repo
- the workspace
- the plan
- the session
- the env

It sits between shared context and execution.

The workflow is the object that says:

- this is the work we are doing
- this is the goal
- these are the current participants
- these are the outputs so far
- this is the current status

That is why it is the right place to group sessions, artifacts, and reports
that belong to one attempt.

## Vertical Layers

The clearest way to view the system is as vertical layers of authority.

### Layer 1: Shared context

This is the stable background.

In Tiller today, this mostly means:

- `Repo`
- `WorkspaceDO`
- canonical repo metadata
- reusable plan artifacts
- long-lived project artifacts and memories

### Layer 2: Concrete effort

This is the workflow layer.

In Tiller, a workflow should represent:

- one concrete run of work against a repo
- optionally seeded by a plan artifact
- with its own status, outputs, and attached participants

This is the layer that is currently too implicit.

### Layer 3: Execution

This is the live runtime layer.

In Tiller today, this includes:

- `StoredSession` / `HubDO` session state
- `Env`
- `EnvLifecycleDO`
- hosted agent runs
- voice runtime attachments

These things are real and important, but they should not be the primary durable
definition of the work.

## Horizontal Participants

Within one workflow, several participants may be active at once.

These are horizontal peers inside the same concrete effort.

Examples:

- a planner harness
- a coding session
- a reviewer harness
- a voice or operator surface

They are all participating in the same workflow, even if they use different
runtimes.

This is important because the workflow is not a purely sequential pipeline.

One workflow may have:

- multiple live sessions
- multiple active investigations
- one writer and several readers
- a paused shell session with a hosted reviewer still working
- a resumed effort after the previous executor detached

The workflow is the shared durable center that makes that activity coherent.

## Mapping To Current Tiller Concepts

This is how the current codebase concepts fit into the model.

### Shared context

- `Repo`
  Canonical project identity and canonical repo state.
- `WorkspaceDO`
  Hosted file state and hosted context.
- reusable plan artifacts
  Durable proposals that may seed future work.
- long-lived memories and project summaries

### Concrete effort

- `Workflow`
  One concrete run of work against shared context.

This is the missing explicit object that should group:

- active participants
- attempt-level artifacts
- current status
- attempt-level summaries and reports

### Execution

- `HubDO` session state
  Live chat, replay, permissions, runner relay.
- `Env`
  Shell-oriented execution surface.
- `EnvLifecycleDO`
  Runtime authority for env lifecycle.
- hosted agent runtime
  Direct-tools or Codemode style execution.
- voice runtime
  Realtime voice-specific execution surface.

### Reusable behavior

- `Harness`
  The reusable way a participant works on a workflow.

Examples:

- planner harness
- coding harness
- reviewer harness
- voice supervisor harness

### Durable outputs

- `Artifact`
  Durable output attached either to shared context or to a workflow.

Important distinction:

- a reusable saved plan usually belongs to shared context
- a report, review round, execution summary, or checkpoint usually belongs to a
  concrete effort

## Why Repo Or Workspace Cannot Own Everything

The repo and workspace are too broad.

They represent the shared world, not one specific attempt inside that world.

One repo can have many different efforts:

- investigate CI
- execute onboarding fix
- review auth changes
- run a coding session from a saved plan
- run two competing attempts from the same saved plan

If the repo or workspace owns all work directly, then the system has no natural
place to represent:

- one attempt versus another
- collaboration versus independent attempts
- outputs belonging to a specific run
- current participants in one piece of work

That is the gap the workflow object fills.

## Why Plan Is Not Enough

A plan artifact is not the same thing as a workflow.

A plan is usually:

- reusable
- durable
- repo-level
- a proposed approach

A workflow is:

- dynamic
- attempt-specific
- attached to current participants
- responsible for current status and outputs

One plan can seed many workflows.

That is a normal and useful distinction.

## Concrete Examples

### Example 1: One plan, two separate attempts

Shared context:

- repo `repo-1`
- plan artifact `plan-7`

Concrete efforts:

- workflow `wf-1` starts from `plan-7`
- workflow `wf-2` also starts from `plan-7`

Execution:

- session `sess-a` is attached to `wf-1`
- session `sess-b` is attached to `wf-2`

This means both efforts share the same repo and the same seed plan, but they
are not the same attempt.

That distinction is difficult to express cleanly without a workflow object.

### Example 2: One plan, one collaborative attempt

Shared context:

- repo `repo-1`
- plan artifact `plan-7`

Concrete effort:

- workflow `wf-1` starts from `plan-7`

Execution:

- coding session `sess-a` is attached to `wf-1`
- reviewer session `sess-b` is also attached to `wf-1`
- a hosted planner or summarizer may also attach to `wf-1`

This means multiple participants are collaborating on one concrete effort.

Again, the repo and the plan do not express that relationship clearly.
The workflow does.

## The Hub-And-Spoke Shape

Without a workflow object, relationships tend to become pairwise:

- plan -> session
- session -> env
- session -> artifact
- artifact -> repo
- reviewer -> session
- voice -> session

That grows awkward as the product adds more harnesses and more execution
surfaces.

With a workflow object, the shape becomes more hub-and-spoke:

- repo -> workflow
- plan artifact -> workflow
- session -> workflow
- env -> workflow
- artifact -> workflow
- hosted harness -> workflow
- voice surface -> workflow

This is easier to reason about because the shared grouping key is explicit.

## What This Changes In Practice

The workflow concept does not replace the current architecture.

It clarifies the authority boundaries between concepts that already exist.

### Shared context still owns

- files
- canonical repo state
- reusable plans
- long-lived project memory

### Workflow should own

- current goal
- current status
- attached participants
- attempt-level artifacts
- effort-level summaries and reports

### Execution should still own

- terminal transcript
- runtime-local state
- temporary process state
- live interaction and transport

This is the practical meaning of the model.

## What A Workflow-First Tiller Means

A workflow-first Tiller is not one where everything becomes a workflow engine.

It is one where:

- shared context stays shared
- concrete efforts become explicit
- execution surfaces attach to efforts instead of impersonating them

The shortest useful definition is:

> Shared context is the world.  
> A workflow is one concrete effort in that world.  
> Sessions, envs, and other runtimes are live participants attached to that effort.

That is the architectural role of the workflow concept in Tiller.
