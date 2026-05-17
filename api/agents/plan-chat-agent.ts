import {
  Think,
  type ChatResponseResult,
  type ChunkContext,
  type PrepareStepContext,
  type Session,
  type StepConfig,
  type StepContext,
  type ToolCallContext,
  type ToolCallDecision,
  type ToolCallResultContext,
  type TurnConfig,
  type TurnContext,
} from "@cloudflare/think";
import type { AgentContext } from "agents";
import { AgentContextProvider } from "agents/experimental/memory/session";
import type { LanguageModel, ToolSet } from "ai";
import {
  type CodexLanguageModelResolution,
  createCodexResponsesProviderOptions,
  resolveCodexLanguageModel,
} from "../agent-core/codex-language-model";
import type { WorkspaceContextAccess } from "../agent-core/types";
import { getAgentSpec } from "../agent-core/specs";
import { createWorkspaceAccess } from "../agent-core/workspace-access";
import { loadRepoArtifacts, renderArtifactBodyMarkdown } from "../coordination";
import { getArtifactStoreStub } from "../helpers";
import { loadRepo } from "../repo/access";
import type { Env } from "../types";
import {
  configurePlanPolicySession,
  createGetPlanContextTool,
  createPlanArtifactTools,
  decidePlanToolCall,
  PLAN_ACTIVE_TOOLS,
  PLAN_POLICY_CONTEXT_LABEL,
  PLAN_INITIAL_ACTIVE_TOOLS,
  PLAN_MODEL,
  PLAN_TURN_MAX_STEPS,
  runBoundedPlanFind,
  runBoundedPlanGrep,
} from "./plan-chat-support";
import { PlanChatWorkspaceProxy } from "./plan-chat-workspace";

export const PLAN_CHAT_AGENT_PATH = "plan-chat";
export const WRITER_MODEL = PLAN_MODEL;

interface PlanChatRequest {
  repoId: string;
  planArtifactId: string;
}

interface PlanChatBenchmark {
  id: string;
  startedAtMs: number;
  repoId?: string;
  planArtifactId?: string;
  routeKind?: string;
  providerBaseUrl?: string;
  modelId?: string;
  currentPlanChars?: number;
  artifactCount?: number;
  historyMessages?: number;
  tools?: string[];
  activeTools?: readonly string[];
  phaseDurationsMs: Record<string, number>;
  firstChunkAtMs?: number;
  firstTextAtMs?: number;
  chunkCount: number;
  textChunkCount: number;
  reasoningChunkCount: number;
  toolChunkCount: number;
  stepCount: number;
  toolCallCount: number;
}

interface PlanChatProtocolEvent {
  type?: string;
  id?: string;
  init?: {
    method?: string;
    body?: string;
  };
}

interface PlanChatInferenceInput {
  continuation?: boolean;
  body?: Record<string, unknown>;
  clientTools?: unknown[];
}

interface PlanChatAgentPrivate {
  _handleProtocolEvent?: (
    connection: unknown,
    event: PlanChatProtocolEvent,
  ) => Promise<void>;
  _handleChatRequest?: (
    connection: unknown,
    event: PlanChatProtocolEvent,
  ) => Promise<void>;
  _runInferenceLoop?: (input: PlanChatInferenceInput) => Promise<unknown>;
  _streamResult?: (
    requestId: string,
    result: unknown,
    abortSignal?: AbortSignal,
    options?: unknown,
  ) => Promise<void>;
}

const UNCONFIGURED_PLAN_MODEL: LanguageModel = {
  specificationVersion: "v3",
  provider: "tiller",
  modelId: "plan-unconfigured",
  supportedUrls: {},
  async doGenerate() {
    throw new Error("Plan Writer model was not configured for this turn.");
  },
  async doStream() {
    throw new Error("Plan Writer model was not configured for this turn.");
  },
};

const CODEX_MODEL_CACHE_TTL_MS = 45_000;

function readBodyString(body: Record<string, unknown> | undefined, key: string): string | null {
  const value = body?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPlanRequest(body: Record<string, unknown> | undefined, previous: PlanChatRequest | null): PlanChatRequest {
  const repoId = readBodyString(body, "repoId") ?? previous?.repoId;
  const planArtifactId = readBodyString(body, "planArtifactId") ?? previous?.planArtifactId;
  if (!repoId) {
    throw new Error("repoId is required");
  }
  if (!planArtifactId) {
    throw new Error("planArtifactId is required");
  }
  return { repoId, planArtifactId };
}

function elapsedMs(startMs: number): number {
  return Math.round(performance.now() - startMs);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringLength(value: string | null | undefined): number {
  return value?.length ?? 0;
}

function countToolItems(items: ReadonlyArray<unknown> | undefined): number {
  return items?.length ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeChatRequestBody(bodyText: string | undefined): Record<string, unknown> {
  if (!bodyText) return { bodyChars: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { bodyChars: bodyText.length, parseable: false };
  }
  if (!isRecord(parsed)) {
    return { bodyChars: bodyText.length, parseable: false };
  }

  const { messages, clientTools, trigger, ...customBody } = parsed;
  return {
    bodyChars: bodyText.length,
    parseable: true,
    messageCount: Array.isArray(messages) ? messages.length : null,
    clientToolCount: Array.isArray(clientTools) ? clientTools.length : null,
    trigger: typeof trigger === "string" ? trigger : null,
    customBodyKeys: Object.keys(customBody).sort(),
  };
}

function summarizeWebSocketMessage(message: unknown): Record<string, unknown> {
  if (typeof message !== "string") {
    return { messageKind: typeof message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return {
      messageKind: "string",
      messageChars: message.length,
      parseable: false,
    };
  }
  if (!isRecord(parsed)) {
    return {
      messageKind: "string",
      messageChars: message.length,
      parseable: false,
    };
  }

  return {
    messageKind: "string",
    messageChars: message.length,
    parseable: true,
    protocolType: typeof parsed.type === "string" ? parsed.type : null,
    requestId: typeof parsed.id === "string" ? parsed.id : null,
  };
}

export class PlanChatAgent extends Think<Env> {
  override maxSteps = PLAN_TURN_MAX_STEPS;
  override sendReasoning = false;
  override workspace = new PlanChatWorkspaceProxy();
  private lastRequest: PlanChatRequest | null = null;
  private activeBenchmark: PlanChatBenchmark | null = null;
  private benchmarkProbesInstalled = false;
  private planContextLoadedForTurn = false;
  private activeWorkspaceAccess: WorkspaceContextAccess | null = null;
  private codexModelCache: {
    model: string;
    expiresAtMs: number;
    resolution: CodexLanguageModelResolution;
  } | null = null;
  private codexModelPending: {
    model: string;
    promise: Promise<CodexLanguageModelResolution>;
  } | null = null;
  private readonly appEnv: Env;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.appEnv = env;
  }

  override getModel(): LanguageModel {
    return UNCONFIGURED_PLAN_MODEL;
  }

  override getSystemPrompt(): string {
    return "Plan Writer is preparing repository context.";
  }

  override getTools(): ToolSet {
    return {};
  }

  override configureSession(session: Session): Session {
    return configurePlanPolicySession(
      session,
      new AgentContextProvider(this, `${PLAN_POLICY_CONTEXT_LABEL}_cached_prompt`),
    );
  }

  override async onStart(): Promise<void> {
    if (!this.isDebugEnabled()) return;
    this.installThinkBenchmarkProbes();
  }

  private isDebugEnabled(): boolean {
    return this.appEnv.PLAN_CHAT_DEBUG === "1";
  }

  private installThinkBenchmarkProbes(): void {
    if (this.benchmarkProbesInstalled) return;
    this.benchmarkProbesInstalled = true;

    const originalOnMessage = this.onMessage.bind(this);
    this.onMessage = async (connection, message) => {
      this.logBenchmark("websocket_message", summarizeWebSocketMessage(message));
      return originalOnMessage(connection, message);
    };

    const internals = this as unknown as PlanChatAgentPrivate;
    const originalHandleProtocolEvent = internals._handleProtocolEvent?.bind(this);
    if (originalHandleProtocolEvent) {
      internals._handleProtocolEvent = async (connection, event) => {
        this.logBenchmark("protocol_event_start", {
          protocolType: event.type ?? null,
          requestId: event.id ?? null,
          method: event.init?.method ?? null,
          ...summarizeChatRequestBody(event.init?.body),
        });
        const startedAtMs = performance.now();
        try {
          return await originalHandleProtocolEvent(connection, event);
        } finally {
          this.logBenchmark("protocol_event_finish", {
            protocolType: event.type ?? null,
            requestId: event.id ?? null,
            durationMs: elapsedMs(startedAtMs),
          });
        }
      };
    }

    const originalHandleChatRequest = internals._handleChatRequest?.bind(this);
    if (originalHandleChatRequest) {
      internals._handleChatRequest = async (connection, event) => {
        this.logBenchmark("chat_request_start", {
          requestId: event.id ?? null,
          method: event.init?.method ?? null,
          ...summarizeChatRequestBody(event.init?.body),
        });
        const startedAtMs = performance.now();
        try {
          return await originalHandleChatRequest(connection, event);
        } finally {
          this.logBenchmark("chat_request_finish", {
            requestId: event.id ?? null,
            durationMs: elapsedMs(startedAtMs),
          });
        }
      };
    }

    const originalRunInferenceLoop = internals._runInferenceLoop?.bind(this);
    if (originalRunInferenceLoop) {
      internals._runInferenceLoop = async (input) => {
        const probeId = crypto.randomUUID();
        this.logBenchmark("inference_loop_start", {
          probeId,
          continuation: input.continuation === true,
          bodyKeys: input.body ? Object.keys(input.body).sort() : [],
          clientToolCount: input.clientTools?.length ?? 0,
        });
        const startedAtMs = performance.now();
        try {
          const result = await originalRunInferenceLoop(input);
          this.logBenchmark("inference_loop_ready_stream", {
            probeId,
            durationMs: elapsedMs(startedAtMs),
            hasResult: Boolean(result),
          });
          return result;
        } catch (error) {
          this.logBenchmark("inference_loop_error", {
            probeId,
            durationMs: elapsedMs(startedAtMs),
            error: summarizeError(error),
          });
          throw error;
        }
      };
    }

    const originalStreamResult = internals._streamResult?.bind(this);
    if (originalStreamResult) {
      internals._streamResult = async (requestId, result, abortSignal, options) => {
        this.logBenchmark("stream_result_start", { requestId });
        const startedAtMs = performance.now();
        try {
          return await originalStreamResult(requestId, result, abortSignal, options);
        } finally {
          this.logBenchmark("stream_result_finish", {
            requestId,
            durationMs: elapsedMs(startedAtMs),
          });
        }
      };
    }
  }

  private beginBenchmark(ctx: TurnContext): PlanChatBenchmark {
    const benchmark: PlanChatBenchmark = {
      id: crypto.randomUUID(),
      startedAtMs: performance.now(),
      historyMessages: ctx.messages.length,
      tools: Object.keys(ctx.tools).sort(),
      activeTools: PLAN_ACTIVE_TOOLS,
      phaseDurationsMs: {},
      chunkCount: 0,
      textChunkCount: 0,
      reasoningChunkCount: 0,
      toolChunkCount: 0,
      stepCount: 0,
      toolCallCount: 0,
    };
    this.activeBenchmark = benchmark;
    this.logBenchmark("turn_start", {
      historyMessages: benchmark.historyMessages,
      availableTools: benchmark.tools,
      activeTools: benchmark.activeTools,
    });
    return benchmark;
  }

  private logBenchmark(event: string, payload: Record<string, unknown> = {}): void {
    if (!this.isDebugEnabled()) return;
    const benchmark = this.activeBenchmark;
    console.info("[plan-chat-benchmark]", JSON.stringify({
      event,
      at: new Date().toISOString(),
      benchmarkId: benchmark?.id ?? null,
      elapsedMs: benchmark ? elapsedMs(benchmark.startedAtMs) : null,
      repoId: benchmark?.repoId ?? null,
      planArtifactId: benchmark?.planArtifactId ?? null,
      routeKind: benchmark?.routeKind ?? null,
      modelId: benchmark?.modelId ?? null,
      ...payload,
    }));
  }

  private async timeBenchmarkPhase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const startedAtMs = performance.now();
    try {
      return await work();
    } finally {
      const durationMs = elapsedMs(startedAtMs);
      if (this.activeBenchmark) {
        this.activeBenchmark.phaseDurationsMs[name] = durationMs;
      }
      this.logBenchmark("phase", { phase: name, durationMs });
    }
  }

  private async resolvePlanCodexModel(): Promise<CodexLanguageModelResolution> {
    const now = Date.now();
    const cached = this.codexModelCache;
    if (cached && cached.model === PLAN_MODEL && cached.expiresAtMs > now) {
      this.logBenchmark("codex_model_cache_hit", {
        cacheTtlMs: cached.expiresAtMs - now,
      });
      return cached.resolution;
    }

    if (this.codexModelPending?.model === PLAN_MODEL) {
      this.logBenchmark("codex_model_pending_hit");
      return this.codexModelPending.promise;
    }

    const promise = resolveCodexLanguageModel(this.appEnv, {
      chatSessionId: this.name,
      model: PLAN_MODEL,
    });
    this.codexModelPending = { model: PLAN_MODEL, promise };

    try {
      const resolution = await promise;
      this.codexModelCache = {
        model: PLAN_MODEL,
        expiresAtMs: Date.now() + CODEX_MODEL_CACHE_TTL_MS,
        resolution,
      };
      this.logBenchmark("codex_model_cache_store", {
        cacheTtlMs: CODEX_MODEL_CACHE_TTL_MS,
        routeKind: resolution.route.kind,
        modelId: resolution.modelId,
      });
      return resolution;
    } finally {
      if (this.codexModelPending?.promise === promise) {
        this.codexModelPending = null;
      }
    }
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    const benchmark = this.beginBenchmark(ctx);
    this.planContextLoadedForTurn = false;
    this.activeWorkspaceAccess = null;
    const request = readPlanRequest(ctx.body, this.lastRequest);
    this.lastRequest = request;
    benchmark.repoId = request.repoId;
    benchmark.planArtifactId = request.planArtifactId;

    const spec = getAgentSpec("plan");
    const codexModelResolutionPromise = this.resolvePlanCodexModel();
    codexModelResolutionPromise.catch(() => undefined);
    const loadedRepo = await this.timeBenchmarkPhase("load_repo_workspace", () => loadRepo(this.appEnv, request.repoId, "selected-write"));
    if (!loadedRepo.ok) {
      throw new Error(typeof loadedRepo.body.error === "string" ? loadedRepo.body.error : `Repo not found: ${request.repoId}`);
    }
    const repo = loadedRepo.repo;
    if (!repo.meta.mainCommit) {
      throw new Error(
        "Canonical main commit is not ready yet for this repository. Wait for repo bootstrap to finish before planning.",
      );
    }

    const artifactStore = getArtifactStoreStub(this.appEnv, repo.meta.repoId);
    const plan = await this.timeBenchmarkPhase("load_plan_artifact", () => artifactStore.getArtifact(request.planArtifactId));
    if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
      throw new Error(`Plan artifact not found: ${request.planArtifactId}`);
    }

    this.workspace.setWorkspace(repo.workspace);
    const workspace = createWorkspaceAccess(repo.workspace);
    this.activeWorkspaceAccess = workspace;
    const { artifacts } = await this.timeBenchmarkPhase("load_repo_artifacts", () => loadRepoArtifacts(repo.meta, artifactStore));
    benchmark.artifactCount = artifacts.length;
    const currentPlanMarkdown = renderArtifactBodyMarkdown(plan.body);
    benchmark.currentPlanChars = currentPlanMarkdown.length;
    const artifactTools = await this.timeBenchmarkPhase("create_artifact_tools", async () => createPlanArtifactTools(workspace, {
      artifactDefaults: {
        repoId: repo.meta.repoId,
        mainCommit: repo.meta.mainCommit,
      },
      artifactStore,
      savePlanDefaults: {
        repoId: repo.meta.repoId,
        planArtifactId: plan.id,
        expectedVersion: plan.version ?? 1,
        currentMainCommit: repo.meta.mainCommit,
      },
    }));
    const tools = {
      ...createGetPlanContextTool({
        repo: repo.meta,
        plan,
        artifacts,
        workspace,
        currentPlanMarkdown,
        maxRecentArtifacts: spec.maxRecentArtifacts ?? 6,
        onSuccess: () => {
          this.planContextLoadedForTurn = true;
        },
      }),
      ...artifactTools,
    };
    const { model, route, providerBaseUrl, modelId, promptCacheKey } = await this.timeBenchmarkPhase(
      "wait_codex_model",
      () => codexModelResolutionPromise,
    );
    benchmark.routeKind = route.kind;
    benchmark.providerBaseUrl = providerBaseUrl;
    benchmark.modelId = modelId;
    benchmark.tools = Object.keys(tools).sort();
    this.logBenchmark("before_turn_ready", {
      phaseDurationsMs: benchmark.phaseDurationsMs,
      currentPlanChars: benchmark.currentPlanChars,
      artifactCount: benchmark.artifactCount,
      modelId,
      providerBaseUrl,
      routeKind: route.kind,
      tools: benchmark.tools,
      maxSteps: PLAN_TURN_MAX_STEPS,
    });

    return {
      model,
      tools,
      activeTools: [...PLAN_INITIAL_ACTIVE_TOOLS],
      maxSteps: PLAN_TURN_MAX_STEPS,
      sendReasoning: false,
      providerOptions: createCodexResponsesProviderOptions(promptCacheKey),
    };
  }

  override beforeStep(ctx: PrepareStepContext): StepConfig | void {
    this.logBenchmark("step_start", {
      stepNumber: ctx.stepNumber,
      stepsSoFar: ctx.steps.length,
      messages: ctx.messages.length,
    });
    return {
      activeTools: [
        ...(ctx.stepNumber === 0 || !this.planContextLoadedForTurn
          ? PLAN_INITIAL_ACTIVE_TOOLS
          : PLAN_ACTIVE_TOOLS),
      ],
    };
  }

  override async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
    this.logBenchmark("tool_start", {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      stepNumber: ctx.stepNumber,
      inputKind: typeof ctx.input,
      inputKeys: isRecord(ctx.input) ? Object.keys(ctx.input).sort() : [],
    });
    const policyDecision = decidePlanToolCall(ctx.toolName, {
      planContextLoaded: this.planContextLoadedForTurn,
    });
    if (policyDecision) return policyDecision;

    if ((ctx.toolName === "find" || ctx.toolName === "grep") && this.activeWorkspaceAccess) {
      const input = isRecord(ctx.input) ? ctx.input : {};
      return {
        action: "substitute",
        output: ctx.toolName === "find"
          ? await runBoundedPlanFind(this.activeWorkspaceAccess, input)
          : await runBoundedPlanGrep(this.activeWorkspaceAccess, input),
      };
    }
  }

  override afterToolCall(ctx: ToolCallResultContext): void {
    if (this.activeBenchmark) {
      this.activeBenchmark.toolCallCount += 1;
    }
    this.logBenchmark("tool_finish", {
      toolName: ctx.toolName,
      toolCallId: ctx.toolCallId,
      stepNumber: ctx.stepNumber,
      durationMs: ctx.durationMs,
      success: ctx.success,
      outputKind: ctx.success ? typeof ctx.output : null,
      error: ctx.success ? null : summarizeError(ctx.error),
    });
  }

  override onChunk(ctx: ChunkContext): void {
    const benchmark = this.activeBenchmark;
    if (!benchmark) return;

    benchmark.chunkCount += 1;
    const chunkType = ctx.chunk.type;
    if (chunkType === "text-delta") benchmark.textChunkCount += 1;
    if (chunkType === "reasoning-delta") benchmark.reasoningChunkCount += 1;
    if (chunkType.startsWith("tool-")) benchmark.toolChunkCount += 1;

    if (benchmark.firstChunkAtMs === undefined) {
      benchmark.firstChunkAtMs = elapsedMs(benchmark.startedAtMs);
      this.logBenchmark("first_chunk", {
        chunkType,
        firstChunkMs: benchmark.firstChunkAtMs,
      });
    }
    if (chunkType === "text-delta" && benchmark.firstTextAtMs === undefined) {
      benchmark.firstTextAtMs = elapsedMs(benchmark.startedAtMs);
      this.logBenchmark("first_text", {
        firstTextMs: benchmark.firstTextAtMs,
      });
    }
  }

  override onStepFinish(ctx: StepContext): void {
    if (this.activeBenchmark) {
      this.activeBenchmark.stepCount += 1;
    }
    this.logBenchmark("step_finish", {
      finishReason: ctx.finishReason,
      textChars: stringLength(ctx.text),
      toolCalls: countToolItems(ctx.toolCalls),
      toolResults: countToolItems(ctx.toolResults),
      warnings: ctx.warnings?.length ?? 0,
      usage: ctx.usage ?? null,
    });
  }

  override onChatResponse(_result: ChatResponseResult): void {
    const benchmark = this.activeBenchmark;
    if (!benchmark) return;

    this.logBenchmark("turn_finish", {
      totalMs: elapsedMs(benchmark.startedAtMs),
      firstChunkMs: benchmark.firstChunkAtMs ?? null,
      firstTextMs: benchmark.firstTextAtMs ?? null,
      stepCount: benchmark.stepCount,
      toolCallCount: benchmark.toolCallCount,
      chunkCount: benchmark.chunkCount,
      textChunkCount: benchmark.textChunkCount,
      reasoningChunkCount: benchmark.reasoningChunkCount,
      toolChunkCount: benchmark.toolChunkCount,
      phaseDurationsMs: benchmark.phaseDurationsMs,
      routeKind: benchmark.routeKind ?? null,
      modelId: benchmark.modelId ?? null,
    });
    this.activeBenchmark = null;
  }

  override onChatError(error: unknown): unknown {
    this.logBenchmark("turn_error", {
      error: summarizeError(error),
    });
    this.activeBenchmark = null;
    return error;
  }
}
