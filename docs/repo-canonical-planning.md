# Repo-Canonical Planning

This document describes the repo-canonical planning model used by `tiller-hub`.

## Why this exists

The product model is:

- `Plan` is repo-level.
- environments execute approved plans.
- when an environment finishes and commits back, that committed work becomes the repo's new current state.
- future repo-level plans should see that new committed state.

The old implementation did not match that model. It had two unrelated copies of repo code:

- env workspaces were cloned from GitHub `HEAD`
- the repo plan workspace was also cloned from GitHub `HEAD`

That created three problems:

1. `Plan` looked repo-scoped in the UI but was still mostly addressed through an env slug.
2. code-aware planning reviewed a cached repo snapshot rather than a first-class canonical repo state.
3. finishing work in an environment did not advance repo state.

The fix is to make the repo first-class inside Tiller.

## Core model

- `Repo` = Tiller's canonical committed code state for a project
- `Env` = a disposable working copy created from a repo revision
- `Session` = a live process running inside an env

`Plan` always reads the repo's canonical committed state.

It does not read:

- dirty env changes
- arbitrary live container drift

That is intentional. Uncommitted env work is private to the env until it is explicitly committed back.

## Authoritative state

The canonical source of truth is the repo workspace Durable Object keyed by normalized repo URL.

We reuse the existing repo plan workspace rather than creating a second repo-level file tree. The canonical repo workspace now contains both:

- committed repo files
- repo metadata and handoffs under `/.tiller/**`

Authoritative repo metadata lives inside the workspace:

- `/.tiller/repo/meta.json`
- `/.tiller/repo/revisions/<revisionId>.json`

The repo index in `ENVS_KV` (using the `repo:` key prefix) is index-only. It exists for discovery and sidebar listing, but it is not authoritative. If the index disagrees with repo metadata in the workspace, the workspace wins.

## Repo revisions

Tiller keeps a lightweight local revision model rather than a full Git implementation.

Each repo has:

- `repoId`
- `repoUrl`
- `currentRevisionId`
- timestamps
- last commit-back provenance

Each revision records:

- revision id such as `r1`, `r2`, `r3`
- parent revision
- source (`github-bootstrap` or `env-commit`)
- source env when relevant
- summary and timestamp

New handoffs are stamped with:

- `repoId`
- `repoRevisionId`

This lets the UI mark drafts and approved plans as outdated when the repo moves forward.

## Environment lifecycle

### Create env

New environments are created from the canonical repo workspace, not from GitHub `HEAD`.

During creation:

- Tiller ensures the repo exists and has canonical metadata
- canonical repo code is exported excluding `/.tiller/**`
- the env workspace is restored from that code snapshot
- the env records `repoId` and `baseRepoRevisionId`

Approved startup plans still materialize into `/.tiller/plan.md` inside the env after the code copy.

### Commit back

`Commit Back` is the explicit action that advances repo state.

Server-side rules:

- the env must exist
- it must not be legacy
- it must be stopped
- it must still be based on the repo's current revision

If those checks pass:

1. export env code excluding `/.tiller/**`
2. restore it into the canonical repo workspace while preserving canonical `/.tiller/**`
3. create the next repo revision
4. update repo metadata
5. update the env's `baseRepoRevisionId`
6. mark sibling envs stale if they were based on an older revision
7. broadcast a repo revision change event

### Reset to repo

`Reset to Repo` replaces env code with the canonical repo code while preserving env-local `/.tiller/**`.

This is the recovery path for stale or legacy envs.

## Planning and review behavior

The visible `Plan` experience stays repo-level.

- plan chat is keyed by repo, not env
- review and integration also operate repo-first
- planning and review always read the canonical repo workspace

They do not read env workspaces directly. This keeps planning deterministic and matches the product rule that only committed env work becomes repo state.

Drafts from an older repo revision stay visible but are marked outdated. Approved plans from older revisions can still be chosen manually, but they are never the default startup plan.

When the repo revision changes, the plan chat is not cleared. Instead, the UI shows a notice that the repo advanced and marks older artifacts outdated.

## Live updates

Commit-back broadcasts a `repo-revision-changed` WebSocket event.

The frontend uses that event to:

- update repo revision badges
- refresh repo and env state
- mark other envs stale
- show a repo-advanced notice in Plan if the currently open repo changed

## Current tradeoffs

This model intentionally favors clarity over Git-like sophistication.

Benefits:

- plans are naturally repo-scoped
- envs stay disposable
- code-aware planning has a deterministic source of truth
- future plans see committed env work even if it has not landed on GitHub `main`

Costs:

- dirty env changes are invisible to Plan
- env work must be explicitly committed back
- stale env commit-back is rejected instead of merged
- there is no rebase or merge engine in this phase

## Runtime note

Repo index entries share the `ENVS_KV` namespace, using the `repo:` key prefix to avoid collisions with env metadata. The index is non-authoritative — repo metadata in the canonical workspace is the source of truth.
