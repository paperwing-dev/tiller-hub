import { Container } from "@cloudflare/containers";
import {
  CodexAuthCoordinator,
  isCodexAuthHelperResult,
  type AuthConnectProvider,
  type CodexAuthHelperResult,
} from "./codex-auth-coordinator";
import type { Env } from "./types";

const HELPER_COMMAND = "tiller-codex-auth-helper";
export const CODEX_AUTH_HELPER_OPERATION_TIMEOUT_MS = 7_500;
const HELPER_TERMINATION_GRACE_MS = 250;
const MAX_HELPER_OUTPUT_BYTES = 128 * 1_024;

interface ContainerExecProcess {
  output(): Promise<{
    stdout: ArrayBuffer;
    stderr: ArrayBuffer;
    exitCode: number;
  }>;
  kill(signal?: number): void;
}

interface ContainerWithExec {
  running: boolean;
  exec(
    command: string[],
    options: {
      stdin: ReadableStream;
      stdout: "pipe";
      stderr: "ignore";
    },
  ): Promise<ContainerExecProcess>;
}

interface CodexAuthHelperCommandOptions {
  authJson: string;
  start(signal: AbortSignal): Promise<void>;
  container(): ContainerWithExec | undefined;
  destroy(): Promise<void>;
  timeoutMs?: number;
}

class CodexAuthHelperDeadlineError extends Error {}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  onTimeout: () => void,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    onTimeout();
    throw new CodexAuthHelperDeadlineError();
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new CodexAuthHelperDeadlineError());
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CodexAuthContainerDestroyFence {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly destroyInstance: () => Promise<void>) {}

  destroy(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    let tracked!: Promise<void>;
    tracked = Promise.resolve().then(() => this.destroyInstance()).finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  async beforeStart(signal: AbortSignal): Promise<void> {
    const pending = this.inFlight;
    if (pending) await pending;
    if (signal.aborted) throw new Error("Codex auth Container start was cancelled");
  }
}

export async function runCodexAuthHelperCommand(
  options: CodexAuthHelperCommandOptions,
): Promise<CodexAuthHelperResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_AUTH_HELPER_OPERATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { version: 1, ok: false, error: { code: "refresh_timeout" } };
  }
  const deadline = Date.now() + timeoutMs;
  const cleanupReserveMs = Math.min(500, Math.max(1, Math.floor(timeoutMs / 4)));
  const workDeadline = deadline - cleanupReserveMs;
  const controller = new AbortController();
  let process: ContainerExecProcess | null = null;
  let outputPromise: ReturnType<ContainerExecProcess["output"]> | null = null;
  try {
    await beforeDeadline(options.start(controller.signal), workDeadline, () => controller.abort());
    const container = options.container();
    if (!container?.running) {
      return { version: 1, ok: false, error: { code: "helper_unavailable" } };
    }
    process = await beforeDeadline(container.exec([HELPER_COMMAND], {
      stdin: new Blob([options.authJson]).stream(),
      stdout: "pipe",
      stderr: "ignore",
    }), workDeadline, () => controller.abort());
    outputPromise = process.output();
    const output = await beforeDeadline(outputPromise, workDeadline, () => controller.abort());
    if (output.stdout.byteLength > MAX_HELPER_OUTPUT_BYTES) {
      return { version: 1, ok: false, error: { code: "invalid_refresh_result" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(output.stdout)) as unknown;
    } catch {
      return { version: 1, ok: false, error: { code: "refresh_failed" } };
    }
    if (!isCodexAuthHelperResult(parsed) || (output.exitCode !== 0 && parsed.ok)) {
      return { version: 1, ok: false, error: { code: "invalid_refresh_result" } };
    }
    return parsed;
  } catch (error) {
    const timedOut = error instanceof CodexAuthHelperDeadlineError;
    controller.abort();
    if (process) {
      try { process.kill(15); } catch { /* already gone */ }
      const remainingCleanupMs = Math.max(0, deadline - Date.now());
      const graceMs = Math.min(
        HELPER_TERMINATION_GRACE_MS,
        Math.floor(remainingCleanupMs / 2),
      );
      if (outputPromise && !await settlesWithin(outputPromise, graceMs)) {
        try { process.kill(9); } catch { /* already gone */ }
      }
    }
    try {
      // The auth Container is an inert singleton. Destroying it is the only
      // way to fence an exec acquisition that timed out before yielding a PID,
      // and it also guarantees no app-server child survives a helper timeout.
      await beforeDeadline(options.destroy(), deadline, () => undefined);
    } catch {
      return { version: 1, ok: false, error: { code: "helper_unavailable" } };
    }
    return {
      version: 1,
      ok: false,
      error: { code: timedOut ? "refresh_timeout" : "helper_unavailable" },
    };
  }
}

function randomGrant(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export class CodexAuthDO extends Container<Env> {
  sleepAfter = "1m";
  entrypoint = ["/usr/bin/tail", "-f", "/dev/null"];
  enableInternet = true;
  private coordinatorInstance: CodexAuthCoordinator | null = null;
  private readonly destroyFence = new CodexAuthContainerDestroyFence(() => this.destroy());

  private get coordinator(): CodexAuthCoordinator {
    if (!this.coordinatorInstance) {
      this.coordinatorInstance = new CodexAuthCoordinator({
        store: {
          get: async <T>(key: string) => await this.ctx.storage.get<T>(key),
          put: async <T>(key: string, value: T) => await this.ctx.storage.put(key, value),
        },
        runHelper: (authJson) => this.runHelper(authJson),
        scheduleRefresh: async (at, expectedRevision) => {
          await this.schedule(at, "refreshScheduled", { expectedRevision });
        },
        createGrant: randomGrant,
      });
    }
    return this.coordinatorInstance;
  }

  private async runHelper(authJson: string): Promise<CodexAuthHelperResult> {
    return await runCodexAuthHelperCommand({
      authJson,
      start: async (signal) => {
        await this.destroyFence.beforeStart(signal);
        await this.start({
          entrypoint: this.entrypoint,
          enableInternet: this.enableInternet,
        }, {
          portToCheck: 1,
          signal,
          retries: Math.ceil(CODEX_AUTH_HELPER_OPERATION_TIMEOUT_MS / 100),
          waitInterval: 100,
        });
      },
      container: () => this.ctx.container as unknown as ContainerWithExec | undefined,
      destroy: async () => await this.destroyFence.destroy(),
    });
  }

  connectCodexAuth(authJson: string) {
    return this.coordinator.connect(authJson);
  }

  exchangeCodexRuntimeAuth(rejectedAccessTokenSha256?: string) {
    return this.coordinator.exchange(rejectedAccessTokenSha256);
  }

  getCodexAuthStatus(refresh = false) {
    return this.coordinator.status(refresh);
  }

  issueAuthConnectGrants(providers: AuthConnectProvider[], connectionId?: string) {
    return this.coordinator.issueGrants(providers, connectionId);
  }

  consumeAuthConnectGrant(provider: AuthConnectProvider, grant: string) {
    return this.coordinator.consumeGrant(provider, grant);
  }

  recordAuthConnectResult(
    provider: AuthConnectProvider,
    grant: string,
    result: "success" | "error",
    error?: string,
  ) {
    return this.coordinator.recordGrantResult(provider, grant, result, error);
  }

  getAuthConnectStatus(connectionId: string) {
    return this.coordinator.connectionStatus(connectionId);
  }

  async refreshScheduled(payload: { expectedRevision?: unknown }): Promise<void> {
    if (!Number.isSafeInteger(payload?.expectedRevision) || (payload.expectedRevision as number) < 1) return;
    await this.coordinator.scheduledRefresh(payload.expectedRevision as number);
  }
}
