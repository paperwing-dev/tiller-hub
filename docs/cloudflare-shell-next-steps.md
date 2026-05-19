# @cloudflare/shell — Next Steps

## Why adopt it

`@cloudflare/shell` provides a single persistence layer for workspace files, backed by
DO SQLite (metadata) + R2 (file content). Both runtime tiers — CF Containers and Dynamic
Workers — can read and write to the same shell instance.

Today, workspace files live in R2 as flat objects, accessed via rclone's S3 protocol from
inside the container. This works, but it's a dead end: if we later want a lightweight
Dynamic Worker mode (no container, just file operations), there's no shared abstraction.
The Dynamic Worker would need its own R2 logic, and reconciling state between two
independent sync paths gets messy fast.

With `@cloudflare/shell` as the shared layer:

- **Container mode** syncs to/from the shell API instead of raw R2. Same pattern as
  rclone (sync down on boot, periodic sync, sync up on shutdown), roughly the same
  performance. Marginal improvement: batch writes are transactional, so crash state is
  always consistent.

- **Light mode** (Dynamic Worker, future) gets file access natively — `shell.read()`,
  `shell.write()`, `shell.glob()`. No sync, no container, no bridging. The files are
  just there.

- **Switching between modes works seamlessly.** A user edits files in light mode, then
  boots a container — those edits are in the workspace. The container makes changes,
  shuts down — light mode sees them. One source of truth.

The key point: adopting `@cloudflare/shell` doesn't hurt the container approach. It's a
roughly equivalent swap of the sync target (shell API instead of raw R2) that opens up
the light tier later without rearchitecting anything. Low cost now, optionality later.

### What it does NOT solve

- **First boot is still slow.** Every file must be downloaded into the container's empty
  `/workspace`. No persistent volumes on CF Containers means every boot starts cold.
  `@cloudflare/shell` doesn't change this — only persistent volumes or lazy loading
  (FUSE) would.

- **The 5-minute sync window.** Crash data loss is bounded by sync frequency. Transactional
  batches make the last completed sync consistent, but you still lose unsaved work.

- **`.git/objects/` problem.** Still too many small files to sync efficiently. This is a
  fundamental issue with syncing git repos regardless of backing store.

---

## What it takes to implement

### 1. Worker-side shell API (few hours)

Add Hono routes to the existing Worker that proxy to `@cloudflare/shell`. The shell
instance would be scoped per workspace slug (one shell per environment).

Rough endpoint surface:

```
GET  /api/shell/:slug/manifest    → file tree with paths, hashes, sizes
GET  /api/shell/:slug/file?path=  → read single file content
POST /api/shell/:slug/batch       → write multiple files atomically
DELETE /api/shell/:slug/file?path= → delete a file
```

This is straightforward — a few Hono routes calling shell methods. Sits alongside the
existing `/api/envs/*` routes.

### 2. Container-side sync script (1-2 days)

Replace the rclone calls in `entrypoint.sh` with a script that talks to the shell API.

**sync_down (boot):**
1. Fetch manifest from `/api/shell/:slug/manifest`
2. Compare against local `/workspace` (empty on first boot, so download everything)
3. Download changed/new files via `/api/shell/:slug/file`
4. Parallel downloads (same as rclone's `--transfers 16`)

**sync_up (periodic + shutdown):**
1. Scan `/workspace`, compute checksums
2. Diff against last known manifest
3. POST changed files as a batch to `/api/shell/:slug/batch`

Could be a bash script (curl + jq), or a small Go/Node binary for better parallelism.
The operations are simple: list, download, upload.

### 3. Migration path (incremental)

Same pattern as the Fly → CF Containers migration: feature flag toggle.

- Keep rclone as the default
- Add shell sync alongside it
- Switch with an env var (`USE_SHELL_SYNC=true`)
- Test, validate, then remove rclone when confident

No big-bang cutover. Both sync paths can coexist.

---

## Later: light tier (Dynamic Worker mode)

This is a separate, larger project that builds on top of the shell integration. Not a
prerequisite for the container-side work above, but the shell layer is a prerequisite
for this.

**What it is:** A Dynamic Worker running a custom agent (Anthropic API + tool use) that
gives Claude file-operation tools mapped to `@cloudflare/shell`. No container, no Linux,
no terminal. ~5ms startup, near-zero cost. Good for code review, refactoring, generation,
config edits — anything that doesn't need bash/git/npm.

**What it requires:**
- Custom agent built on Anthropic SDK with tool definitions for file operations
- UI to let the user choose light vs full mode
- Conversation management (streaming, tool use loop, error handling)

**What it doesn't require:**
- Escalation logic — the user picks the mode, not the system
- Any changes to the container path — it already syncs to the same shell layer

Estimated effort: ~1 week for a working prototype, independent of the container-side
shell integration.
