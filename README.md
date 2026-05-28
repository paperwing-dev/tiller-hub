# Tiller Coding Hub

An opinionated way to manage AI harnesess. Almost all built on Cloudflare. Supports sandboxing, agent orchestration, worktrees, voice -- everything and the kitchen sync.


> **Note:** This package is synced to a [public standalone repo](https://github.com/paperwing-dev/tiller-hub) for Cloudflare's deploy button. Development happens in this monorepo.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paperwing-dev/tiller-hub&autoDeploy=true)

_Steer queries to the agent that fits the job, using infrastructure sized to the task. Switch to more powerful agents and compute seamlessly, picking up right where the last agent left off._

TLDR, it's a wrapper around coding agents like Claude Code/Codex/your own, but focused on remote execution and coordination between agents. If you want to build your own AI IDE while still taking advantage of the updates from coding agents, this is a good starting place.

For more background, check out [paperwing.dev/code/tiller](www.paperwing.dev/code/tiller).

## Why

Claude Code and Codex just use their models, the UI is constantly changing, and the code is shit anyway. Might as well make and host your own.

"Tired of Claude Code changing all the time and bugs? Make your own with cloudflare and even more bugs!"


## Subscriptions Usage vs API Keys

In order to use your subscriptions, traffic must be coming from your local machine. Given this, you have two good options. The first is to run `tiller` locally, and use the API keys for remote development. As long as you are locally running `tiller`, all subscriptions and remote containers will work. As soon as `tiller` goes down, remote containers still work, but they don’t have access to the subscription.

The second option is to always be running `tiller serve` on your home server. This creates a tunnel which will route all traffic from your home network, and satisfy the subscription requirements.

__Note:__ It’s technically possible to use subscriptions remotely without using a tunnel. The app was originally built this way. However, with the “OpenClaw” changes, this doesn’t seem like something that will be allowed for long so it was removed. If you want to add it in yourself, it should be pretty easy to vibe code.

## How To Run

1. Deploy using the "Cloudflare Deploy" button.
2. Open the deployed Tiller UI and finish the setup wizard.
3. Kimi K2.5 works through the included Workers AI binding. Add Anthropic or OpenAI keys only if you also want Claude or Codex API access.
4. Optionally use the in-app `Publish & Protect` flow to move from `workers.dev` to your own protected custom domain.
5. Create a new environment. Cloudflare-hosted sandboxes are enabled immediately and selected by default.
6. Install the `tiller` package if you also want the optional Tiller Host workflow.

The deploy-button flow asks for one region input, `TILLER_REGION`. Use one of:
`wnam`, `enam`, `weur`, `eeur`, `apac`, or `oc`.

The standalone deploy template intentionally does not include root
`.env.example` or `.dev.vars.example` files. Cloudflare treats those files as
deploy-button inputs, and Tiller model credentials are configured later inside
the protected setup flow instead.

The default deploy-button flow is intended to work in any user's Cloudflare
account. `workers.dev` is the public bootstrap URL. Custom domains are optional
and can be connected later from the Settings page or first-run wizard when you
want a stable protected deployment. In the supported product flow, a custom
domain is always paired with Cloudflare Access.

When you open `Publish & Protect`, Tiller now explains the exact Cloudflare
token shape inside the UI and verifies the token before it makes changes. Start
from the `Edit Cloudflare Workers` template, then add:

- `Account` / `Access: Apps and Policies` / `Edit`
- `Account` / `Access: Service Tokens` / `Edit` if your dashboard exposes it
- `Account` / `Cloudflare Tunnel` / `Edit`
- `Zone` / `DNS` / `Edit`

Scope that token to the account and zone that own your hostname. If your
dashboard does not show `Access: Service Tokens`, create the token from an
account role that can manage Zero Trust service tokens.

That flow now provisions both sides of the always-on host gateway:

- the protected exact-host Cloudflare Access app for `tiller-gateway.<domain>`
- the remote-managed Cloudflare Tunnel and DNS record for the same hostname

So the normal Pi or home-server path no longer needs a local `cloudflared
login`, `cert.pem`, or `tunnel route dns` step. `tiller host` fetches the
stored gateway tunnel bootstrap from the hub and runs the local connector with
that token.

## Power-user deploys

If you already know your final hostname, you can still use the same
`npm run deploy` entrypoint. Put the custom-domain settings in `.env`:

```bash
TILLER_CUSTOM_DOMAIN=tiller.example.com
CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
TILLER_ACCESS_EMAILS=you@example.com,teammate@example.com
```

Then run:

```bash
npm run deploy
```

That path deploys directly to the custom domain, creates or reuses a dedicated
exact-host Cloudflare Access app for that hostname, and then enables Access.
This direct path only supports hostnames that are not already covered by a
wildcard Cloudflare Access app.
The deploy script also derives `CLOUDFLARE_ACCOUNT_ID` automatically from
`TILLER_CUSTOM_DOMAIN`, so Wrangler can avoid membership discovery during
API-token deploys.

Installing `tiller` is only needed if you want the optional local CLI workflow.
It is not required for normal browser use of the hosted UI.

If you also want local `tiller` access after deploy, install `tiller` and run:

```bash
tiller
```

`workers.dev` hubs stay public and bootstrap automatically. Protected custom
domains open a browser sign-in on first run and store the Cloudflare Access
service token pair for the CLI. `tiller init` still exists as the advanced
manual fallback.

Repository-backed workflows require the configured Tiller GitHub App. Public
`workers.dev` hubs cannot add repositories. On localhost or a protected custom
domain, add repositories from the GitHub repo picker; the list is limited to
repositories selected in the App installation with `contents:write`,
`pull_requests:write`, and `metadata:read`. Tiller does not accept arbitrary
repository URLs for new repos or environments.

The source Wrangler config uses Docker Hub defaults:
<code>docker.io/jamieatlason/tiller-sandbox:stable</code> and
<code>docker.io/jamieatlason/tiller-scm:stable</code>.
The supported maintainer release flow does not deploy those mutable tags
directly. It builds both images, tags them with the current commit SHA, and
deploys the hub with those SHA-pinned refs. Hub-only deploys preserve whatever
container images are already live unless you explicitly override them.

## How To Use

1. Explore the Tiller Hub UI wherever you deployed it. You can do everything from there
2. Configure and install the Tiller GitHub App on the repositories you want to use
3. Add a selected repository from the repo picker, then create environments from that repo
4. Run `npm run tiller` locally. This allows starting, stopping, and using any session that you've create in the UI. Both local sessions and remote sessions.

## What Is Supported

Tiller can be controlled through a web ui at the "tiller-hub", or locally via the "tiller" cli package.

## Architecture

### Execution Backends

Tiller supports two execution backends:

- `cf`: Cloudflare Containers for fully hosted execution
- `host`: Docker on a machine running `tiller host`

Fly.io is no longer a supported runtime.

### Environment Lifecycle

Interactive environment runtime state is owned by `EnvLifecycleDO`, not by ad hoc route heuristics or session presence. The worker routes request lifecycle transitions, the runner reports lifecycle events, and the UI consumes the projected lifecycle state. For stop, the intended path is:

1. request stop
2. persist snapshot while the runner is still alive
3. acknowledge snapshot persistence
4. terminate the runner
5. project `stopped`

Normal env reads and routine actions do not reconcile lifecycle from backend
polling. Lifecycle transitions come from request handlers plus op-id-matched
runner callbacks.

### Runtime Boundaries

Each subsystem owns exactly one kind of truth:

| Owner | Owns | Does not own |
|---|---|---|
| `EnvLifecycleDO` | env phase, start/stop ops, durable save sequencing, startup diagnostics | harness health, session terminal presence |
| `SandboxDO` | container start/stop, port readiness, idle timeout | env phase policy, session truth |
| `entrypoint.sh` | local service boot, child PID tracking, container cleanup | env lifecycle policy, session semantics |
| `tiller-harness` | hub session, harness spawn/respawn, WebSocket traffic | whether the env should stop |

Lead-process (`tiller-harness`) exit is **not** env stop. When the harness exits
unexpectedly, the container stays alive for debugging and the env lifecycle
remains `running`. The existing idle timeout collects the container. The
harness failure is projected as `leadHarnessStatus: "failed"` on env metadata,
separate from the env lifecycle phase.

For the full boundary rules, see [docs/runtime-boundaries.md](./docs/runtime-boundaries.md).

### Embedded Custom Agents

With "Dynamic Workers", you can run agents that don't need a container at an even cheaper cost. We used one to create the "Plan" agent. Look in the repo for an example of how you could build your agent like "review" for example. The one issue with these agents is that Claude Code is not supported with a subscription -- only via the API. Chatgpt 5.4 does work with a subscription, but only if you are running the `tiller` CLI tool locally. All models work via the API, and we have a few from Cloudflares API gateway prepopulated that you can choose from.

We typically use ChatGpt 5.4 running `tiller` locally for this application. Applications where there are no subscriptions (many users supported), will require using api keys and would be better suited for other models.

## What runs where

### Cloudflare

- Web app and API
- `HubDO` session state
- `WorkspaceDO` file storage and Research
- optional Cloudflare runner backend via `SandboxDO`

### Tiller Host

- Docker container lifecycle
- startup diagnostics and lifecycle callbacks
- outbound network egress for the running coding harness

### Container

- syncs workspace files from `WorkspaceDO`
- starts `tiller-harness` as a direct child process
- reports structured startup diagnostics and log tails back to the hub
- connects back to the hosted hub

## Backend choices

| Backend | Executes where                        | Use when                                                           |
| ------- | ------------------------------------- | ------------------------------------------------------------------ |
| `host`  | Docker on your machine or home server | Better egress, personal subscriptions, lower-cost personal compute |
| `cf`    | Cloudflare Containers                 | Fully hosted execution                                             |

The backend is selectable per environment in the UI, with Cloudflare-hosted
sandboxes as the default path on deployed hubs. Localhost development hides the
Cloudflare backend and uses the host backend only.

## Local development on localhost

This is the simplest day-to-day development loop for `tiller-hub`. It is a
completely local world:

1. Put one model credential in `.dev.vars` (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`).
2. `npm run dev` runs the hub on localhost.
3. `tiller host` starts the local host services in a second terminal.
4. The UI only offers the `host` backend.
5. Local containers call back to the hub through `host.docker.internal`.

### 0. Add local model auth

Local localhost development requires one model credential in `.dev.vars`. `.env`
is only for deploy-time inputs.

```bash
cd <project-root>/packages/hub
cp docs/examples/local-dev-vars.sample .dev.vars
```

Then fill one of:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`

### 1. Pull the sandbox image

```bash
docker pull docker.io/jamieatlason/tiller-sandbox:stable
```

Or run `tiller host setup` which does this automatically. Override the host
image by setting `localRunnerImage` in `~/.config/tiller/config.json`.

### 2. Start the hub

```bash
cd <project-root>/packages/hub
npm run dev
```

### 3. Start Tiller Host

```bash
tiller host
```

Check it:

```bash
curl http://127.0.0.1:8789/healthz
```

### 4. Open the local UI

Open [http://localhost:5173](http://localhost:5173).

The local network path is:

- browser -> `http://localhost:5173`
- hub -> `http://127.0.0.1:8789`
- local Docker env container -> `http://host.docker.internal:5173`

If starting an environment fails, check whether `tiller host` is still
running.

## Hosted hub with Tiller Host

Use this mode when the hub stays deployed on Cloudflare but containers should
run on your own machine or home server.

### 1. Run Tiller Host on the machine that will execute local containers

`tiller-hub` controls the host backend through the active Tiller Host session
in `HubDO`. The runner itself is no longer exposed through a public Cloudflare
Tunnel hostname.

If you also want hosted Plan/Research and remote Codex environments to use your
home-network subscription egress, `tiller host` will additionally start the
gateway service and expose the protected gateway hostname when the hub is on a
custom domain.

### 2. Configure the deployed worker

```bash
cd <project-root>/packages/hub
printf '%s' 'https://tiller.example.com' | npx wrangler secret put HUB_PUBLIC_URL
cd <project-root>
npm run deploy --workspace packages/hub
```

Runner and gateway discovery now come from runtime registration plus live
routability, not from worker secrets alone.

`HUB_PUBLIC_URL` is also optional. If you leave it unset, `tiller-hub` derives
its public URL from the incoming request origin. Only set it when you want to
override that auto-detected value.

New environment creation now requires an explicit backend choice. The web UI
defaults to `host` when a Tiller Host is currently connected and to `cf`
otherwise.

### 3. Add local config for `tiller`

Preferred:

```bash
tiller
```

On first run, `tiller` writes `~/.config/tiller/config.json` for you. Public
`workers.dev` hubs complete locally. Protected custom domains open a browser
page, let Cloudflare Access handle sign-in, then save the returned service
token pair automatically.

If you need the manual path instead, `tiller init` still accepts
`--client-id` / `--client-secret` for protected custom domains and
`--public-hub` for intentionally public custom domains.

If you still prefer manual config, `tiller setup` reads:

```json
{
  "hubUrl": "https://tiller.example.com",
  "namespace": "your-namespace",
  "clientId": "<cf-access-client-id>",
  "clientSecret": "<cf-access-client-secret>"
}
```

By default, `tiller` derives `tiller-gateway.<hub-domain>` from `hubUrl`.
Override it with `gatewayHostname` only if your gateway hostname does not
follow that pattern.

For the full auth/config surface, see
[auth-matrix.md](./docs/auth-matrix.md).
For a Deploy to Cloudflare-oriented hosted setup, see
[deploy-to-cloudflare.md](./docs/deploy-to-cloudflare.md).
For local service auth and named-tunnel details, see
[local-service-auth.md](./docs/local-service-auth.md).

### 4. Preferred laptop flow

Once the worker config is in place, day-to-day local use should go through
`tiller`:

```bash
cd <project-root>
npm run build --workspace packages/tiller
cd packages/tiller
npm run setup -- --local
npm start
```

Plain `tiller` now:

- opens the env/session picker
- starts the local host services when you choose or attach to a host environment
- tears down only the services that invocation started when you exit

Use `tiller host` on an always-on machine when you want hosted Plan/Research
and remote Codex environments to route through a home-network subscription
gateway.

When attached to a session, the controls are:

- single `Ctrl+C` exits `tiller` and then local cleanup runs
- `Ctrl+]` sends abort to the remote session

Useful commands:

```bash
npm run doctor
npm run status
npm run up
npm run down
```

### 5. Use it

- Open `tiller-hub`
- click `New Environment`
- choose `Tiller Host` or `Cloudflare Containers`
- start the environment normally
- use `Research` the same way regardless of backend

## Research

`Research` is hosted and uses `WorkspaceDO`, so it is independent of where the
container runs. That means:

- Research works even if the environment is stopped
- moving execution to `host` does not remove the Research button

### Codex subscription path

Research and remote Codex environments can use a home-network Tiller gateway
for subscription-backed routing. Hosted routes require a routable gateway, and
host envs use the gateway of their selected `runnerMachineId`. When no usable
gateway is available, Codex envs set to `auto` can fall back to `OPENAI_API_KEY`
with a visible warning. Import a Codex login in Tiller Settings with the copyable
Terminal script, or run `tiller auth import codex` if Tiller is installed on the
machine that already has a local Codex login.

On protected custom-domain hubs, a headless Pi can still start `tiller` in the
terminal while the browser sign-in happens on another machine by pasting the
connection code from the browser back into the Pi terminal.

## Main docs

- [runner-backends.md](./docs/runner-backends.md)
  - how `cf` and `host` work
  - Tiller Host setup
  - tunnel setup
  - operational caveats
- [local-service-auth.md](./docs/local-service-auth.md)
  - why runner/relay use both Cloudflare Access and bearer-token auth
  - what breaks when named tunnels or secrets drift
- [codex-relay.md](./docs/codex-relay.md)
  - Research relay for Codex subscription egress

## Package commands

```bash
cd <project-root>/packages/hub
npm run dev
npm run build
npm run deploy
npm run test
```
