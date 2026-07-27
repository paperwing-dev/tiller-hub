import type {
  Artifact,
  ArtifactRef,
  PlanArtifact,
  PlanArtifactBody,
  ReviewArtifact,
  ReviewArtifactBody,
} from "./types";

export const MAX_PLAN_MARKDOWN_BYTES = 1024 * 1024;

const ATX_HEADING_PATTERN = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/u;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;

function normalizeHeadingText(value: string): string {
  return value.replace(/[ \t]+#+[ \t]*$/u, "").trim();
}

export function derivePlanTitleFromMarkdown(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;
  let readingTitleSection = false;

  for (const line of markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = { marker: marker[0]!, length: marker.length };
      } else if (
        marker[0] === fence.marker
        && marker.length >= fence.length
        && !fenceMatch[2]!.trim()
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const heading = ATX_HEADING_PATTERN.exec(line);
    if (heading) {
      const headingText = normalizeHeadingText(heading[2]!);
      if (heading[1]!.length === 1) return headingText;
      readingTitleSection = /^title:?$/iu.test(headingText);
      continue;
    }

    if (readingTitleSection && line.trim()) return line.trim();
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function renderArtifactBodyMarkdown(body: unknown): string {
  if (isRecord(body) && typeof body.markdown === "string") {
    return body.markdown;
  }
  return "";
}

function toPlanArtifactBody(body: unknown): PlanArtifactBody {
  return {
    markdown: renderArtifactBodyMarkdown(body),
  };
}

function toReviewArtifactBody(body: unknown): ReviewArtifactBody {
  const record = isRecord(body) ? body : {};
  return {
    summary: typeof record.summary === "string" ? record.summary : "",
    findings: getStringArray(record.findings),
    relevantFiles: getStringArray(record.relevantFiles),
    openQuestions: getStringArray(record.openQuestions),
    proposedPlan: typeof record.proposedPlan === "string" ? record.proposedPlan : "",
    memoryRefs: getStringArray(record.memoryRefs),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(Array.isArray(record.reviewIssues) ? { reviewIssues: record.reviewIssues as ReviewArtifactBody["reviewIssues"] } : {}),
    ...(isRecord(record.reviewIssueStats) ? { reviewIssueStats: record.reviewIssueStats as unknown as ReviewArtifactBody["reviewIssueStats"] } : {}),
    ...(isRecord(record.reviewMeta) ? { reviewMeta: record.reviewMeta as unknown as ReviewArtifactBody["reviewMeta"] } : {}),
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

export function listCurrentPlanDraftArtifacts(
  artifacts: Artifact[],
  _refs: ArtifactRef[],
): PlanArtifact[] {
  return listPlanArtifacts(artifacts)
    .filter((artifact) => artifact.status === "draft")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function getPlanVersion(
  _artifacts: Artifact[],
  artifact: PlanArtifact,
): number {
  return artifact.version ?? 1;
}

export function renderArtifactPlanMarkdown(artifact: PlanArtifact): string {
  return renderArtifactBodyMarkdown(artifact.body);
}

export function renderRecentArtifactPrompt(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return "";

  const rendered = artifacts.map((artifact) => {
    const kind = artifact.type === "review" ? "review" : artifact.type;
    return [
      `<artifact id="${artifact.id}" kind="${kind}" createdAt="${artifact.createdAt}">`,
      `Title: ${artifact.title}`,
      `Status: ${artifact.status ?? "draft"}`,
      `Markdown:\n${renderArtifactBodyMarkdown(artifact.body)}`,
      `</artifact>`,
    ].filter(Boolean).join("\n");
  });

  return `<recent-artifacts>\n${rendered.join("\n\n")}\n</recent-artifacts>`;
}
