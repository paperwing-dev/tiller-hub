# Scheduled Runs

Scheduled Runs start one selected plan at the browser-computed next local
3:00 AM. They use the execution backend selected in Settings when the stopped
environment is created, the Codex harness, and the configured OpenAI API or
subscription billing route. The scheduled time must be in the future and no
more than 36 hours away.

## Ownership

`EnvLifecycleDO` is the single lifecycle authority. It owns environment
creation, the schedule alarm, ordinary Start and Stop, the three-hour hard
cap, persistence, cleanup, and the public projection. There is no scheduler
poller and no parallel scheduling state machine.

`ScheduledRunCapacityDO` owns only two exact-pair capacity leases. Its keys are
`{ slug, attemptId }`. Release records a monotonically ordered fence even when
no lease is visible, so a delayed acquire cannot recreate capacity after a
cancel or deadline.

The harness owns process-scoped behavior: replacement prompt delivery, the
30-minute idle timer, and exact-operation completion or idle reports.

## Stored state

Each environment incarnation stores its selected plan once:

```ts
interface ImmutableEnvironmentPlan {
  incarnationId: string;
  artifactId: string;
  version: number;
  renderedPlanDocument: string;
  createdAt: string;
}
```

Scheduled instructions are not part of the document. Editing or deleting the
source artifact does not change a scheduled run or a later ordinary Start for
that environment.

The lifecycle record is flat:

```text
EnvironmentPlanSchedule
  -> ActiveScheduledRunReceipt
  -> FinishedScheduledRunReceipt
```

The active receipt pins the winning plan incarnation, attempt, Start
operation, harness settings, execution placement, non-secret model route,
runner generation, credential scope, and cleanup facts. A machine-backed
receipt includes the exact machine UUID; a Cloudflare receipt has no machine
ID. Finished receipts retain whether Start occurred. The attempt counter and
runner-command generation are high-water keys that survive rollback,
environment deletion, and slug reuse.

## Creation and publication

Creation validates the selected backend, harness, configured billing route,
timezone, time window, and one specific plan. It then persists that placement
and creates a stopped environment without minting credentials, creating a
runtime, or acquiring capacity.

The lifecycle owner first stores pending mutable state, the immutable plan,
and a provisional recovery alarm. External KV publication happens while the
incarnation claim is still held. A transaction then makes the incarnation
visible, clears the claim, and replaces the recovery alarm with the schedule
alarm. Rollback always clears failed pending state, even when KV cleanup
reports an error, while preserving the incarnation tombstone and high-water
keys.

## Starting

At the alarm, the owner performs read-only eligibility checks, persists an
attempt, acquires capacity, revalidates the stored backend and billing route,
and atomically claims ordinary Start. Machine-backed runs require their exact
stored machine; Cloudflare-backed runs do not consult the current Settings
selection or machine state. No second Start is issued after that claim.

Credential construction, workspace restoration, plan materialization, and
runner dispatch happen under a minimal preparation receipt. Stop or the hard
cap may lock the outcome and allocate a newer runner generation while
preparation is live, but cleanup and persistence settlement wait until the
preparation effect is quiescent.

Credentials are minted and revoked for the exact
`{ incarnationId, startOpId }` scope. `credentialsMayExist` is cleared only
after exact cleanup succeeds. Container commands also carry the monotonically
increasing runner generation, so delayed Start cannot overtake Stop.

Transient eligibility failures retry every ten minutes. Capacity denial
retries every minute. An ambiguous capacity acquire does not retry Start; it
retains the attempt and reconciles exact release first. All pre-Start retries
end at `runAtMs + 3h`.

## Completion and finalization

The initial and replacement prompts deliver the pinned plan and tell the agent
to inspect the persisted workspace. When implementation and verification are
complete, the agent runs:

```bash
tiller-plan complete
```

The command retries transient and ambiguous responses and includes the exact
Start operation. Idle, manual Stop, and the post-Start hard cap request
Interrupted. Completion requests Completed. The first requested outcome wins
in the same transaction that claims or reuses ordinary Stop and allocates its
newer runner generation.

Completed or Interrupted is final only after strict workspace persistence,
fenced runner-stop evidence, scoped credential cleanup, and exact capacity
release. Save failure remains Failed. Runner uncertainty alone sets
`cleanupRequired`; reconnecting the assigned machine and retrying exact Stop can clear
that uncertainty and recover the already requested outcome.

## Cancellation and actions

Cancel is idempotent before Start. If capacity acquisition may have happened,
the schedule remains finalizing until exact release is confirmed. Delete first
cancels a pending schedule and is rejected while a run is active, cleanup is
finalizing, or runner uncertainty remains.

| Projection | UI actions |
| --- | --- |
| Scheduled | `Scheduled · 3:00 AM`; Cancel; Delete through cancellation |
| Running / implementing | `Implementing plan`; Stop |
| Running / saving | `Saving and finalizing`; Stop is idempotent |
| Completed, Interrupted, clean Failed | Ordinary Start and Delete |
| Failed with runner uncertainty | Assigned machine required; no migration or reassignment control |

An ordinary Start atomically archives a clean terminal projection while
retaining the immutable plan and persisted workspace.

## API

Creation accepts:

```ts
schedule?: { runAtMs: number; timeZone: string };
```

Environment projections expose:

```ts
scheduledRun?: {
  state: "scheduled" | "running" | "completed" | "interrupted" | "failed";
  stage?: "implementing" | "saving";
  runAtMs: number;
  timeZone: string;
  error?: string;
  cleanupRequired?: boolean;
};
```

Lifecycle endpoints are:

```text
POST /api/envs/:slug/scheduled-run/cancel
POST /api/envs/:slug/scheduled-run/idle
POST /api/envs/:slug/plan-execution/complete
```

Idle and completion require `X-Tiller-Lifecycle-Op-Id`.

The Cloudflare binding is `SCHEDULED_RUN_CAPACITY`, exported as
`ScheduledRunCapacityDO`. The capacity class and migration were not present in
the production baseline, so its unshipped migration entry uses the final class
name directly; no deployed-class rename migration is required.

## Review boundary

Automated review is deliberately outside this lifecycle. The stable seam is:

```text
implementation complete -> completion request -> ordinary Stop
```

A review feature can intercept the completion request with its own operation,
then issue final completion without changing schedule, capacity, persistence,
or cleanup ownership.
