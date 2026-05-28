# Deploy To Cloudflare

This package is designed to support a Deploy to Cloudflare flow for the hosted
`tiller-hub` Worker in any user's Cloudflare account.

`tiller`, Tiller Host, and the relay are still local-machine concerns.
They stay outside the deploy button flow.

## What the button covers

- the hosted Worker app
- KV
- R2
- Durable Objects
- Workers AI binding
- Cloudflare-hosted sandboxes via the default `wrangler.jsonc`

The source `wrangler.jsonc` config points at Docker Hub container defaults:

- `docker.io/jamieatlason/tiller-sandbox:stable`
- `docker.io/jamieatlason/tiller-scm:stable`

That is only the starting point. The supported maintainer release flow builds
both images, tags them with the git commit SHA, and deploys the hub with those
SHA-pinned image refs. Hub-only deploys preserve the currently live container
images unless you explicitly override them.

## What it does not replace

- local `tiller` install
- the first local `tiller` run
- `tiller setup`
- the optional Tiller Host backend itself

The normal protected custom-domain path now provisions the gateway hostname,
gateway tunnel config, and DNS record inside `Publish & Protect`. Local
`cloudflared login` and `cert.pem` are only needed for the legacy fallback
where you keep managing the named tunnel on the host yourself.

## Current constraints

- The repository must be public for the button to be useful.
- Cloudflare's deploy button works best when the Worker app is isolated enough
  to deploy from a subdirectory.
- The local half of Tiller still needs post-deploy setup because it is not a
  Worker app.

## Recommended shape

The realistic tight UX is:

1. Click Deploy to Cloudflare for the hosted Worker.
2. Enter one `TILLER_REGION` value: `wnam`, `enam`, `weur`, `eeur`, `apac`, or `oc`.
3. Open the deployed app and finish the setup wizard.
4. Use the included Workers AI model, or add Anthropic/OpenAI keys if you want those providers.
5. Start using Cloudflare-hosted sandboxes immediately.
6. Optionally use the in-app `Publish & Protect` flow to move to your own protected custom domain.
7. Optionally install `tiller` and run it locally if you want execution on your own machine.

## Naming

The hosted Worker does not need to be named `tiller-hub`. The public deploy
flow supports either:

- a custom domain, such as `https://tiller.example.com`
- a `workers.dev` URL, such as `https://my-tiller-control-plane.<subdomain>.workers.dev`

Cloudflare's deploy setup page lets users customize the Worker name. Workers
Builds passes that selected name to Wrangler as `WRANGLER_CI_OVERRIDE_NAME`.
The Tiller deploy script uses that selected name when it derives generated
resources such as the R2 bucket and container applications, so the Worker,
bucket, and container names stay together.

For local power-user deploys outside Workers Builds, set
`TILLER_WORKER_NAME=tiller-hub-maple` before running `npm run deploy` if you
want the same explicit name override.

If you use `workers.dev`, local execution now relies on quick tunnels rather
than derived sibling hostnames. `workers.dev` is also the public bootstrap URL.
The supported protected deployment story is:

1. bootstrap on `workers.dev`
2. use `Publish & Protect` inside the app
3. attach your own domain
4. enable Cloudflare Access in the same flow

The supported product flow does not leave custom domains public.

Inside `Publish & Protect`, Tiller now links users to Cloudflare's API token
page, explains the dashboard labels to use, and verifies the token before
running the workflow. The recommended token starts from `Edit Cloudflare
Workers`, then adds:

- `Account` / `Access: Apps and Policies` / `Edit`
- `Account` / `Access: Service Tokens` / `Edit` if your dashboard exposes it
- `Account` / `Cloudflare Tunnel` / `Edit`
- `Zone` / `DNS` / `Edit`

If the dashboard does not show `Access: Service Tokens`, the user should create
the token from an account role that can manage Zero Trust service tokens.

`HUB_PUBLIC_URL` does not need to be known before first deploy. The Worker
derives it from the request origin until you connect a custom domain and store
the override later.

`TILLER_REGION` is the single deploy-button region input. The deploy script uses
it to create or reuse the R2 bucket in that location and to inject
`DO_LOCATION_HINT` into the generated deploy config before `wrangler deploy`
runs.

Do not put root `.env.example` or `.dev.vars.example` files in the standalone
deploy template. Cloudflare's deploy button treats those files as deploy inputs,
but model credentials are configured later inside the protected app setup flow.

For power users, `npm run deploy` also supports direct protected custom-domain
deploys via `.env`. Start from `docs/examples/deploy-env.sample`:

```bash
cp docs/examples/deploy-env.sample .env
TILLER_CUSTOM_DOMAIN=tiller.example.com
CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
TILLER_ACCESS_EMAILS=you@example.com,teammate@example.com
```

That path creates or reuses a dedicated exact-host Cloudflare Access app for
the hostname. It only supports hostnames that are not already covered by a
wildcard Cloudflare Access app.
When `TILLER_CUSTOM_DOMAIN` is set, the deploy script also derives
`CLOUDFLARE_ACCOUNT_ID` automatically from that hostname so Wrangler does not
need Cloudflare membership discovery for the API token.

For maintainers, there are three distinct deploy/update modes:

1. Validation deploy from the repo root
   - run `npm run deploy`
   - requires local HEAD to match upstream
   - triggers `.github/workflows/validate-deploy.yml`
   - waits for both container images to be published under the current commit SHA
   - deploys `tiller-hub` with `CONTAINER_IMAGE_TAG` and
     `SCM_BOOTSTRAP_IMAGE_TAG` pinned to that SHA
   - updates `tiller-deploy/deploy`

2. Canonical release flow
   - run the manual `.github/workflows/release.yml` workflow
   - bumps and publishes packages from the release commit
   - builds images from that release commit
   - deploys and packages the hub with SHA-pinned image refs
   - updates `tiller-deploy/release`

3. Hub-only deploy from `packages/hub`
   - run `npm run deploy`
   - deploys Worker/config/UI changes only
   - preserves the currently live container image refs unless you explicitly
     override them

If you changed `packages/containers/**` or `packages/harness/**`, use the root
validation deploy or the canonical release workflow. A hub-only deploy will not
roll those container changes forward by itself.

`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are no longer required for
the deploy script itself. They are also no longer part of the normal CLI
onboarding path. Protected hubs bootstrap those values through the browser on
the first `tiller` run, and `tiller init` remains the advanced manual fallback.

For local development, use [wrangler.dev.jsonc](../wrangler.dev.jsonc) through
`npm run dev`. That local config is intentionally Tiller-Host-only: it sets the
default backend to `host`, points the hub at `http://127.0.0.1:8789`, and does
not configure Cloudflare Containers for localhost startup. Start from
`docs/examples/local-dev-vars.sample`; local model auth must go in `.dev.vars`,
not `.env`. Set at least one of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
or `OPENAI_API_KEY` or localhost will stay on the "Required setup" page.
