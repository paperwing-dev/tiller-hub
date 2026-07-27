# Tiller Authentication Matrix

Execution placement and provider billing are independent. Settings stores the
execution backend for new workloads plus `claudeBillingMode` and
`openaiBillingMode`. Each workload freezes both placement and its applicable
provider route before dispatch.

## Deployment Inputs

| Name | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Local/CI deploys | Deploy Worker resources. |
| `CLOUDFLARE_ACCOUNT_ID` | Local/CI deploys | Select the Cloudflare account without discovery. |
| `TILLER_REGION` | Deploy-button flow | R2 and Durable Object placement. |
| `WRANGLER_CI_OVERRIDE_NAME` | Workers Builds | Selected Worker name. |

Production origin and Access trust are not supplied by `HUB_PUBLIC_URL` or
scalar `CF_ACCESS_*` secrets. They come from the canonical workers.dev trust
and credential records in `HubDO`.

## Hub Model and Repository Inputs

| Name | Use |
| --- | --- |
| `ENABLED_ENV_HARNESSES` | Comma-separated `claude-code`, `codex`, and `opencode`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude subscription billing. |
| `ANTHROPIC_API_KEY` | Claude API billing. |
| `OPENAI_API_KEY` | OpenAI API billing; never consulted by an active subscription profile. |
| `TILLER_WORKERS_AI_ACCOUNT_ID` / `TILLER_WORKERS_AI_API_TOKEN` | Explicit Workers AI credentials when no bound `AI` service is used. |
| `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | GitHub App repository access. |
| `DO_LOCATION_HINT` | Durable Object placement override. |
| `LOCAL_DEV_ONLY_BACKEND` | Contributor loopback development only. |

Imported Codex subscription credentials are stored and refreshed by `HubDO`.
Refresh credentials are never passed to runtimes.

## Canonical Access Principals

| Principal | Signed Access identity | Allowed scope |
| --- | --- | --- |
| Owner | Canonical normalized email and no service identity | UI plus owner-only Settings, credential issuance, Access renewal, and cleanup manifest. |
| Service | No email and canonical service-client `common_name` | CLI, machine daemon, runtimes, callbacks, ordinary HTTP, and WebSockets. |
| Callback bypass | Exact allowlisted method/path | GitHub webhook and Access broker proof/completion only. |
| Local development | Loopback request | Contributor-only relaxed boundary. |

Owner-only routes reject the shared service principal. Raw Access client headers
are consumed at Cloudflare's edge and are not Worker authentication.

## Local Configuration

Values live in `~/.config/tiller/config.json` or `TILLER_CONFIG_PATH`.

| Key / environment variable | Purpose |
| --- | --- |
| `hubUrl` / `HUB_URL` | Exact workers.dev origin; localhost is allowed only for development. |
| `clientId` / `CF_ACCESS_CLIENT_ID` | Installation service client ID delivered by encrypted browser connection. |
| `clientSecret` / `CF_ACCESS_CLIENT_SECRET` | Installation service secret delivered by encrypted browser connection. |
| `machineId` | Generated persistent machine UUID; it cannot be overridden by the environment. |
| `displayName` / `TILLER_MACHINE_DISPLAY_NAME` | Human-readable hostname or label. |
| `localRunnerPort` / `TILLER_LOCAL_RUNNER_PORT` | Loopback runner port, default `8789`. |
| `localRunnerImage` / `TILLER_LOCAL_RUNNER_IMAGE` | Managed sandbox image. |

Config normalization prefers a stored workers.dev URL, strips retired aliases,
custom-domain attempts, public flags, promotion state, enable tokens, and
hostname identity, and preserves valid Access credentials and machine UUID.

## Runtime Provider Inputs

| Route | Supervisor input |
| --- | --- |
| Claude subscription | `CLAUDE_CODE_OAUTH_TOKEN` |
| Claude API | `ANTHROPIC_API_KEY` |
| Codex subscription | App-server mode plus a scoped runtime-auth callback capability |
| Codex API direct CLI | `OPENAI_API_KEY` and direct-CLI mode |
| Codex API app-server | `OPENAI_API_KEY` and app-server mode |
| OpenCode Workers AI | Hub proxy model ID and scoped proxy token |

The supervisor strips Access credentials, runtime capabilities, refresh
credentials, callback tokens, and bridge secrets before spawning child
TUI/tool/model-command processes.

## Machine Readiness

Your machine reuses the installation-wide service credential. A healthy
advertisement includes its UUID, display name, Docker/runner checks, protocol
versions, and exact runtime image. Readiness expires with the health lease.

An unavailable placement or provider route fails closed. There is no
cross-backend, cross-billing, auth-file, or API-key fallback during an active
lifecycle.
