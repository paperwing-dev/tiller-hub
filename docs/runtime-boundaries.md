# Runtime Boundaries

This document defines the ownership rules that all runtime code must follow.
It is normative — new code must comply with these boundaries.

## Five Owners

### EnvLifecycleDO

Owns:
- env runtime phase (`stopped | starting | running | saving | stopping | failed`)
- start/stop operation IDs
- durable stop/save sequencing
- explicit lifecycle transitions from request handlers and op-id-matched runner callbacks

Does not own:
- session terminal presence
- harness child process health
- startup event transport
- read-path repair based on backend polling

### SandboxDO

Owns:
- Cloudflare container start/stop/status
- port readiness
- runner lifecycle callbacks into EnvLifecycleDO
- idle-timeout-based runner collection (`sleepAfter`)

Does not own:
- final env phase policy
- harness health policy
- session truth

### entrypoint.sh

Owns:
- local service boot inside the container
- spawning tiller-harness as a direct child process
- tracking real child PIDs
- local cleanup when the container itself is stopping (SIGTERM)

Does not own:
- env lifecycle policy
- session attachability semantics
- startup diagnostics authority

### tiller-harness

Owns:
- hub session creation
- harness process spawn/respawn (via `harness-supervisor.ts`)
- WebSocket session traffic
- agent/harness input and output routing

Does not own:
- whether the env as a whole should stop

### Startup Diagnostics

Own:
- stable startup step IDs
- recent startup event timeline
- capped harness / stop-control / bootstrap log tails

Do not own:
- env lifecycle truth without the matching start op ID
- session terminal transport
- runner supervision

## Harness Failure vs Env Stop

Lead-process exit is **not** env stop. When tiller-harness exits unexpectedly:

1. `entrypoint.sh` checks the `stop-requested` marker
2. If the marker is absent, this is a harness failure:
   - report `leadHarnessStatus: "failed"` to the hub
   - keep the container alive for debugging
   - let the idle timeout collect the container
3. If the marker is present, this is an intentional stop:
   - proceed with the durable stop path as normal

The env can be `status: "running"` while `leadHarnessStatus: "failed"`.
These are separate state dimensions. Do not collapse them.

## Stop Markers

Two local markers coordinate the stop path inside the container:

| Marker | Written by | When | Meaning |
|---|---|---|---|
| `stop-requested` | stop-control-server | immediately on `/prepare-stop` | an intentional lifecycle stop is in flight |
| `stop-prepared` | stop-control-server | after snapshot upload succeeds | durable-stop precondition is satisfied |

Both markers are cleared on container boot.

## Side Channels That Must Stay Subordinate

- **startup diagnostics**: debugging surface only, never lifecycle truth without matching op ID
- **session.active**: attachability/session presence only, never env runtime truth
- **KV status**: projected cache of lifecycle state, never the primary authority
- **backend status probes**: observational only, never a normal lifecycle transition path

## Forbidden Shortcuts

- Session presence is not env truth
- startup diagnostics are not lifecycle by themselves
- Lead-process exit is not env stop
- Harness health is not env lifecycle phase
