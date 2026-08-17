export const RECOVERY_PAGE_SIZE = 1000;
export const COLD_MOUNT_PAGE_SIZE = 200;
export const MAX_RECOVERY_MESSAGES = 4096;
export const MAX_RECOVERY_BYTES = 8 * 1024 * 1024;
export const RECOVERY_DEADLINE_MS = 15_000;
export const RECOVERY_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

export interface DurableTerminalMessage {
  id: string;
  sessionId: string;
  seq: number;
  content: unknown;
  localId?: string;
}

export type TerminalRecoveryFaultCode =
  | "collision"
  | "overflow"
  | "deadline"
  | "non_progress"
  | "fetch_failed";

export type TerminalRecoveryState =
  | { status: "recovering" }
  | { status: "ready" }
  | { status: "fault"; code: TerminalRecoveryFaultCode };

export interface TerminalRecoveryFetchOptions {
  limit: number;
  afterSeq?: number;
  maxBytes: number;
  signal: AbortSignal;
  onBytes(receivedBytes: number): void;
}

export class TerminalRecoveryOverflowError extends Error {
  constructor() {
    super("terminal_recovery_overflow");
    this.name = "TerminalRecoveryOverflowError";
  }
}

export interface TerminalRecoveryOptions {
  sessionId: string;
  fetchPage(options: TerminalRecoveryFetchOptions): Promise<DurableTerminalMessage[]>;
  write(message: DurableTerminalMessage, callback: () => void): void;
  onSequenceComplete(seq: number): void;
  onStateChange(state: TerminalRecoveryState): void;
  onSettled(lastSeq: number): void;
  /** Sequence represented by the last completed canonical screen checkpoint. */
  getStableSequence?(): number | undefined;
  restoreStableScreen?(callback: () => void): void;
  onQueueUsage?(messages: number, bytes: number): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxMessages?: number;
  maxBytes?: number;
  deadlineMs?: number;
}

interface PendingMessage {
  message: DurableTerminalMessage;
  fingerprint: string;
  bytes: number;
}

type StableRestorePhase = "idle" | "waiting-for-write" | "restoring";

interface TerminalRecoveryFetchRequest {
  limit: number;
  afterSeq?: number;
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const normalized = normalize((candidate as Record<string, unknown>)[key]);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function messageFingerprint(message: DurableTerminalMessage): string {
  return stableJson({
    id: message.id,
    sessionId: message.sessionId,
    seq: message.seq,
    content: message.content,
    localId: message.localId ?? null,
  });
}

function serializedBytes(message: DurableTerminalMessage): number {
  return new TextEncoder().encode(messageFingerprint(message)).byteLength;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded accept-once window for browser terminal history and live events.
 * IDs are retained only while an event is unapplied; callback-completed state
 * relies on ThreadDO's canonical invariants.
 */
export class TerminalRecoveryController {
  private readonly bySeq = new Map<number, PendingMessage>();
  private readonly seqById = new Map<string, number>();
  private pendingBytes = 0;
  private reservedBytes = 0;
  private fetchReservedBytes = 0;
  private fetchReservedMessages = 0;
  private activeFetchAbort: AbortController | null = null;
  private lastCompletedSeq = 0;
  private baselineKnown = false;
  private state: TerminalRecoveryState = { status: "recovering" };
  private writePending = false;
  private fetchPending = false;
  private recoveryRequested = false;
  private restorePhase: StableRestorePhase = "idle";
  private retryRequested = false;
  private disposed = false;
  private generation = 0;
  private deadlineAt = 0;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: TerminalRecoveryOptions) {
    this.options.onStateChange(this.state);
  }

  get lastSeq(): number {
    return this.lastCompletedSeq;
  }

  get recoveryState(): TerminalRecoveryState {
    return this.state;
  }

  get pendingMessageCount(): number {
    return this.bySeq.size;
  }

  get isSettled(): boolean {
    return (
      this.state.status === "ready" &&
      !this.writePending &&
      !this.fetchPending &&
      this.bySeq.size === 0
    );
  }

  async startCold(): Promise<void> {
    const generation = this.beginRecovery(0, false);
    const request = this.createFetchRequest(COLD_MOUNT_PAGE_SIZE);
    if (!request) return;
    const page = await this.fetchWithRetry(request, generation);
    if (!page || !this.isCurrent(generation)) return;
    if (page.length > request.limit) {
      this.fault("overflow");
      return;
    }
    this.releaseFetchReservation();

    const chronological = [...page].sort((left, right) => left.seq - right.seq);
    const firstSeq = chronological[0]?.seq;
    this.lastCompletedSeq = firstSeq === undefined ? 0 : Math.max(0, firstSeq - 1);
    this.baselineKnown = true;
    this.discardBeforeOrAtBaseline();
    for (const message of chronological) {
      if (!this.acceptPending(message)) return;
    }
    this.fetchPending = false;
    this.drainOrRecoverGap(generation);
  }

  startCacheRestore(lastSeq: number, serializedBytes: number, restore: (callback: () => void) => void): void {
    const generation = this.beginRecovery(0, false);
    this.reservedBytes = serializedBytes;
    this.reportQueueUsage();
    if (this.reservedBytes > (this.options.maxBytes ?? MAX_RECOVERY_BYTES)) {
      this.fault("overflow");
      return;
    }
    try {
      this.writePending = true;
      restore(() => {
        if (!this.isCurrent(generation)) {
          if (this.state.status === "fault" && this.restorePhase === "waiting-for-write") {
            this.adoptCompletedCache(lastSeq);
          }
          this.completeFaultedWriteBarrier();
          return;
        }
        this.adoptCompletedCache(lastSeq);
        void this.fetchForward(lastSeq, generation);
      });
    } catch {
      this.writePending = false;
      this.reservedBytes = 0;
      this.fault("non_progress");
    }
  }

  recoverGap(): void {
    if (this.disposed || this.state.status === "fault" || !this.baselineKnown) return;
    if (this.writePending) {
      this.recoveryRequested = true;
      if (this.state.status !== "recovering") {
        this.setState({ status: "recovering" });
        this.armDeadline(this.generation, true);
      }
      return;
    }
    if (this.fetchPending) return;
    const preserveDeadline = this.state.status === "recovering" && this.deadlineTimer !== null;
    const generation = this.beginRecovery(this.lastCompletedSeq, true, false, preserveDeadline);
    void this.fetchForward(this.lastCompletedSeq, generation);
  }

  retry(): void {
    if (this.disposed || this.state.status !== "fault") return;
    if (this.restorePhase !== "idle") {
      this.retryRequested = true;
      return;
    }
    this.startRetry();
  }

  private startRetry(): void {
    this.retryRequested = false;
    if (!this.baselineKnown) {
      this.clearPendingWindow();
      void this.startCold();
      return;
    }
    this.clearPendingWindow();
    const generation = this.beginRecovery(this.lastCompletedSeq, true);
    void this.fetchForward(this.lastCompletedSeq, generation);
  }

  acceptLive(message: DurableTerminalMessage): void {
    if (this.disposed || message.sessionId !== this.options.sessionId) return;
    if (this.state.status === "fault") return;
    if (this.baselineKnown && message.seq <= this.lastCompletedSeq) return;
    if (!this.acceptPending(message)) return;

    if (!this.baselineKnown) return;
    const expected = this.lastCompletedSeq + 1;
    if (message.seq > expected && !this.fetchPending && !this.writePending) {
      this.recoverGap();
      return;
    }
    this.drainOrRecoverGap(this.generation);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.retryRequested = false;
    this.restorePhase = "idle";
    this.abortActiveFetch();
    this.clearDeadline();
    this.clearPendingWindow();
  }

  private beginRecovery(
    baseline: number,
    baselineKnown: boolean,
    resetWindow = true,
    preserveDeadline = false,
  ): number {
    this.abortActiveFetch();
    this.generation += 1;
    if (resetWindow) this.clearPendingWindow();
    this.lastCompletedSeq = baseline;
    this.baselineKnown = baselineKnown;
    this.fetchPending = true;
    this.writePending = false;
    this.recoveryRequested = false;
    this.setState({ status: "recovering" });
    const generation = this.generation;
    this.armDeadline(generation, !preserveDeadline);
    return generation;
  }

  private armDeadline(generation: number, resetDeadline: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (resetDeadline) {
      this.deadlineAt = now + (this.options.deadlineMs ?? RECOVERY_DEADLINE_MS);
    }
    this.clearDeadline();
    this.deadlineTimer = setTimeout(() => {
      if (this.isCurrent(generation) && this.state.status === "recovering") {
        this.fault("deadline");
      }
    }, Math.max(0, this.deadlineAt - now));
  }

  private setState(next: TerminalRecoveryState): void {
    if (
      this.state.status === next.status &&
      (this.state.status !== "fault" || next.status !== "fault" || this.state.code === next.code)
    ) return;
    this.state = next;
    this.options.onStateChange(next);
  }

  private acceptPending(message: DurableTerminalMessage): boolean {
    if (
      message.sessionId !== this.options.sessionId ||
      !Number.isInteger(message.seq) ||
      message.seq < 1 ||
      !message.id
    ) {
      this.fault("collision");
      return false;
    }
    if (this.baselineKnown && message.seq <= this.lastCompletedSeq) return true;

    const fingerprint = messageFingerprint(message);
    const sameSeq = this.bySeq.get(message.seq);
    if (sameSeq) {
      if (sameSeq.fingerprint !== fingerprint) this.fault("collision");
      return sameSeq.fingerprint === fingerprint;
    }
    const existingSeq = this.seqById.get(message.id);
    if (existingSeq !== undefined) {
      const existing = this.bySeq.get(existingSeq);
      if (!existing || existing.fingerprint !== fingerprint) this.fault("collision");
      return existing?.fingerprint === fingerprint;
    }

    const bytes = serializedBytes(message);
    if (
      this.bySeq.size + this.fetchReservedMessages + 1 >
        (this.options.maxMessages ?? MAX_RECOVERY_MESSAGES) ||
      this.pendingBytes + this.reservedBytes + this.fetchReservedBytes + bytes >
        (this.options.maxBytes ?? MAX_RECOVERY_BYTES)
    ) {
      this.fault("overflow");
      return false;
    }
    const pending: PendingMessage = { message, fingerprint, bytes };
    this.bySeq.set(message.seq, pending);
    this.seqById.set(message.id, message.seq);
    this.pendingBytes += bytes;
    this.reportQueueUsage();
    return true;
  }

  private discardBeforeOrAtBaseline(): void {
    for (const [seq, pending] of this.bySeq) {
      if (seq > this.lastCompletedSeq) continue;
      this.bySeq.delete(seq);
      this.seqById.delete(pending.message.id);
      this.pendingBytes -= pending.bytes;
      this.reportQueueUsage();
    }
  }

  private async fetchForward(cursor: number, generation: number): Promise<void> {
    let nextCursor = cursor;
    while (this.isCurrent(generation)) {
      const request = this.createFetchRequest(RECOVERY_PAGE_SIZE, nextCursor);
      if (!request) return;
      const page = await this.fetchWithRetry(request, generation);
      if (!page || !this.isCurrent(generation)) return;
      if (page.length > request.limit) {
        this.fault("overflow");
        return;
      }
      this.releaseFetchReservation();
      const chronological = [...page].sort((left, right) => left.seq - right.seq);
      const advancedCursor = chronological.reduce((max, message) => Math.max(max, message.seq), nextCursor);
      if (chronological.length > 0 && advancedCursor <= nextCursor) {
        this.fault("non_progress");
        return;
      }
      for (const message of chronological) {
        if (!this.acceptPending(message)) return;
      }
      if (chronological.length < request.limit) break;
      nextCursor = advancedCursor;
    }
    if (!this.isCurrent(generation)) return;
    this.fetchPending = false;
    if (this.bySeq.size > 0 && !this.bySeq.has(this.lastCompletedSeq + 1)) {
      this.fault("non_progress");
      return;
    }
    this.drainOrRecoverGap(generation);
  }

  private async fetchWithRetry(
    request: TerminalRecoveryFetchRequest,
    generation: number,
  ): Promise<DurableTerminalMessage[] | null> {
    this.fetchReservedMessages = request.limit;
    this.reportQueueUsage();
    let attempt = 0;
    while (this.isCurrent(generation)) {
      if (this.deadlineExceeded()) {
        this.fault("deadline");
        return null;
      }
      const remainingBytes = (this.options.maxBytes ?? MAX_RECOVERY_BYTES)
        - this.pendingBytes
        - this.reservedBytes;
      if (remainingBytes <= 0) {
        this.fault("overflow");
        return null;
      }
      this.fetchReservedBytes = 0;
      const abortController = new AbortController();
      this.activeFetchAbort = abortController;
      try {
        const page = await this.options.fetchPage({
          ...request,
          maxBytes: remainingBytes,
          signal: abortController.signal,
          onBytes: (receivedBytes) => this.reserveFetchBytes(receivedBytes, generation),
        });
        if (this.activeFetchAbort === abortController) this.activeFetchAbort = null;
        if (this.deadlineExceeded()) {
          this.fault("deadline");
          return null;
        }
        return page;
      } catch (error) {
        if (this.activeFetchAbort === abortController) this.activeFetchAbort = null;
        this.fetchReservedBytes = 0;
        this.reportQueueUsage();
        if (!this.isCurrent(generation)) return null;
        if (error instanceof TerminalRecoveryOverflowError) {
          this.fault("overflow");
          return null;
        }
        const delayMs = RECOVERY_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          this.fault("fetch_failed");
          return null;
        }
        attempt += 1;
        if ((this.options.now ?? Date.now)() + delayMs >= this.deadlineAt) {
          this.fault("deadline");
          return null;
        }
        await (this.options.sleep ?? defaultSleep)(delayMs);
      }
    }
    return null;
  }

  private createFetchRequest(
    pageSize: number,
    afterSeq?: number,
  ): TerminalRecoveryFetchRequest | null {
    const remainingMessages = (this.options.maxMessages ?? MAX_RECOVERY_MESSAGES) - this.bySeq.size;
    const remainingBytes = (this.options.maxBytes ?? MAX_RECOVERY_BYTES)
      - this.pendingBytes
      - this.reservedBytes;
    if (remainingMessages <= 0 || remainingBytes <= 0) {
      this.fault("overflow");
      return null;
    }
    return {
      limit: Math.min(pageSize, remainingMessages),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    };
  }

  private reserveFetchBytes(receivedBytes: number, generation: number): void {
    if (
      !this.isCurrent(generation) ||
      !Number.isInteger(receivedBytes) ||
      receivedBytes < this.fetchReservedBytes ||
      this.pendingBytes + this.reservedBytes + receivedBytes >
        (this.options.maxBytes ?? MAX_RECOVERY_BYTES)
    ) {
      throw new TerminalRecoveryOverflowError();
    }
    this.fetchReservedBytes = receivedBytes;
    this.reportQueueUsage();
  }

  private releaseFetchReservation(): void {
    this.fetchReservedBytes = 0;
    this.fetchReservedMessages = 0;
    this.reportQueueUsage();
  }

  private abortActiveFetch(): void {
    const active = this.activeFetchAbort;
    this.activeFetchAbort = null;
    active?.abort();
    this.fetchReservedBytes = 0;
    this.fetchReservedMessages = 0;
    this.reportQueueUsage();
  }

  private drainOrRecoverGap(generation: number): void {
    if (!this.isCurrent(generation) || this.writePending || !this.baselineKnown) return;
    if (this.state.status === "recovering" && this.fetchPending) return;
    const next = this.bySeq.get(this.lastCompletedSeq + 1);
    if (!next) {
      if (this.fetchPending) return;
      if (this.bySeq.size > 0) {
        this.recoverGap();
        return;
      }
      this.clearDeadline();
      this.setState({ status: "ready" });
      this.options.onSettled(this.lastCompletedSeq);
      return;
    }

    this.writePending = true;
    const callbackGeneration = this.generation;
    try {
      this.options.write(next.message, () => {
        if (!this.isCurrent(callbackGeneration)) {
          this.completeFaultedWriteBarrier();
          return;
        }
        this.writePending = false;
        if (this.deadlineExceeded() && this.state.status === "recovering") {
          this.fault("deadline");
          return;
        }
        this.bySeq.delete(next.message.seq);
        this.seqById.delete(next.message.id);
        this.pendingBytes -= next.bytes;
        this.reportQueueUsage();
        this.lastCompletedSeq = next.message.seq;
        this.options.onSequenceComplete(this.lastCompletedSeq);
        if (this.recoveryRequested) {
          this.recoveryRequested = false;
          this.recoverGap();
          return;
        }
        this.drainOrRecoverGap(callbackGeneration);
      });
    } catch {
      this.writePending = false;
      this.fault("non_progress");
    }
  }

  private deadlineExceeded(): boolean {
    return (this.options.now ?? Date.now)() >= this.deadlineAt;
  }

  private fault(code: TerminalRecoveryFaultCode): void {
    if (this.disposed || this.state.status === "fault") return;
    const waitForWrite = this.writePending && this.options.restoreStableScreen !== undefined;
    this.generation += 1;
    this.fetchPending = false;
    this.writePending = false;
    this.recoveryRequested = false;
    this.retryRequested = false;
    const stableSequence = this.options.getStableSequence?.();
    if (
      stableSequence !== undefined &&
      Number.isInteger(stableSequence) &&
      stableSequence >= 0
    ) {
      this.lastCompletedSeq = stableSequence;
      this.baselineKnown = true;
    } else if (this.options.getStableSequence) {
      // The screen will be reset, but there is no completed checkpoint to
      // represent any partially written cold-mount records. Retry through the
      // bounded latest-tail path instead of treating sequence zero (or a
      // partial write) as a canonical rollback baseline.
      this.lastCompletedSeq = 0;
      this.baselineKnown = false;
    }
    this.restorePhase = waitForWrite ? "waiting-for-write" : "idle";
    this.abortActiveFetch();
    this.clearDeadline();
    this.setState({ status: "fault", code });
    if (!waitForWrite) this.beginStableRestore();
  }

  private completeFaultedWriteBarrier(): void {
    if (this.state.status !== "fault" || this.restorePhase !== "waiting-for-write") return;
    this.restorePhase = "idle";
    this.beginStableRestore();
  }

  private beginStableRestore(): void {
    if (this.disposed || this.state.status !== "fault" || this.restorePhase !== "idle") return;
    const restore = this.options.restoreStableScreen;
    if (!restore) {
      if (this.retryRequested) this.startRetry();
      return;
    }
    this.restorePhase = "restoring";
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (this.disposed) return;
      this.restorePhase = "idle";
      if (this.retryRequested && this.state.status === "fault") this.startRetry();
    };
    try {
      restore(complete);
    } catch {
      complete();
    }
  }

  private adoptCompletedCache(lastSeq: number): void {
    this.writePending = false;
    this.reservedBytes = 0;
    this.reportQueueUsage();
    this.lastCompletedSeq = lastSeq;
    this.baselineKnown = true;
    this.discardBeforeOrAtBaseline();
    this.options.onSequenceComplete(lastSeq);
  }

  private clearPendingWindow(): void {
    this.bySeq.clear();
    this.seqById.clear();
    this.pendingBytes = 0;
    this.reservedBytes = 0;
    this.releaseFetchReservation();
    this.reportQueueUsage();
  }

  private reportQueueUsage(): void {
    this.options.onQueueUsage?.(
      this.bySeq.size + this.fetchReservedMessages,
      this.pendingBytes + this.reservedBytes + this.fetchReservedBytes,
    );
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.state.status !== "fault";
  }
}
