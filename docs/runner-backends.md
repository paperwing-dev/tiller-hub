# Execution Backends

The Hub control plane and workspace state always remain on Cloudflare. Settings
chooses where newly created workloads execute:

- **Cloudflare Containers** uses the internal `cf` backend.
- **Your machine** uses the internal `host` backend and one exact machine UUID.

Cloudflare is selected by default. There is no backend selector in workload
creation and no ordered fallback policy.

## Stored Selection and Placement

`HubDO` owns one selection:

```ts
type ExecutionSelection =
  | { target: "cf" }
  | { target: "host"; machineId: string };
```

Every new durable workload resolves that selection exactly once and persists:

```ts
type ExecutionPlacement =
  | { backend: "cf"; machineId: null }
  | { backend: "host"; machineId: string };
```

Environment creation, planner runs, reviews, plan writers, and standalone jobs
use `resolveNewExecutionPlacement()`. Placement is written before dispatch.
Restarts, scheduled runs, reconnects, automatic retries, stop, cleanup, and
deletion use only the workload's stored placement.

Changing Settings never scans, stops, migrates, or reassigns existing work. A
user-created rerun is new work and uses the current selection; an automatic
retry stays on its original placement.

## Availability Rules

Cloudflare Containers is always selectable as intent. Selecting Your machine
requires the exact ready candidate returned by `GET /api/execution/status`.
The Settings mutation sends `expectedMachineId`, which is checked as a
linearizable concurrency precondition.

A machine is ready only while its advertisement is fresh and all compatibility
checks pass:

- Docker is healthy.
- The local runner is healthy.
- Runner command protocol is version 1.
- Runtime-auth protocol is version 1.
- The managed runtime image matches the Hub contract.

`machine-alive` binds an authenticated connection to a machine UUID but does
not establish readiness. A fresh healthy advertisement claims the one
available machine slot. A second live UUID is rejected. When the same UUID has
duplicate sockets, the newest healthy socket becomes command-active and the
older socket is demoted.

Health loss or lease expiry withdraws readiness. Another machine may advertise
after the previous one is offline, but workloads pinned to the old UUID remain
pinned.

## Error Contract

New work fails without trying another backend:

> The selected execution backend is unavailable. Choose another backend in
> Settings.

Existing work fails without reassignment:

> This workload’s execution backend is unavailable. Delete and recreate it to
> use your current Settings choice.

There is no repair, migration, force-delete, forget, or automatic fallback
operation.

## Deletion Safety

Cloudflare-backed deletion destroys the exact Cloudflare runtime before
durable workload state is removed.

Machine-backed deletion sends a fenced destroy command to the stored
`machineId`. Only an acknowledgement or typed runner-not-found proof confirms
absence. Any other result leaves workspace, sessions, lifecycle state, and the
workload definition intact. The definition is the last record removed.

If the assigned machine is permanently unavailable, recovery and deletion are
outside the current scope.

Repository deletion never cascades workload deletion. It refuses while any
workload definition, active planner/review/writer, standalone runtime, or
pending cleanup remains.

## Machine Setup

Copy the exact command from Settings:

```bash
tiller host setup --hub-url https://<exact-host>.workers.dev
```

Setup validates the canonical URL and service credential, verifies Docker,
pulls the compatible image, creates or preserves a machine UUID, installs or
updates the systemd/launchd service, verifies the healthy Hub advertisement,
and opens or prints Settings. It exits without waiting for activation and never
selects the machine automatically.

Daemon configuration is noninteractive. Invalid credentials instruct the
operator to rerun setup.

## Local Development

Loopback origins are the only production-ingress exemption. A typical
contributor loop is:

```bash
cd packages/hub
npm run dev

# in another terminal
tiller host
```

Local Docker workloads call the Hub through `host.docker.internal`. Model
credentials belong in `packages/hub/.dev.vars`, not `.env`.

## Images

The sandbox and SCM images are built from `packages/containers` and published
to Docker Hub. Release deploys pin immutable commit-SHA tags. The execution
machine pulls the Hub-compatible sandbox image during setup or update.

Docker containers retain their creation image. Updating the machine service
does not mutate an existing workload container; delete and recreate that
workload normally when a new runtime is required.

Relevant implementation:

- `api/execution.ts`
- `api/execution/routes.ts`
- `api/hub.ts`
- `api/env/runner-backend-cf.ts`
- `api/env/runner-backend-host.ts`
- `packages/tiller/src/host-stack.ts`
- `packages/tiller/src/host-supervisor.ts`
