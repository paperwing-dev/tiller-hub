import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

const NATIVE_WRITER_IDENTITY_KEY = "native-plan-writer-identity";
const NATIVE_RUNTIME_FENCE_KEY = "native-runtime-fence";

interface NativeRuntimeFence {
  state: "fenced" | "absent";
  jobSlug: string | null;
}

// Dedicated container class for one-shot hosted planner runs. Bound to the
// sandbox image in wrangler.jsonc — the planner needs the coding CLIs and the
// tiller-planner bin baked there; lightweight GitHub job images do not.
export class PlannerRunDO extends Container<Env> {
  // Native lifecycle RPCs may arrive while container start/destroy is awaiting
  // I/O. Keep the complete operation ordered inside this deterministic DO so
  // a fenced Stop cannot be overtaken by an earlier late Start.
  private runtimeOperationTail: Promise<void> = Promise.resolve();
  sleepAfter = "8h";

  async startPlannerJob(envVars: Record<string, string>): Promise<void> {
    await this.enqueueRuntimeOperation(async () => {
      if (await this.ctx.storage.get<NativeRuntimeFence>(NATIVE_RUNTIME_FENCE_KEY)) {
        throw new Error("Planner runtime was already destroyed.");
      }
      if (envVars.TILLER_REVIEWER_ISOLATION_PROTOCOL !== "1") {
        throw new Error("Protected reviewer isolation is required.");
      }
      await this.start({ envVars, enableInternet: true });
    });
  }

  async destroyPlannerJob(): Promise<void> {
    await this.enqueueRuntimeOperation(async () => {
      const existing = await this.ctx.storage.get<NativeRuntimeFence>(NATIVE_RUNTIME_FENCE_KEY);
      if (existing?.state === "absent") return;
      await this.ctx.storage.put(NATIVE_RUNTIME_FENCE_KEY, {
        state: "fenced",
        jobSlug: null,
      } satisfies NativeRuntimeFence);
      await this.ctx.container?.destroy();
      await this.ctx.storage.put(NATIVE_RUNTIME_FENCE_KEY, {
        state: "absent",
        jobSlug: null,
      } satisfies NativeRuntimeFence);
    });
  }

  async onActivityExpired(): Promise<void> {
    const planWriterIdentity = await this.ctx.storage.get<string>(NATIVE_WRITER_IDENTITY_KEY);
    if (planWriterIdentity) {
      // Plan Writer meaningful-idle policy belongs to its supervisor. Returning
      // without stopping renews the Container activity timeout.
      return;
    }
    await super.onActivityExpired();
  }

  /**
   * Reserves and starts the one deterministic Plan Writer identity assigned
   * to this DO. Replayed and concurrent creates converge without inventing a
   * launch nonce; a different identity can never take over the instance.
   */
  async ensurePlanWriterRuntime(
    jobSlug: string,
    envVars: Record<string, string>,
  ): Promise<{ jobSlug: string; created: boolean }> {
    return this.enqueueRuntimeOperation(async () => {
      let created = false;
      await this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get<NativeRuntimeFence>(NATIVE_RUNTIME_FENCE_KEY)) {
          throw new Error(`Plan Writer runtime ${jobSlug} was already destroyed.`);
        }
        const existing = await transaction.get<string>(NATIVE_WRITER_IDENTITY_KEY);
        if (existing && existing !== jobSlug) {
          throw new Error(`Planner runtime is already reserved for ${existing}.`);
        }
        if (!existing) {
          await transaction.put(NATIVE_WRITER_IDENTITY_KEY, jobSlug);
          created = true;
        }
      });
      if (!created) return { jobSlug, created: false };
      try {
        await this.start({ envVars, enableInternet: true });
        return { jobSlug, created: true };
      } catch (error) {
        await this.ctx.storage.transaction(async (transaction) => {
          if (await transaction.get<string>(NATIVE_WRITER_IDENTITY_KEY) === jobSlug) {
            await transaction.delete(NATIVE_WRITER_IDENTITY_KEY);
          }
        });
        throw error;
      }
    });
  }

  async inspectPlanWriterRuntime(jobSlug: string): Promise<{ registered: boolean; live: boolean; jobSlug: string | null }> {
    return this.enqueueRuntimeOperation(async () => {
      const registeredJobSlug = await this.ctx.storage.get<string>(NATIVE_WRITER_IDENTITY_KEY) ?? null;
      if (registeredJobSlug && registeredJobSlug !== jobSlug) {
        throw new Error(`Planner runtime is reserved for ${registeredJobSlug}, not ${jobSlug}.`);
      }
      const state = await this.getState();
      return {
        registered: registeredJobSlug === jobSlug,
        live: registeredJobSlug === jobSlug && (state.status === "running" || state.status === "healthy"),
        jobSlug: registeredJobSlug,
      };
    });
  }

  async destroyPlanWriterRuntime(jobSlug: string): Promise<void> {
    await this.enqueueRuntimeOperation(async () => {
      let alreadyAbsent = false;
      await this.ctx.storage.transaction(async (transaction) => {
        const registeredJobSlug = await transaction.get<string>(NATIVE_WRITER_IDENTITY_KEY) ?? null;
        const fence = await transaction.get<NativeRuntimeFence>(NATIVE_RUNTIME_FENCE_KEY) ?? null;
        if (registeredJobSlug && registeredJobSlug !== jobSlug) {
          throw new Error(`Refusing to destroy ${registeredJobSlug} through the ${jobSlug} fence.`);
        }
        if (fence?.jobSlug && fence.jobSlug !== jobSlug) {
          throw new Error(`Refusing to destroy ${fence.jobSlug} through the ${jobSlug} fence.`);
        }
        alreadyAbsent = fence?.state === "absent";
        if (!alreadyAbsent) {
          await transaction.put(NATIVE_RUNTIME_FENCE_KEY, {
            state: "fenced",
            jobSlug,
          } satisfies NativeRuntimeFence);
        }
      });
      if (alreadyAbsent) return;
      await this.ctx.container?.destroy();
      await this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get<string>(NATIVE_WRITER_IDENTITY_KEY) === jobSlug) {
          await transaction.delete(NATIVE_WRITER_IDENTITY_KEY);
        }
        await transaction.put(NATIVE_RUNTIME_FENCE_KEY, {
          state: "absent",
          jobSlug,
        } satisfies NativeRuntimeFence);
      });
    });
  }

  private enqueueRuntimeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.runtimeOperationTail.then(operation, operation);
    this.runtimeOperationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
