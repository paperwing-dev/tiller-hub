import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// Dedicated bootstrap container for initializing canonical repo git artifacts.
// This class is intentionally minimal and only supports short-lived repo bootstrap jobs.
export class ScmBootstrapDO extends Container<Env> {
  async startBootstrapJob(
    repoId: string,
    envVars: Record<string, string>,
  ): Promise<void> {
    await this.ctx.storage.put("repoId", repoId);
    await this.start({ envVars, enableInternet: true });
  }

  async destroyBootstrapJob(): Promise<void> {
    await this.ctx.container?.destroy();
  }
}
