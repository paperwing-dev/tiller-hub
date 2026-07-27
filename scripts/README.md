# Deploy Scripts

This folder contains the Node-side deployment helper for `tiller-hub`.

The public deployment flow does more than a plain `wrangler deploy`:

- derive one deploy-button region input into multiple Cloudflare settings
- create or reuse the R2 bucket before deploy
- preserve live container image references during Hub-only deploys
- keep Wrangler-specific deployment concerns out of Worker runtime code

## `deploy-with-region.mjs`

This is the deploy entrypoint used by:

```bash
npm run deploy
```

It is responsible for:

- loading `.env` for local maintainer deploys
- reading `wrangler.jsonc`
- honoring the Worker name selected by Workers Builds or `TILLER_WORKER_NAME`
- requiring and validating the deploy-button selection or explicit
  `TILLER_REGION` environment override
- deriving a stable R2 bucket name from the Worker name
- deriving generated container application names from the selected Worker name
- using an explicit `CLOUDFLARE_ACCOUNT_ID` for container image inspection
- creating the R2 bucket non-interactively when it does not exist
- generating a temporary workers.dev Wrangler config with `DO_LOCATION_HINT`
  and the selected R2 bucket
- deploying the Worker

The script deploys only to workers.dev. Custom domains and aliases are not
supported Hub origins.

When the Worker already has Cloudflare container applications, the script
preserves their current image references by default. This keeps Hub-only
deploys safe. Validation and release workflows pass explicit SHA-tagged image
overrides when they intend to upgrade the containers.

## Important behavior

### Explicit Cloudflare account selection

Set `CLOUDFLARE_ACCOUNT_ID` for local or CI API-token deploys. This avoids
Wrangler membership discovery and lets the script inspect existing container
applications before it deploys.

Set `TILLER_REGION` explicitly for local or CI deploys. The tracked Wrangler
configuration intentionally leaves the value blank so public deploy-button
users cannot silently inherit a maintainer's geography:

```bash
TILLER_REGION=wnam CLOUDFLARE_ACCOUNT_ID=<account-id> npm run deploy
```

### Non-interactive R2 bucket creation

The script creates buckets with:

```text
--update-config=false
```

so `npm run deploy` never pauses to modify the source config interactively.

## Rule of thumb for future changes

Runtime behavior, persistent Access state, and authenticated settings belong
under `api/`. This folder should contain only pre-deploy resource creation,
temporary Wrangler config generation, and maintainer deployment concerns.
