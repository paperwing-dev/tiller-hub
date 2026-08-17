export interface BrowserTerminalMetricSummary {
  label: string;
  session: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  peakRecoveryMessages: number;
  peakRecoveryBytes: number;
}

type BrowserTerminalMetricLogger = Pick<Console, "info" | "warn">;

function safeTerminalIdentifier(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ref_${value.length}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

/** Browser-local terminal metrics. Never records terminal content or raw identifiers. */
export class BrowserTerminalMetricRecorder {
  private readonly sessionRef: string;
  private readonly samples = new Map<string, number[]>();
  private sampleCount = 0;
  private windowStartedAt = performance.now();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private peakRecoveryMessages = 0;
  private peakRecoveryBytes = 0;

  constructor(
    sessionId: string,
    private readonly isEnabled: () => boolean,
    private readonly logger: BrowserTerminalMetricLogger = console,
  ) {
    this.sessionRef = safeTerminalIdentifier(sessionId);
  }

  record(label: string, durationMs: number): void {
    if (!this.isEnabled()) return;
    const samples = this.samples.get(label) ?? [];
    samples.push(Math.max(0, durationMs));
    this.samples.set(label, samples);
    this.sampleCount += 1;

    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), 30_000);
    }
    if (durationMs >= 100) {
      this.logger.warn("[tiller] slow terminal metric", {
        label,
        session: this.sessionRef,
        durationMs,
      });
    }
    if (this.sampleCount >= 64 || performance.now() - this.windowStartedAt >= 30_000) {
      this.flush();
    }
  }

  observeRecoveryQueue(messages: number, bytes: number): void {
    if (!this.isEnabled()) return;
    this.peakRecoveryMessages = Math.max(this.peakRecoveryMessages, messages);
    this.peakRecoveryBytes = Math.max(this.peakRecoveryBytes, bytes);
  }

  flush(): BrowserTerminalMetricSummary[] {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const summaries: BrowserTerminalMetricSummary[] = [];
    for (const [label, samples] of this.samples) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((left, right) => left - right);
      const summary: BrowserTerminalMetricSummary = {
        label,
        session: this.sessionRef,
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        peakRecoveryMessages: this.peakRecoveryMessages,
        peakRecoveryBytes: this.peakRecoveryBytes,
      };
      summaries.push(summary);
      this.logger.info("[tiller] terminal metrics", summary);
    }
    this.samples.clear();
    this.sampleCount = 0;
    this.peakRecoveryMessages = 0;
    this.peakRecoveryBytes = 0;
    this.windowStartedAt = performance.now();
    return summaries;
  }

  reset(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.samples.clear();
    this.sampleCount = 0;
    this.peakRecoveryMessages = 0;
    this.peakRecoveryBytes = 0;
    this.windowStartedAt = performance.now();
  }

  dispose(): void {
    if (this.isEnabled()) this.flush();
    else this.reset();
  }
}
