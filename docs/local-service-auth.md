# Local Service Auth

This note explains the current auth model between deployed `tiller-hub`, the
Tiller Host backend, and the home-network gateway.

## Roles

- runner:
  - manages local Docker environments for `backend: "host"` through the active host session
- gateway:
  - routes Codex subscription traffic from hosted Plan/Research and remote Codex envs

They may run on the same machine, but the system treats them as separate
services.

## Discovery model

The deployed hub no longer reads runner or gateway URLs from worker secrets.

Instead:

1. `tiller` or `tiller host` registers a host service in `HubDO`
2. the same host process can also register a public gateway URL when gateway tunneling is available
3. `tiller-hub` selects the newest active runner and newest active gateway independently

That removes the old secret-managed service-discovery paths:

- `LOCAL_RUNNER_URL`
- `LOCAL_RUNNER_TOKEN`
- `RESEARCH_RELAY_URL`
- `RESEARCH_RELAY_TOKEN`

## Public access model

For custom-domain deployments, the public gateway hostname sits behind
Cloudflare Access:

- `https://tiller-gateway.example.com`

Requests from the deployed hub include:

- `CF-Access-Client-Id`
- `CF-Access-Client-Secret`

Those headers are the only app-to-service auth layer in the current design.
The old extra bearer-token layer has been removed for this iteration.

## Request flows

### Tiller Host backend

1. Browser calls deployed `tiller-hub`
2. `tiller-hub` decides an env uses `backend: "host"`
3. `tiller-hub` looks up the active host registration
4. `tiller-hub` sends a runner-control request through `HubDO`
5. Tiller Host receives the request over its hub session connection
6. Tiller Host starts or manages the local Docker container

### Codex gateway routing

1. Browser calls deployed `tiller-hub`
2. Hosted Plan/Research or remote Codex env launch needs a Codex route
3. `tiller-hub` looks up the active gateway registration
4. `tiller-hub` calls the gateway URL
5. Cloudflare Access validates the request when the gateway is on a protected custom domain
6. The gateway forwards Codex traffic to `https://chatgpt.com/backend-api/codex/responses`

If no healthy gateway is registered, `tiller-hub` falls back to `OPENAI_API_KEY`
when that key is configured.

## Localhost behavior

When services are loopback-only:

- runner control stays on the hub session path
- gateway calls go directly to `http://127.0.0.1:<gateway-port>`

Cloudflare Access is only required on the public hostname path.

## Operational failure modes

### Cloudflare Access headers missing or wrong

Symptoms:

- requests fail before they hit the runner or gateway
- Cloudflare returns a login or deny response

### Runner offline

Symptoms:

- host backend env creation/start fails
- Cloudflare backend envs are unaffected

### Gateway offline

Symptoms:

- hosted Plan/Research and remote Codex envs stop using the subscription route
- if `OPENAI_API_KEY` is configured, they fall back automatically
- if `OPENAI_API_KEY` is not configured, Codex-backed hosted features become unavailable

## Relevant code

- [runner-backend-host.ts](../api/env/runner-backend-host.ts)
- [model-route.ts](../api/model-route.ts)
- [service-registry.ts](../api/service-registry.ts)
- [runner-server.ts](../../tiller/src/runner-server.ts)
- [gateway-server.ts](../../tiller/src/gateway-server.ts)
