# Codex Gateway Routing

The old standalone Codex relay process has been replaced by the gateway service
inside `tiller host`.

Use this when `tiller-hub` is deployed on Cloudflare Workers but Codex traffic
should egress from a machine on your home network.

## 1. Import a Codex Login into Tiller

Import a Codex login from Tiller Settings. Settings shows a copy button for a
Terminal script that reads the local Codex login automatically. If Tiller is
installed on the machine that already has a Codex subscription login, the shorter
CLI path is:

```bash
tiller auth import codex
```

Tiller stores and refreshes the imported Codex credential in the hub. Containers never
receive refresh tokens and do not read `~/.codex/auth.json`.

## 2. Start Tiller Host

On the machine that should provide the gateway route:

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

## 3. Expose it with Cloudflare Tunnel

For a quick test:

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

For a stable deployment, use a named tunnel and a hostname such as
`tiller-gateway.example.com`.

`tiller host` can manage the tunnel for you when your config includes
`gatewayHostname` / `TILLER_GATEWAY_HOSTNAME`.

## 4. Service discovery

No worker secrets are needed for the gateway URL.

Instead:

1. `tiller host` connects to the hub
2. it registers the active gateway URL and capabilities in `HubDO`
3. the hub mints scoped gateway session tokens for hosted Plan/Research and remote Codex envs
4. the gateway exchanges each session token with the hub for short-lived upstream access

## 5. Fallback behavior

When a healthy gateway is available, Codex routing prefers the gateway-backed
subscription path.

When no healthy gateway is available:

- Codex envs with `auto` auth can fall back to `OPENAI_API_KEY` with a visible warning
- Codex envs with `subscription` auth fail clearly instead of falling back
- otherwise Codex-backed hosted features are unavailable
