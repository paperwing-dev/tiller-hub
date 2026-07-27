# Container Runtime Decisions

## Container runs harnesses as a non-root `tiller` user

`--dangerously-skip-permissions` is required for fully autonomous operation (no approval prompts), but Claude Code refuses this flag when running as root for security reasons. The entrypoint runs privileged bootstrap and cleanup work as root, then drops to the `tiller` user via `runuser` for tiller-harness/Claude Code.

## The container is the permission boundary

The sandbox image is the isolation boundary for coding sessions on either
execution backend. For autonomous container runs, the entrypoint launches Claude Code with `--dangerously-skip-permissions`; Codex is launched by `tiller-harness` with approval and sandbox bypass flags.

This is only appropriate inside the managed sandbox runtime. Local interactive usage can still route permissions through the normal harness hooks.

## `--resume` is NOT passed to Claude Code

On a fresh container, there are no prior Claude Code conversations to resume. Passing `--resume` can leave Claude Code stuck at "No conversations found to resume. Press Ctrl+C to exit." Container boot starts a fresh child harness session instead.

## Onboarding is pre-seeded in the Docker image

Claude Code shows first-run prompts on new homes. The base image pre-creates the Claude state/settings needed for headless startup so container boots do not block on onboarding UI.

## Agent CLIs are pinned in the image

The sandbox base image pins Claude Code, Codex, and OpenCode versions. Auto-updaters and nonessential Claude traffic are disabled because container runtime should be reproducible and image-driven.

The harness terminal parser pins `@xterm/headless` to the same exact version as
the browser's `@xterm/xterm`. After a harness terminal fix, validation on Your
machine must check the pinned `localRunnerImage`; restarting a container does
not replace its original image, so delete and recreate the workload normally.

## Workspace sync goes through hub APIs

`/workspace` is restored and saved by `workspace-sync.mjs` through authenticated hub workspace APIs. The entrypoint runs sync on boot, periodically while active, and during stop finalization. The hub owns the durable workspace state and lifecycle acknowledgements.

## Plan Writers use an isolated bootstrap

`TILLER_BOOTSTRAP_MODE=plan-writer` branches before normal environment setup.
The branch materializes the plan's frozen basis commit as a root-owned read-only
checkout and skips mutable workspace synchronization, repository ownership
changes, services, GitHub credential setup, and periodic upload.

The small harness supervisor keeps the generation-scoped Hub credential. Claude
Code, Codex app-server, and their native TUI run as the unprivileged provider
user with an explicit environment allowlist and no Hub/GitHub credential or MCP
configuration. Only bounded provider state, terminal state, and managed local
hook/socket paths are writable. The supervisor owns terminal registration,
publication, and meaningful-idle shutdown. The deployment-only eight-hour
deadline protects startup and is cleared immediately after runtime
registration; it is not a steady-state writer lifetime.

Cloudflare Containers and Your machine both key runtime creation and destruction by the exact
`(repoId, planArtifactId, generation)` identity. Runtime provenance remains in
ArtifactStore until exact destruction succeeds.
