# Sprites (Fly.io) vs Cloudflare — Architecture Comparison

Historical note: this comparison is preserved for context only. Fly.io is no
longer a supported Tiller runtime.

A comparison of Fly.io's Sprites architecture (JuiceFS-backed VMs) and Cloudflare's
stack, evaluated in the context of Tiller-Hub's remote sandboxed development environments.

Updated to include Dynamic Workers (March 2026) — a new Cloudflare primitive that
changes the calculus for lightweight agent workloads.

---

## The Three Approaches

**Fly.io Sprites** — bare VMs on shared hardware, backed by a hacked JuiceFS (SQLite
metadata + S3 data chunks), with NVMe read-through caching and Litestream for SQLite
durability. Everything is built from low-level primitives.

**Cloudflare Containers** — managed container runtime at the edge, paired with Durable
Objects (built-in SQLite), R2 object storage (zero egress), and Workers for routing/API.
Higher-level primitives, less to build yourself. Full Linux environment.

**Cloudflare Dynamic Workers** — V8 isolates instantiated at runtime with arbitrary code.
Millisecond startup, near-zero cost. Paired with `@cloudflare/shell` (virtual filesystem
backed by DO SQLite + R2) and `@cloudflare/worker-bundler` (npm resolution + esbuild).
No shell, no process spawning — JavaScript/Python/WASM only.

---

## Where Fly.io Sprites Win

### Granular Storage Control
JuiceFS gives full POSIX filesystem semantics backed by object storage. Files are split
into content-addressable chunks, deduplicated across workspaces, and cached on local NVMe.
This means:
- Lazy file loading (fetch on first read, not full restore at boot)
- Cross-workspace deduplication (shared dependencies stored once)
- Fine-grained incremental sync (chunk-level, not file-level)

Cloudflare's `@cloudflare/shell` partially closes this gap (see Dynamic Workers section),
but it's a virtual filesystem, not POSIX — and only available in Worker-land, not inside
containers.

### Mature VM Isolation
Fly Machines are full microVMs (Firecracker). Stronger isolation boundary than containers,
with full kernel-level separation. Better for untrusted workloads or multi-tenant scenarios
where a container escape would be catastrophic.

### Persistent Volumes (Native)
Fly Machines support persistent NVMe volumes attached directly to VMs. No sync layer
needed — files survive restarts natively. Cloudflare Containers don't have persistent
volumes yet.

### Flexible Networking
Fly supports private networking (WireGuard mesh), custom IP allocation, and Anycast IPs.
More control over inter-service communication. Cloudflare Containers are limited to
service bindings and public routes.

### Escape Hatch to Bare Metal
When you hit platform limits, Fly lets you drop down to raw VM configuration. Cloudflare
Containers are more opinionated — you work within their model or not at all.

---

## Where Cloudflare Wins

### Durable Objects Replace an Entire Storage Layer
Sprites needed to build: JuiceFS + hacked SQLite metadata backend + Litestream replication
to S3. All of this exists to get durable, low-latency state near compute.

Durable Objects give you this out of the box:
- Built-in SQLite, automatically replicated and durable
- Single-entity isolation per `idFromName()` — no shared-database contention
- Hibernation with zero idle cost
- WebSocket auto-response without waking the DO

This is the single biggest architectural advantage. Fly had to engineer around the absence
of this primitive.

### R2 Zero Egress
The Sprites NVMe cache exists largely because S3 reads are expensive at scale. R2 has zero
egress fees, which removes the cost pressure that makes aggressive caching necessary. You
can read from R2 liberally without worrying about bandwidth bills.

### Edge-Local Container Images
Fly Machines pull images from a registry, which is historically the slowest step in
container creation. Cloudflare Containers have images deployed to the edge — no pull step
from an external registry. This reduces cold start latency.

### Integrated Auth (Cloudflare Access)
Zero Trust auth sits in front of all routes natively. No sidecar, no proxy, no auth
middleware to bolt on. JWT verification is a few lines of code. Fly requires you to bring
your own auth layer.

### Workers as the Glue Layer
Hono on Workers gives you a programmable API/routing layer that runs at the edge with
sub-millisecond cold starts. The Worker can orchestrate DOs, R2, KV, AI, and Containers
from one unified codebase. Fly's equivalent is a separate API service you deploy and
manage yourself.

### Simpler Operational Model
No infrastructure to manage. No VM sizing, no kernel updates, no NVMe provisioning, no
Litestream configuration, no JuiceFS tuning. The platform handles replication, failover,
and scaling. This means fewer moving parts to break and less operational toil.

### Workers AI (Built-In Inference)
Voice agent, STT, image generation — all available as bindings without deploying or
managing model servers. Fly would require a separate GPU instance or external API calls.

### Cost at Low-to-Medium Scale
Workers, DOs, R2, and KV have generous free tiers. Fly charges per-VM from the start.
For a single-user or small-team tool like Tiller-Hub, Cloudflare's pricing is
significantly cheaper.

---

## Dynamic Workers — The Third Option

Dynamic Workers (March 2026) are a new Cloudflare primitive: V8 isolates instantiated at
runtime with arbitrary JavaScript/Python/WASM code. They don't replace containers, but
they open up a tiered execution model.

### What Dynamic Workers Provide

- **~5ms startup** — roughly 100x faster than containers, near-instant for the user
- **`@cloudflare/shell`** — virtual filesystem backed by DO SQLite + R2 with typed file
  operations (read, write, search, replace, diff, glob, JSON query). Transactional batch
  writes. Lazy state resolution. This is essentially the JuiceFS-like persistence layer
  that was previously missing from Cloudflare's story.
- **`@cloudflare/worker-bundler`** — resolves npm dependencies from the registry, bundles
  with esbuild, serves full apps with built-in asset handling
- **RPC across security boundaries** — expose typed TypeScript APIs to sandboxed code
  via Cap'n Web RPC. The sandbox never sees credentials.
- **`@cloudflare/codemode`** — wraps code execution with normalization, MCP server
  generation from OpenAPI specs
- **$0.002/unique worker/day** — orders of magnitude cheaper than container billing

### What Dynamic Workers Cannot Do

- No shell access — cannot run `bash`, `git`, `npm install`, `python`, build tools
- No process spawning — single V8 isolate, no subprocesses
- No PTY — no terminal stream, no interactive sessions
- No real filesystem — `@cloudflare/shell` is virtual (typed methods, not POSIX)
- No arbitrary binaries — JavaScript/Python/WASM only

### Why This Matters for Tiller-Hub

Tiller-Hub currently runs Claude Code CLI in a container. Claude Code needs a real Linux
environment: shell access (Bash tool), real filesystem, git, npm, PTY streaming. Dynamic
Workers cannot replace this.

**But** — not every agent interaction needs a full Linux sandbox. Many tasks only need
file operations:
- Code review and analysis (read files, produce feedback)
- Code generation and refactoring (read, write, search/replace)
- Documentation generation (read code, write markdown)
- Configuration changes (edit JSON/YAML/TOML)

These could run entirely in a Dynamic Worker with `@cloudflare/shell`, at millisecond
latency and near-zero cost. The container only needs to exist when the task requires
shell execution.

### The Hybrid Architecture (Tiered Execution)

```
User request → HubDO decides tier:

┌─────────────────────────────────────────────────────────────────┐
│  LIGHT TIER — Dynamic Worker + @cloudflare/shell               │
│  Startup: ~5ms | Cost: ~$0.002/day                             │
│  Can do: read/write/edit files, search, diff, glob,            │
│          npm bundling, code generation, review                  │
│  Cannot: shell, git, builds, tests, install packages           │
│                                                                 │
│  Escalates to heavy tier when shell access is needed ↓         │
├─────────────────────────────────────────────────────────────────┤
│  HEAVY TIER — CF Container (full Linux)                        │
│  Startup: ~2-3s | Cost: container billing                      │
│  Can do: everything — shell, git, npm, python, builds, tests   │
│  Workspace state shared via @cloudflare/shell / R2             │
└─────────────────────────────────────────────────────────────────┘
```

Most agent sessions could start in the light tier and only escalate when Claude's tool
use requires shell access. This would:
- Eliminate cold start for the majority of interactions
- Dramatically reduce cost (most sessions never need a container)
- Keep `@cloudflare/shell` as the single source of truth for workspace state
- Let the container be stateless — it reads/writes through the shell layer, no rclone

### What This Requires to Build

1. **Custom agent on Claude API** — the light tier can't run Claude Code CLI (needs PTY).
   It would need a custom agent built on the Anthropic SDK that uses `@cloudflare/shell`
   for file operations and calls Claude API directly.
2. **Tier escalation logic** — HubDO needs to detect when a task requires shell access
   and boot a container. The container inherits workspace state from `@cloudflare/shell`.
3. **Unified workspace state** — both tiers read/write through `@cloudflare/shell` so
   state is consistent regardless of which tier is active.
4. **UI adaptation** — the frontend needs to handle both tiers (no terminal for light
   tier, terminal appears when container boots).

### Trade-offs vs Pure Container Approach

| Dimension | Pure Container | Hybrid (Dynamic Worker + Container) |
|---|---|---|
| Cold start | ~2-3s always | ~5ms for light tasks, ~2-3s only when needed |
| Cost | Container billing for all sessions | Near-zero for most, container only on escalation |
| Complexity | Simple (one runtime) | Higher (two runtimes, escalation logic, custom agent) |
| Claude Code features | Full CLI (hooks, MCP, permissions) | Light tier loses CLI features |
| Workspace persistence | rclone sync (fragile) | `@cloudflare/shell` (durable, structured) |
| Capability | Full Linux always | JS-only until escalated |

**The honest trade-off:** The hybrid approach trades implementation complexity for
dramatically better startup time and cost. Whether it's worth it depends on what
percentage of sessions actually need shell access.

---

## What Cloudflare Needs to Close the Gap

### 1. Persistent Volumes for Containers (Critical — for pure container approach)
**Gap:** No way to attach durable storage to a container. Workspace state must be synced
to/from R2 via rclone, which means:
- Boot is slow (full workspace restore)
- 5-minute sync windows risk data loss on crash
- `.git/objects/` can't be synced reliably (excluded today)

**What closing it looks like:** A volume mount (even a small one, 1-10 GB) that survives
container restarts. This single feature would eliminate the rclone layer entirely.

**Status:** Not yet available. However, Dynamic Workers + `@cloudflare/shell` offer an
alternative path — if the hybrid architecture is adopted, persistent volumes become less
critical because `@cloudflare/shell` is the durable layer and the container is stateless.

### 2. `@cloudflare/shell` Inside Containers (Would Unlock Hybrid)
**Gap:** `@cloudflare/shell` only runs in Worker/DO context. Containers can't natively
mount it as a filesystem. Bridging requires an HTTP/RPC API between the container and
the Worker managing the shell state.

**What closing it looks like:** A client library or FUSE adapter that lets a container
mount `@cloudflare/shell` state as a local filesystem. Read-through caching on the
container's local disk, writes flushed back to the shell layer.

**Workaround:** Build a thin HTTP API in the Worker that the container calls for file
operations. Or continue using rclone to R2 as the bridge.

### 3. Container Warm Pools / Pre-Warming (Nice to Have)
**Gap:** Container start still has a cold-start window. No way to keep a pool of idle
containers ready to accept workloads.

**What closing it looks like:** An API to maintain N idle container instances that can be
claimed and configured on demand. Or a hibernation model where stopped containers resume
instantly (similar to DO hibernation).

**Workaround:** Proactively call `getSandboxStub()` for expected slugs so the container is
already booting before the user triggers it. With the hybrid approach, this matters less —
most interactions start in the Dynamic Worker tier with no cold start.

### 4. Private Networking Between Containers (Minor)
**Gap:** Containers can't talk to each other over a private mesh. Communication must go
through Workers/DOs or public routes.

**What closing it looks like:** A private network namespace where containers within the
same account can reach each other by name, without exposing traffic to the public internet.

**Relevance to Tiller-Hub:** Low. Current architecture routes everything through the HubDO,
which is the correct pattern for this use case.

---

## Summary

| Dimension | Fly.io Sprites | CF Containers | CF Dynamic Workers | CF Hybrid |
|---|---|---|---|---|
| State management | JuiceFS + Litestream | Durable Objects | DO + @cloudflare/shell | DO + shell (unified) |
| Storage cost | S3 egress, needs cache | R2 zero egress | R2 zero egress | R2 zero egress |
| Workspace persistence | NVMe volumes | rclone to R2 | @cloudflare/shell (native) | shell = source of truth |
| Cold start | Image pull (~seconds) | Edge-local (~2-3s) | ~5ms | ~5ms light, ~2-3s heavy |
| Isolation | Firecracker microVMs | Containers | V8 isolates | V8 + container |
| Shell / git / builds | Full Linux | Full Linux | No | Only when escalated |
| Auth | Bring your own | CF Access | CF Access | CF Access |
| Ops complexity | High | Low | Low | Medium |
| Cost (small scale) | Per-VM billing | Container billing | ~$0.002/day | Mostly near-zero |
| AI/inference | External GPUs | Workers AI | Workers AI | Workers AI |

## Recommendations

### If most sessions need shell access → stay with pure CF Containers
The hybrid approach adds complexity. If nearly every Claude session runs tests, installs
packages, or uses git, the Dynamic Worker tier will just be a pass-through that adds
latency before escalating anyway. Keep it simple.

### If many sessions are read/write only → build the hybrid
Code review, generation, refactoring, documentation — these are file operations. If a
meaningful percentage of sessions never touch the shell, the hybrid approach pays for
itself in startup speed and cost reduction. `@cloudflare/shell` also solves the workspace
persistence problem as a side effect.

### Either way, `@cloudflare/shell` is worth adopting
Even in a pure container approach, `@cloudflare/shell` is a better persistence layer than
raw rclone. It provides structured, transactional, lazy file operations backed by DO + R2.
The container could sync against it instead of raw R2, getting incremental sync and crash
safety for free.

**Bottom line:** Dynamic Workers don't replace containers for Tiller-Hub, but they change
the architecture from "always pay for a full Linux sandbox" to "pay for Linux only when
you need it." The real win is `@cloudflare/shell` — it closes the persistence gap that
was previously Fly's biggest advantage, regardless of which execution tier you use.
