export const TERMINAL_ACK_TIMEOUT_MS = 1000;
export const TERMINAL_WARNING_COOLDOWN_MS = 2000;

export interface TerminalAckTrackerOptions {
  // Stale-ACK warning (yellow): at most one while any tracked seq is pending.
  onStaleWarning: (message: string) => void;
  // Failed-ACK report (red): coalesced on a cooldown, see warnFailure below.
  onFailure: (message: string) => void;
  // Live-send drop warning (yellow): coalesced on a cooldown.
  onDrop: (message: string) => void;
  timeoutMs?: number;
  cooldownMs?: number;
}

// Tracks fast-lane terminal input/control seqs awaiting ACKs. ACKs are
// live-only, so entries self-delete on timeout and the owner must call
// clear() on disconnect — anything in flight then will never be acked.
export class TerminalAckTracker {
  private pendingInputs = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingControls = new Map<number, ReturnType<typeof setTimeout>>();
  private warningActive = false;
  private failureWarnedAt: number | null = null;
  private dropWarnedAt: number | null = null;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly options: TerminalAckTrackerOptions) {
    this.timeoutMs = options.timeoutMs ?? TERMINAL_ACK_TIMEOUT_MS;
    this.cooldownMs = options.cooldownMs ?? TERMINAL_WARNING_COOLDOWN_MS;
  }

  trackInput(inputSeq: number): void {
    const timer = setTimeout(() => {
      // Delete on timeout so a never-acked seq (e.g. across a dropped socket)
      // can't grow the map forever or suppress future warnings.
      this.pendingInputs.delete(inputSeq);
      this.warnOnce("Terminal input is delayed; waiting for the remote session.");
      this.resetWarningIfIdle();
    }, this.timeoutMs);
    this.pendingInputs.set(inputSeq, timer);
  }

  trackControl(controlSeq: number): void {
    const timer = setTimeout(() => {
      this.pendingControls.delete(controlSeq);
      this.warnOnce("Terminal control is delayed; waiting for the remote session.");
      this.resetWarningIfIdle();
    }, this.timeoutMs);
    this.pendingControls.set(controlSeq, timer);
  }

  handleInputAck(inputSeq: number, error?: string): void {
    const timer = this.pendingInputs.get(inputSeq);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingInputs.delete(inputSeq);
    if (error) {
      this.warnFailure(`Terminal input failed: ${error}`);
    } else {
      this.failureWarnedAt = null;
    }
    this.resetWarningIfIdle();
  }

  handleControlAck(controlSeq: number, error?: string): void {
    const timer = this.pendingControls.get(controlSeq);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingControls.delete(controlSeq);
    if (error) {
      this.warnFailure(`Terminal control failed: ${error}`);
    } else {
      this.failureWarnedAt = null;
    }
    this.resetWarningIfIdle();
  }

  warnSendFailed(what: string): void {
    const now = Date.now();
    if (this.dropWarnedAt != null && now - this.dropWarnedAt < this.cooldownMs) return;
    this.dropWarnedAt = now;
    this.options.onDrop(`Not connected — ${what} dropped.`);
  }

  clear(): void {
    for (const timer of this.pendingInputs.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.pendingControls.values()) {
      clearTimeout(timer);
    }
    this.pendingInputs.clear();
    this.pendingControls.clear();
    this.warningActive = false;
    this.failureWarnedAt = null;
  }

  private warnOnce(message: string): void {
    if (this.warningActive) return;
    this.warningActive = true;
    this.options.onStaleWarning(message);
  }

  private resetWarningIfIdle(): void {
    if (this.pendingInputs.size === 0 && this.pendingControls.size === 0) {
      this.warningActive = false;
    }
  }

  // Coalesce failed-ACK reports on a cooldown rather than on empty pending
  // maps: in a no-owner window each failed ACK drains the map immediately, so
  // a drain-based reset would still report once per keypress.
  private warnFailure(message: string): void {
    const now = Date.now();
    if (this.failureWarnedAt != null && now - this.failureWarnedAt < this.cooldownMs) return;
    this.failureWarnedAt = now;
    this.options.onFailure(message);
  }
}
