# Tiller Auth Matrix

This is the current auth and config surface for `tiller-hub`, `tiller`, and
`tiller-harness`.

The important split is:

- execution backend: Cloudflare Containers or a registered runner
- harness auth path: gateway subscription route, direct API credentials, or direct provider credentials

## Deployment-time credentials

These are used to deploy the worker, not during normal runtime.

| Name | Where used | Required | Notes |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler deploys / CI | Yes | Standard Cloudflare API token for deploy-time operations. |
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler deploys / CI | Sometimes | Useful when Wrangler cannot infer the account automatically. |
| `TILLER_REGION` | Deploy flow | Yes for the deploy-button path | One of `wnam`, `enam`, `weur`, `eeur`, `apac`, or `oc`. |

Optional power-user deploy inputs:

| Name | Where used | Required | Notes |
| --- | --- | --- | --- |
| `TILLER_CUSTOM_DOMAIN` | `npm run deploy` | Optional | Deploys directly to a protected custom domain instead of `workers.dev`. |
| `TILLER_ACCESS_EMAILS` | `npm run deploy` | Required with `TILLER_CUSTOM_DOMAIN` | Comma- or newline-separated emails allowed through Cloudflare Access. |
| `CF_ACCESS_CLIENT_ID` | local `tiller` only | Optional | Not required for deploy. Useful for protected custom-domain hubs. |
| `CF_ACCESS_CLIENT_SECRET` | local `tiller` only | Optional | Same role as `CF_ACCESS_CLIENT_ID`. |

## Hosted `tiller-hub` runtime bindings and secrets

These are the live bindings or secrets used by the deployed worker.

| Name | Required | Used for | Notes |
| --- | --- | --- | --- |
| `HUB_PUBLIC_URL` | Optional | Public hub URL handed to containers | If unset, `tiller-hub` derives it from the incoming request origin. |
| `CF_ACCESS_CLIENT_ID` | Optional | Cloudflare Access service token | Required only when the hub is on a protected custom domain. |
| `CF_ACCESS_CLIENT_SECRET` | Optional | Cloudflare Access service token | Same role as `CF_ACCESS_CLIENT_ID`. |
| `TILLER_GATEWAY_TUNNEL_ID` | Auto-managed | Stored gateway tunnel bootstrap | Written by `Publish & Protect` when the protected gateway tunnel is provisioned. |
| `TILLER_GATEWAY_TUNNEL_NAME` | Auto-managed | Stored gateway tunnel bootstrap | Defaults to `tiller-gateway`. |
| `TILLER_GATEWAY_TUNNEL_TOKEN` | Auto-managed | Stored gateway tunnel bootstrap | Used by `tiller host` to run the managed gateway tunnel. |
| `TILLER_GATEWAY_TUNNEL_TARGET_PORT` | Auto-managed | Stored gateway tunnel bootstrap | Currently `8788`. |
| `DEFAULT_NAMESPACE` | Yes | Default namespace selection | Current system still assumes a default namespace exists. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional | Claude subscription auth in containers | Current subscription path for Claude containers. |
| `ANTHROPIC_API_KEY` | Optional | Anthropic API auth in containers | Used when Claude auth resolves to API mode. |
| `OPENAI_API_KEY` | Optional | Codex/OpenAI API fallback | Used when no active Codex gateway subscription route exists. |
| `TILLER_OPENCODE_PROXY_TOKEN` | Internal | OpenCode hub proxy auth | Generated automatically by the hub and injected into OpenCode containers. |
| `OPENAI_MODEL` | Optional | Hosted Research model override | Defaults are defined by agent specs if unset. |
| `GITHUB_TOKEN` | Optional | Private repo tarballs and GitHub package access | Needed for private repos or package pulls that require auth. |
| `DO_LOCATION_HINT` | Optional | Hub Durable Object placement override | Usually injected automatically from `TILLER_REGION`. |

## Runtime-discovered local services

These are no longer configured as worker secrets.

`tiller-hub` discovers them from machine registration in `HubDO`:

- active runner:
  - used only for host backend env lifecycle
- active gateway:
  - used for Codex subscription routing from hosted features and remote Codex envs

Removed worker-secret paths:

- `LOCAL_RUNNER_URL`
- `LOCAL_RUNNER_TOKEN`
- `RESEARCH_RELAY_URL`
- `RESEARCH_RELAY_TOKEN`

## Local `tiller` config

These values live in `~/.config/tiller/config.json` or equivalent env vars.

| Key / Env | Required | Used for | Notes |
| --- | --- | --- | --- |
| `hubUrl` / `HUB_URL` | Yes | Target hub URL | Example: `https://tiller.example.com`. |
| `clientId` / `CF_ACCESS_CLIENT_ID` | Optional | Cloudflare Access service token | Required when the hub is on a protected custom domain. Ignored for `workers.dev` hubs. |
| `clientSecret` / `CF_ACCESS_CLIENT_SECRET` | Optional | Cloudflare Access service token | Same role as `clientId`. |
| `gatewayTunnelName` / `TILLER_GATEWAY_TUNNEL_NAME` | Optional | Legacy local gateway named tunnel | Defaults to `tiller-gateway`. Fallback only when hub-managed gateway bootstrap is unavailable. |
| `gatewayHostname` / `TILLER_GATEWAY_HOSTNAME` | Optional | Public gateway hostname | Defaults to `tiller-gateway.<hub-domain>`. |
| `localRunnerPort` / `TILLER_LOCAL_RUNNER_PORT` | Optional | Local runner listen port | Defaults to `8789`. |
| `gatewayPort` / `TILLER_GATEWAY_PORT` | Optional | Local gateway listen port | Defaults to `8788`. |
| `localRunnerImage` / `TILLER_LOCAL_RUNNER_IMAGE` | Optional | Local sandbox image | Defaults to `docker.io/jamieatlason/tiller-sandbox:stable`. Override it when you want a custom or SHA-pinned host image. |
| `cloudflaredConfigPath` / `TILLER_CLOUDFLARED_CONFIG_PATH` | Optional | Legacy tunnel config path | Defaults to `~/.cloudflared/config.yml`. Fallback only for locally managed named tunnels. |

## Minimal supported setups

### Hosted hub only

Required:

- `DEFAULT_NAMESPACE`
- provider auth for whichever harnesses you actually use

Notes:

- OpenCode uses the hub's built-in Workers AI binding through an internal hub proxy.
- AI Gateway is intentionally out of scope for this v1 harness path.

Optional:

- `HUB_PUBLIC_URL`
- `CF_ACCESS_CLIENT_ID`
- `CF_ACCESS_CLIENT_SECRET`

### Hosted hub + laptop-local execution

Required on the machine:

- `hubUrl`
- `clientId` and `clientSecret`, only if the hub is a protected custom domain
- Docker
- local image matching `localRunnerImage` (default: `docker.io/jamieatlason/tiller-sandbox:stable`)

Optional:

- a different `localRunnerImage` if you want to pin a SHA or custom build

### Hosted hub + home-network gateway

Required on the machine:

- `hubUrl`
- `clientId` and `clientSecret`, only if the hub is a protected custom domain
- `tiller host`
- ChatGPT/Codex auth available on that machine

Normal path:

- finish `Publish & Protect` so the hub stores the managed gateway tunnel bootstrap
- run `tiller host setup`
- run `tiller host`

Legacy fallback:

- local Cloudflare tunnel credentials when using a manually managed named tunnel

Optional:

- `OPENAI_API_KEY` in the hub as fallback when the gateway is offline

### Hosted hub + OpenCode on Workers AI

Required on the hub:

- `DEFAULT_NAMESPACE`

Notes:

- No local `opencode login` state is required.
- No extra Cloudflare Workers AI API credentials are required.
- No AI Gateway route is used in v1.

## Explicitly removed legacy items

These are no longer part of the active runtime surface:

- `LOCAL_RUNNER_URL`
- `LOCAL_RUNNER_TOKEN`
- `RESEARCH_RELAY_URL`
- `RESEARCH_RELAY_TOKEN`
- `TILLER_RESEARCH_RELAY_HOSTNAME`
- `TILLER_RESEARCH_RELAY_PORT`
- `TILLER_RESEARCH_RELAY_TOKEN`
- `FLY_API_TOKEN`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT`
- `CF_ACCESS_TEAM_DOMAIN`
