import { renderArtifactBodyMarkdown } from "../api/coordination/planning";
import type { Artifact, PlanArtifact, PlanStatus } from "../api/coordination/types";

export { renderArtifactBodyMarkdown } from "../api/coordination/planning";

const PLAN_STATUSES: PlanStatus[] = ["draft", "evaluating", "todo", "completed", "archived"];

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
    .sort((left, right) => (
      (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
    ));
}

export function groupPlansByStatus(artifacts: Artifact[]): Record<PlanStatus, PlanArtifact[]> {
  const grouped: Record<PlanStatus, PlanArtifact[]> = {
    draft: [],
    evaluating: [],
    todo: [],
    completed: [],
    archived: [],
  };
  for (const plan of listPlanArtifacts(artifacts)) {
    grouped[plan.status ?? "draft"].push(plan);
  }
  for (const status of PLAN_STATUSES) {
    grouped[status].sort((left, right) => (
      (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
    ));
  }
  return grouped;
}

export function getPlanDisplayVersion(plan: PlanArtifact): number {
  if (!renderArtifactBodyMarkdown(plan.body).trim()) return 0;
  return Math.max(1, (plan.version ?? 1) - 1);
}
