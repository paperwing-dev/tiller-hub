# Tiller Hub Live Sync

This document explains how repo and env state syncing works in `tiller-hub` after the authoritative-summary refactor.

## Goals

- Keep repo/env UI state live across tabs without expensive collection polling.
- Make websocket updates authoritative for normal operation.
- Keep recovery cheap and targeted when websocket delivery is missed or delayed.
- Avoid stale overwrites from out-of-order refreshes.

## High-Level Model

There are now four websocket messages for repo/env state:

- `env-upsert`
- `env-remove`
- `repo-upsert`
- `repo-remove`

The server broadcasts full entity summaries after visible state changes. The client keeps central `envs` and `repos` stores in `src/useLiveSyncStore.ts` and applies every update through the same upsert/remove path.

`repo-main-changed` still exists, but it is no longer a general sync mechanism. It is only used for diff-style plan notifications such as “main changed from env X”.

## Authoritative State

### Server

The server writes persisted state first, then broadcasts a projected summary:

- Envs use `persistEnvSnapshot(...)` in `api/env/routes.ts`
- Repos use repo persist helpers plus `broadcastRepoSummary(...)` in `api/repo/routes.ts`

Important rules:

- Every env write stamps `updatedAt`
- Every repo write stamps `updatedAt`
- Websocket payloads use the same summary shape as REST snapshots
- Repo delete emits attached `env-remove` events before `repo-remove`

### Client

The client sync layer is split into:

- `src/useLiveSyncStore.ts` for the hook, watchdogs, targeted recovery, and store updates
- `src/live-sync-store.ts` for pure reconciliation helpers and selection cleanup
- `src/env-state.ts` for normalized entity upsert/remove helpers and branch-status selectors

Each upsert is guarded by `updatedAt`:

- newer or equal timestamp wins
- older snapshot is ignored

This applies to both websocket updates and recovery fetches.

## Websocket Flow

Normal operation is:

1. A repo/env mutation persists server state.
2. The server broadcasts `*-upsert` or `*-remove`.
3. `App` receives the event through `createReconnectingWebSocket(...)`.
4. `useLiveSyncStore` applies the event through the guarded upsert/remove helpers.
5. Views render from the central store.

The views do not maintain their own shadow copies of repo/env state.

## Full Refreshes

Full collection refreshes still exist, but only as snapshot/recovery paths:

- initial page load
- websocket reconnect
- explicit/manual recovery

They do **not** replace the store wholesale.

Current behavior:

1. Fetch the full list from REST.
2. Merge each fetched entity through the same guarded upsert path.
3. For entities missing from the collection response, run targeted verification fetches:
   - `fetchEnv(hubUrl, slug)`
   - `fetchRepo(hubUrl, repoId)`
4. Only remove an entity if the targeted fetch confirms it is gone.

This prevents an older collection snapshot from clobbering newer websocket state.

## Targeted Watchdogs

The old 3-second collection polling loop and 60-second env polling loop are gone.

Instead, `useLiveSyncStore` starts per-entity watchdogs only while an entity is transitional.

### Env watchdog trigger

An env gets a watchdog when:

- `status` is `creating`
- `status` is `starting`
- `status` is `saving`
- `status` is `stopping`
- `status` is `deleting`
- `scmOperationType` is non-null
- `githubPublishStatus` is `publishing`
- `githubPublishOperationId` is non-null

### Repo watchdog trigger

A repo gets a watchdog when:

- `gitStatus === "pending"`

### Watchdog cadence

The current backoff schedule is:

- 10s
- 30s
- 60s
- 120s
- 120s thereafter

Each watchdog performs a targeted entity fetch, not a collection refresh.

Watchdogs stop when:

- the entity reaches terminal state
- the entity is removed
- a newer websocket update already resolved the transition

## Selection Behavior

The central store also owns selection cleanup:

- removing an env clears env selection for that slug
- removing an env clears a session selection only if that session was env-backed
- removing a repo clears plan selection for that repo
- when an env stops, an active session selection for that env is moved back to env view

Standalone local sessions are not treated as envs and should survive env refreshes.

## Branch Status

The UI does not blindly trust persisted `env.branchStatus`.

Displayed branch status is derived client-side from:

- env raw SCM fields
- repo `mainCommit`

The selector lives in `src/env-state.ts` and uses shared SCM logic from `api/scm/model.ts`.

This keeps branch display cheap and consistent without requiring repo-enrichment reads on every broadcast.

## Repo Shape

Repo summaries are intentionally lightweight.

The live sync model no longer depends on expensive server-side enrichment like repo env counts or approved-plan summary flags. The sidebar derives env count from the env store. Plan-related state still comes from targeted plan/handoff fetches.

## UI Actions

Typical action behavior:

- Create repo/env:
  - use the API response immediately
  - websocket events reconcile other tabs
- Start/stop/delete env:
  - rely on the live store plus targeted env watchdogs
- SCM actions:
  - rely on live env/repo upserts plus targeted entity refresh callbacks where needed
- Repo delete:
  - initiating tab removes the repo/envs from the central store immediately from the delete response
  - other tabs learn through `env-remove` and `repo-remove`

## Invariants

These are the main invariants to preserve if this code changes:

- All visible repo/env state changes must emit authoritative websocket summaries.
- REST snapshots and websocket summaries must stay shape-compatible.
- Full refresh must merge through timestamp-guarded upserts, never blindly replace.
- Missing entities from a collection snapshot must be verified before removal.
- `repo-main-changed` is for plan notifications, not generic repo/env syncing.

## Known Simplifications

The current implementation still has some pragmatic leftovers:

- `repo-main-changed` still coexists with the new summary protocol for plan UX
- the client store is a custom hook plus pure helpers, not a separate state library or reducer framework

Those are structural cleanups, not core sync behavior.
