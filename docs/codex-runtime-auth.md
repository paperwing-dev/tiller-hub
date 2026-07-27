# Codex Runtime Authentication

Codex subscription execution uses `codex app-server` on both Cloudflare
Containers and Your machine. The trusted runtime supervisor requests scoped access tokens
directly from the Hub through the app-server `chatgptAuthTokens` callback.
There is no separate response proxy, public model hostname, or local relay.

## Selection and lifecycle ownership

Every new lifecycle owner freezes one immutable execution profile before its
launch is committed:

- `subscription-app-server`
- `api-key-direct-cli`
- `api-key-app-server`

The profile stores only its kind, surface, and immutable execution placement. Auth
mode and runtime mode are derived from the kind. Callback URLs, capabilities,
secrets, lifecycle subjects, and access tokens are launch-time supervisor
configuration and are never persisted in the profile.

The supported targets are Cloudflare Containers and the exact machine stored
in the workload placement. Implementor profiles are fenced by environment,
incarnation, and Start operation. Plan Writers are fenced by generation; plan
and environment reviewers are fenced by run. A child-process respawn reuses
the same frozen profile. A replacement execution gets a new identity and
resolves the current Global Settings selection again.

API-key fallback, when allowed by the selected billing mode, is resolved before
launch commit. After commit, a subscription execution never changes to API
billing and no running execution falls back to another route.

## Credential authority and callback routes

`HubDO` owns imported credentials, refresh serialization, account identity,
rejected-token handling, and active-owner validation. Refresh tokens stay in
the Hub. A successful runtime exchange returns only an access token, ChatGPT
account ID, and expiry. The supervisor pins the first returned account for its
launched app-server instance and rejects a later refresh that changes it.

Surface-owned callbacks are:

- `/api/envs/:slug/codex/runtime-auth`
- `/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/runtime-auth`
- `/api/planner-runtime/repos/:repoId/runs/:runId/runtime-auth`
- `/api/env-review-runtime/envs/:slug/runs/:runId/runtime-auth`

Cancellation, replacement, completion, or a newer Start/generation/run makes
the old subject inactive through the existing authoritative fences.

## Process boundary

Subscription implementors start app-server on a private Unix socket and attach
the stock Codex TUI. Writers and reviewers reuse the app-server client. The
supervisor receives `TILLER_CODEX_RUNTIME_AUTH_URL` and
`TILLER_CODEX_RUNTIME_CAPABILITY`; TUI, tool, and model-command children do not.

The centralized child-environment allowlist also excludes Cloudflare Access
credentials, GitHub and other bridge secrets, refresh tokens, callback tokens,
runtime capabilities, and unrelated parent-process secrets. This protects
against accidental inheritance inside the user-owned container/supervisor
boundary; it is not an OS isolation boundary between processes owned by the
same user.

`TILLER_CODEX_RUNTIME_MODE` remains the process-dispatch switch. Both
`app-server` and `direct-cli` remain valid.

## Machine readiness

A compatible machine advertisement includes:

```json
{
  "runnerCommandProtocol": 1,
  "codexRuntimeAuthProtocol": 1
}
```

Readiness uses the live runner session, the exact managed runtime image, and
the runtime-auth protocol. Settings distinguishes an offline backend, a runtime
that needs updating, an environment that is not connected, and unavailable
authentication. Cloudflare availability is evaluated independently and never
depends on a local host capability.

## Hard-cutover maintenance window

This change has no lasting dual execution path or legacy profile reader. Roll
it out in three operational phases:

1. Before the maintenance window, deploy the Hub runtime-auth contract while
   the currently deployed release still selects the gateway.
2. During the window, stop active environments and all Plan Writer/reviewer
   work; deploy app-server-only selection; install the matching Tiller CLI;
   run `tiller host update`; recreate affected workloads normally; verify the
   fresh machine advertisement; and restart the service. The gateway is
   unselectable at this point and no new gateway sessions are minted.
3. Smoke-test a subscription implementor/TUI, a writer, a reviewer, and an
   explicit API-key execution on each enabled backend, then deploy the physical
   gateway-code deletion represented by the final source state.

A connected host without `codexRuntimeAuthProtocol: 1` is reported as
runtime-update-required. It is not used through a compatibility fallback.
Scheduled Codex runs are unsupported and are not migrated.

## Retired Cloudflare resources

The cutover stops provisioning or using the former named Tunnel, DNS record,
and Access application. Tiller deliberately does not delete external
Cloudflare resources during setup or re-registration. After smoke tests pass,
an administrator may remove the old resources manually in the Cloudflare
dashboard:

1. In Zero Trust, delete the Access application and service-token policy that
   protected the old subscription hostname, if they are not shared.
2. In Networks > Tunnels, delete the old Tiller subscription Tunnel.
3. In the relevant DNS zone, delete the old subscription-hostname record.
4. Delete any dedicated service token only after confirming it is unused by
   the Hub or another application.
5. Remove any obsolete host-side `cloudflared` service/configuration using the
   operating system's normal service manager.

Confirm ownership before deleting anything. Existing resources may have been
renamed or repurposed, and Tiller cannot safely infer that from retired local
state.

## Failure behavior

Permanent credential or account-continuity failures require importing the
Codex login again. Temporary refresh failures report authentication
unavailable without destroying the stored credential. Inactive lifecycle
subjects require a new Start or replacement. App-server or TUI crashes may use
the existing paired-process respawn budget and keep their frozen grant.

There is no mid-runtime API-key fallback, auth-file fallback, response proxy,
global epoch, or subscription concurrency scheduler.
