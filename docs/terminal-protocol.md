# Durable Terminal Protocol

## Canonical durable stream

Session terminal output is committed and delivered in this order:

1. `ThreadDO.appendSessionMessage` commits the event and allocates its sequence.
2. Hub broadcasts that canonical event after the commit returns.
3. Browser and CLI consumers apply events in sequence order and advance only after their terminal write completes.

`message-received` and the HTTP session-message representation retain `id`, `sessionId`/`session_id`, canonical `seq`, `content`, and optional `localId`/`local_id`.

`StoredSession.seq` remains on the wire for compatibility, but is deprecated and non-authoritative. It is not updated by new session-message appends. `session-alive` updates `updated_at` for coarse activity ordering.

ThreadDO stores a sequence-authority marker for every thread. Generic non-session threads remain `external-v0`. The first successful session append atomically changes its deterministic `session:<id>` thread to `thread-v1`, after incorporating the existing `MAX(seq)`. A `thread-v1` session thread rejects the legacy externally sequenced append path.

Duplicate UUID behavior is canonical and fail closed:

- The same UUID, sender, kind, body, and local ID returns the original event without rebroadcast.
- A differing reuse of the UUID fails with `session_message_conflict`.
- Other commit failures surface as `session_message_commit_failed`.
- Legacy session writes after cutover fail with `legacy_sequence_authority_rejected`.

These errors never include terminal content or an underlying exception.

## Recovery bounds

Only durable session `message-received` events pass through the ordering gate. Permissions, terminal ACKs, detach, and connection state remain live while recovery is incomplete.

- Cold mount reads one newest-first page of 200 and adopts `firstSeq - 1` as its intentional baseline.
- Cache recovery restores the callback-completed serialized screen, then pages forward.
- Gap and reconnect recovery page forward in batches of 1,000 until a short page.
- Every full page must advance its cursor.
- Pending HTTP events, WebSocket events, xterm writes, and CLI stdout backpressure share a limit of 4,096 messages or 8 MiB.
- Total recovery time is 15 seconds. Transient fetch retries wait 250 ms, 500 ms, 1 second, 2 seconds, and 4 seconds while inside that deadline.
- Conflicting sequence/UUID/payload representations, overflow, deadline, and non-progress stop recovery without advancing past the last completed terminal write.
- Browser and CLI consumers handle the first overflow or deadline by discarding their local recovery state and cold-loading the newest 200 messages. They warn that older missed output was skipped. A second overflow/deadline, collision, non-progress, or fetch failure remains fail-closed.

Browser recovery offers Retry and Detach. CLI recovery requires reattachment; raw terminal input/output stops, while permission and detach controls remain available.

## Terminal operation protocol 1

A harness advertises `terminalOperationProtocol: 1` in its owner reconnect registration. Until Hub acknowledges a capability-only `replay: false` registration with the canonical ThreadDO high-water sequence, every socket continues registering with replay disabled. The acknowledgement is ordered through the session append-and-broadcast chain and must echo the current session and registration ID with an empty event list. The harness adopts that sequence without dispatching historical actions; stale, malformed, and uncorrelated replay responses are ignored. Later reconnect replay pages are also correlated and ordered through that chain. Live durable events wait behind the replay barrier, where overlapping events are validated and accepted once before the harness cursor advances; full 1,000-message pages continue until a short page completes recovery. Strict controller routing activates only on that exact live owner connection. Older owners retain legacy routing.

Client terminal input may include `cols` and `rows`. Hub alone adds `applyDimensions` to forwarded input. A valid first resize claims an unowned terminal. A successfully delivered non-empty input transfers control; old input without dimensions transfers without changing size. Passive resizes are acknowledged as successful no-ops. Input that waited for an owner is forwarded with `applyDimensions: false`.

`terminal-detach { sessionId, clientId }`, viewer disconnect, session switch, owner rebinding, and owner replacement release the applicable lease.

The harness runs PTY output, headless xterm parsing, resize, and ordinary input through one ordered queue. CPR and abort are priority protocol operations. Only normal/private CPR replies are forwarded. The local terminal and durable stream receive the DSR-filtered node-pty string; headless xterm receives the original string.

## Rollout and rollback

Deploy in this order:

1. Hub capability support, optional input dimensions, detach, and legacy fallback.
2. Browser and CLI clients.
3. Harness and container image advertising protocol 1.

For Your machine, verify the pinned `localRunnerImage` and delete/recreate the
workload normally before evaluating a runtime fix; a running container retains
the image it was created with.

The ThreadDO sequence cutover is forward-only. A normal rollback may revert UI, recovery, or controller behavior, but must retain ThreadDO allocation, the authority marker, and legacy session-write rejection.

A complete old-code rollback is a maintenance operation:

1. Stop all session-message ingestion.
2. Wait for every in-flight append to finish.
3. Run Hub's read-only `getSessionSequenceReconciliation()` report (backed by each ThreadDO's `getCanonicalMaxSequence()`).
4. Reconcile each deprecated `sessions.seq` to that exact maximum.
5. Verify that ThreadDO reports no duplicate IDs or sequences and that all reconciled values match.
6. Only then deploy code that uses the legacy allocator.

## Reliability boundary

Durable ordering and recovery are improved; lossless harness-to-Hub delivery is not yet guaranteed.

Producer delivery remains at-most-once. The next phase adds producer commit ACK, bounded unacknowledged spooling, same-UUID retry, and one centralized consumer accept-once gate. This protocol does not add previews, duplicate rebroadcast, TerminalDO, local echo, Enter batching, or speculative output.

## Flush measurement

The default autonomous-output window is a first-byte-anchored, non-resetting 250 ms timer for both isolated and continuous output. Buffers flush at 32 KiB and never exceed 64 KiB or 250 ms. For 100 ms after terminal input, the harness uses the 8 ms input-echo path so typing stays responsive. Set `TILLER_OUTPUT_FLUSH_MS=8` or `16` only for a fixed diagnostic comparison; other values select 250 ms.

Set `TILLER_TERMINAL_METRICS=1` on Hub and harness processes to emit hop-local p50, p95, p99, operation rate, bytes, queue depth, and CPU samples. Set browser local storage key `tiller:terminal-metrics` to `true` for xterm parse and recovery-queue samples. Metrics use only each process's monotonic clock; never subtract timestamps from different processes or machines.

Use a controlled passthrough process such as `node -e "process.stdin.pipe(process.stdout)"` and send unique `tiller-echo:<nonce>` lines. Measure the input ACK/network baseline separately, then correlate each nonce with its callback-completed output. The input-echo path should keep keypress-to-parsed-output p95 no more than baseline + 50 ms and p99 no more than baseline + 100 ms.

Compare ThreadDO commit, Hub broadcast, network transit, headless/browser xterm parse, commits per second, bytes, CPU, and peak recovery queue. A live epoch/offset stream needs a separate design and is considered only if the durable commit/broadcast span is the dominant remaining delay; UUID previews are not an option.
