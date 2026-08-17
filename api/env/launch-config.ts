import {
  asPlanArtifact,
  renderArtifactBodyMarkdown,
  type ArtifactStoreDO,
  type PlanArtifact,
} from "../coordination";
import { getWorkspaceStub } from "../helpers";
import type { HubDO } from "../hub";
import type {
  CodexAuthPreference,
  Env,
  EnvMeta,
  RepoMeta,
  ResolvedClaudeAuthMode,
} from "../types";
import {
  resolveCodexContainerAuth,
  resolveContainerAuth,
  resolveOpenCodeContainerAuth,
} from "./container-auth";
import { getSecret } from "../setup/config";
import { resolveProtectionState } from "../protection";
import { readAccessServiceCredential } from "../access/credentials";
import {
  buildScmContainerEnvVars,
  type StartupPlanSelection,
} from "../scm/model";
import {
  resolveContainerHubUrl,
  buildEnvWorkspaceApiBaseUrl,
} from "./hub-url";
import type { SelectedRepoWorkspace } from "../plan/store";
import workspacePolicy from "./workspace-policy.json";
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  bridgeCredentialsToEnvVars,
  createGitHubBridgeRecord,
} from "../github/bridge";
import { SESSION_ENV_NAMES_VAR } from "../redaction";
import { TILLER_MCP_SERVERS_ENV_VAR, type RepoMcpServer } from "../mcp-servers";
import {
  getHarnessModel,
  validateHarnessSettings,
} from "../../shared/harness-catalog";
import { buildOpenCodeRuntimeEnv } from "../opencode/runtime-env";
import type {
  ScheduledRunCredentialIds,
  ScheduledRunCredentialScope,
} from "./scheduled-run-state";
import {
  codexExecutionAuthMode,
  codexExecutionRuntimeMode,
  codexUnavailableReasonMessage,
  resolveCodexExecutionForEnv,
} from "../codex-execution";
import { getEnvLifecycleStub } from "../helpers";
import { mintEnvironmentRuntimeCapability } from "./runtime-capability";
import type { CodexExecutionProfile } from "../types";
import { BillingResolutionError, createBillingResolutionError } from "../billing-resolution";
import { getDurableObjectStub } from "../durable-object";
import {
  resolveBillingCompatibility,
  type BillingMode,
  type ProviderControlledCredentialClass,
} from "../../shared/billing";

export type RepoWorkspaceHandle = SelectedRepoWorkspace;

export const ENV_ONLY_CANONICAL_EXCLUDES = workspacePolicy.envOnlyCanonicalExcludes;
export const TREE_HASH_EXCLUDES = ENV_ONLY_CANONICAL_EXCLUDES;
export const STARTUP_PLAN_IMPLEMENTATION_PREAMBLE = [
  "Read the approved startup plan below and execute it immediately.",
  "",
  "Work step by step, update files as needed, run relevant checks, and continue until the plan is complete or you hit a real blocker.",
  "",
  "Startup plan:",
  "",
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context.",
  "Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation",
  "and verification.",
].join("\n");

export type EnvStartCause = "ordinary" | "scheduled";

export const SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE = [
  "This is an unattended Tiller Scheduled Run. Implement and verify the approved startup plan autonomously.",
  "Inspect the existing workspace before changing it; it may contain work from an earlier process.",
  "Only after implementation and verification are complete, run `tiller-plan complete`.",
].join("\n");

export function withStartCausePreamble(document: string | null, cause: EnvStartCause): string | null {
  if (cause === "ordinary") return document;
  if (!document) return SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE;

  const canonicalDocument = buildStartupPlanDocument(document);
  const plan = canonicalDocument.slice(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE.length).trim();
  if (
    plan === SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE
    || plan.startsWith(`${SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE}\n\n`)
  ) {
    return canonicalDocument;
  }
  return [
    STARTUP_PLAN_IMPLEMENTATION_PREAMBLE,
    SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE,
    plan,
  ].filter(Boolean).join("\n\n");
}

interface RepoPlanSource {
  meta: Pick<RepoMeta, "repoId" | "mainCommit">;
}

export type StartupArtifactStore = Pick<ArtifactStoreDO, "getArtifact" | "listLatestTodoPlansForMain">;
type RepoLaunchSettingsHub = Pick<
  HubDO,
  | "resolveRepoSessionEnvVars"
  | "listEnabledRepoMcpServers"
>;

interface LaunchMcpServer {
  id: string;
  url: string;
}

function getHub(env: Env): RepoLaunchSettingsHub {
  return getDurableObjectStub<RepoLaunchSettingsHub>(env, env.HUB, "hub");
}

async function resolveRepoSessionEnvVars(
  env: Env,
  repoId: string | null | undefined,
): Promise<Record<string, string>> {
  const normalizedRepoId = repoId?.trim();
  if (!normalizedRepoId) return {};
  const hub = getHub(env);
  return await hub.resolveRepoSessionEnvVars(normalizedRepoId);
}

async function resolveEnabledRepoMcpServers(
  env: Env,
  repoId: string | null | undefined,
): Promise<RepoMcpServer[]> {
  const normalizedRepoId = repoId?.trim();
  if (!normalizedRepoId) return [];
  const hub = getHub(env);
  if (typeof hub.listEnabledRepoMcpServers !== "function") return [];
  return await hub.listEnabledRepoMcpServers(normalizedRepoId);
}

function serializeLaunchMcpServers(servers: LaunchMcpServer[]): string {
  return JSON.stringify(servers.map((server) => ({
    id: server.id,
    url: server.url,
  })));
}

function withLaunchEnvMetadata(
  repoSessionEnvVars: Record<string, string>,
  commonEnvVars: Record<string, string>,
  harnessEnvVars: Record<string, string>,
): Record<string, string> {
  const envVars = {
    ...repoSessionEnvVars,
    ...commonEnvVars,
    ...harnessEnvVars,
  };
  const sessionEnvNames = Object.keys(repoSessionEnvVars)
    .filter((name) => envVars[name] === repoSessionEnvVars[name])
    .sort();

  return {
    ...envVars,
    [SESSION_ENV_NAMES_VAR]: sessionEnvNames.join(","),
    TILLER_MANAGED_ENV_NAMES: Object.keys(envVars).sort().join(","),
  };
}

export function buildStartupPlanDocument(planText: string): string {
  const trimmed = planText.trim();
  if (!trimmed) {
    return STARTUP_PLAN_IMPLEMENTATION_PREAMBLE;
  }

  const normalized = trimmed.replace(/\r\n/g, "\n");
  if (normalized.startsWith(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE)) {
    return trimmed;
  }

  return `${STARTUP_PLAN_IMPLEMENTATION_PREAMBLE}\n\n${trimmed}`;
}

async function resolveLatestTodoPlan(
  artifactStore: StartupArtifactStore,
  repoId: string,
  mainCommit: string | null,
): Promise<PlanArtifact | null> {
  if (!mainCommit) return null;
  return (await artifactStore.listLatestTodoPlansForMain(repoId, mainCommit, 1))[0] as PlanArtifact | undefined ?? null;
}

export async function resolveSpecificStartupPlanArtifact(
  artifactStore: StartupArtifactStore,
  artifactId: string,
): Promise<PlanArtifact> {
  const selectedPlan = asPlanArtifact(await artifactStore.getArtifact(artifactId));
  if (!selectedPlan) throw new Error(`Plan artifact not found: ${artifactId}`);
  return selectedPlan;
}

export async function resolveSelectedPlanArtifact(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<PlanArtifact | null> {
  if (selection.mode === "none") {
    return null;
  }

  const selectedPlan = selection.mode === "specific"
    ? await resolveSpecificStartupPlanArtifact(artifactStore, selection.artifactId)
    : await resolveLatestTodoPlan(
      artifactStore,
      repo.meta.repoId,
      currentMainCommit,
    );

  if (!selectedPlan) {
    if (selection.mode === "todo") return null;
    throw new Error(`Plan artifact not found: ${selection.artifactId}`);
  }

  if (
    selection.mode !== "specific" &&
    selectedPlan.basis.mainCommit !== currentMainCommit
  ) {
    throw new Error(
      `Plan artifact ${selectedPlan.id} belongs to ${selectedPlan.basis.mainCommit ?? "unknown main"}, expected ${currentMainCommit ?? "unknown main"}.`,
    );
  }

  return selectedPlan;
}

export async function resolveSelectedPlanId(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, selection);
  return selectedPlan?.id ?? null;
}

export async function resolveStartupPlanDocument(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, selection);
  return renderResolvedStartupPlanDocument(selectedPlan);
}

export function renderResolvedStartupPlanDocument(selectedPlan: PlanArtifact | null): string | null {
  return selectedPlan ? buildStartupPlanDocument(renderArtifactBodyMarkdown(selectedPlan.body)) : null;
}

export async function materializeResolvedStartupPlan(
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  selectedPlan: PlanArtifact | null,
): Promise<string | null> {
  await materializeStartupPlanDocument(
    envWorkspace,
    renderResolvedStartupPlanDocument(selectedPlan),
  );
  return selectedPlan?.id ?? null;
}

export async function materializeStartupPlanDocument(
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  document: string | null,
): Promise<void> {
  if (document) {
    await envWorkspace.writeWorkspaceFile("/.tiller/plan.md", document);
    return;
  }
  await envWorkspace.clearWorkspacePlanFile();
}

export async function materializeStartupPlan(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, selection);
  return materializeResolvedStartupPlan(envWorkspace, selectedPlan);
}

export async function buildContainerLaunchConfig(
  env: Env,
  requestUrl: string,
  slug: string,
  repoUrl: string,
  repoMeta: Pick<RepoMeta, "repoId" | "githubFullName" | "githubDefaultBranch"> | null | undefined,
  meta: EnvMeta,
  options?: {
    startCause?: EnvStartCause;
    credentialScope?: ScheduledRunCredentialScope;
    startOpId?: string;
    startAuthClaim?: {
      claudeAuthMode: ResolvedClaudeAuthMode | null;
      codexAuthPreference: CodexAuthPreference | null;
    };
  },
): Promise<{
  envVars: Record<string, string>;
  meta: Pick<EnvMeta, "harness" | "resolvedAuthMode" | "codexAuthMode">;
  credentials: ScheduledRunCredentialIds;
}> {
  const backend = meta.backend;
  const harness = meta.harness;
  const harnessSettings = validateHarnessSettings(harness, meta.harnessSettings);
  if (!harnessSettings) {
    throw new Error(
      `A complete committed model and effort pair is required to launch the ${harness} harness.`,
    );
  }
  const catalogModel = getHarnessModel(harness, harnessSettings.model);
  if (!catalogModel) throw new Error(`Model ${harnessSettings.model} is not supported by ${harness}.`);
  let billingMode: BillingMode | null = null;
  let pinnedCodexProfile: CodexExecutionProfile | null = null;
  const lifecycle = options?.startOpId ? getEnvLifecycleStub(env, slug) : null;
  pinnedCodexProfile = lifecycle && harness === "codex"
    ? await lifecycle.getCodexExecutionProfile(options!.startOpId!)
    : null;
  if (catalogModel.credential !== "workers-ai") {
    const claim = options?.startAuthClaim;
    if (!claim) throw new Error("Environment start billing claim is missing.");
    const openCodeUsesApiKey = catalogModel.credential === "openai-api-key"
      || catalogModel.credential === "anthropic-api-key";
    const claimedMode: BillingMode | null = harness === "claude-code"
      ? claim.claudeAuthMode
      : harness === "codex"
        ? claim.codexAuthPreference === "subscription"
          ? "subscription"
          : claim.codexAuthPreference === "api-key" ? "api" : null
        : openCodeUsesApiKey ? "api" : null;
    const compatibility = resolveBillingCompatibility(
      catalogModel.credential as ProviderControlledCredentialClass,
      claimedMode,
    );
    if (compatibility.kind !== "compatible") {
      throw createBillingResolutionError(catalogModel, compatibility.kind);
    }
    billingMode = compatibility.mode;
  }
  const runnerId = meta.runnerId ?? slug;
  const hubPublicUrl = await resolveContainerHubUrl(env, requestUrl, backend);
  const protection = await resolveProtectionState(env, requestUrl);
  const repoSessionEnvVars = await resolveRepoSessionEnvVars(env, repoMeta?.repoId);
  const repoMcpServers = await resolveEnabledRepoMcpServers(env, repoMeta?.repoId);
  const accessCredential = protection.protectionMode === "cf-access"
    ? await readAccessServiceCredential(env, hubPublicUrl)
    : null;
  const cfClientId = accessCredential?.clientId ?? "";
  const cfClientSecret = accessCredential?.clientSecret ?? "";
  const launchMcpServers: LaunchMcpServer[] = repoMcpServers.map((server) => ({
    id: server.id,
    url: server.url,
  }));
  const githubBridge = repoMeta?.githubFullName && await isGitHubAppAllowedForRequest(env, new Request(requestUrl))
    ? await createGitHubBridgeRecord(env, {
        subject: {
          type: "interactive-env",
          envSlug: slug,
          ...(options?.credentialScope ?? {}),
        },
        githubFullName: repoMeta.githubFullName,
      })
    : null;
  const githubBaseCheckout = repoMeta?.githubFullName && meta.githubBaseCommitSha && githubBridge
    ? {
        fullName: repoMeta.githubFullName,
        baseBranch: meta.githubBaseBranch ?? repoMeta.githubDefaultBranch ?? "",
        baseCommitSha: meta.githubBaseCommitSha,
        branch: meta.githubBranch ?? "",
      }
    : null;
  const commonEnvVars = {
    NAMESPACE: "hub",
    REPO_SLUG: slug,
    REPO_URL: repoUrl,
    RUNNER_BACKEND: backend,
    RUNNER_ID: runnerId,
    HUB_URL: hubPublicUrl,
    ...(githubBaseCheckout
      ? {
          TILLER_GITHUB_FULL_NAME: githubBaseCheckout.fullName,
          TILLER_GITHUB_BASE_BRANCH: githubBaseCheckout.baseBranch,
          TILLER_GITHUB_BASE_COMMIT_SHA: githubBaseCheckout.baseCommitSha,
          TILLER_GITHUB_BRANCH: githubBaseCheckout.branch,
          TILLER_GITHUB_WORKSPACE_DRAFT_FULL: "0",
        }
      : {}),
    NODE_OPTIONS: "--dns-result-order=ipv4first",
    TILLER_HARNESS: harness,
    ...(env.TILLER_TERMINAL_METRICS === "1" ? { TILLER_TERMINAL_METRICS: "1" } : {}),
    ...(options?.startCause === "scheduled" ? { TILLER_START_CAUSE: "scheduled" } : {}),
    [TILLER_MCP_SERVERS_ENV_VAR]: serializeLaunchMcpServers(launchMcpServers),
    ...buildScmContainerEnvVars(meta),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
    ...(options?.startOpId && meta.incarnationId
      ? {
          TILLER_RUNTIME_CAPABILITY: await mintEnvironmentRuntimeCapability(env, {
            envSlug: slug,
            incarnationId: meta.incarnationId,
            startOperationId: options.startOpId,
          }),
        }
      : {}),
    ...(githubBridge ? bridgeCredentialsToEnvVars(githubBridge) : {}),
  };
  const baseCredentials: ScheduledRunCredentialIds = {
    ...(githubBridge ? { githubBridgeId: githubBridge.id } : {}),
  };

  if (harness === "codex") {
    if (catalogModel.binding.kind !== "codex") throw new Error(`Invalid Codex model: ${catalogModel.id}`);
    let profile: CodexExecutionProfile | null = pinnedCodexProfile;
    if (!profile) {
      const resolution = await resolveCodexExecutionForEnv(env, {
        surface: "implementor",
        backend,
        authPreference: billingMode === "subscription" ? "subscription" : "api-key",
      });
      if (resolution.kind === "unavailable") {
        const message = codexUnavailableReasonMessage(resolution);
        if (
          resolution.reason === "api_key_missing"
          || resolution.reason === "subscription_missing"
          || resolution.reason === "subscription_needs_reconnect"
        ) {
          throw new BillingResolutionError("credential-not-configured", message);
        }
        throw new Error(message);
      }
      profile = resolution.profile;
      if (options?.startOpId) {
        profile = await getEnvLifecycleStub(env, slug).claimCodexExecutionProfile(
          options.startOpId,
          profile,
        );
        if (!profile) throw new Error("Environment start authentication ownership changed; Restart required.");
      }
    }

    const authMode = codexExecutionAuthMode(profile);
    const runtimeMode = codexExecutionRuntimeMode(profile);
    let authEnvVars: Record<string, string>;
    if (profile.kind === "subscription-app-server") {
      const incarnationId = meta.incarnationId?.trim() ?? "";
      const startOpId = options?.startOpId?.trim() ?? "";
      if (!incarnationId || !startOpId) {
        throw new Error("Codex subscription launch requires an active environment start fence.");
      }
      authEnvVars = {
        TILLER_CODEX_RUNTIME_AUTH_URL: `${hubPublicUrl}/api/envs/${encodeURIComponent(slug)}/codex/runtime-auth`,
      };
    } else {
      const auth = await resolveCodexContainerAuth(env, { authPreference: "api-key" });
      authEnvVars = auth.envVars;
    }

    const envVars = withLaunchEnvMetadata(repoSessionEnvVars, commonEnvVars, {
      TILLER_CODEX_AUTH_MODE: authMode,
      TILLER_CODEX_RUNTIME_MODE: runtimeMode,
      TILLER_CODEX_MODEL: catalogModel.binding.model,
      TILLER_CODEX_REASONING_EFFORT: harnessSettings.effort,
      ...(harnessSettings.fastMode ? { TILLER_CODEX_FAST_MODE: "1" } : {}),
      ...authEnvVars,
    });
    return {
      envVars,
      meta: {
        harness,
        codexAuthMode: authMode,
      },
      credentials: baseCredentials,
    };
  }

  if (harness === "opencode") {
    if (catalogModel.binding.kind !== "opencode") throw new Error(`Invalid OpenCode model: ${catalogModel.id}`);
    const auth = await resolveOpenCodeContainerAuth(env, catalogModel);
    const envVars = withLaunchEnvMetadata(
      repoSessionEnvVars,
      commonEnvVars,
      buildOpenCodeRuntimeEnv({
        model: catalogModel,
        auth,
        proxyBaseUrl: `${hubPublicUrl}/api/opencode/v1`,
        reasoningEffort: harnessSettings.effort,
      }),
    );
    return {
      envVars,
      meta: { harness },
      credentials: baseCredentials,
    };
  }

  if (catalogModel.binding.kind !== "claude") throw new Error(`Invalid Claude Code model: ${catalogModel.id}`);
  if (!billingMode) throw new Error("Claude launch is missing its claimed billing mode.");
  const auth = await resolveContainerAuth(env, {
    requested: billingMode,
    backend,
  });
  const envVars = withLaunchEnvMetadata(repoSessionEnvVars, commonEnvVars, {
    TILLER_CLAUDE_AUTH_RESOLVED_MODE: auth.resolvedAuthMode,
    TILLER_CLAUDE_MODEL: catalogModel.binding.model,
    TILLER_CLAUDE_EFFORT: harnessSettings.effort,
    ...(harnessSettings.fastMode ? { TILLER_CLAUDE_FAST_MODE: "1" } : {}),
    ...auth.envVars,
  });

  return {
    envVars,
    meta: {
      harness,
      resolvedAuthMode: auth.resolvedAuthMode,
    },
    credentials: baseCredentials,
  };
}
