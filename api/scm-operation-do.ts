import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// Dedicated lightweight container for short-lived SCM operations like
// promote/merge jobs. Unlike interactive sandboxes, this does not wait for
// stop-control or runner readiness ports.
export class ScmOperationDO extends Container<Env> {
  async startOperationJob(envVars: Record<string, string>): Promise<void> {
    await this.start({ envVars, enableInternet: true });
  }

  async destroyOperationJob(): Promise<void> {
    await this.ctx.container?.destroy();
  }
}
