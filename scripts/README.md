# Deploy Scripts

This folder contains the Node-side deployment helpers for `tiller-hub`.

These scripts exist because the public deployment flow has to do more than a
plain `wrangler deploy`:

- derive one deploy-button region input into multiple Cloudflare settings
- create or reuse the R2 bucket before deploy
- support a direct protected custom-domain deploy for power users
- bootstrap Cloudflare Access when the final domain is protected
- work around Wrangler and local-DNS edge cases that do not belong in Worker
  runtime code

## Files

### `deploy-with-region.mjs`

This is the main deploy entrypoint used by:

```bash
npm run deploy
```

It is responsible for:

- loading `.env` for local power-user deploys
- reading `wrangler.jsonc`
- validating `TILLER_REGION`
- deriving a stable R2 bucket name from the Worker name
- ensuring `CLOUDFLARE_ACCOUNT_ID` is set for Wrangler when deploying with an
  API token
- creating the R2 bucket non-interactively when it does not exist
- generating a temporary Wrangler config with:
  - `DO_LOCATION_HINT`
  - `r2_buckets`
  - custom-domain route / `workers_dev = false` when needed
  - preserved live container image refs when no explicit container image
    override was supplied
- deploying the Worker
- optionally finalizing a protected custom-domain deployment through the hub API

There are two supported modes:

1. Bootstrap mode
   - no `TILLER_CUSTOM_DOMAIN`
   - deploys to `workers.dev`

2. Protected custom-domain mode
   - `TILLER_CUSTOM_DOMAIN` is set
   - deploys directly to the custom domain
   - finalizes Cloudflare Access

When the deployed Worker already has Cloudflare container applications, the
script preserves their current image refs by default. This keeps `npm run deploy`
safe for hub-only changes. The root validation deploy and canonical release
workflow pass explicit SHA-tagged image overrides when they intend to upgrade
the containers.

### `access-bootstrap.mjs`

This file contains the script-local Cloudflare Access and readiness helpers.

It intentionally stays separate from the Worker-side `api/access/*` code.
The Worker owns the durable, final Access state. The script only owns the
preflight and readiness checks needed around deployment.

It is responsible for:

- resolving the Cloudflare account from a hostname
- checking whether the hostname is already covered by an unsupported wildcard
  Cloudflare Access app
- probing hub availability
- falling back to public DNS + direct edge probes when the local machine cannot
  resolve the hostname yet

## Why this logic is not inside the Worker

These deploy concerns happen before the final app state exists.

Examples:

- R2 bucket creation has to happen before deploy
- Wrangler needs an account id before it can talk to some APIs
- a direct protected custom-domain deploy needs preflight checks before the hub
  can safely enable Access
- local DNS on the operator machine can lag behind public DNS, but the deploy
  should still be able to confirm that the edge is live

Putting this into the Worker would mix bootstrap concerns with runtime behavior
and make failure recovery harder.

## Important edge cases these scripts handle

### 1. Wrangler account discovery with API tokens

Wrangler may try to call Cloudflare membership APIs when `CLOUDFLARE_ACCOUNT_ID`
is not set. Some API-token flows do not have the permissions Wrangler expects
for that discovery step.

To avoid that, the deploy script derives `CLOUDFLARE_ACCOUNT_ID` from
`TILLER_CUSTOM_DOMAIN` before it calls Wrangler.

### 2. Non-interactive R2 bucket creation

`wrangler r2 bucket create` will prompt to modify config files unless the script
disables that behavior explicitly.

The deploy script always creates buckets with:

- `--update-config=false`

so `npm run deploy` never stops for interactive prompts.

### 3. Local DNS lag on a brand-new custom domain

Sometimes Cloudflare has already attached the custom domain and public resolvers
already return the hostname, but the operator machine still gets `ENOTFOUND`
through the normal `fetch` / `curl` resolver path.

When that happens, `access-bootstrap.mjs`:

- resolves the hostname against public DNS directly
- probes the edge via the returned IPs with the correct hostname / SNI
- treats the domain as ready if the edge responds with:
  - `200`
  - redirect
  - `401`
  - `403`

That prevents a successful deploy from looking “stuck” just because the local
resolver is stale.

### 4. Unsupported wildcard Access coverage

Tiller does not try to take over a hostname that is already covered by a
wildcard Cloudflare Access app.

If preflight detects wildcard coverage, the script fails before deploy with a
clear error. The supported protected path is a custom domain whose exact host
can be owned by Tiller's own Cloudflare Access app.

## Rule of thumb for future changes

If the logic is about:

- the final runtime behavior of the hub
- persistent Access state
- settings shown in the UI

it probably belongs under `api/`.

If the logic is about:

- pre-deploy resource creation
- temporary bootstrap access
- Wrangler quirks
- local operator-machine networking behavior during deploy

it probably belongs in this folder.
