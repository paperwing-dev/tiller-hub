# Tiller Hub — Architecture Decisions

## Container runs harnesses as a non-root `tiller` user

`--dangerously-skip-permissions` is required for fully autonomous operation (no approval prompts), but Claude Code refuses this flag when running as root for security reasons. The entrypoint runs privileged bootstrap and cleanup work as root, then drops to the `tiller` user via `runuser` for tiller-harness/Claude Code.

## `--dangerously-skip-permissions` for full autonomy

The container IS the sandbox — Claude Code runs inside an isolated Fly machine with no access to production systems. Rather than routing every tool call through the web UI for manual approval (which defeats the purpose of remote agents), we skip permissions entirely. Anthropic's own devcontainer docs recommend this for containerized use.

## `--resume` is NOT passed to Claude Code

On a fresh container (or after image rebuild), there are no prior conversations to resume. Passing `--resume` causes Claude Code to show "No conversations found to resume. Press Ctrl+C to exit." and become stuck in a dead-end state. Each container boot starts a fresh conversation instead.

## Onboarding is pre-seeded in the Docker image

Claude Code shows first-run prompts (TOS acceptance, theme selection) on every boot because `~/.claude/` state doesn't persist across container stop/start cycles. Rather than syncing `~/.claude/` to R2 (which would drag in session transcripts, debug logs, and introduce sync conflicts), we pre-create `~/.claude.json` with `{"hasCompletedOnboarding": true}` at image build time.

## `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`

Set in the Dockerfile. The container is ephemeral — telemetry and auto-update checks are unnecessary overhead. The Claude Code version is pinned in the image.

## Workspace sync via rclone to R2

`/workspace` is synced to Cloudflare R2 every 5 minutes and on shutdown. This survives container stop/start cycles. Claude config (`~/.claude/`) is NOT synced — it's pre-seeded in the image instead (see above).

## R2 costs are negligible

R2's free tier gives 10M Class A (writes) and 10M Class B (reads) ops/month, and egress is always free. A 2,000-file repo doing one start/stop per day with periodic syncs uses ~180K ops/month — you'd need ~55 active environments with daily restarts to exceed the free tier. Storage for source code is pennies. The number of files affects container boot speed (each file is an HTTP round-trip), not cost. `--transfers 16 --checkers 16` on rclone parallelizes this and keeps startup fast.

## `.git/objects/` is excluded from sync, git is broken on restart — and that's OK

rclone excludes `.git/objects/` to avoid syncing potentially hundreds of MB of git object data. This means git commands don't work after a restart (refs exist but point to missing objects). This is acceptable because Claude starts a fresh conversation each boot (`--resume` is not passed), so preserving git state across restarts has minimal value. The repo can always be re-cloned from `REPO_URL` if needed.
