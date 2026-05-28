# Runner Backends

`tiller-hub` now separates hosted workspace state from execution backend. That lets
the same hub target either Cloudflare Containers or a host-managed Docker runner
without changing the UI, `tiller-harness`, or `tiller`.

## Why this exists

The original design coupled workspace state, Research chat, and container
lifecycle into one Cloudflare Container-backed Durable Object. That worked for
Cloudflare-hosted execution, but it made two things awkward:

- `Research` was tied to the Cloudflare container path even though it does not
  need a running container.
- Subscription-backed AI products may accept residential egress and challenge
  datacenter egress. Tiller Host gives better egress without moving the hub off
  Cloudflare.

The current split keeps the control plane hosted while making execution
pluggable.

## Current architecture

- `HubDO`
  - Session state, WebSocket fanout, replay, permissions, terminal attach state.
- `WorkspaceDO`
  - Workspace files, tar sync, Research chat, chat history.
- Runner backend
  - `cf`: Cloudflare Containers via `SandboxDO`.
  - `host`: Docker on a machine running `tiller host`.
- Container
  - Runs the existing `packages/containers` boot flow.
  - Syncs against hosted workspace APIs.
  - Starts `tiller-harness`, which connects back to the hosted hub.

## Backend matrix

| Backend | Executes where | Good for | Notes |
| --- | --- | --- | --- |
| `cf` | Cloudflare Containers | Fully hosted execution | Uses `SandboxDO` for lifecycle and startup diagnostics |
| `host` | Docker on your machine or home server | Better outbound egress, personal subscriptions, cheaper compute | Requires `tiller host`; the optional public tunnel is gateway-only |

## Request flow

### Tiller Host backend

1. The UI creates an environment with `backend: "host"`.
2. `tiller-hub` stores env metadata in KV and initializes `WorkspaceDO`.
3. `tiller-hub` resolves one routable host machine for that env operation and sends
   runner control to that machine through `HubDO`.
4. Tiller Host starts a local Docker container from the configured `localRunnerImage`
   ref (default: `docker.io/jamieatlason/tiller-sandbox:stable`).
5. The container syncs files from `WorkspaceDO`, starts `tiller-harness`, and reports
   structured startup diagnostics back to the hub.
6. `tiller-harness` connects back to `HubDO` and creates a normal session.
7. The web UI and `tiller` attach to the hosted hub exactly the same way they do
   for Cloudflare Containers.

### Cloudflare Containers backend

1. The UI creates an environment with `backend: "cf"`.
2. `tiller-hub` stores env metadata in KV and initializes `WorkspaceDO`.
3. `tiller-hub` calls `SandboxDO`.
4. `SandboxDO` starts the Cloudflare container.
5. The container syncs from `WorkspaceDO`, starts `tiller-harness`, and connects back
   to `HubDO`.

## What stays hosted on Cloudflare

- The `tiller-hub` web app and API.
- `HubDO`.
- `WorkspaceDO`.
- The `Research` button and chat history.
- Workspace file browsing and sync APIs.

Local execution does not move workspace state or Research off Cloudflare. It
only changes where the container runs.

## Research and host execution

`Research` is intentionally independent of runner backend:

- It reads and writes workspace files through `WorkspaceDO`.
- It stores history in `WorkspaceDO`.
- It still works when no container is running.

If you are using the Codex subscription path, the outbound network
origin is handled by the separate gateway role, not the runner. Hosted
Plan/Research use a routable host gateway, and host envs use the gateway of
their selected host machine. If no usable gateway is available, Tiller falls
back to `OPENAI_API_KEY` when configured.

## Local development on localhost

This is the simplest browser-first development loop. It is intentionally a
local-only world:

- `npm run dev` starts `tiller-hub` on localhost
- `tiller host` starts the local host services
- the UI only offers the `host` backend
- local Docker containers call back to the hub through `host.docker.internal`

### Prerequisites

- Docker running locally
- one model credential in `.dev.vars`
- use `.dev.vars`, not `.env`, for localhost model auth

### 0. Add local model auth

Copy `docs/examples/local-dev-vars.sample` to `.dev.vars`, then set at least one of:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

Without one of those, the localhost hub will stay on the "Required setup" page.

### 1. Pull the sandbox image

```bash
docker pull docker.io/jamieatlason/tiller-sandbox:stable
```

Or run `tiller host setup` which does this automatically.

### 2. Start the hub

```bash
cd <project-root>/packages/hub
npm run dev
```

### 3. Start Tiller Host

The host services are built into `tiller`:

```bash
tiller host
```

Health check:

```bash
curl http://127.0.0.1:8789/healthz
```

### 4. Use the local UI

Open `http://localhost:5173`.

The local network path is:

- browser -> `http://localhost:5173`
- hub -> `http://127.0.0.1:8789`
- local Docker env container -> `http://host.docker.internal:5173`

If environment start fails on localhost, check `tiller host` first.

## Deployed hub with Tiller Host

Use this mode when `tiller-hub` stays hosted on Cloudflare but containers should
run on your own machine or home server.

### 1. Run Tiller Host on the machine that will execute local containers

The deployed hub no longer talks to the host backend over a public runner
hostname. It uses the active Tiller Host session in `HubDO` for host backend
control.

You only need a public Cloudflare Tunnel when you want the separate gateway
role for hosted Plan/Research and remote Codex subscription routing.

### 2. Point `tiller-hub` at the host backend

```bash
cd <project-root>/packages/hub
printf '%s' 'https://tiller.example.com' | npx wrangler secret put HUB_PUBLIC_URL
cd <project-root>
npm run deploy --workspace packages/hub
```

The active host session is discovered from runtime registration, but execution
uses live routability checks instead of durable registration alone.

New environment creation always chooses the backend explicitly. The web UI
defaults to `host` when a Tiller Host is connected and `cf` otherwise.

### 3. Add local config for `tiller`

For laptop-oriented local use, `tiller setup` reads these from
`~/.config/tiller/config.json`:

```json
{
  "hubUrl": "https://tiller.example.com",
  "clientId": "<cf-access-client-id>",
  "clientSecret": "<cf-access-client-secret>"
}
```

By default, `tiller` derives `tiller-gateway.<hub-domain>` from `hubUrl`.
Override it only if your gateway hostname uses a different name.

### 4. Preferred laptop flow

After the one-time worker setup above, use `tiller` as the local
entry point:

```bash
cd <project-root>
npm run build --workspace packages/tiller
cd packages/tiller
npm run setup
npm start
```

Plain `tiller` opens the picker and uses the connected Tiller Host when you
choose host-backed environments. Helpful companion commands:

```bash
tiller doctor
tiller status
tiller host
tiller down
```

If you also want hosted Plan/Research and remote Codex environments to use a
home-network subscription route, run `tiller host` on an always-on machine.

### 5. Use it

- Open `tiller-hub`.
- Click `New Environment`.
- Choose `Tiller Host` or `Cloudflare Containers`.
- Start the environment normally.
- Use `Research` the same way regardless of backend.

## Operational notes

- `tiller host` should run under a supervisor such as `systemd`, `launchd`, or
  Docker Compose if you want this to be reliable.
- If the gateway tunnel is down, hosted subscription-backed Codex traffic falls
  back to `OPENAI_API_KEY` when configured.
- If Tiller Host is up but Docker is down, local env starts will fail on the
  host machine.
- If you change `tiller-harness` or container boot logic, rebuild or repin the
  configured `localRunnerImage`.
- Existing envs can be mixed: some `cf`, some `host`.
- Existing host envs stay pinned to their selected `runnerMachineId`; they do
  not silently drift to a newer active host.

## Container images and registries

The sandbox container image is built from `packages/containers/Dockerfile`
and the SCM bootstrap image is built from
`packages/containers/Dockerfile.scm`. Both are published by
`.github/workflows/container-image.yml` when the supported maintainer release
flow triggers it.

| Context | Image | Registry | Config |
| --- | --- | --- | --- |
| Source config / deploy-button defaults | `docker.io/jamieatlason/tiller-sandbox:stable` and `docker.io/jamieatlason/tiller-scm:stable` | Docker Hub | `wrangler*.jsonc` |
| Root validation deploy / canonical release flow | `docker.io/jamieatlason/tiller-sandbox:<git-sha>` and `docker.io/jamieatlason/tiller-scm:<git-sha>` | Docker Hub | root deploy or release workflow passes explicit overrides |
| Tiller Host | configured `localRunnerImage` ref | Local Docker only | Pulled directly by `tiller host setup` or pinned explicitly in local config |

CI pushes to **Docker Hub only**. Docker Hub is required because Cloudflare
Containers can pull from Docker Hub directly. The supported release flow pins
the deployed container apps to immutable commit-SHA tags so Cloudflare is forced
to pull the new image. Hub-only `packages/hub` deploys intentionally
preserve the currently live container image refs unless `CONTAINER_IMAGE_TAG`
and/or `SCM_BOOTSTRAP_IMAGE_TAG` are set.

Maintainers can push dev image tags by triggering the CI workflow with a custom
`image_tag` input (e.g. `dev-foo`) instead of the default `stable`.

## Files involved

- [env/routes.ts](../api/env/routes.ts)
- [workspace/do.ts](../api/workspace/do.ts)
- [sandbox-do.ts](../api/sandbox-do.ts)
- [runner-backend.ts](../api/env/runner-backend.ts)
- [runner-backend-cf.ts](../api/env/runner-backend-cf.ts)
- [runner-backend-host.ts](../api/env/runner-backend-host.ts)
- [runner-server.ts](../../tiller/src/runner-server.ts)
