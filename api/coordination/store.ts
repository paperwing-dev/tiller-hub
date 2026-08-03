import type { ArtifactStoreDO } from "./artifact-store-do";
import { asPlanArtifact } from "./planning";
import type {
  Artifact,
  ArtifactRef,
  PlanArtifact,
} from "./types";

export async function loadRepoArtifacts(
  artifactStore: Pick<ArtifactStoreDO, "listArtifacts" | "listRefs">,
): Promise<{ artifacts: Artifact[]; refs: ArtifactRef[] }> {
  const [artifacts, refs] = await Promise.all([
    artifactStore.listArtifacts({ limit: 500 }),
    artifactStore.listRefs(),
  ]);
  return {
    artifacts,
    refs,
  };
}

export function getPlanArtifactById(artifacts: Artifact[], id: string): PlanArtifact | null {
  return asPlanArtifact(artifacts.find((artifact) => artifact.id === id) ?? null);
}
