import { z } from "zod";
import type {
  PlanReviewIssue,
  PlanReviewIssueStats,
} from "../agent-core";
import type { PlanArtifact, ReviewArtifact } from "../coordination";

export const PLAN_DEFAULT_MODEL = "gpt-5.4";

export const PLAN_MODEL_OPTIONS = [
  { id: "gpt-5.4", label: "ChatGPT 5.4" },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 120B" },
  { id: "@cf/moonshotai/kimi-k2.5", label: "Kimi K2.5" },
] as const;

export const PLAN_REVIEW_MODELS = [
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/moonshotai/kimi-k2.5",
] as const;

export type PlanModelId = (typeof PLAN_MODEL_OPTIONS)[number]["id"];

export interface FilteredPlanReviewIssue extends PlanReviewIssue {
  sourceReviewId: string;
  sourceModel?: string;
}

export interface DroppedPlanReviewIssue {
  issue: PlanReviewIssue;
  sourceReviewId: string;
  sourceModel?: string;
  reason: string;
}

export interface ParsedPlanReview {
  summary: string;
  issues: PlanReviewIssue[];
}

export interface FilteredPlanReview {
  kept: FilteredPlanReviewIssue[];
  dropped: DroppedPlanReviewIssue[];
  stats: PlanReviewIssueStats;
}

export interface PlanIntegrationAcceptedItem {
  sourceReviewId: string;
  issue: string;
  change: string;
}

export interface PlanIntegrationRejectedItem {
  sourceReviewId: string;
  issue: string;
  reason: string;
}

export interface ParsedPlanIntegration {
  accepted: PlanIntegrationAcceptedItem[];
  rejected: PlanIntegrationRejectedItem[];
  updatedSummary: string;
  revisedPlan: string;
}

const reviewIssueSchema = z.object({
  issue: z.string().trim().min(1),
  evidenceQuote: z.string().trim().min(1),
  recommendedChange: z.string().trim().min(1),
});

const reviewResponseSchema = z.object({
  summary: z.string().trim().default(""),
  issues: z.array(reviewIssueSchema).max(8).default([]),
});

const integrationAcceptedSchema = z.object({
  sourceReviewId: z.string().trim().min(1),
  issue: z.string().trim().min(1),
  change: z.string().trim().min(1),
});

const integrationRejectedSchema = z.object({
  sourceReviewId: z.string().trim().min(1),
  issue: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});

const integrationResponseSchema = z.object({
  accepted: z.array(integrationAcceptedSchema).default([]),
  rejected: z.array(integrationRejectedSchema).default([]),
  updatedSummary: z.string().trim().min(1),
  revisedPlan: z.string().trim().min(1),
});

export function isPlanModelId(value: unknown): value is PlanModelId {
  return PLAN_MODEL_OPTIONS.some((option) => option.id === value);
}

export function resolvePlanModel(value: unknown): PlanModelId {
  return isPlanModelId(value) ? value : PLAN_DEFAULT_MODEL;
}

export function resolveStartupPlanId(options: {
  requestedPlanId?: string | null;
  startupPlanId?: string | null;
  approvedPlans?: Array<Pick<PlanArtifact, "id">>;
}): string | null {
  if (options.requestedPlanId !== undefined) {
    return options.requestedPlanId;
  }

  if (options.startupPlanId) {
    return options.startupPlanId;
  }

  return options.approvedPlans?.[0]?.id ?? null;
}

export function isWorkersAIPlanModel(model: string): boolean {
  return model.startsWith("@cf/");
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractJsonObject(text: string): string | null {
  const unfenced = stripMarkdownFence(text);
  if (!unfenced) return null;

  try {
    JSON.parse(unfenced);
    return unfenced;
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return unfenced.slice(start, end + 1);
  }
}

function parseJsonPayload<T>(text: string, schema: z.ZodType<T>): T | null {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;

  try {
    return schema.parse(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeEvidenceQuote(value: string): string {
  return value.trim().replace(/^["'`]+|["'`]+$/g, "");
}

export function buildPlanReviewPrompt(draft: Pick<PlanArtifact, "title" | "body">): string {
  return [
    "Review the implementation plan below.",
    "Use the available read-only repository tools before answering so your critique is code-aware.",
    "Return JSON only. Do not include markdown fences or explanatory prose.",
    "Use this shape:",
    '{ "summary": "short summary", "issues": [ { "issue": "specific problem", "evidenceQuote": "exact quote copied from the draft", "recommendedChange": "specific change to make" } ] }',
    "Rules:",
    "- Inspect the relevant files with tools before producing the final answer.",
    "- Only report issues that are grounded in the current draft text.",
    "- evidenceQuote must be an exact quote copied from the draft plan.",
    "- Keep issues specific and actionable.",
    "- If there are no grounded issues, return an empty issues array.",
    "- Maximum 6 issues.",
    "",
    `Goal: ${draft.title}`,
    `Summary: ${draft.body.summary}`,
    "",
    "Plan:",
    draft.body.proposedPlan,
    "",
    draft.body.relevantFiles.length > 0 ? `Relevant files: ${draft.body.relevantFiles.join(", ")}` : "Relevant files: none",
  ].join("\n");
}

export function buildPlanReviewRepairPrompt(rawReview: string): string {
  return [
    "Convert the review text below into valid JSON.",
    "Return JSON only. Do not include markdown fences.",
    "Use this shape:",
    '{ "summary": "short summary", "issues": [ { "issue": "specific problem", "evidenceQuote": "exact quote copied from the draft", "recommendedChange": "specific change to make" } ] }',
    "If the review text does not contain a grounded issue, return an empty issues array.",
    "",
    "Review text:",
    rawReview,
  ].join("\n");
}

export function parsePlanReviewResponse(text: string): ParsedPlanReview {
  const parsed = parseJsonPayload(text, reviewResponseSchema);
  if (!parsed) {
    return {
      summary: "",
      issues: [],
    };
  }

  return {
    summary: parsed.summary,
    issues: parsed.issues.map((issue) => ({
      issue: issue.issue,
      evidenceQuote: normalizeEvidenceQuote(issue.evidenceQuote),
      recommendedChange: issue.recommendedChange,
    })),
  };
}

export function filterPlanReviewIssues(options: {
  draft: Pick<PlanArtifact, "body">;
  sourceReviewId: string;
  sourceModel?: string;
  issues: PlanReviewIssue[];
}): FilteredPlanReview {
  const kept: FilteredPlanReviewIssue[] = [];
  const dropped: DroppedPlanReviewIssue[] = [];
  const seen = new Set<string>();
  const draftText = `${options.draft.body.summary}\n${options.draft.body.proposedPlan}`;

  for (const issue of options.issues) {
    const evidenceQuote = normalizeEvidenceQuote(issue.evidenceQuote);
    const normalizedEvidence = normalizeText(evidenceQuote);
    const normalizedIssue = normalizeText(issue.issue);
    const normalizedChange = normalizeText(issue.recommendedChange);
    const dedupeKey = `${normalizedIssue}::${normalizedEvidence}`;

    let reason: string | null = null;

    if (!issue.recommendedChange.trim()) {
      reason = "missing recommended change";
    } else if (!evidenceQuote) {
      reason = "missing evidence quote";
    } else if (!draftText.includes(evidenceQuote)) {
      reason = "evidence quote does not appear in the current draft";
    } else if (normalizedEvidence === normalizedIssue || normalizedEvidence === normalizedChange) {
      reason = "evidence quote only restates the issue";
    } else if (seen.has(dedupeKey)) {
      reason = "duplicate review item";
    }

    if (reason) {
      dropped.push({
        issue: {
          ...issue,
          evidenceQuote,
        },
        sourceReviewId: options.sourceReviewId,
        sourceModel: options.sourceModel,
        reason,
      });
      continue;
    }

    seen.add(dedupeKey);
    kept.push({
      ...issue,
      evidenceQuote,
      sourceReviewId: options.sourceReviewId,
      sourceModel: options.sourceModel,
    });
  }

  return {
    kept,
    dropped,
    stats: {
      total: options.issues.length,
      kept: kept.length,
      dropped: dropped.length,
    },
  };
}

export function summarizeFilteredReview(options: {
  parsedSummary: string;
  filtered: FilteredPlanReview;
}): string {
  const { kept, dropped } = options.filtered.stats;
  if (kept === 0) {
    if (dropped > 0) {
      return `No grounded issues kept; dropped ${dropped} unsupported suggestion${dropped === 1 ? "" : "s"}.`;
    }
    return options.parsedSummary || "No grounded issues found in this review.";
  }

  const firstIssue = options.filtered.kept[0]?.issue;
  const summaryPrefix = `${kept} grounded issue${kept === 1 ? "" : "s"} kept`;
  const droppedSuffix =
    dropped > 0 ? `, ${dropped} dropped as unsupported` : "";
  return `${summaryPrefix}${droppedSuffix}. ${firstIssue}`;
}

export function buildPlanIntegrationPrompt(options: {
  draft: Pick<PlanArtifact, "title" | "body">;
  filteredIssues: FilteredPlanReviewIssue[];
  selectedModel: string;
}): string {
  const issueBlocks =
    options.filteredIssues.length > 0
      ? options.filteredIssues
          .map(
            (issue, index) =>
              [
                `Issue ${index + 1}`,
                `sourceReviewId: ${issue.sourceReviewId}`,
                `sourceModel: ${issue.sourceModel ?? "unknown"}`,
                `issue: ${issue.issue}`,
                `evidenceQuote: ${issue.evidenceQuote}`,
                `recommendedChange: ${issue.recommendedChange}`,
              ].join("\n"),
          )
          .join("\n\n")
      : "No grounded review issues were kept after filtering.";

  return [
    "Revise the implementation plan using the filtered review issues below.",
    "Treat review feedback as advisory only. Some review feedback was filtered out before this step because it was unsupported or low-signal.",
    "Preserve the draft unless a filtered issue materially improves it.",
    "Reject filtered issues that are already covered, lower quality than the draft, or out of scope.",
    "Return JSON only. Do not include markdown fences.",
    "Use this shape:",
    '{ "accepted": [ { "sourceReviewId": "review id", "issue": "issue text", "change": "what changed in the revised draft" } ], "rejected": [ { "sourceReviewId": "review id", "issue": "issue text", "reason": "why it was rejected" } ], "updatedSummary": "short revised summary", "revisedPlan": "full standalone revised plan" }',
    "Rules:",
    "- Every filtered issue listed below must appear exactly once in accepted or rejected.",
    "- Do not invent issues that are not listed below.",
    "- revisedPlan must be complete and standalone.",
    "- If you reject every filtered issue, keep the plan materially unchanged.",
    "",
    `Selected planner model: ${options.selectedModel}`,
    `Goal: ${options.draft.title}`,
    `Current draft summary: ${options.draft.body.summary}`,
    "",
    "Current draft plan:",
    options.draft.body.proposedPlan,
    "",
    "Filtered review issues:",
    issueBlocks,
  ].join("\n");
}

export function buildPlanIntegrationRepairPrompt(rawIntegration: string): string {
  return [
    "Convert the integration result below into valid JSON.",
    "Return JSON only. Do not include markdown fences.",
    "Use this shape:",
    '{ "accepted": [ { "sourceReviewId": "review id", "issue": "issue text", "change": "what changed in the revised draft" } ], "rejected": [ { "sourceReviewId": "review id", "issue": "issue text", "reason": "why it was rejected" } ], "updatedSummary": "short revised summary", "revisedPlan": "full standalone revised plan" }',
    "",
    "Integration result:",
    rawIntegration,
  ].join("\n");
}

export function parsePlanIntegrationResponse(text: string): ParsedPlanIntegration | null {
  return parseJsonPayload(text, integrationResponseSchema);
}

export function buildPlanIntegrationReply(options: {
  reviews: Array<Pick<ReviewArtifact, "id" | "body">>;
  accepted: PlanIntegrationAcceptedItem[];
  rejected: PlanIntegrationRejectedItem[];
  updatedSummary: string;
  savedDraftId?: string;
  groundedIssueCount: number;
  droppedIssueCount: number;
}): string {
  const reviewedByLines =
    options.reviews.length > 0
      ? options.reviews.map((review) => `- \`${review.id}\` — \`${review.body.model ?? "unknown model"}\``)
      : ["- None."];

  const acceptedLines =
    options.accepted.length > 0
      ? options.accepted.map(
          (item) =>
            `- \`${item.sourceReviewId}\` — ${item.issue}: ${item.change}`,
        )
      : ["- None."];

  const rejectedLines =
    options.rejected.length > 0
      ? options.rejected.map(
          (item) =>
            `- \`${item.sourceReviewId}\` — ${item.issue}: ${item.reason}`,
        )
      : ["- None."];

  const updatedDraftLines = [
    `- ${options.updatedSummary}`,
    `- Grounded review issues considered: ${options.groundedIssueCount}. Dropped before synthesis: ${options.droppedIssueCount}.`,
    options.savedDraftId
      ? `- Saved revised draft artifact \`${options.savedDraftId}\`.`
      : "- No revised draft was saved.",
  ];

  return [
    "## Reviewed by",
    ...reviewedByLines,
    "",
    "## Accepted",
    ...acceptedLines,
    "",
    "## Rejected",
    ...rejectedLines,
    "",
    "## Updated draft",
    ...updatedDraftLines,
  ].join("\n");
}
