import { describe, expect, it, vi } from "vitest";

vi.mock("../api/setup/config", () => ({
  getSecret: vi.fn(async () => undefined),
}));

vi.mock("../api/protection", () => ({
  resolveProtectionState: vi.fn(async () => ({ protectionMode: "public" })),
}));

vi.mock("../api/model-route", () => ({
  resolveCodexModelRoute: vi.fn(async () => null),
}));

vi.mock("../api/env/hub-url", () => ({
  resolveContainerHubUrl: vi.fn(async () => "https://hub.example.com"),
  buildEnvWorkspaceApiBaseUrl: vi.fn((_hubUrl: string, slug: string) => `https://hub.example.com/api/workspace/${slug}`),
  buildRepoGitArtifactUrl: vi.fn((_hubUrl: string, repoId: string, artifactId: string) =>
    `https://hub.example.com/api/repos/${repoId}/git-artifacts/${artifactId}`),
  buildEnvScmOperationResultUrl: vi.fn(),
  buildEnvScmOperationHeartbeatUrl: vi.fn(),
  buildEnvScmOperationFailedUrl: vi.fn(),
  buildRepoGitArtifactStagingUrl: vi.fn(),
}));

vi.mock("../api/env/container-auth", () => ({
  resolveContainerAuth: vi.fn(async () => ({
    authMode: "auto",
    resolvedAuthMode: "api",
    envVars: {
      ANTHROPIC_API_KEY: "anthropic-key",
    },
  })),
  resolveCodexContainerAuth: vi.fn(),
  resolveOpenCodeContainerAuth: vi.fn(),
}));

const { buildContainerLaunchConfig } = await import("../api/env/launch-config");

describe("buildContainerLaunchConfig", () => {
  it("emits REPO_SLUG as the only runtime slug env var", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      {} as any,
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      {
        repoId: "repo-1",
        gitArtifactId: "artifact-1",
      },
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2026-04-13T00:00:00.000Z",
      },
    );

    expect(launchConfig.envVars).toMatchObject({
      REPO_SLUG: "demo-env",
      RUNNER_BACKEND: "cf",
      TILLER_HARNESS: "claude-code",
    });
    expect(Object.keys(launchConfig.envVars)).not.toContain("ENV_SLUG");
    expect(Object.keys(launchConfig.envVars)).not.toContain("TILLER_HARNESS_VERSION");
  });
});
