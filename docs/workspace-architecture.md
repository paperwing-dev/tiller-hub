# Workspace Architecture Decisions

> Note
> This document reflects the earlier single-DO design where workspace state
> lived inside `SandboxDO`. The current implementation uses a separate
> `WorkspaceDO` plus pluggable runner backends. For the current architecture,
> see [runner-backends.md](./runner-backends.md).

Why we built the workspace layer the way we did. Each section covers a decision,
what we considered, and what convinced us.

---

## The Problem

Tiller-Hub stores workspace files in R2, accessed by rclone from inside CF
Containers. The Worker has zero awareness of what files exist — R2 is a flat
object store with no file abstraction. This means:

- You can't read or modify workspace files without booting a full Linux container
- Any "light mode" (code review, chat, analysis) requires the same cold boot
- The Worker can't offer a file browser, search, or any file-aware UI
- Two independent systems (rclone in the container, R2 as storage) with no
  shared abstraction

---

## Decision 1: DO SQLite as source of truth

**What we chose:** Cloudflare's `Workspace` class (from `agents/experimental/workspace`)
stores files in Durable Object SQLite. Files < 1MB live inline in SQLite. Files
>= 1MB overflow to R2 automatically. The DO owns the files. The container syncs
from the DO, not from R2.

**What we considered:**

- **R2 as source of truth (status quo):** Files in R2, rclone syncs to containers.
  Problem: the Worker can't read files, so any light mode would need its own R2
  client. You'd end up with two independent representations of the same workspace
  that need reconciliation.

- **R2 as source of truth with Workspace as metadata cache:** Force all files to R2
  by setting `inlineThreshold: 0`. Workspace becomes a metadata index only. Both
  container (via rclone) and dynamic worker (via Workspace) read from R2.
  Problem: every file read from the dynamic worker is an R2 GET — slower than
  SQLite for the light-mode use case, which is the whole point.

**Why SQLite wins:** Most source code files are well under 1MB. SQLite reads are
sub-millisecond from within the DO. The dynamic worker gets instant file access
with no network calls. The container just needs a sync mechanism to/from the DO,
which replaces rclone. Single source of truth, no dual-state reconciliation.

Importantly, this doesn't lock us into JavaScript. The Workspace is just a file
database — it stores bytes and doesn't care what's in them. Containers still run
full Linux with whatever tools you need. The only thing that changed is where
files are stored and how they get to the container.

---

## Decision 2: One DO per workspace (Workspace embedded in SandboxDO)

**What we chose:** Embed the `Workspace` instance directly in `SandboxDO`
(which extends `Container`) rather than creating a separate `WorkspaceDO`.

**What we considered:**

- **Two DOs per workspace:** `WorkspaceDO extends Agent` for files,
  `SandboxDO extends Container` for the Linux container. Clean separation, but
  means cross-DO communication for sync, two objects to manage per workspace,
  and more complex routing.

- **One DO (chosen):** We investigated whether `Container` satisfies the
  `WorkspaceHost` interface that `Workspace` needs. It turns out `Container.sql()`
  and `Agent.sql()` have identical implementations — both are tagged-template
  methods that call `this.ctx.storage.sql.exec()` and spread the cursor into an
  array. The adapter is a single type cast: `this as unknown as WorkspaceHost`.

**Why one DO wins:**

- No cross-DO communication. The container syncs with its own DO.
- No extra DO binding in wrangler config. `SANDBOX` already exists.
- No SQLite conflicts: Container uses `container_schedules`, Workspace uses
  `cf_workspace_default`. Completely disjoint namespaces.
- SQLite belongs to the DO, not the Linux container. It works regardless of
  whether the container is running — which is exactly what light mode needs.

---

## Decision 3: Container sync via `outboundByHost`

**What we chose:** Use `Container.outboundByHost` to intercept outbound HTTP from
inside the container. The container fetches `http://workspace.internal/manifest`
and SandboxDO handles it directly — no public API, no auth tokens.

**What we considered:**

- **Public HTTP API with CF Access service tokens:** Container calls
  `https://tiller.example.com/api/workspace/:slug/*` with service token headers.
  Works, but requires passing credentials to the container, adds network latency
  through the public internet, and needs a separate auth mechanism.

- **rclone against a WebDAV interface on the DO:** We researched whether rclone
  could talk to the DO via WebDAV instead of S3. Finding: rclone's HTTP remote
  is read-only (can't upload). WebDAV would work but requires implementing
  PROPFIND/MKCOL with XML parsing — 500-800 lines of code for a protocol adapter
  we don't need.

- **rclone against R2 (status quo):** Works today but requires R2 credentials in
  the container, and R2 is no longer the source of truth.

**Why the public API wins:** The container already calls the Worker's public API
for boot progress reporting — same auth pattern (CF Access service token headers).
The workspace API routes are needed regardless for light-mode UI and file
browsing, so the container reuses them for sync. No new auth mechanism, no new
infrastructure. We initially investigated `Container.outboundByHost` for direct
DO interception but it doesn't exist in the current `@cloudflare/containers`
package (v0.1.1). The public API approach is simpler and proven.

---

## Decision 4: Manifest diff + tar streaming for sync

**What we chose:** Manifest-based diffing to determine what changed, tar streaming
for bulk file transfer.

**What we considered:**

- **Full tar each way:** Stream entire workspace as tar on boot, stream it all back
  on shutdown. Simple (one request each direction) but wasteful for periodic sync —
  copying 50MB every 5 minutes when only 3 files changed. We discussed this
  multiple times and rejected it each time for the periodic case.

- **File-by-file download:** Fetch manifest, diff locally, download changed files
  one HTTP request at a time. Too many round trips for initial sync of a full repo.

- **Manifest diff + tar (chosen):** Best of both. Boot: fetch manifest, then stream
  all files as one tar. Periodic sync-up: `find -newer /tmp/.last-sync` to detect
  local changes, pack only changed files into a tar, POST once. Sub-second for a
  typical 5-file changeset.

**Why it wins:** Efficient for both cases. Boot is one bulk download. Periodic sync
is cheap — only changed files, one request. No rclone dependency. Implemented as a
~200 line Node.js script (`workspace-sync.mjs`) — the container already has
Node.js 22.

---

## Decision 5: `inlineThreshold: 1_000_000` (1MB)

**What we chose:** Override Cloudflare's default 1.5MB inline threshold to 1MB.

**Why:** DO SQLite has a hard 2MB row limit. Workspace stores binary file content
as base64, which inflates size by ~33%. A 1.5MB binary → ~2.0MB of base64 — right
at the limit. With path and metadata columns in the same row, it can exceed 2MB
and crash.

At 1MB: 1MB binary → ~1.33MB base64 → safely under 2MB. The trade-off (slightly
more files go to R2) is negligible — very few source code files are between 1MB
and 1.5MB.

---

## Decision 6: No `.git/` in workspace

**What we chose:** Don't store `.git/` directory in the workspace.

**Why:** GitHub's tarball API (used for workspace init) doesn't include `.git/`.
Storing `.git/objects/` would massively bloat the workspace — thousands of small
files, most of which are never read. The current rclone config already excludes
`.git/objects/` for this reason.

For light mode: doesn't need git history. For container mode: can `git clone
--depth 1` locally if git operations are needed (Claude Code uses git).

---

## Decision 7: No migration, delete existing environments

**What we chose:** Delete all existing environments and start fresh rather than
building migration logic.

**Why:** There are few enough existing environments that migration code isn't worth
writing and debugging. A `migrate-from-r2` endpoint would need to scan R2 objects,
write them to the DO, handle errors, and clean up — all for a one-time operation.
Faster and safer to just start over.

---

## Decision 8: No rclone

**What we chose:** Remove rclone entirely from the container.

**Why:** rclone was the sync engine for the R2-based model. With DO SQLite as
source of truth and `outboundByHost` for container-to-DO communication, rclone
has no role. Its capabilities (checksum diffing, parallel transfers, S3 protocol)
are replaced by the manifest-diff + tar-streaming approach over a direct DO
connection.

This also removes the rclone install step from the Dockerfile (saves image size)
and eliminates R2 credentials from the container environment.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 SandboxDO                     │
│  (extends Container, one per workspace slug)  │
│                                               │
│  ┌───────────────────────────────────────┐    │
│  │  Workspace (DO SQLite + R2 overflow)  │    │
│  │  - readFile, writeFile, glob, bash    │    │
│  │  - files < 1MB: inline in SQLite      │    │
│  │  - files >= 1MB: R2 (automatic)       │    │
│  └───────────────────────────────────────┘    │
│                                               │
│  Container lifecycle: start / stop / status   │
│                                               │
│  outboundByHost: "workspace.internal"         │
│  ├─ /manifest  → file list with sizes/mtimes  │
│  ├─ /download  → stream tar of all files      │
│  └─ /upload    → extract tar, write files     │
│                                               │
│  Light mode (Phase 3):                        │
│  - Chat with Claude via Anthropic SDK         │
│  - Tools map to Workspace methods             │
│  - bash() via @cloudflare/shell               │
└───────────────┬──────────────────────────────┘
                │ outboundByHost
                │ (http://workspace.internal/*)
     ┌──────────▼──────────┐
     │   Linux Container    │
     │                      │
     │   workspace-sync.mjs │
     │   ├─ sync_down()     │
     │   └─ sync_up()       │
     │                      │
     │   /workspace/        │
     │   tiller-harness + Claude  │
     │   startup diagnostics│
     └──────────────────────┘
```

External access (light mode UI, file browsing):
```
Browser → Worker (Hono) → SandboxDO RPC → Workspace methods
```
