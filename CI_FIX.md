# CI Fix: Cloudflare Containers Push

Historical note: this document predates the current Docker-Hub-only release
flow and Fly removal. Do not treat `USE_CF_CONTAINERS` or `FLY_API_TOKEN`
references below as part of the current runtime contract.

## Problem

The GitHub Actions workflow (`.github/workflows/tiller-base-image.yml`) builds the Docker image and pushes to GHCR successfully, but the Cloudflare Containers registry push fails.

**Root cause:** The workflow uses `cloudflare/wrangler-action@v3` which installs wrangler in an isolated npm context. When it runs `wrangler containers push tiller-sandbox:v1`, wrangler calls `docker inspect tiller-sandbox:v1` but can't find the image — even though it was built and tagged in an earlier step. The wrangler-action appears to run in a way that loses visibility of the Docker daemon's image store.

**Additional constraint:** Cloudflare Containers rejects `:latest` tags. The image must be tagged with a specific version like `:v1`.

## Current state on main

- Build step: `docker build -t tiller-sandbox:latest` (only tags as `:latest`, not `:v1`)
- Push step: uses `cloudflare/wrangler-action@v3` with `command: containers push tiller-sandbox:v1`
- Result: `Error: No such image: tiller-sandbox:v1`

## Fix needed

The workflow on main (`.github/workflows/tiller-base-image.yml`) needs two changes:

1. **Tag as `:v1` at build time:** Add `-t tiller-sandbox:v1` to the `docker build` command
2. **Replace wrangler-action with direct wrangler call:** Instead of `cloudflare/wrangler-action@v3`, use:
   ```yaml
   - name: Install wrangler
     run: npm install -g wrangler@latest
   - name: Push to Cloudflare registry
     run: npx wrangler containers push tiller-sandbox:v1
     env:
       CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
   ```

## Current local state

- On branch `fix/ci-wrangler-push` (based off `feat/hapi-voice-agents-sdk`)
- The correct workflow file exists locally at `.github/workflows/tiller-base-image.yml` but wasn't committed
- The main feature branch is `feat/hapi-voice-agents-sdk`
- `MIGRATION.md` is untracked

## After CI is fixed

Once the `:v1` image exists in Cloudflare's registry, the Worker can be deployed with the containers config:

1. In `packages/hub/wrangler.jsonc`, the `containers` array references `registry.cloudflare.com/6e5c043f652fe45f30d6724b5d20ac94/tiller-sandbox:v1`
2. Run `npm run deploy` from `packages/hub`
3. Set `USE_CF_CONTAINERS=true` via `npx wrangler secret put USE_CF_CONTAINERS`
4. Test by creating an environment from the web UI at the configured hub domain

## GitHub secrets (already set)

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with containers edit permission
- `FLY_API_TOKEN` — Fly.io org token
- `NODE_AUTH_TOKEN` — Classic PAT with `read:packages` for private npm packages

## Repo

`git@github.com:paperwing-dev/paperwing-infrastructure.git`
