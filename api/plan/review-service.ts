import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  buildSystemPrompt,
  createHostedToolRegistry,
  createWorkspaceAccess,
  getAgentSpec,
  getHostedToolsForAgent,
  resolveAgentAuth,
  resolveAgentModel,
  runDirectToolsRuntime,
  toAiSdkTools,
} from "../agent-core";
import { requireChatGPTAvailability } from "../chatgpt-availability";
import type {
  AgentSpec,
  HostedTool,
  HostedToolName,
  PlanReviewIssueStats,
  PlanReviewMeta,
  WorkspaceContextAccess,
} from "../agent-core/types";
import {
  createPlanArtifactInput,
  createReviewArtifactInput,
  type ArtifactStoreDO,
  type PlanArtifact,
  type ReviewArtifact,
} from "../coordination";
import type { Env, RepoMeta } from "../types";
import type { WorkspaceDO } from "../workspace/do";
import {
  buildPlanIntegrationPrompt,
  buildPlanIntegrationRepairPrompt,
  buildPlanIntegrationReply,
  buildPlanReviewPrompt,
  buildPlanReviewRepairPrompt,
  filterPlanReviewIssues,
  isWorkersAIPlanModel,
  parsePlanIntegrationResponse,
  parsePlanReviewResponse,
  PLAN_REVIEW_MODELS,
  resolvePlanModel,
  summarizeFilteredReview,
} from "./workflow";
import { createScopedReviewWorkspace } from "./scoped-review-workspace";

interface RepoPlanWorkspace {
  meta: RepoMeta;
  planWorkspace: WorkspaceDO;
  artifactStore: Pick<ArtifactStoreDO, "createArtifact" | "listArtifacts">;
}

interface ReviewExecutionResult {
  text: string;
  meta: PlanReviewMeta;
}

interface PendingReviewSave {
  artifact: ReturnType<typeof createReviewArtifactInput>;
}

export interface ReviewRoundResult {
  ok: true;
  draftId: string;
  reviews: Array<{
    id: string;
    model?: string;
    summary: string;
    reviewIssueStats?: PlanReviewIssueStats;
    reviewMeta?: PlanReviewMeta;
  }>;
}

export interface IntegrationResult {
  ok: true;
  skipped?: boolean;
  groundedIssueCount: number;
  droppedIssueCount: number;
  artifact?: PlanArtifact;
  reply: string;
}

function createCodeAwareReviewSpec(): AgentSpec {
  return {
    ...getAgentSpec("reviewer"),
    baseInstructions: [
      "You are reviewing an implementation plan with read-only repository tools.",
      "You must inspect repository files before returning your final answer.",
      "Focus on grounded issues in the draft: missing validation, inaccurate assumptions about the code, contradictory steps, or unnecessary work.",
      "Do not give generic advice. If you cannot ground an issue in the draft and inspected code, omit it.",
      "Return only the structured JSON requested by the user message.",
    ].join(" "),
    toolNames: ["read_file", "list_files", "glob"] satisfies HostedToolName[],
    includeMemories: false,
    includeRecentArtifacts: false,
    injectWorkspaceSummary: true,
    maxSteps: 6,
    maxContextChars: 14_000,
  };
}

async function repairTextToJson(options: {
  model: string;
  workersAI: ReturnType<typeof createWorkersAI>;
  prompt: string;
}): Promise<string> {
  const repaired = await generateText({
    model: options.workersAI.chat(options.model),
    system: "Repair malformed model output into valid JSON. Return JSON only with no markdown fences.",
    prompt: options.prompt,
  });
  return repaired.text.trim();
}

async function runCodeAwareReview(options: {
  draft: PlanArtifact;
  model: string;
  workersAI: ReturnType<typeof createWorkersAI>;
  workspace: WorkspaceContextAccess;
}): Promise<ReviewExecutionResult> {
  const spec = createCodeAwareReviewSpec();
  const toolRegistry = createHostedToolRegistry(options.workspace, {
    artifactDefaults: {
      repoId: options.draft.repoId,
      mainCommit: options.draft.basis.mainCommit,
    },
  });
  const tools = toAiSdkTools(getHostedToolsForAgent(toolRegistry, spec));
  const systemPrompt = await buildSystemPrompt(spec, options.workspace);

  let retriedForToolUse = false;
  let result = await generateText({
    model: options.workersAI.chat(options.model),
    system: systemPrompt,
    prompt: buildPlanReviewPrompt(options.draft),
    tools,
    stopWhen: stepCountIs(spec.maxSteps ?? 6),
  });

  if (result.toolCalls.length === 0) {
    retriedForToolUse = true;
    result = await generateText({
      model: options.workersAI.chat(options.model),
      system: `${systemPrompt}\n\nYou must use the repository tools before answering.`,
      prompt: [
        buildPlanReviewPrompt(options.draft),
        "",
        "You did not inspect repository files on the previous attempt. Read the relevant files first, then finalize the review.",
      ].join("\n"),
      tools,
      stopWhen: stepCountIs(spec.maxSteps ?? 6),
    });
  }

  return {
    text: result.text.trim(),
    meta: {
      toolCallCount: result.toolCalls.length,
      finishReason: result.finishReason,
      truncated: result.finishReason === "length",
      warningCount: result.warnings?.length ?? 0,
      retriedForToolUse,
    },
  };
}

async function generateIsolatedPlannerText(options: {
  env: Env;
  selectedModel: string;
  systemPrompt: string;
  prompt: string;
}): Promise<string> {
  if (isWorkersAIPlanModel(options.selectedModel)) {
    const workersAI = createWorkersAI({ binding: options.env.AI });
    const result = await generateText({
      model: workersAI.chat(options.selectedModel),
      system: options.systemPrompt,
      prompt: options.prompt,
    });
    return result.text.trim();
  }

  const spec = getAgentSpec("plan");
  const availability = await requireChatGPTAvailability(options.env, "ChatGPT planning");
  const auth = await resolveAgentAuth(options.env, spec, availability.codexRoute);

  let text = "";
  await runDirectToolsRuntime({
    env: options.env,
    spec: {
      ...spec,
      maxSteps: 1,
    },
    accessToken: auth.accessToken ?? "",
    accountId: auth.accountId,
    model: resolveAgentModel(options.env, spec, options.selectedModel),
    systemPrompt: options.systemPrompt,
    codexRoute: auth.codexRoute,
    responseTools: [],
    toolRegistry: new Map<HostedToolName, HostedTool>(),
    initialInput: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.prompt }],
      },
    ],
    hooks: {
      onTextDelta: (delta) => {
        text += delta;
      },
    },
  });

  return text.trim();
}

async function generateIsolatedPlannerIntegration(options: {
  env: Env;
  selectedModel: string;
  prompt: string;
}): Promise<string> {
  const systemPrompt =
    "You are the primary planning assistant revising an implementation plan after a review round. Work only from the current draft and the filtered review issues provided in the user message. Do not rely on previous chat history or unrelated repo context.";
  const integrationText = await generateIsolatedPlannerText({
    env: options.env,
    selectedModel: options.selectedModel,
    systemPrompt,
    prompt: options.prompt,
  });

  if (parsePlanIntegrationResponse(integrationText)) {
    return integrationText;
  }

  return generateIsolatedPlannerText({
    env: options.env,
    selectedModel: options.selectedModel,
    systemPrompt: "Repair malformed planner output into valid JSON. Return JSON only with no markdown fences.",
    prompt: buildPlanIntegrationRepairPrompt(integrationText),
  });
}

function createReviewWorkspace(planWorkspace: WorkspaceDO, draft: PlanArtifact): WorkspaceContextAccess {
  return createScopedReviewWorkspace(createWorkspaceAccess(planWorkspace), draft.body.relevantFiles);
}

function summarizeReviewText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "No review summary available.";
  return compact.slice(0, 200) + (compact.length > 200 ? "..." : "");
}

function extractFindings(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .slice(0, 8);
}

export async function runPlanReviewRound(options: {
  env: Env;
  repoPlan: RepoPlanWorkspace;
  draft: PlanArtifact;
}): Promise<ReviewRoundResult> {
  const workersAI = createWorkersAI({ binding: options.env.AI });
  const reviewWorkspace = createReviewWorkspace(options.repoPlan.planWorkspace, options.draft);
  const pendingReviews: PendingReviewSave[] = [];

  for (const model of PLAN_REVIEW_MODELS) {
    const execution = await runCodeAwareReview({
      draft: options.draft,
      model,
      workersAI,
      workspace: reviewWorkspace,
    });

    const rawReviewText = execution.text.trim();
    let reviewText = rawReviewText;
    const reviewId = crypto.randomUUID();
    let parsedReview = parsePlanReviewResponse(reviewText);
    let repaired = false;

    if (!parsedReview.summary && parsedReview.issues.length === 0) {
      repaired = true;
      reviewText = await repairTextToJson({
        model,
        workersAI,
        prompt: buildPlanReviewRepairPrompt(reviewText),
      });
      parsedReview = parsePlanReviewResponse(reviewText);
    }

    const filteredReview = filterPlanReviewIssues({
      draft: options.draft,
      sourceReviewId: reviewId,
      sourceModel: model,
      issues: parsedReview.issues,
    });

    pendingReviews.push({
      artifact: createReviewArtifactInput({
        repo: options.repoPlan.meta,
        title: `Review of ${options.draft.title}`,
        body: {
          summary: summarizeFilteredReview({
            parsedSummary: parsedReview.summary || summarizeReviewText(rawReviewText),
            filtered: filteredReview,
          }),
          findings:
            filteredReview.kept.length > 0
              ? filteredReview.kept.map((issue) => issue.issue)
              : extractFindings(rawReviewText),
          relevantFiles: options.draft.body.relevantFiles,
          openQuestions: [],
          proposedPlan: rawReviewText,
          memoryRefs: [],
          model,
          reviewIssues: filteredReview.kept.map(
            ({ sourceReviewId: _sourceReviewId, sourceModel: _sourceModel, ...issue }) => issue,
          ),
          reviewIssueStats: filteredReview.stats,
          reviewMeta: {
            ...execution.meta,
            repaired,
          },
        },
        createdBy: "plan-review",
        createdAt: new Date().toISOString(),
        parentArtifactId: options.draft.id,
      }),
    });
  }

  const savedReviews: ReviewArtifact[] = [];
  for (const pendingReview of pendingReviews) {
    const saved = options.repoPlan.artifactStore.createArtifact(pendingReview.artifact);
    const reviewArtifact = saved.type === "review"
      ? saved as ReviewArtifact
      : null;
    if (!reviewArtifact) {
      throw new Error(`Expected review artifact, got ${saved.type}`);
    }
    savedReviews.push(reviewArtifact);
  }

  return {
    ok: true,
    draftId: options.draft.id,
    reviews: savedReviews.map((review) => ({
      id: review.id,
      model: review.body.model,
      summary: review.body.summary,
      reviewIssueStats: review.body.reviewIssueStats,
      reviewMeta: review.body.reviewMeta,
    })),
  };
}

export async function integratePlanReviews(options: {
  env: Env;
  repoPlan: RepoPlanWorkspace;
  draft: PlanArtifact;
  selectedModel: unknown;
}): Promise<IntegrationResult> {
  const selectedModel = resolvePlanModel(options.selectedModel);
  const allArtifacts = options.repoPlan.artifactStore.listArtifacts({ limit: 500 });
  const reviews = allArtifacts
    .filter((artifact): artifact is ReviewArtifact => artifact.type === "review")
    .filter(
      (artifact) =>
        artifact.parentArtifactId === options.draft.id &&
        artifact.basis.mainCommit === options.draft.basis.mainCommit,
    );

  if (reviews.length === 0) {
    throw new Error("No review artifacts found for this draft");
  }

  const groundedIssues = reviews.flatMap((review) => {
    const parsedIssues =
      review.body.reviewIssues ??
      filterPlanReviewIssues({
        draft: options.draft,
        sourceReviewId: review.id,
        sourceModel: review.body.model,
        issues: parsePlanReviewResponse(review.body.proposedPlan).issues,
      }).kept.map(({ sourceReviewId: _sourceReviewId, sourceModel: _sourceModel, ...issue }) => issue);

    return parsedIssues.map((issue) => ({
      ...issue,
      sourceReviewId: review.id,
      sourceModel: review.body.model,
    }));
  });

  const droppedIssueCount = reviews.reduce(
    (total, review) => total + (review.body.reviewIssueStats?.dropped ?? 0),
    0,
  );

  if (groundedIssues.length === 0) {
    return {
      ok: true,
      skipped: true,
      groundedIssueCount: 0,
      droppedIssueCount,
      reply: buildPlanIntegrationReply({
        reviews,
        accepted: [],
        rejected: reviews.map((review) => ({
          sourceReviewId: review.id,
          issue: "All review items were filtered out before synthesis",
          reason:
            "No grounded review issue survived deterministic filtering, so the draft was left unchanged.",
        })),
        updatedSummary:
          "No revised draft was saved because none of the review feedback was grounded enough to integrate.",
        groundedIssueCount: 0,
        droppedIssueCount,
      }),
    };
  }

  const integrationText = await generateIsolatedPlannerIntegration({
    env: options.env,
    selectedModel,
    prompt: buildPlanIntegrationPrompt({
      draft: options.draft,
      filteredIssues: groundedIssues,
      selectedModel,
    }),
  });
  const integration = parsePlanIntegrationResponse(integrationText);

  if (!integration) {
    throw new Error("Planner returned an invalid integration response");
  }

  const draftChanged =
    integration.revisedPlan.trim() !== options.draft.body.proposedPlan.trim() ||
    integration.updatedSummary.trim() !== options.draft.body.summary.trim();

  if (!draftChanged) {
    return {
      ok: true,
      skipped: true,
      groundedIssueCount: groundedIssues.length,
      droppedIssueCount,
      reply: buildPlanIntegrationReply({
        reviews,
        accepted: integration.accepted,
        rejected: integration.rejected,
        updatedSummary:
          "The planner kept the draft materially unchanged after reviewing the grounded feedback.",
        groundedIssueCount: groundedIssues.length,
        droppedIssueCount,
      }),
    };
  }

  const revisedDraft = options.repoPlan.artifactStore.createArtifact(
    createPlanArtifactInput({
      repo: options.repoPlan.meta,
      title: options.draft.title,
      body: {
        summary: integration.updatedSummary,
        findings: integration.accepted.map((item) => item.change),
        relevantFiles: options.draft.body.relevantFiles,
        openQuestions: options.draft.body.openQuestions,
        proposedPlan: integration.revisedPlan,
        memoryRefs: options.draft.body.memoryRefs,
        model: selectedModel,
      },
      createdBy: "plan-integrator",
      parentArtifactId: options.draft.id,
      supersedesArtifactId: options.draft.id,
    }),
  ) as PlanArtifact;

  return {
    ok: true,
    skipped: false,
    groundedIssueCount: groundedIssues.length,
    droppedIssueCount,
    artifact: revisedDraft,
    reply: buildPlanIntegrationReply({
      reviews,
      accepted: integration.accepted,
      rejected: integration.rejected,
      updatedSummary: integration.updatedSummary,
      savedDraftId: revisedDraft.id,
      groundedIssueCount: groundedIssues.length,
      droppedIssueCount,
    }),
  };
}
