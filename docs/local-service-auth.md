# Machine Service Authentication

`tiller host` maintains one authenticated service session to the canonical
workers.dev Hub. The installation-wide Cloudflare Access credential is shared
by the CLI, machine service, runtime harnesses, callbacks, HTTP, and
WebSockets. It is not a per-machine credential.

## Identity and Readiness

Machine setup generates and persists a UUID. The hostname is advertised
separately as `displayName` and is never used as execution provenance.

`machine-alive` binds the authenticated socket to that UUID only. A subsequent
fresh advertisement must report:

- healthy Docker and local runner checks;
- runner command protocol 1;
- runtime-auth protocol 1; and
- the Hub-compatible runtime image.

Only then can it claim the one live machine slot. A different live UUID is
rejected. For duplicate sockets with the same UUID, the newest healthy
advertisement is command-active.

## Runner Control

The Hub does not discover runner URLs from Worker secrets. Fenced commands
travel over the authenticated machine session:

1. lifecycle state identifies the workload's stored machine UUID;
2. `HubDO` verifies that exact UUID is currently healthy and routable;
3. `HubDO` sends the command to its command-active socket;
4. the machine daemon forwards it to the loopback runner; and
5. the runner acknowledges the exact command generation, operation ID, and
   desired state.

No command is redirected to the current Settings selection or another machine.

The retired `LOCAL_RUNNER_URL`, `LOCAL_RUNNER_TOKEN`,
`RESEARCH_RELAY_URL`, and `RESEARCH_RELAY_TOKEN` paths remain unsupported.

## Cloudflare Access

Service calls send the canonical Access client ID and secret to Cloudflare.
The Worker trusts only Cloudflare's verified application JWT. A service
principal must have no owner email and a signed `common_name` equal to the
canonical service client ID.

Raw credential headers are not origin authentication. Custom-domain scalar
`CF_ACCESS_*` trust is unsupported.

## Runtime Authentication

Codex subscription runtimes start app-server on a private Unix socket. The
supervisor presents a scoped callback capability to the Hub, which verifies
the stored environment start, writer generation, or review run before issuing
an access token.

Refresh credentials, Access credentials, bridge secrets, and callback
capabilities are excluded from child process environments. See
[codex-runtime-auth.md](codex-runtime-auth.md).

## Failure Behavior

- No healthy advertised machine: new machine-selected work returns the selected
  backend error.
- Stored machine offline: existing work returns delete/recreate guidance.
- Runtime image or protocol mismatch: Settings reports the incompatibility;
  there is no alternate backend.
- Lifecycle owner replaced or cancelled: the old callback is rejected and
  never rebound.
- Destroy not acknowledged: durable workload state remains intact.

Loopback URLs and `host.docker.internal` are used only for local process and
contributor networking; they do not define machine identity.
