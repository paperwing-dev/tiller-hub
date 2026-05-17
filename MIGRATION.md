# Cloudflare Containers Migration

Historical note: this document predates the current runtime.

The Fly.io migration is complete:

- Fly.io is no longer a supported runtime.
- `USE_CF_CONTAINERS` is no longer part of the runtime contract.
- the old `/api/envs/:slug/terminal` debug-shell path is gone.
- startup diagnostics now come from structured lifecycle events rather than ttyd/tmux.

For current behavior, use these docs instead:

- [README.md](./README.md)
- [docs/runner-backends.md](./docs/runner-backends.md)
- [docs/runtime-boundaries.md](./docs/runtime-boundaries.md)
