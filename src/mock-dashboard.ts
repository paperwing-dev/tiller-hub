import type { EnvMeta, RepoMeta } from "../api/types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../api/scm/model";
import { getHarnessDefault } from "../shared/harness-catalog";
import { isLoopbackUrl } from "../shared/local-dev";

const NOW = "2026-06-13T02:00:00.000Z";
const MAIN_COMMIT = "mock-main-20260613";
const PREVIOUS_MAIN_COMMIT = "mock-main-20260530";

const DEMO_REPOS = [
  {
    repoId: "mock-repo-paperwing-tiller",
    repoUrl: "https://github.com/paperwing-dev/tiller-demo",
    githubFullName: "paperwing-dev/tiller-demo",
    githubInstallationId: 10001,
    updatedAt: NOW,
    lastCommittedFromEnvSlug: "checkout-polish",
    lastCommittedAt: "2026-06-13T01:15:00.000Z",
  },
  {
    repoId: "mock-repo-atlas-studio",
    repoUrl: "https://github.com/paperwing-dev/atlas-studio",
    githubFullName: "paperwing-dev/atlas-studio",
    githubInstallationId: 10002,
    updatedAt: "2026-06-12T20:30:00.000Z",
    lastCommittedFromEnvSlug: "map-controls",
    lastCommittedAt: "2026-06-12T20:15:00.000Z",
  },
  {
    repoId: "mock-repo-kumo-admin",
    repoUrl: "https://github.com/paperwing-dev/kumo-admin",
    githubFullName: "paperwing-dev/kumo-admin",
    githubInstallationId: 10003,
    updatedAt: "2026-06-11T18:10:00.000Z",
    lastCommittedFromEnvSlug: "billing-audit",
    lastCommittedAt: "2026-06-11T17:50:00.000Z",
  },
  {
    repoId: "mock-repo-voicekit",
    repoUrl: "https://github.com/paperwing-dev/voicekit",
    githubFullName: "paperwing-dev/voicekit",
    githubInstallationId: 10004,
    updatedAt: "2026-06-10T15:40:00.000Z",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
  },
  {
    repoId: "mock-repo-docs-site",
    repoUrl: "https://github.com/paperwing-dev/docs-site",
    githubFullName: "paperwing-dev/docs-site",
    githubInstallationId: 10005,
    updatedAt: "2026-06-09T12:00:00.000Z",
    lastCommittedFromEnvSlug: "nav-refresh",
    lastCommittedAt: "2026-06-09T11:30:00.000Z",
  },
  {
    repoId: "mock-repo-billing-ops",
    repoUrl: "https://github.com/paperwing-dev/billing-ops",
    githubFullName: "paperwing-dev/billing-ops",
    githubInstallationId: 10006,
    updatedAt: "2026-06-08T09:25:00.000Z",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
  },
];

export function shouldUseLocalDashboardMock(hubUrl: string): boolean {
  return isLoopbackUrl(hubUrl);
}

export function getMockDashboardRepos(): RepoMeta[] {
  return DEMO_REPOS.map(makeRepo);
}

export function getMockDashboardEnvs(): EnvMeta[] {
  const envs = [
    makeEnv({
      repoId: "mock-repo-paperwing-tiller",
      slug: "checkout-polish",
      backend: "host",
      harness: "codex",
      status: "running",
      startupPlanId: "plan-checkout-polish",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
      resolvedAuthMode: "subscription",
      codexAuthMode: "subscription",
      bootMessage: "Codex is connected and ready for UI iteration.",
    }),
    makeEnv({
      repoId: "mock-repo-paperwing-tiller",
      slug: "navigation-density",
      backend: "host",
      harness: "claude-code",
      status: "stopped",
      startupPlanId: "plan-navigation-density",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
      resolvedAuthMode: "subscription",
    }),
    makeEnv({
      repoId: "mock-repo-paperwing-tiller",
      slug: "settings-flow",
      backend: "cf",
      harness: "opencode",
      status: "stopped",
      startupPlanId: null,
      baseMainCommit: PREVIOUS_MAIN_COMMIT,
      lastKnownMainCommit: PREVIOUS_MAIN_COMMIT,
      branchStatus: "behind-main",
    }),
    makeEnv({
      repoId: "mock-repo-paperwing-tiller",
      slug: "voice-agent-spike",
      backend: "host",
      harness: "claude-code",
      status: "failed",
      startupPlanId: "plan-voice-agent-spike",
      workspaceNeedsAttention: true,
      branchStatus: "needs-attention",
      resolvedAuthMode: "api",
      error: "Mock startup failure: subscription runtime authentication unavailable.",
      errorAt: "2026-06-13T01:42:00.000Z",
      bootStepId: "hub-connect",
    }),
    makeEnv({
      repoId: "mock-repo-atlas-studio",
      slug: "map-controls",
      backend: "cf",
      harness: "claude-code",
      status: "running",
      startupPlanId: "plan-map-controls",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    }),
    makeEnv({
      repoId: "mock-repo-atlas-studio",
      slug: "terrain-loading",
      backend: "host",
      harness: "codex",
      status: "stopped",
      startupPlanId: "plan-terrain-loading",
    }),
    makeEnv({
      repoId: "mock-repo-kumo-admin",
      slug: "billing-audit",
      backend: "cf",
      harness: "opencode",
      status: "stopped",
      startupPlanId: "plan-billing-audit",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    }),
    makeEnv({
      repoId: "mock-repo-kumo-admin",
      slug: "role-matrix",
      backend: "host",
      harness: "codex",
      status: "running",
      startupPlanId: "plan-role-matrix",
    }),
    makeEnv({
      repoId: "mock-repo-kumo-admin",
      slug: "invoice-export",
      backend: "cf",
      harness: "claude-code",
      status: "failed",
      startupPlanId: "plan-invoice-export",
      workspaceNeedsAttention: true,
      branchStatus: "needs-attention",
      error: "Mock startup failure: missing billing fixture.",
      errorAt: "2026-06-11T18:05:00.000Z",
      bootStepId: "harness-launch",
    }),
    makeEnv({
      repoId: "mock-repo-voicekit",
      slug: "latency-meter",
      backend: "host",
      harness: "codex",
      status: "running",
      startupPlanId: "plan-latency-meter",
    }),
    makeEnv({
      repoId: "mock-repo-voicekit",
      slug: "stream-recorder",
      backend: "cf",
      harness: "claude-code",
      status: "stopped",
      startupPlanId: "plan-stream-recorder",
      baseMainCommit: PREVIOUS_MAIN_COMMIT,
      lastKnownMainCommit: PREVIOUS_MAIN_COMMIT,
      branchStatus: "behind-main",
    }),
    makeEnv({
      repoId: "mock-repo-docs-site",
      slug: "nav-refresh",
      backend: "host",
      harness: "opencode",
      status: "stopped",
      startupPlanId: "plan-nav-refresh",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    }),
    makeEnv({
      repoId: "mock-repo-docs-site",
      slug: "search-index",
      backend: "cf",
      harness: "codex",
      status: "starting",
      startupPlanId: "plan-search-index",
    }),
  ];
  const nextSlotByRepo = new Map<string, number>();
  return envs.map((env) => {
    const sidebarSlot = (nextSlotByRepo.get(env.repoId) ?? 0) + 1;
    nextSlotByRepo.set(env.repoId, sidebarSlot);
    return { ...env, sidebarSlot };
  });
}

export function getMockDashboardRepo(repoId: string): RepoMeta | null {
  return getMockDashboardRepos().find((repo) => repo.repoId === repoId) ?? null;
}

export function getMockDashboardEnv(slug: string): EnvMeta | null {
  return getMockDashboardEnvs().find((env) => env.slug === slug) ?? null;
}

function makeEnv(
  overrides: Partial<EnvMeta> & Pick<EnvMeta, "repoId" | "slug" | "backend" | "harness" | "status">,
): EnvMeta {
  const { repoId, slug, backend, harness, status, ...optionalOverrides } = overrides;
  const repo = DEMO_REPOS.find((candidate) => candidate.repoId === repoId) ?? DEMO_REPOS[0]!;
  const env = {
    slug,
    repoUrl: repo.repoUrl,
    repoId: repo.repoId,
    backend,
    harness,
    harnessSettings: getHarnessDefault(harness),
    createdAt: NOW,
    updatedAt: NOW,
    status,
    ...(harness === "codex" ? { codexAuthMode: "subscription" as const } : {}),
    ...(harness === "claude-code" ? { resolvedAuthMode: "api" as const } : {}),
    ...createInitialEnvScmState({
      slug,
      startupPlanId: optionalOverrides.startupPlanId ?? null,
      mainCommit: MAIN_COMMIT,
    }),
    ...optionalOverrides,
  };

  return env;
}

function makeRepo(repo: (typeof DEMO_REPOS)[number]): RepoMeta {
  return {
    repoId: repo.repoId,
    repoUrl: repo.repoUrl,
    githubInstallationId: repo.githubInstallationId,
    githubFullName: repo.githubFullName,
    ...createInitialRepoScmState(),
    mainCommit: MAIN_COMMIT,
    gitArtifactId: `mock-git-artifact-${repo.repoId}`,
    gitStatus: "ready",
    createdAt: NOW,
    updatedAt: repo.updatedAt,
    bootstrappedFromRef: "main",
    lastCommittedFromEnvSlug: repo.lastCommittedFromEnvSlug,
    lastCommittedAt: repo.lastCommittedAt,
    githubPublish: null,
  };
}
