import type { Artifact, ArtifactRef, PlanArtifact, ReviewArtifact } from "../api/coordination/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toPlanArtifact(artifact: Artifact): PlanArtifact | null {
  if (artifact.type !== "plan" || !isRecord(artifact.body)) return null;
  return {
    ...artifact,
    type: "plan",
    body: {
      summary: typeof artifact.body.summary === "string" ? artifact.body.summary : "",
      findings: getStringArray(artifact.body.findings),
      relevantFiles: getStringArray(artifact.body.relevantFiles),
      openQuestions: getStringArray(artifact.body.openQuestions),
      proposedPlan: typeof artifact.body.proposedPlan === "string" ? artifact.body.proposedPlan : "",
      memoryRefs: getStringArray(artifact.body.memoryRefs),
      ...(typeof artifact.body.model === "string" ? { model: artifact.body.model } : {}),
    },
  };
}

function toReviewArtifact(artifact: Artifact): ReviewArtifact | null {
  if (artifact.type !== "review" || !isRecord(artifact.body)) return null;
  const planArtifact = toPlanArtifact({
    ...artifact,
    type: "plan",
  });
  if (!planArtifact) return null;
  return {
    ...artifact,
    type: "review",
    body: {
      ...planArtifact.body,
      ...(Array.isArray(artifact.body.reviewIssues) ? { reviewIssues: artifact.body.reviewIssues as ReviewArtifact["body"]["reviewIssues"] } : {}),
      ...(isRecord(artifact.body.reviewIssueStats) ? { reviewIssueStats: artifact.body.reviewIssueStats as ReviewArtifact["body"]["reviewIssueStats"] } : {}),
      ...(isRecord(artifact.body.reviewMeta) ? { reviewMeta: artifact.body.reviewMeta as ReviewArtifact["body"]["reviewMeta"] } : {}),
    },
  };
}

export function getApprovedPlanRef(refs: ArtifactRef[]): ArtifactRef | null {
  return refs.find((ref) => ref.name === "approved-plan") ?? null;
}

export function isPlanOutdatedForMain(
  artifact: Pick<Artifact, "basis">,
  mainCommit: string | null,
): boolean {
  return !artifact.basis.mainCommit || (!!mainCommit && artifact.basis.mainCommit !== mainCommit);
}

export function listPlanArtifacts(artifacts: Artifact[]): PlanArtifact[] {
  return artifacts
    .map((artifact) => toPlanArtifact(artifact))
    .filter((artifact): artifact is PlanArtifact => !!artifact)
    .filter((artifact) => !!artifact.basis.mainCommit)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function buildSupersededIdSet(planArtifacts: PlanArtifact[]): Set<string> {
  return new Set(
    planArtifacts
      .map((artifact) => artifact.supersedesArtifactId)
      .filter((id): id is string => !!id),
  );
}

export function listCurrentPlanDraftArtifacts(
  artifacts: Artifact[],
  refs: ArtifactRef[],
): PlanArtifact[] {
  const planArtifacts = listPlanArtifacts(artifacts);
  const supersededIds = buildSupersededIdSet(planArtifacts);
  const approvedPlanId = getApprovedPlanRef(refs)?.artifactId ?? null;

  return planArtifacts.filter((artifact) => !supersededIds.has(artifact.id) && artifact.id !== approvedPlanId);
}

export function listReviewArtifactsForDraft(
  artifacts: Artifact[],
  draftId: string | null,
): ReviewArtifact[] {
  if (!draftId) return [];
  return artifacts
    .map((artifact) => toReviewArtifact(artifact))
    .filter((artifact): artifact is ReviewArtifact => !!artifact && artifact.parentArtifactId === draftId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function getLineageRootId(artifactById: Map<string, PlanArtifact>, artifact: PlanArtifact): string {
  let current: PlanArtifact | undefined = artifact;
  const seen = new Set<string>();

  while (current?.supersedesArtifactId && !seen.has(current.supersedesArtifactId)) {
    seen.add(current.id);
    const previous = artifactById.get(current.supersedesArtifactId);
    if (!previous) break;
    current = previous;
  }

  return current?.id ?? artifact.id;
}

export function getDraftVersion(artifacts: Artifact[], artifact: PlanArtifact): number {
  const planArtifacts = listPlanArtifacts(artifacts);
  const artifactById = new Map(planArtifacts.map((candidate) => [candidate.id, candidate]));
  const rootId = getLineageRootId(artifactById, artifact);
  const lineage = planArtifacts
    .filter((candidate) => getLineageRootId(artifactById, candidate) === rootId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const index = lineage.findIndex((candidate) => candidate.id === artifact.id);
  return index >= 0 ? index + 1 : 1;
}
