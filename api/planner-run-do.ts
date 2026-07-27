import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

const NATIVE_WRITER_IDENTITY_KEY = "native-plan-writer-identity";

// Dedicated container class for one-shot hosted planner runs. Bound to the
// sandbox image in wrangler.jsonc — the planner needs the coding CLIs and the
// tiller-planner bin baked there; lightweight GitHub job images do not.
export class PlannerRunDO extends Container<Env> {
  // Native lifecycle RPCs may arrive while container start/destroy is awaiting
  // I/O. Keep the complete operation ordered inside this deterministic DO so
  // a fenced Stop cannot be overtaken by an earlier late Start.
  private planWriterRuntimeTail: Promise<void> = Promise.resolve();
  sleepAfter = "8h";

  async startPlannerJob(envVars: Record<string, string>): Promise<void> {
    await this.start({ envVars, enableInternet: true });
  }

  async destroyPlannerJob(): Promise<void> {
    await this.ctx.container?.destroy();
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
    return this.enqueuePlanWriterOperation(async () => {
      let created = false;
      await this.ctx.storage.transaction(async (transaction) => {
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
    return this.enqueuePlanWriterOperation(async () => {
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
    await this.enqueuePlanWriterOperation(async () => {
      const registeredJobSlug = await this.ctx.storage.get<string>(NATIVE_WRITER_IDENTITY_KEY) ?? null;
      if (!registeredJobSlug) return;
      if (registeredJobSlug !== jobSlug) {
        throw new Error(`Refusing to destroy ${registeredJobSlug} through the ${jobSlug} fence.`);
      }
      await this.ctx.container?.destroy();
      await this.ctx.storage.transaction(async (transaction) => {
        if (await transaction.get<string>(NATIVE_WRITER_IDENTITY_KEY) === jobSlug) {
          await transaction.delete(NATIVE_WRITER_IDENTITY_KEY);
        }
      });
    });
  }

  private enqueuePlanWriterOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.planWriterRuntimeTail.then(operation, operation);
    this.planWriterRuntimeTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
