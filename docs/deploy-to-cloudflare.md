# Deploy to Cloudflare

Each production Tiller Hub has one protected, exact workers.dev origin. Worker
custom domains, aliases, and competing persisted public URLs are unsupported.

## Deploy Button Scope

The Cloudflare deploy flow creates:

- the Worker UI and API;
- KV and R2 storage;
- Durable Objects;
- the Workers AI binding; and
- Cloudflare Container applications.

The source configuration starts from the public Docker Hub images:

- `docker.io/jamieatlason/tiller-sandbox:stable`
- `docker.io/jamieatlason/tiller-scm:stable`

Release and validation deployments pin both applications to the release commit
SHA. Hub-only deploys preserve the currently deployed image references unless
they receive explicit image overrides.

The deploy flow does not install the local CLI or prepare Your machine.

## Canonical Origin and Access

The Worker name determines the canonical URL, for example:

```text
https://tiller.<account-subdomain>.workers.dev
```

The first browser visit loads only the Access onboarding UI and allowlisted
onboarding APIs. All other APIs, callbacks, agent routes, and WebSocket routes
fail closed until canonical trust is committed.

Onboarding creates or retains two exact-host Cloudflare Access applications:

- `Tiller Hub`
- `Tiller callbacks`

It also retains one owner identity provider, the owner and service-token
policies, and one installation-wide service token. The owner comes from the
Cloudflare OAuth identity. No custom hostname is provisioned.

After trust exists, top-level Worker ingress compares every UI, API, callback,
agent, and WebSocket request with the exact canonical origin. Other production
hostnames return not found. Localhost remains available for contributors.

GitHub App homepage, setup, and webhook URLs are always generated from the
canonical helper. Request origins and retired persisted public URLs are not
trusted.

## Normal Setup

1. Deploy the Worker.
2. On Cloudflare's deployment configuration page, enter `wnam`, `enam`,
   `weur`, `eeur`, `apac`, or `oc` in the blank `TILLER_REGION` field. This
   choice is required; Cloudflare does not infer the nearest region.
3. Open the exact workers.dev URL.
4. Complete Cloudflare Access and GitHub App onboarding.
5. Configure model access.
6. Create workloads using the default Cloudflare Containers selection.
7. Optionally copy the Settings command to prepare Your machine:

   ```bash
   tiller host setup --hub-url https://<exact-host>.workers.dev
   ```

8. Explicitly click **Use this machine** in Settings.

The machine workflow uses the existing Hub service credential and authenticated
session. It does not create DNS, a Tunnel, a runner hostname, or another Access
application.

## Deployment Inputs

`HUB_PUBLIC_URL`, custom-domain configuration, and deploy-time
`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are not part of the supported
production path. The canonical URL is derived from committed workers.dev
trust.

`TILLER_REGION` controls the R2 location and Durable Object location hint.
There is no geographic default. The checked-in value is blank so Cloudflare's
deployment form requires input; the deployment script independently rejects a
missing or invalid choice before resource creation.
Model credentials are configured after Access onboarding; do not add root
`.env.example` or `.dev.vars.example` files to the standalone deploy template.

For local or CI API-token deploys, set `CLOUDFLARE_ACCOUNT_ID` explicitly.
Also set `TILLER_REGION` explicitly, for example:

```bash
TILLER_REGION=weur CLOUDFLARE_ACCOUNT_ID=<account-id> npm run deploy
```

## Maintainer Deployment Paths

Validation deploy from the monorepo root:

```bash
npm run deploy
```

This requires local HEAD to match upstream, builds and publishes SHA-tagged
runtime images, deploys those exact images, and updates the validation record.

The canonical release workflow publishes packages and images from the release
commit, deploys SHA-pinned applications, and updates the release record.

A Hub-only deploy from `packages/hub` changes Worker/config/UI code and
preserves live container image references. If `packages/harness` or
`packages/containers` changed, use validation or release instead.

## Clean-Slate Releases

The sticky-placement release requires a coordinated maintenance window and no
old-client compatibility period. Follow
[workers-dev-execution-cutover.md](workers-dev-execution-cutover.md). The
predeploy gate must report zero workload definitions, active runs, retained
runtimes, and pending cleanup before the final Worker is deployed.

The migration captures legacy resource identifiers in a secret-free cleanup
manifest and never calls Cloudflare to delete external resources. Operators
download the manifest and clean those resources manually after verifying the
canonical deployment.

## Local Development

Use `wrangler.dev.jsonc` through:

```bash
cd packages/hub
npm run dev
```

Loopback requests are intentionally exempt from canonical ingress. Start
`tiller host` separately for local Docker execution and put local model
credentials in `.dev.vars`.
