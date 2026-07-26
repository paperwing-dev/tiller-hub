import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// Lightweight container for short-lived GitHub-backed jobs, such as env draft
// PR publishing. It deliberately has no long-lived runner lifecycle.
export class GitHubJobDO extends Container<Env> {
  async startJob(envVars: Record<string, string>): Promise<void> {
    await this.start({ envVars, enableInternet: true });
  }

  async destroyJob(): Promise<void> {
    await this.ctx.container?.destroy();
  }
}
