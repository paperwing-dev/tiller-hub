import type { RepoMeta } from "../types";
import type { ArtifactStoreDO } from "./artifact-store-do";
import { asPlanArtifact, asReviewArtifact } from "./planning";
import type {
  Artifact,
  ArtifactRef,
  CreateArtifactInput,
  PlanArtifact,
  PlanArtifactBody,
  ReviewArtifact,
  ReviewArtifactBody,
} from "./types";

export async function loadRepoArtifacts(
  repo: Pick<RepoMeta, "repoId">,
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

export function createPlanArtifactInput(options: {
  repo: Pick<RepoMeta, "repoId" | "mainCommit">;
  title: string;
  body: PlanArtifactBody;
  createdBy?: string;
  createdAt?: string;
  parentArtifactId?: string;
  supersedesArtifactId?: string;
}): CreateArtifactInput<PlanArtifactBody> {
  return {
    repoId: options.repo.repoId,
    type: "plan",
    basis: {
      repoId: options.repo.repoId,
      mainCommit: options.repo.mainCommit,
    },
    title: options.title,
    body: options.body,
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    ...(options.parentArtifactId ? { parentArtifactId: options.parentArtifactId } : {}),
    ...(options.supersedesArtifactId ? { supersedesArtifactId: options.supersedesArtifactId } : {}),
  };
}

export function createReviewArtifactInput(options: {
  repo: Pick<RepoMeta, "repoId" | "mainCommit">;
  title: string;
  body: ReviewArtifactBody;
  createdBy?: string;
  createdAt?: string;
  parentArtifactId: string;
}): CreateArtifactInput<ReviewArtifactBody> {
  return {
    repoId: options.repo.repoId,
    type: "review",
    basis: {
      repoId: options.repo.repoId,
      mainCommit: options.repo.mainCommit,
    },
    title: options.title,
    body: options.body,
    parentArtifactId: options.parentArtifactId,
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  };
}

export function getPlanArtifactById(artifacts: Artifact[], id: string): PlanArtifact | null {
  return asPlanArtifact(artifacts.find((artifact) => artifact.id === id) ?? null);
}

export function getReviewArtifactById(artifacts: Artifact[], id: string): ReviewArtifact | null {
  return asReviewArtifact(artifacts.find((artifact) => artifact.id === id) ?? null);
}
