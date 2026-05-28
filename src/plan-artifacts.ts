import { renderArtifactBodyMarkdown } from "../api/coordination/planning";
import type { Artifact, ArtifactRef, PlanArtifact, PlanStatus, ReviewArtifact } from "../api/coordination/types";

export { renderArtifactBodyMarkdown } from "../api/coordination/planning";

const PLAN_STATUSES: PlanStatus[] = ["draft", "todo", "completed", "archived"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizePlanArtifact(artifact: Artifact): PlanArtifact | null {
  if (artifact.type !== "plan") return null;
  return {
    ...artifact,
    type: "plan",
    body: {
      markdown: renderArtifactBodyMarkdown(artifact.body),
    },
    status: artifact.status ?? "draft",
    updatedAt: artifact.updatedAt ?? artifact.createdAt,
    version: artifact.version ?? 1,
  };
}

function normalizeReviewArtifact(artifact: Artifact): ReviewArtifact | null {
  if (artifact.type !== "review" || !isRecord(artifact.body)) return null;
  return {
    ...artifact,
    type: "review",
    body: {
      summary: typeof artifact.body.summary === "string" ? artifact.body.summary : "",
      findings: getStringArray(artifact.body.findings),
      relevantFiles: getStringArray(artifact.body.relevantFiles),
      openQuestions: getStringArray(artifact.body.openQuestions),
      proposedPlan: typeof artifact.body.proposedPlan === "string" ? artifact.body.proposedPlan : "",
      memoryRefs: getStringArray(artifact.body.memoryRefs),
      ...(typeof artifact.body.model === "string" ? { model: artifact.body.model } : {}),
      ...(Array.isArray(artifact.body.reviewIssues) ? { reviewIssues: artifact.body.reviewIssues as ReviewArtifact["body"]["reviewIssues"] } : {}),
      ...(isRecord(artifact.body.reviewIssueStats) ? { reviewIssueStats: artifact.body.reviewIssueStats as ReviewArtifact["body"]["reviewIssueStats"] } : {}),
      ...(isRecord(artifact.body.reviewMeta) ? { reviewMeta: artifact.body.reviewMeta as ReviewArtifact["body"]["reviewMeta"] } : {}),
    },
  };
}

export function isPlanOutdatedForMain(
  artifact: Pick<Artifact, "basis">,
  mainCommit: string | null,
): boolean {
  return !artifact.basis.mainCommit || (!!mainCommit && artifact.basis.mainCommit !== mainCommit);
}

export function listPlanArtifacts(artifacts: Artifact[]): PlanArtifact[] {
  return artifacts
    .map((artifact) => normalizePlanArtifact(artifact))
    .filter((artifact): artifact is PlanArtifact => !!artifact)
    .filter((artifact) => !!artifact.basis.mainCommit)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function groupPlansByStatus(artifacts: Artifact[]): Record<PlanStatus, PlanArtifact[]> {
  const grouped = Object.fromEntries(PLAN_STATUSES.map((status) => [status, []])) as Record<PlanStatus, PlanArtifact[]>;
  for (const plan of listPlanArtifacts(artifacts)) {
    grouped[plan.status ?? "draft"].push(plan);
  }
  for (const status of PLAN_STATUSES) {
    grouped[status].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return grouped;
}

export function listCurrentPlanDraftArtifacts(
  artifacts: Artifact[],
  _refs: ArtifactRef[],
): PlanArtifact[] {
  return groupPlansByStatus(artifacts).draft;
}

export function listReviewArtifactsForDraft(
  artifacts: Artifact[],
  draftId: string | null,
): ReviewArtifact[] {
  if (!draftId) return [];
  return artifacts
    .map((artifact) => normalizeReviewArtifact(artifact))
    .filter((artifact): artifact is ReviewArtifact => !!artifact && artifact.parentArtifactId === draftId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function getDraftVersion(_artifacts: Artifact[], artifact: PlanArtifact): number {
  return artifact.version ?? 1;
}
