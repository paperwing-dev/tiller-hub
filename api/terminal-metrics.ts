export interface HopMetricSummary {
  label: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  operationsPerSecond: number;
  bytes: number;
}

export function safeTerminalIdentifier(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ref_${value.length}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

/** Hop-local aggregation only; it never combines clocks from different processes. */
export class HopMetricRecorder {
  private samples: number[] = [];
  private bytes = 0;
  private windowStartedAt = performance.now();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly label: string,
    private readonly enabled: boolean,
    private readonly emit: (summary: HopMetricSummary) => void = (summary) => console.log("[terminal-metric]", summary),
  ) {}

  record(durationMs: number, bytes = 0): void {
    if (!this.enabled) return;
    this.samples.push(Math.max(0, durationMs));
    this.bytes += Math.max(0, bytes);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 30_000);
    }
    if (durationMs >= 100) {
      console.warn("[terminal-metric] slow sample", {
        label: this.label,
        durationMs,
        bytes,
      });
    }
    if (this.samples.length >= 64 || performance.now() - this.windowStartedAt >= 30_000) {
      this.flush();
    }
  }

  flush(): HopMetricSummary | null {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.samples.length === 0) return null;
    const now = performance.now();
    const elapsedSeconds = Math.max(0.001, (now - this.windowStartedAt) / 1000);
    const sorted = [...this.samples].sort((left, right) => left - right);
    const summary: HopMetricSummary = {
      label: this.label,
      count: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      operationsPerSecond: sorted.length / elapsedSeconds,
      bytes: this.bytes,
    };
    this.samples = [];
    this.bytes = 0;
    this.windowStartedAt = now;
    this.emit(summary);
    return summary;
  }
}
