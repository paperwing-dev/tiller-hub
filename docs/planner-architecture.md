# Planner Architecture

The Plan page has one canonical `PlanArtifact`. Plan Writers edit that
artifact through provider-owned planning conversations; reviewers and Plan
Skills remain separate advisory Tiller conversations.

The native Plan Writer path is the product implementation. It has no feature
flag, compatibility writer, candidate application, or writer-chat fallback.

## Terminology

- **Plan Writer** is the long-lived product feature shown below the canonical
  plan artifact. It has explicit Start and Stop operations.
- A **native TUI adapter** is the provider-specific Claude Code or Codex
  implementation inside a running Plan Writer. It is not a separate runner.
- A **one-shot reviewer run** is a disposable provider execution for one
  reviewer or Plan Skill turn. The Tiller thread persists; the provider process
  does not.
- A **runtime backend** places and destroys containers. `cf` uses Cloudflare
  Containers and `host` uses the Docker runner on Your machine. Both Plan Writers and
  one-shot reviewer runs use these same backends.

Plan Skills are orchestration definitions, not writer adapters. Every Plan
Skill invokes one or more one-shot reviewer runs, stores their persistent
history in Tiller, and can create pending contributions for the Plan Writer.

## Durable Model

`reviewer_registry` remains the only writer registry. A writer is identified
solely by:

```text
(repoId, planArtifactId, generation)
```

Its terminal, runtime operation, immutable execution placement, and provider
conversation are bound to that identity. The writer row stores only durable facts: monotonic generation,
provider/model, frozen basis commit, starting body digest, exact runtime
reasoning effort, provenance, provider conversation ownership, publication
cursor, stop reason, and startup/cleanup/synchronization errors.

Each new writer or reviewer run resolves the current Settings selection once.
Retries, reconnects, stop, and cleanup use that stored placement.

`starting` and `running` are derived from registration and retained runtime
facts. Connected browsers, terminal attachment, busy state, idle deadlines,
and saving state are not persisted as lifecycle states.

## Public Lifecycle

The only product lifecycle operations are:

```text
GET  /api/repos/:repoId/plans/:planArtifactId/live-writer
POST /api/repos/:repoId/plans/:planArtifactId/live-writer/start
POST /api/repos/:repoId/plans/:planArtifactId/live-writer/stop
```

GET is read-only. Start is idempotent and returns an existing starting/running
generation. A stopped generation's exact retained runtime must be destroyed
before generation `G+1` can be reserved. Stop requires `expectedGeneration`,
fences publication in ArtifactStore before revoking terminal input, and cannot
affect a replacement. There is no Ensure or Restart lifecycle.

Completing or archiving a plan uses the same internal stop primitive. Returning
the plan to an editable status never starts a writer. Deletion is blocked until
the writer is stopped and exact runtime provenance has been cleared.

## Terminal and Runtime

Plan Writer terminals reuse the normal terminal fast lane and history protocol,
but use a `plan-writer` scope containing repo, plan, and generation. They do not
appear in environment listings or environment cleanup. Revocation is immutable:
history remains readable while input, paste, resize, abort, and controller
operations are rejected.

Both Your machine and Cloudflare use the deterministic generation identity.
The machine runner reuses command-operation fencing. The existing `PlannerRunDO` implements
deterministic create-or-get, exact inspection, and exact destruction for Cloudflare;
no additional Durable Object is used. Infrastructure `sleepAfter` expiry keeps
its normal stop behavior for one-shot jobs, but a DO reserved by a Plan Writer
leaves shutdown to the generation supervisor.

The container entrypoint has an early `plan-writer` branch. It checks out the
frozen basis commit read-only, skips mutable workspace sync and services, drops
the provider to an unprivileged user, and passes only an explicit provider
environment allowlist. GitHub/Hub credentials and MCP configuration are not
available to the provider. A narrow generation credential stays in the
supervisor and is exposed to managed hooks through a local Unix socket.

## Provider Adapters

Claude Code runs its native TUI with a deterministic session ID and Plan
permission mode. Managed hooks establish turn boundaries and intercept
`ExitPlanMode`; the complete plan is published and exit is denied with a saved
or retryable message. Managed `SessionStart` context survives compaction.

Codex runs app-server plus the remote native TUI. The supervisor creates the
foreground root thread in Plan collaboration mode. External turn-complete
notifications are wake-ups; a transient authoritative `thread/read` chooses the
newest complete plan item from that root thread. Missed notifications are found
during startup catch-up. Subagent threads never publish.

Conversation replacement commands and ownership, mode, cwd, sandbox, or
permission drift invalidate the generation. Provider conversation IDs are
ownership/provenance for the current process, not crash recovery.

## Publication

Provider publications contain the generation, provider conversation ID,
monotonic sequence, bounded event ID, Markdown, and SHA-256 digest. The narrow
normalizer changes line endings, trims excess terminal blank lines, and writes
one final newline; it rejects empty or greater-than-1-MiB bodies.

`publishObservedPlan` is the native Plan Writer's Markdown mutation authority.
One ArtifactStore transaction validates ownership and sequencing, recognizes
exact cursor replay first, replaces the complete Markdown atomically, and
updates the cursor. Unchanged bodies do not increment artifact version. Replay
after a lost response is deterministic, and context refresh is repaired through
the same exact replay.

WebSocket artifact/writer messages are hints. The browser refetches
authoritative state after hints, reconnect, and visibility restoration, while
the plan reader preserves the nearest heading and approximate scroll position.

## Activity and Shutdown

The supervisor owns in-memory activity state. Non-empty PTY input, contribution
paste delivery, turn completion, publication completion, and a response handled
inside an active turn are meaningful activity. Terminal output, page views,
attachments, heartbeats, resize/control messages, reviewers, pending
contributions, and skill fan-out are not.

For Cloudflare, turns and publication suspend the globally configured idle
timer, which defaults to 15 minutes. The timer restarts on authoritative
completion. PTY delivery and idle shutdown share one ordered lifecycle queue.
Your machine disables this time-based cutoff after registration. An independent
deployment-only eight-hour deadline protects startup and is cleared as soon as
the runtime registers successfully.

## Reviewers, Contributions, and Skills

Reviewers remain persistent Tiller threads backed by one-shot runs. Every turn
uses the exact plan snapshot captured at submission.

Reviewer forwarding and Plan Skill forwarding create idempotent contributions.
The browser switches to the writer, waits for its acknowledged terminal fast
lane, sends one sanitized bracketed paste followed by Enter, and marks the
delivered contributions `incorporated`. A handoff remains pending if delivery
fails or if no live writer is ready; older pending contributions can be sent or
dismissed explicitly. Publication itself never infers incorporation.

The browser-owned writer composer uses the same live slash-command discovery as
the reviewer UI and invokes the existing Hub fan-out path for both providers.
It always receives the repository's current Plan Skill list, so a newly saved
command does not require a writer restart and multiple commands remain
available. Claude also receives root-owned native projected Plan Skills with
frozen IDs and revision for direct TUI use; Codex relies on the shared browser
composer. Skill results remain in Tiller until the user sends selected reports
to the writer.

## Binary Pins

The image pins Claude Code `2.1.207` and Codex `0.144.3`. Container smoke tests
verify the installed CLI surfaces and generated Codex app-server bindings. The
Plan Writer is available directly after deploying that image and the matching
Hub/UI code.
