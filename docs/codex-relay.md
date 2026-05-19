# Codex Gateway Routing

The old standalone Codex relay process has been replaced by the gateway service
inside `tiller host`.

Use this when `tiller-hub` is deployed on Cloudflare Workers but Codex traffic
should egress from a machine on your home network.

## 1. Start Tiller Host

On the machine that has ChatGPT/Codex subscription access:

```bash
cd <project-root>/packages/tiller
npm run build
node dist/index.js host
```

Or, once installed globally:

```bash
tiller host
```

The gateway inside Tiller Host listens on `http://127.0.0.1:8788` by default
and exposes:

- `GET /healthz`
- `GET /capabilities`
- `POST /codex/responses`
- `POST /v1/responses`

## 2. Expose it with Cloudflare Tunnel

For a quick test:

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

For a stable deployment, use a named tunnel and a hostname such as
`tiller-gateway.example.com`.

`tiller host` can manage the tunnel for you when your config includes
`gatewayHostname` / `TILLER_GATEWAY_HOSTNAME`.

## 3. Service discovery

No worker secrets are needed for the gateway URL.

Instead:

1. `tiller host` connects to the hub
2. it registers the active gateway URL and capabilities in `HubDO`
3. hosted Plan/Research and remote Codex envs discover that registration at runtime

## 4. Fallback behavior

When a healthy gateway is available, Codex routing prefers the gateway-backed
subscription path.

When no healthy gateway is available:

- if `OPENAI_API_KEY` is configured, Tiller falls back automatically
- otherwise Codex-backed hosted features are unavailable
