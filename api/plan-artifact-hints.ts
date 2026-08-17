import { getDurableObjectStub } from "./durable-object";
import type { HubDO } from "./hub";
import type { Env } from "./types";

export async function broadcastPlanArtifactUpdatedHint(
  env: Env,
  repoId: string,
  planArtifactId: string,
): Promise<void> {
  try {
    const hub = getDurableObjectStub<Pick<HubDO, "broadcastPlanArtifactUpdated">>(env, env.HUB, "hub");
    await hub.broadcastPlanArtifactUpdated(repoId, planArtifactId);
  } catch {
    // WebSocket notifications are lossy convergence hints; ArtifactStore remains authoritative.
  }
}
