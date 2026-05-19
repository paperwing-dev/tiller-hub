import type { Artifact, ArtifactRef, PlanArtifact, PlanArtifactBody, ReviewArtifact, ReviewArtifactBody } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toPlanArtifactBody(body: unknown): PlanArtifactBody {
  const record = isRecord(body) ? body : {};
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    findings: getStringArray(record.findings),
    relevantFiles: getStringArray(record.relevantFiles),
    openQuestions: getStringArray(record.openQuestions),
    proposedPlan: typeof record.proposedPlan === "string" ? record.proposedPlan : "",
    memoryRefs: getStringArray(record.memoryRefs),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
  };
}

function toReviewArtifactBody(body: unknown): ReviewArtifactBody {
  const planBody = toPlanArtifactBody(body);
  const record = isRecord(body) ? body : {};
  return {
    ...planBody,
    ...(Array.isArray(record.reviewIssues) ? { reviewIssues: record.reviewIssues as ReviewArtifactBody["reviewIssues"] } : {}),
    ...(isRecord(record.reviewIssueStats) ? { reviewIssueStats: record.reviewIssueStats as ReviewArtifactBody["reviewIssueStats"] } : {}),
    ...(isRecord(record.reviewMeta) ? { reviewMeta: record.reviewMeta as ReviewArtifactBody["reviewMeta"] } : {}),
  };
}

export function asPlanArtifact(artifact: Artifact | null | undefined): PlanArtifact | null {
  if (!artifact || artifact.type !== "plan") return null;
  return {
    ...artifact,
    type: "plan",
    body: toPlanArtifactBody(artifact.body),
  };
}

export function asReviewArtifact(artifact: Artifact | null | undefined): ReviewArtifact | null {
  if (!artifact || artifact.type !== "review") return null;
  return {
    ...artifact,
    type: "review",
    body: toReviewArtifactBody(artifact.body),
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
    .map((artifact) => asPlanArtifact(artifact))
    .filter((artifact): artifact is PlanArtifact => !!artifact)
    .filter((artifact) => !!artifact.basis.mainCommit);
}

export function listReviewArtifactsForDraft(
  artifacts: Artifact[],
  draftId: string | null,
): ReviewArtifact[] {
  if (!draftId) return [];
  return artifacts
    .map((artifact) => asReviewArtifact(artifact))
    .filter((artifact): artifact is ReviewArtifact => !!artifact && artifact.parentArtifactId === draftId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function buildSupersededPlanIdSet(planArtifacts: PlanArtifact[]): Set<string> {
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
  const supersededIds = buildSupersededPlanIdSet(planArtifacts);
  const approvedPlanId = getApprovedPlanRef(refs)?.artifactId ?? null;

  return planArtifacts
    .filter((artifact) => !supersededIds.has(artifact.id))
    .filter((artifact) => artifact.id !== approvedPlanId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function getPlanLineageRootId(
  artifactById: Map<string, PlanArtifact>,
  artifact: PlanArtifact,
): string {
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

export function getPlanVersion(
  artifacts: Artifact[],
  artifact: PlanArtifact,
): number {
  const planArtifacts = listPlanArtifacts(artifacts);
  const artifactById = new Map(planArtifacts.map((candidate) => [candidate.id, candidate]));
  const rootId = getPlanLineageRootId(artifactById, artifact);
  const lineage = planArtifacts
    .filter((candidate) => getPlanLineageRootId(artifactById, candidate) === rootId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const index = lineage.findIndex((candidate) => candidate.id === artifact.id);
  return index >= 0 ? index + 1 : 1;
}

export function renderArtifactPlanMarkdown(artifact: PlanArtifact): string {
  return [
    `# ${artifact.title}`,
    "",
    `Artifact type: ${artifact.type}`,
    `Created by: ${artifact.createdBy ?? "unknown"}`,
    `Created at: ${artifact.createdAt}`,
    `Repo ID: ${artifact.repoId}`,
    ...(artifact.basis.mainCommit ? [`Main commit: ${artifact.basis.mainCommit}`] : []),
    ...(artifact.basis.envSlug ? [`Env provenance: ${artifact.basis.envSlug}`] : []),
    "",
    "## Summary",
    artifact.body.summary,
    "",
    "## Findings",
    ...(artifact.body.findings.length > 0 ? artifact.body.findings.map((finding) => `- ${finding}`) : ["- None recorded"]),
    "",
    "## Relevant Files",
    ...(artifact.body.relevantFiles.length > 0 ? artifact.body.relevantFiles.map((file) => `- ${file}`) : ["- None recorded"]),
    "",
    "## Open Questions",
    ...(artifact.body.openQuestions.length > 0
      ? artifact.body.openQuestions.map((question) => `- ${question}`)
      : ["- None recorded"]),
    "",
    "## Proposed Plan",
    artifact.body.proposedPlan,
    "",
    "## Memory References",
    ...(artifact.body.memoryRefs.length > 0 ? artifact.body.memoryRefs.map((ref) => `- ${ref}`) : ["- None recorded"]),
    "",
  ].join("\n");
}

export function renderRecentArtifactPrompt(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return "";

  const rendered = artifacts.map((artifact) => {
    const body = asPlanArtifact(artifact)?.body ?? asReviewArtifact(artifact)?.body ?? toPlanArtifactBody(artifact.body);
    const kind = artifact.type === "review" ? "review" : artifact.type;
    return [
      `<artifact id="${artifact.id}" kind="${kind}" createdAt="${artifact.createdAt}">`,
      `Title: ${artifact.title}`,
      `Summary: ${body.summary}`,
      body.findings.length > 0 ? `Findings:\n- ${body.findings.join("\n- ")}` : "",
      body.relevantFiles.length > 0 ? `Relevant files:\n- ${body.relevantFiles.join("\n- ")}` : "",
      body.openQuestions.length > 0 ? `Open questions:\n- ${body.openQuestions.join("\n- ")}` : "",
      body.proposedPlan ? `Plan:\n${body.proposedPlan}` : "",
      `</artifact>`,
    ].filter(Boolean).join("\n");
  });

  return `<recent-artifacts>\n${rendered.join("\n\n")}\n</recent-artifacts>`;
}
