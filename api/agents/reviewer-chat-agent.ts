import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { AgentContext } from "agents";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type GenerateTextOnFinishCallback,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  buildSystemPrompt,
  createReviewerTools,
  createWorkspaceAccess,
  REVIEWER_AGENT_SPEC,
} from "../agent-core";
import { renderArtifactBodyMarkdown } from "../coordination";
import { getArtifactStoreStub } from "../helpers";
import { loadRepo } from "../repo/access";
import type { Env } from "../types";
import { KIMI_K2_7_CODE } from "../../shared/harness-catalog";

const REVIEWER_MODELS = [
  "@cf/nvidia/nemotron-3-120b-a12b",
  KIMI_K2_7_CODE.providerModel,
] as const;

function readRequiredBodyString(options: OnChatMessageOptions | undefined, key: string): string {
  const body = (options?.body as Record<string, unknown> | undefined) ?? {};
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function assertReviewerModel(model: string): void {
  if (!(REVIEWER_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unsupported reviewer model: ${model}`);
  }
}

export class ReviewerChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  private readonly appEnv: Env;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.appEnv = env;
  }

  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<any>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const spec = REVIEWER_AGENT_SPEC;
    const repoId = readRequiredBodyString(options, "repoId");
    const threadId = readRequiredBodyString(options, "threadId");
    const loadedRepo = await loadRepo(this.appEnv, repoId);
    if (!loadedRepo.ok) {
      throw new Error(typeof loadedRepo.body.error === "string" ? loadedRepo.body.error : `Repo not found: ${repoId}`);
    }
    const repo = loadedRepo.repo;

    const artifactStore = getArtifactStoreStub(
      this.appEnv,
      repo.meta.repoId,
      repo.meta.artifactStoreGeneration,
    );
    const registryRow = await artifactStore.getReviewer(threadId);
    if (!registryRow || registryRow.repoId !== repo.meta.repoId) {
      throw new Error(`Reviewer thread not found: ${threadId}`);
    }
    assertReviewerModel(registryRow.reviewerModel);

    const plan = await artifactStore.getArtifact(registryRow.planArtifactId);
    if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
      throw new Error(`Plan artifact not found: ${registryRow.planArtifactId}`);
    }

    const workspace = createWorkspaceAccess(repo.workspace);
    const tools = createReviewerTools(workspace);
    const baseSystemPrompt = await buildSystemPrompt(spec, workspace);
    const systemPrompt = [
      baseSystemPrompt,
      "You are reviewing the attached implementation plan. Before reviewing, identify the files this plan touches via glob/list_files.",
      "Return concise, code-aware feedback. You cannot save or modify the plan.",
      `Repository ID: ${repo.meta.repoId}`,
      `Plan artifact ID: ${plan.id}`,
      "Current plan Markdown:",
      renderArtifactBodyMarkdown(plan.body),
    ].join("\n\n");
    const workersAI = createWorkersAI({ binding: this.appEnv.AI });
    const modelMessages = await convertToModelMessages(this.messages, { tools });

    const result = streamText({
      model: workersAI.chat(registryRow.reviewerModel),
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(spec.maxSteps),
    });

    return result.toUIMessageStreamResponse();
  }
}
