# Secret Storage Design Decision

## Problem

Tiller Hub needs API keys (Anthropic, OpenAI, GitHub, etc.) to function. We want a zero-config deploy experience: click "Deploy to Cloudflare", visit the URL, paste your keys in a settings page, done. No CLI, no API tokens, no dashboard steps after deploy.

The question: where do we store secrets entered via the settings page?

## Options Evaluated

### 1. Wrangler Secrets (via `wrangler secret put`)

The standard Cloudflare approach. Secrets are encrypted, write-only, and appear on `env` natively.

- **Pros:** Best security. Encrypted at rest, write-only (can't be read back), native to the platform.
- **Cons:** Requires CLI access. Can't be set from a web UI without a Cloudflare API token. Defeats the zero-config goal.

### 2. Workers Secrets API (from the settings page)

The settings page calls `PUT /accounts/{id}/workers/scripts/{name}/secrets` to set real wrangler secrets programmatically.

- **Pros:** Same security as wrangler secrets. No env mutation needed.
- **Cons:** Requires a `CF_API_TOKEN` with Workers Scripts Edit permission to be pre-configured. The user must create an API token in the Cloudflare dashboard before the settings page works. This is a prerequisite that defeats the zero-config goal. Each save also triggers a Worker redeployment (~5s cold start).

### 3. KV Namespace Storage

Store secrets as JSON in a KV key (e.g., `_setup:config` in the existing ENVS_KV namespace).

- **Pros:** Simple. Zero prerequisites. Instant reads/writes.
- **Cons:** KV values are readable by anyone with dashboard KV access OR any Cloudflare API token with KV read permissions (`GET /accounts/{id}/storage/kv/namespaces/{ns}/values/_setup:config`). This is a significant security downgrade from wrangler secrets — secrets are effectively plaintext and programmatically exfiltrable.

### 4. Cloudflare Secrets Store

A newer Cloudflare product with dual-layer encryption and RBAC.

- **Pros:** Excellent security.
- **Cons:** The Worker binding is read-only (`env.MY_SECRET.get()`). There is no `set()` method. All writes require the Dashboard, Wrangler CLI, or the REST API (which needs an API token). Cannot satisfy the "configure later via settings page" requirement.

### 5. Durable Object SQLite Storage (chosen)

Store secrets in the existing HubDO's private SQLite database, in a `config` table.

- **Pros:**
  - Zero prerequisites. The Worker writes to its own DO — no API tokens or CLI needed.
  - Not readable via any REST API (unlike KV).
  - Not readable via any CLI command (unlike KV).
  - Only visible in Data Studio (dashboard) to users with the Workers Platform Admin role, and access is audit-logged.
  - Instant reads/writes — no redeployment, no cache propagation.
  - Leverages existing infrastructure — HubDO is already a singleton with SQLite.
  - Wrangler secrets still take precedence — if a user later runs `wrangler secret put`, that value wins.
  - Encrypted at rest by Cloudflare's infrastructure (AES-256).

- **Cons:**
  - Not write-only — values are stored as plaintext in SQLite and can be read by the Worker code (necessary for the Worker to use them).
  - Data Studio visibility — since October 2025, account admins with Workers Platform Admin role can browse DO SQLite tables in the Cloudflare dashboard. Secrets stored here are readable through that interface. However, this requires elevated permissions and access is audit-logged.
  - Not encrypted at the application level — secrets are plaintext in the SQLite rows. A future enhancement could encrypt with a key derived from a deployment-specific value.
  - Tied to the DO instance — if the Worker is redeployed with a different name or the DO is lost, config must be re-entered. Wrangler secrets survive this since they're stored separately.
  - Per-isolate caching — config is cached in Worker memory with a 60-second TTL. A secret rotation takes up to 60 seconds to propagate across all isolates. Acceptable for a settings page used occasionally.

### 6. Encrypted KV (DO-stored key + KV ciphertext)

Generate an AES-256 key in the DO on first boot, encrypt secrets before storing in KV. Requires compromising both systems to extract secrets.

- **Pros:** Strongest application-level security. KV alone gives useless ciphertext. DO alone gives just the raw key.
- **Cons:** Significantly more complex. Two storage systems to manage. Key rotation becomes a multi-step operation. For a self-hosted personal tool, this is over-engineered.

## Decision: Durable Object SQLite (#5)

We chose DO SQLite because it's the only option that satisfies all three constraints simultaneously:

1. **Zero-config UX** — no prerequisites, no CLI, no API tokens
2. **Meaningfully better security than KV** — not API-accessible, not CLI-accessible, admin-only dashboard visibility with audit logging
3. **Simple implementation** — uses existing HubDO singleton, ~30 lines of new code for the config table and RPC methods

The security posture is a pragmatic middle ground: better than KV (no programmatic exfiltration), worse than wrangler secrets (admin can view in Data Studio). For a self-hosted personal deployment, this is an acceptable trade-off. Users who want wrangler-secret-level security can still use `wrangler secret put` — those values always take precedence over DO-stored config.

## Implementation

Secrets are accessed via a `getSecret(env, key)` helper function that:
1. Checks `env[key]` first (wrangler secrets win)
2. Falls back to HubDO's `config` table (cached per-isolate with 60s TTL)

This avoids mutating the Workers `env` object (which is undocumented behavior) and requires updating only ~4 call sites that read configurable secrets.
