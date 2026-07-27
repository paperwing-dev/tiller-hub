import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { AgentContext } from "agents";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  buildSystemPrompt,
  createHostedToolRegistry,
  createWorkspaceAccess,
  getAgentSpec,
  getHostedToolsForAgent,
  toAiSdkTools,
} from "../agent-core";
import type { AgentSpec } from "../agent-core";
import { renderArtifactBodyMarkdown } from "../coordination";
import { getArtifactStoreStub } from "../helpers";
import { loadRepo } from "../repo/access";
import { PLAN_REVIEW_MODELS } from "../plan/workflow";
import type { Env } from "../types";

function readRequiredBodyString(options: OnChatMessageOptions | undefined, key: string): string {
  const body = (options?.body as Record<string, unknown> | undefined) ?? {};
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function assertReviewerModel(model: string): void {
  if (!(PLAN_REVIEW_MODELS as readonly string[]).includes(model)) {
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
    _onFinish: StreamTextOnFinishCallback<any>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const spec: AgentSpec = {
      ...getAgentSpec("reviewer"),
      toolNames: ["read_file", "list_files", "glob"],
      includeMemories: false,
      includeRecentArtifacts: false,
    };
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
    const toolRegistry = createHostedToolRegistry(workspace);
    const hostedTools = getHostedToolsForAgent(toolRegistry, spec);
    const tools = toAiSdkTools(hostedTools);
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
      stopWhen: stepCountIs(spec.maxSteps ?? 8),
    });

    return result.toUIMessageStreamResponse();
  }
}

export const REVIEWER_CHAT_AGENT_PATH = "reviewer-chat";
