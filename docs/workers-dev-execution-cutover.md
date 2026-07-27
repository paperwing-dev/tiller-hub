# workers.dev and Sticky-Placement Cutover

This release is a clean workload version. Deploy it in one coordinated
maintenance window. Do not retain or migrate an environment, planner run,
review, plan writer, standalone runtime, or machine provenance from an earlier
version.

There is no dual-origin period, old-client compatibility mode, runtime
reassignment, or stopped-Cloudflare canary.

## Before the Window

Prove the candidate against a live protected workers.dev Hub:

- owner login reaches the UI and owner-only APIs;
- the installation service credential reaches HTTP and WebSocket routes;
- callback bypasses reach only their exact paths;
- the CLI encrypted connection succeeds;
- one machine advertises healthy Docker, runner protocol, runtime-auth
  protocol, and runtime image;
- Settings can select that exact machine;
- a fresh workload starts, attaches, reconnects, refreshes runtime auth, and
  deletes normally;
- changing Settings affects only subsequently created work; and
- an unavailable selected backend fails without using the other backend.

Publish the compatible CLI and both runtime images before changing the live
Hub.

Determine the exact canonical workers.dev origin from committed Access trust.
Update and verify the GitHub App homepage, setup URL, and webhook URL against
that origin. Any pending OAuth attempt created from another origin must expire
or be removed before strict ingress.

## Capture Legacy Cleanup Identifiers

Before legacy Hub configuration is cleared, ensure its complete resource
identifiers are present so the atomic migration can capture:

- custom hostname and Worker service;
- account, zone, and custom-domain IDs; and
- legacy custom-domain Access application and policy IDs.

The manifest must not contain an API token, Access secret, canonical service
token, canonical Access application, or canonical policy.

The migration writes the versioned manifest in the same `HubDO` transaction
that clears legacy state. It makes no external Cloudflare request. After
deployment, the owner downloads it from:

```text
GET /api/settings/legacy-custom-domain-cleanup
```

The response is uncached and downloadable. Absence returns 404. External
resources are removed manually only after the new Hub is verified.

## Maintenance Window

1. Re-run the protected workers.dev canary for owner login, service HTTP and
   WebSocket access, callbacks, and CLI connection.
2. Confirm the compatible CLI and runtime images are published.
3. Capture cleanup identifiers; update and verify every external callback URL.
4. While their assigned backends are available, synchronize and normally
   delete every Cloudflare- and machine-backed environment.
5. Drain and remove every planner, reviewer, plan writer, and standalone
   runtime on both backends.
6. Run the predeploy gate and abort unless it reports zero workload
   definitions, active runs, retained runtimes, and pending cleanup:

   ```text
   GET /api/settings/predeploy-clean-slate
   ```

7. Stop the old machine service.
8. Deploy the final Worker, strict canonical ingress, removed routes, and
   atomic configuration migration.
9. If desired, run the exact Settings command and explicitly select the ready
   machine:

   ```bash
   tiller host setup --hub-url https://<exact-host>.workers.dev
   ```

10. Create all workloads fresh.

Do not proceed past step 6 with blockers. Do not force-delete, forget, repair,
or infer the placement of residual records.

## Atomic Configuration Migration

The idempotent migration:

- requires canonical workers.dev trust;
- preserves a valid new-format execution selection or writes `{ "target":
  "cf" }`;
- captures the cleanup manifest before clearing legacy resource state;
- clears deployment-mode, custom-domain, rollback, setup-session, origin-bound
  OAuth attempt, and legacy host-registration state; and
- performs no external mutation.

It does not migrate workload or machine provenance. An unexpected legacy
workload record fails closed.

## Post-Deploy Verification

Verify:

- only the exact workers.dev origin serves UI, API, callbacks, agents, and
  WebSockets;
- `Tiller Hub` and `Tiller callbacks` remain the active canonical Access
  applications;
- removed custom-domain, promotion, lifecycle, return, rollback, and
  deployment-mode endpoints return 404;
- Settings initially selects Cloudflare unless a valid new selection existed;
- the cleanup manifest is owner-only, uncached, downloadable, and secret-free;
- machine setup preserves its generated UUID across subsequent setup/update;
- Settings selection is explicit and machine-ID precondition conflicts are
  visible; and
- fresh workloads retain their original placement through restart, schedule,
  reconnect, retry, stop, cleanup, and deletion.

Only after these checks should the identifiers in the cleanup manifest be used
for manual Cloudflare resource cleanup.
