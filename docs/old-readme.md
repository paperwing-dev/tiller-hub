Historical note: this file describes an older architecture and is kept only for
reference. Fly.io and ttyd are no longer part of the supported runtime.

## Architecture: Why We Wrap Claude Code CLI

Tiller wraps Claude Code as a PTY subprocess rather than using the Claude SDK (Anthropic API) directly.

Claude Code is an entire agent — ~20 built-in tools (Read, Write, Edit, Bash, Glob, Grep, Task, etc.), context management (CLAUDE.md, auto-memory, git awareness), sub-agent orchestration, and a battle-tested agent loop. Using the SDK directly means rebuilding all of that yourself and maintaining it as Anthropic ships improvements you don't get.

Tiller's job is **remote access**, not agent implementation. The CLI spawns Claude Code, captures its PTY stream, and pipes it over WebSocket to a Durable Object. The web UI (or any future client) consumes that stream. Claude Code does the hard work; Tiller is transport.

This also means the local Claude Code session stays fully functional. Tiller adds remote access on top — it doesn't replace the local experience.

**Future: voice control.** The PTY stream doesn't need to be rendered in a terminal. Strip ANSI codes, detect permission prompts and tool output (they have predictable patterns), and route to TTS/STT instead of xterm.js. The terminal UI is one consumer of the stream — a voice agent is another. The transport layer doesn't change.

---

## Auth Strategy: Cloudflare Access

Tiller uses Cloudflare Access as the sole authentication layer. There is no application-level JWT, no login form, no token management. CF Access authenticates every request at the edge before it reaches the Worker.

### How It Works

#### Web UI (browser)

1. User navigates to `hapi.paperwing.dev`
2. CF Access intercepts the request and redirects to the identity provider login (configured in Zero Trust dashboard)
3. After authentication, CF Access sets a `CF_Authorization` cookie scoped to `hapi.paperwing.dev`
4. All subsequent requests (fetch + WebSocket upgrades) automatically include this cookie
5. CF Access validates the cookie at the edge and adds a `Cf-Access-Jwt-Assertion` header to the request before forwarding to the Worker
6. The Worker's auth middleware verifies this JWT against CF Access's public JWKS (`/cdn-cgi/access/certs`) with an audience check, then sets the namespace for DO routing

The web UI uses `credentials: "include"` on all fetch calls so the browser sends the CF Access cookie cross-origin.

#### CLI (service token)

1. The CLI reads CF Access service token credentials from `~/.config/hapi/config.json`
2. Every HTTP request and WebSocket upgrade includes `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers
3. CF Access validates the service token at the edge (same as a browser session) and adds the `Cf-Access-Jwt-Assertion` header
4. The Worker verifies the JWT the same way — it doesn't distinguish between user sessions and service tokens

Service token JWTs have a `common_name` claim (the client ID) instead of an `email` claim, but since this is a single-user system, the Worker uses a fixed `DEFAULT_NAMESPACE` env var for all authenticated requests regardless of identity type.

#### Dev (local)

When `DEV_NAMESPACE` is set in `.dev.vars` and there's no `Cf-Access-Jwt-Assertion` header (i.e., running locally via `wrangler dev`), the middleware skips JWT verification and uses `DEV_NAMESPACE` as the namespace. This is a single `if` statement, not a parallel auth system.

### Server-Side Verification

The auth code is ~20 lines in `api/auth.ts`:

- `verifyCfAccessJwt(request, env)` — reads the `Cf-Access-Jwt-Assertion` header, verifies it via `jose.jwtVerify` + `createRemoteJWKSet` against the team's JWKS endpoint, checks the audience matches `CF_ACCESS_AUD`
- `authMiddleware()` — Hono middleware that calls `verifyCfAccessJwt` on every `/api/*` request, skipping `/health` and WebSocket upgrades. Sets `c.set("namespace", env.DEFAULT_NAMESPACE)` on success.
- WebSocket auth happens in `hub.ts` `onConnect` — same `verifyCfAccessJwt` call on the upgrade request headers

### Worker Secrets (Production)

| Secret                  | Value                           | Purpose                                                       |
| ----------------------- | ------------------------------- | ------------------------------------------------------------- |
| `CF_ACCESS_AUD`         | `8ec0add2...`                   | Audience tag from the Access Application — JWT audience check |
| `CF_ACCESS_TEAM_DOMAIN` | `overvues.cloudflareaccess.com` | Used to build the JWKS URL for JWT verification               |
| `DEFAULT_NAMESPACE`     | `<your-email>`         | Fixed namespace for DO routing (single-user system)           |

### Cloudflare Zero Trust Dashboard Setup

All of this is configured at https://one.dash.cloudflare.com under **Zero Trust**:

1. **Access Application** — A self-hosted application covering `*.paperwing.dev` (wildcard). This means any subdomain, including `hapi.paperwing.dev`, is protected. The application's **audience tag** (Application ID) is used as `CF_ACCESS_AUD`.

2. **Access Policies** — The application has (at least) two policies:

   - An **Allow** policy for email-based login (e.g., One-time PIN, Google, etc.) — this covers the web UI
   - A **Service Auth** policy linked to the `hapi-service-token` — this covers the CLI

3. **Service Token** — Created under **Access controls > Service credentials > Service Tokens**. Produces a Client ID + Client Secret pair. This is a **reusable policy** that must be **attached to the Access Application** (just creating the policy isn't enough — it shows "Used by applications: 0" until attached).

4. **Attaching the policy** — Go to **Access controls > Applications**, edit the `*.paperwing.dev` application, and add the service auth policy to its policy list. Without this step, the service token headers are ignored and requests get redirected to login.

---

## Architecture: Remote Tool Permissions

Tiller uses Claude Code's **PreToolUse hooks** to intercept tool permissions and route them through the Durable Object for remote approval via the web UI.

### Why PreToolUse Hooks

Claude Code provides two extension points for tool approval: `--permission-prompt-tool` (which only works in headless mode, not with a live terminal) and hooks (which work in any mode including interactive PTY sessions). Since Tiller wraps a live terminal, hooks are the only viable option. Terminal output parsing was considered but rejected as fragile — permission prompts can change format across versions.

### Why Long-Poll to Durable Object

The hook script communicates with the DO via HTTP long-polling rather than short-polling, local broker, WebSocket, or SSE:

| Approach                     | Trade-offs                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Long-poll to DO** (chosen) | Cloudflare-native (same pattern as CF Waiting Room). DO HTTP responses have unlimited wall time — waiting on a Promise doesn't consume CPU time. Only ~12 requests max per permission (25s windows over 5min timeout). Fully decoupled from CLI process. |
| Short-polling                | 200+ requests per permission (1.5s interval over 5min). Wasteful and slower response.                                                                                                                                                                    |
| Local HTTP broker            | Simpler but couples to CLI process. Hook would call localhost, CLI would proxy to DO. Extra moving part.                                                                                                                                                 |
| WebSocket from hook          | Overengineered for request-response. Hook runs once per tool call and exits.                                                                                                                                                                             |
| SSE                          | Buffering issues with Node.js fetch. Not a natural fit for single-response pattern.                                                                                                                                                                      |
| Cloudflare Workflows         | Overkill for sub-minute decisions.                                                                                                                                                                                                                       |

Trade-off: CF Access credentials must be passed to the hook via env vars (already needed for auth). ~100ms latency per request (vs ~1ms for localhost).

### Permission Flow

```
 ┌─────────┐     ┌──────────┐     ┌────────────────┐     ┌─────────┐
 │  Claude  │     │ PreTool  │     │   CF Worker +   │     │  Web UI │
 │  Code    │────▶│ Use Hook │────▶│  Durable Object │◀────│ (React) │
 │ (agent)  │     │ (.mjs)   │     │   (hub.ts)      │     │         │
 └─────────┘     └──────────┘     └────────────────┘     └─────────┘
      │                │                    │                    │
      │ 1. Tool call   │                    │                    │
      │───────────────▶│                    │                    │
      │                │ 2. POST /perms     │                    │
      │                │───────────────────▶│                    │
      │                │                    │ 3. WS broadcast    │
      │                │                    │───────────────────▶│
      │                │ 4. GET ?wait=true  │                    │
      │                │───────────────────▶│  (held open)       │
      │                │                    │                    │
      │                │                    │ 5. User clicks     │
      │                │                    │    "Allow"         │
      │                │                    │◀───────────────────│
      │                │                    │ 6. POST resolve    │
      │                │ 7. HTTP response   │                    │
      │                │◀───────────────────│                    │
      │ 8. Hook exits  │                    │                    │
      │    (allow)     │                    │                    │
      │◀───────────────│                    │                    │
      │ 9. Tool runs   │                    │                    │
```

1. Claude Code triggers a tool call (e.g., `Bash`, `Edit`)
2. PreToolUse hook fires, sends `POST /api/sessions/:id/permissions` to create a pending permission
3. DO broadcasts `permission-created` to all WS clients (web UI receives it)
4. Hook long-polls `GET /api/sessions/:id/permissions/:permId?wait=true` — DO holds the HTTP request open
5. User sees PermissionBanner in web UI with tool details (diff for Edit, command for Bash, etc.)
6. User clicks Allow/Deny → web UI sends `POST /api/sessions/:id/permissions/:permId` to resolve
7. DO resolves the pending Promise → HTTP response flows back to hook
8. Hook outputs `permissionDecision: "allow"` or `"deny"` and exits
9. Claude Code proceeds (or blocks) based on the decision

**"Allow for Session"** stores the tool name in `sessions.allowed_tools`. On subsequent calls, the hook checks this list before creating a permission request, skipping the approval flow entirely.

## Sandboxed Dev Environments

Tiller provisions on-demand sandboxed containers for running Claude Code sessions remotely. Each environment is a container running the `tiller-base` Docker image with Ubuntu 24.04, Node.js 22, Claude Code CLI, tiller-harness, and ttyd.

Currently deployed on **Fly.io**. Migrating to **Cloudflare Containers**.

### Why we started with Fly.io

CF Containers didn't exist (or was too early in beta) when this was built. Fly's Machines API was the proven option for programmatically creating containers, and it shipped fast — `api/fly.ts` is a 110-line REST client that got sandboxes working.

### Why we're migrating to Cloudflare Containers

The hub is already a Cloudflare Worker + Durable Object. The container connects _outbound_ to the hub via WebSocket — the hub never reaches into the container. This means the Fly integration is pure overhead: an external API, an external vendor, and workarounds for problems that don't exist on the same platform.

#### 1. ttyd is publicly exposed with no auth

Every Fly machine exposes `https://tiller-{slug}.fly.dev` → port 7681 (ttyd). There's no authentication on the Fly side. Anyone who guesses the slug gets a bash shell inside the container with access to the workspace, Claude Code, and every secret in the environment.

With CF Containers, there is no public URL. ttyd is only reachable through the Worker via `getTcpPort(7681)`, which is behind CF Access. The security hole disappears without writing any auth code.

#### 2. Split-brain state between KV and Fly

`envs.ts` stores `flyMachineId` in KV, but the actual machine state (started/stopped/destroyed) lives in Fly. Every status check requires an HTTP call to Fly's API that can fail, timeout, or return stale data:

```ts
// envs.ts — this pattern repeats 5 times
const fly = new FlyClient(c.env.FLY_API_TOKEN);
const machine = await fly.getMachine(meta.flyMachineId);
status = machine.state; // might disagree with what KV says
```

A `"pending"` placeholder exists because machine creation is async — the hub doesn't know when Fly finishes. Machines can be destroyed on Fly's side (host failure, manual intervention) while KV still references them, requiring `catch { /* machine may not exist */ }` guards everywhere.

With CF Containers, the container IS a Durable Object. `env.SANDBOX.get(id)` gives you the container directly — its lifecycle is the DO's lifecycle. No KV metadata to reconcile, no pending states, no stale reads.

#### 3. Credential sprawl

Every Fly container gets 9 env vars baked in at creation (`envs.ts:80-91`), including long-lived service credentials:

- `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` — so rclone can sync to R2
- `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` — so tiller-harness can authenticate back to the hub over the public internet
- `ANTHROPIC_API_KEY`

With CF Containers, the container is a DO on the same Worker — no CF Access credentials needed for tiller-harness to talk to the hub (internal communication). That drops 2 long-lived credential pairs from every container.

#### 4. Workspace persistence: backup/restore replaces rclone

The current approach syncs the workspace to R2 every 5 minutes via rclone. If the Fly host crashes between syncs, up to 5 minutes of Claude Code's work is lost.

CF Containers provides `createBackup()` / `restoreBackup()` via the Sandbox SDK. These snapshot the ephemeral disk to R2 as a squashfs archive and restore it on next start via FUSE overlayfs. The workspace lives on fast local disk (not R2 FUSE — FUSE is too slow for npm install and git operations that write thousands of small files). This is the same pattern as today (local disk + periodic R2 persistence) but with a platform-native mechanism instead of rclone.

**What improves:** No rclone binary in the image, no R2 credentials in the container, no rclone config generation in the entrypoint, simpler backup/restore calls from the DO. The sync gap doesn't disappear entirely — you'd still call `createBackup()` periodically or on session end — but the mechanism is cleaner and the restore is faster (FUSE overlayfs mount vs full rclone sync).

**What doesn't change:** The workspace still lives on ephemeral local disk. You still need a SIGTERM trap to persist state before shutdown. The fundamental pattern is the same.

#### 5. The entrypoint simplifies significantly

The current `entrypoint.sh` is 106 lines managing: rclone config generation, git auth, sync_up/sync_down, SSH setup, SIGTERM cleanup, periodic sync loop, ttyd, tiller-harness, and process management.

| Goes away with CF Containers  | Why                                            |
| ----------------------------- | ---------------------------------------------- |
| rclone config + binary        | `createBackup()` / `restoreBackup()` from DO   |
| sync_up / sync_down functions | Backup/restore API                             |
| Periodic sync loop            | Backup triggered from DO or on session end     |
| SSH setup                     | `wrangler containers ssh` for debugging        |
| R2 credential env vars        | Backup/restore is platform-native, no S3 creds |

What remains: git auth, ttyd, tiller-harness, SIGTERM trap (calls backup). ~30 lines.

### Cost and operational comparison

**Cost:** Comparable. Fly shared-cpu-1x/512MB vs CF Containers `basic` (0.25 vCPU, 1 GiB RAM). Both bill only while the container is running. For mostly-idle sandboxes that are manually stopped, similar spend.

**Stop/start:** Same pattern. Machines don't auto-stop today (`autostop: "off"` in `fly.ts:78`). They stop when tiller-harness exits or the user calls `/api/envs/:slug/stop`. CF Containers uses the same manual lifecycle — no need for `sleepAfter`. `ctx.container.start()` / `ctx.container.signal(15)` replaces `fly.startMachine()` / `fly.stopMachine()`.

**Cold start:** Both ~2-3 seconds from stopped state for this image size. CF Containers may be slightly slower for large images but in the same ballpark.

### What changes in the codebase

The migration touches ~4 files. App logic, web UI, and tiller-harness are untouched.

| File                      | Change                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/fly.ts`              | **Deleted.** Replaced by a Container DO class (~30 lines extending `Container` from `@cloudflare/containers`)                                                  |
| `api/envs.ts`             | Swap `FlyClient` calls for DO container calls. Same API shape (create/start/stop/destroy/status). KV metadata simplifies since container state is the DO state |
| `container/Dockerfile`    | Drop `rclone`, `openssh-server`, rclone install step. Smaller image                                                                                            |
| `container/entrypoint.sh` | Drop rclone config/sync, SSH setup. Keep git auth, ttyd, tiller-harness. 106 → ~30 lines                                                                             |
| `wrangler.jsonc`          | Add Container DO binding + container image reference                                                                                                           |
| `container/fly.toml`      | **Deleted**                                                                                                                                                    |

**Unchanged:** `api/index.ts` (router), `api/hub.ts` (HubDO), `src/` (React UI), tiller-harness, voice, all `/api/envs` endpoint shapes.

### Known CF Containers beta issues

CF Containers is in public beta (since June 2025, no GA date). Relevant open issues:

| Issue                                                                                                                    | Impact on tiller                                                                                                                                       | Severity |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **WebSocket connections don't renew `sleepAfter` timeout** ([#147](https://github.com/cloudflare/containers/issues/147)) | **Not a blocker.** Tiller uses manual stop/start (`autostop: "off"`), not `sleepAfter`. Same pattern on CF Containers.                                 |
| **Containers can be killed on host restart with no uptime guarantee**                                                    | Same risk as Fly (any host can fail). SIGTERM + 15 min grace period is generous. Entrypoint trap persists state on shutdown — same pattern as today. |
| **R2 reads fail over 10-15MB** ([#137](https://github.com/cloudflare/containers/issues/137))                             | Low impact. Backup/restore uses squashfs archives (not individual file reads). Workspace files rarely exceed 10MB.                                   |
| **Ephemeral disk (no persistent volumes)**                                                                               | Not a problem. Fly doesn't use persistent volumes either. Both rely on R2 for persistence between sessions.                                          |

No hard blockers. The beta risk is reliability/stability regressions, not missing features.

### Other platforms evaluated

**Google Cloud Run** — Request-scoped by design. Containers only exist while handling HTTP requests (max 60 min timeout). Claude Code sessions run for hours with persistent background processes. Cloud Run Jobs remove the timeout but also remove HTTP serving. No per-instance identity, slower cold starts, VPC networking complexity. Wrong model.

**GCE / EC2** — Would work mechanically, but the API surface is enormous, boot times are minutes not seconds, no native scale-to-zero, and per-second billing with minimums makes idle sandboxes expensive.

### How it works (current Fly.io implementation)

- **Container image** (`container/Dockerfile`): Ubuntu 24.04 with Node 22, Claude Code CLI, tiller-harness, ttyd (web terminal), rclone (R2 sync), and SSH.
- **Machine management** (`api/fly.ts`): A `FlyClient` wrapping the [Fly.io Machines API](https://fly.io/docs/machines/api/) to create, start, stop, and destroy machines in the `tiller-sandbox` app.
- **Environment CRUD** (`api/envs.ts`): API routes that tie together Fly machines, KV metadata, and R2 storage.
- **R2 sync** (`container/entrypoint.sh`): Workspace state is synced to/from Cloudflare R2 on boot, shutdown, and every 5 minutes — so containers can be stopped and restarted without losing work.

### API

| Method   | Endpoint                | Description                        |
| -------- | ----------------------- | ---------------------------------- |
| `GET`    | `/api/envs`             | List all environments              |
| `POST`   | `/api/envs`             | Create environment (`{ repoUrl }`) |
| `GET`    | `/api/envs/:slug`       | Get environment info + live status |
| `POST`   | `/api/envs/:slug/start` | Start a stopped container          |
| `POST`   | `/api/envs/:slug/stop`  | Stop a running container           |
| `POST`   | `/api/envs/:slug/sync`  | Trigger sync via hub DO            |
| `DELETE` | `/api/envs/:slug`       | Destroy machine + R2 data + KV     |

### Container lifecycle

1. `POST /api/envs` with a `repoUrl` → creates a container, clones the repo into `/workspace`, starts tiller-harness + ttyd
2. Container stops when tiller-harness exits or user calls `/api/envs/:slug/stop`
3. `POST /api/envs/:slug/start` wakes it — backup restore recovers workspace state
4. `DELETE /api/envs/:slug` destroys the container and cleans up R2 backups + KV

### Secrets

| Secret                                                      | Purpose                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `FLY_API_TOKEN`                                             | Fly.io API auth for machine CRUD (removed after CF Containers migration)                                            |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` | Passed to containers for rclone R2 sync (removed after CF Containers migration — backup/restore is platform-native) |

## Voice

Eleventy labs solves everything for us. If we want to build our own we need to do all this cloudflareAI

- Kyutai = local STT + TTS models (Moshi — runs on their own hardware, no API costs)
- Pipecat = the orchestration framework that wires STT → LLM → TTS together into a working loop
- WebRTC = the audio transport (how voice travels browser ↔ server in real-time with low latency)
- The LLM in the middle = a small model that figures out which project/MCP server/skill to invoke based
  on what you said
- Claude Code daemons = the actual workers launched per project

Realtime Kit
