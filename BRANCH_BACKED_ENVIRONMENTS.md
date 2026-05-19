# Branch-Backed Environments

> Historical note: the snapshot-backed env model described below is superseded
> by [plans-to-do/repo-git-workspace-envs.md](../../plans-to-do/repo-git-workspace-envs.md).
> Keep this document for reference only.

This document describes a proposed source-control model for Tiller that keeps the current repo/plan/environment UX, replaces `promote` / `reconcile` with normal git language, and avoids introducing a second canonical repo authority.

The main simplification in this version is:

- canonical repo `main` stays hosted and readable by the hub
- environments become opaque branch-backed workspaces
- environment durability comes from explicit saved snapshots, not from file-by-file hosted mirrors

## Why we are doing this

Tiller's current isolated environment model has drifted into re-implementing git concepts with custom product language:

- local changes vs promotable changes
- ahead/behind semantics
- custom merge and conflict behavior
- repo revision chains and sync-state logic

That has two costs:

- the UX does not feel like normal development
- the implementation is carrying custom SCM logic we do not want long-term

At the same time, the current app shape is good and should be preserved:

- repos are the top-level object
- `Plan` is repo-scoped
- environments are the thing the user opens and works in
- the harness view is centered on an environment, not on a separate branch-management screen

The important product constraint is narrower than it first seemed:

- the hub needs durable access to canonical repo files
- the hub does not need live hosted access to env-local dirty files
- the hub does need durable access to agent/session transcripts

That leads to a cleaner split:

- canonical repo state stays hosted in WorkspaceDO
- environment branch state lives as saved env snapshots
- agent communication and transcripts live in the hub/session layer, not in env file storage

## Product model

In v1, the simplest model is:

- `environment == branch-backed workspace`
- one repo has one canonical `main`
- each environment has one visible branch name

The branch is real and visible to the user, but the environment remains the primary product object.

That means:

- creating an environment from a plan or task also creates its branch
- opening an environment is how the user opens that branch-backed workspace
- deleting an environment also deletes that branch state in v1

There is no separate first-class "workstream" object yet.

## UX

### What stays the same

- repos stay grouped in the sidebar
- `Plan` stays repo-scoped
- environments stay listed under their repo
- opening an environment shows the harness/session view

### What changes

Each environment now exposes a branch identity.

A typical env card or header should show:

- environment label
- branch name
- harness
- runtime state
- branch state relative to `main`

Example:

- env: `auth cleanup`
- branch: `feat/auth-cleanup`
- harness: `codex`
- runtime: `Active`
- branch state: `Ready to merge`

### Primary user actions

Per environment:

- `Start`
- `Stop`
- `Promote to Main`
- `Reset to Main`
- `Delete`

Optional convenience actions:

- `Rename Branch`
- `Copy Branch Name`

These actions may exist as buttons, but the product should also support them as normal agent/chat requests:

- "promote this to main"
- "reset this to main"
- "delete this env"

The important point is that the user does not need to manage git through a control-heavy UI.

### User-facing status

Keep runtime status and branch status separate.

Runtime status:

- `Stopped`
- `Starting`
- `Active`
- `Failed`

Branch status badges:

- `Up to date`
- `Behind main`
- `Ready to merge`
- `Needs attention`

Transient activity:

- `Merging...`
- `Updating...`

Environments are allowed to fall behind `main`. Catching up is explicit. There is no requirement to auto-merge or auto-rebase envs in the background.

## Architectural decisions

### 1. Keep one canonical repo authority

The canonical source of truth remains the repo workspace in Tiller.

- canonical `main` lives in the repo WorkspaceDO
- repo planning continues to read canonical `main`
- there is no long-lived master git service
- there is no second authoritative repo copy that must stay in sync with WorkspaceDO

This preserves the strongest part of the current repo-canonical planning model.

### 2. Keep the hosted file layer for canonical repo state, not for active env state

This proposal does not replace the current WorkspaceDO + R2 file architecture for the repo.

The hosted file layer remains responsible for:

- canonical repo files
- repo-level `Plan`
- plan and handoff artifacts
- file-aware UI and hosted tools that operate on canonical code

This proposal does change the role of env persistence:

- the hub no longer needs live hosted access to env-local dirty files
- env state does not need to be mirrored file-by-file while the env is running
- env durability can be handled separately from canonical repo hosting

So the product split becomes:

- repo `main` is hosted project state
- envs are execution workspaces

### 3. Use real git inside environments

While an environment is running, it should use a normal git repository in `/workspace`.

Agents can use normal git commands:

- `git status`
- `git diff`
- `git add`
- `git commit`
- `git stash`
- `git log`

We want git behavior to come from git, not from Tiller recreating it with custom metadata.

### 4. Persist each env as one opaque saved workspace

The main simplification in this proposal is:

- do not restore an env from hosted files plus a separate git artifact
- do not reconstruct branch state from `base + checkpoint + working tree`
- do not build a partial git host in Tiller

Instead, each saved env state is one opaque snapshot artifact containing:

- workspace files
- `.git`
- save metadata

That means a saved env restore point is one coherent unit, not two independent persistence planes that have to be stitched back together.

The practical effect is:

- real commits survive stop/start
- merge conflicts can survive stop/start
- staging state can survive stop/start
- branch identity survives stop/start

This is intentionally different from the older rejected "full tar every 5 minutes" idea. The old objection was about using full tar as the normal continuous sync path. This proposal uses opaque saved snapshots only at explicit save boundaries.

### 5. Save envs only at explicit boundaries

Authoritative env durability should come from explicit save points, not periodic sync.

Trusted save boundaries should be:

- env stop
- successful `Promote to Main`
- optional future explicit "save now" behavior if needed

This means:

- the current 5-minute env file sync is no longer part of the correctness model
- branch restore points come from saved env snapshots
- crash recovery expectations become tied to the most recent completed save

In v1, the simplest version is:

- no periodic env mirror is required
- save on explicit boundaries only

If later needed, a best-effort background save can be added, but it should not be treated as the thing that makes branch state correct.

### 6. Keep the supported git surface narrow across stop/start

This model should support the common git states that matter for agent workflows:

- normal commits
- staged changes
- branch refs
- merges
- merge conflicts

It should not promise perfect stop/start fidelity for every obscure git workflow in v1, such as:

- rebase in progress
- cherry-pick in progress
- bisect
- other sequencer-heavy flows

That keeps the architecture bounded and avoids accidentally turning Tiller into a full git host.

### 7. Fail closed and rebuild explicitly

If env restore looks wrong, Tiller should not try clever repair.

The default behavior should be:

- restore if the saved env snapshot is valid
- if restore fails or metadata looks wrong, mark the env `Needs attention`
- offer `Rebuild from Main`

The product goal is not "never fail." It is "fail in a way that is understandable and recoverable."

### 8. Keep transcripts and coordination separate from env file persistence

The hub still needs durable access to what agents are saying.

That should remain a hub/session responsibility, not an env file-storage responsibility.

In v1:

- session transcripts continue to live in the hub/session layer
- the hub can still observe agent output and user input
- coordination between multiple agents remains container-local

That means:

- agents in one env can coordinate inside the same container
- the env filesystem is not used as the communication bus
- cross-env or cross-container coordination can be added later through the hub if needed

For now, container-local coordination is enough.

### 9. Promote happens in short-lived sandboxes

There is no permanent merge service.

`Promote to Main`:

- restore canonical repo `main`
- restore the env snapshot
- merge env branch into `main`
- if clean:
  - update canonical repo files in WorkspaceDO
  - update canonical repo git state
  - mark env as merged or leave it open depending on product choice
- if conflicted:
  - leave canonical `main` unchanged
  - return the env to `Needs attention`

This keeps merges deterministic without introducing a long-lived master git container.

### 10. GitHub is not the live source of truth

In this proposal:

- GitHub is not where active env branches live
- GitHub is not the live backing store for env state
- GitHub remains an external publish boundary

This avoids:

- branch spam on GitHub
- accidental CI noise
- coupling internal env lifecycle to remote repo workflow

## Lifecycle flows

### Create environment

When creating an environment from a repo plan or task:

1. derive the new env metadata and branch name
2. restore canonical `main` into a temporary git sandbox
3. create the env branch from `main`
4. materialize the working copy
5. save the initial env snapshot

Result:

- the user gets a new environment
- that environment has a visible branch name
- the harness starts from a real branch-backed workspace

### Start environment

When an environment starts:

1. restore the latest env snapshot into `/workspace`
2. verify the saved branch metadata is consistent enough to restore
3. check out the env branch
4. start the harness

No file-by-file env mirror is required for restore.

### Stop environment

When an environment stops:

1. archive the workspace and `.git` into a new env snapshot
2. persist save metadata such as branch name, HEAD, and timestamp
3. mark that save as the current authoritative restore point

This is the main durability boundary for branch state.

### Promote to Main

When the user or agent asks to promote an env into canonical `main`:

1. restore canonical repo `main`
2. restore the env snapshot
3. merge the env branch into `main`
4. if clean:
   - write the merged repo files back to WorkspaceDO
   - persist updated canonical repo git state
   - update repo revision metadata
5. if conflicted:
   - leave canonical `main` unchanged
   - mark the env `Needs attention`

After merge, repo-level `Plan` immediately reads the new canonical `main`.

## What stays unchanged

- repo-level `Plan`
- repo grouping and env grouping in the UI
- WorkspaceDO as the canonical repo file storage layer
- plan artifacts, handoffs, and memories under `/.tiller/**`
- env lifecycle actions such as create/start/stop/delete
- the idea that users open environments, not abstract branch screens
- hub/session transcript infrastructure

## Main downsides

This plan is much cleaner than a master git container, but it still has real architectural costs.

### 1. Opaque env snapshots can be large and slower to save/restore

Persisting a whole env workspace plus `.git` is much simpler semantically, but it can be heavier operationally.

Implications:

- long-lived envs can accumulate larger save artifacts
- start/stop may be slower than the current incremental env mirror
- storage retention and pruning policies may eventually be needed

### 2. Unsaved running changes are more vulnerable to crashes

Because env durability comes from explicit save boundaries:

- a clean stop is durable
- update/merge completion is durable
- a hard crash between saves can lose more recent work

This is a real tradeoff for the simpler architecture.

### 3. The hub loses direct file-level visibility into envs

This is intentional, but it is still a product tradeoff.

Implications:

- the hub can read canonical repo `main` directly
- the hub cannot treat env-local dirty files as a hosted file browser surface
- if you want to inspect env work, you generally open the env

That is acceptable in this model, but it is a real change.

### 4. Merge/update orchestration still needs queueing

Even without a master git service, two envs cannot merge into canonical `main` at the same time.

The hub still needs:

- per-repo serialization for merge/update operations
- deterministic success/failure reporting
- clear conflict handling

### 5. This is still not a full git host

The product is exposing real branches to the user, but Tiller is not trying to become a full git hosting platform.

That means v1 should stay narrow:

- one canonical `main`
- env branches created from `main`
- merges back into `main`
- no branch-to-branch merges
- no force-push semantics
- no advanced remote management model

### 6. Env and branch lifecycles are intentionally coupled

This is a simplifying choice, but it has consequences:

- deleting the env also deletes the branch-backed workspace
- there is no reopen-a-branch-without-the-env flow in v1
- there is no multiple-envs-on-one-branch flow in v1

### 7. Recovery paths still need to exist

Even with opaque env snapshots, Tiller needs explicit fallback behavior for:

- corrupted env save artifacts
- interrupted merge/update operations
- unsupported git stop/start states

The product should assume that `Rebuild from Main` remains an essential escape hatch.

## Why this is still the preferred direction

Compared to the current model, this proposal:

- replaces unfamiliar SCM language with familiar git language
- keeps the current repo/plan/env UX shape
- avoids re-implementing git semantics in application logic

Compared to the "git beside hosted env files" variant, this proposal:

- removes the hardest coherence problem
- avoids restoring envs from two different persistence planes
- no longer depends on periodic env file sync for branch correctness

Compared to the rejected master git container idea, this proposal:

- keeps one canonical repo authority
- avoids a permanent second repo system
- scopes git complexity to env save/restore and short-lived merge sandboxes

That makes it the best balance we have found so far between:

- user familiarity
- architectural simplicity
- fit with the existing Tiller app

## Current recommendation

Proceed with an env-first, branch-backed model where:

- environments remain the primary UX object
- each env has a visible branch name
- canonical repo `main` remains hosted in WorkspaceDO
- environments are restored from opaque saved env snapshots
- env durability comes from explicit save boundaries, not periodic file mirroring
- git is real inside envs
- environments may fall behind `main` until explicitly updated
- hub/session transcripts remain durable and independent of env file persistence
- multi-agent coordination stays container-local for now
- merge/update operations run in short-lived sandboxes

This gives the product a branch-based workflow without requiring users to manage git state through a heavy UI and without forcing Tiller to become a full git server.
