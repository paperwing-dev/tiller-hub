/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderToString } from "react-dom/server";
import { fireEvent, waitFor } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";
import SessionList from "../SessionList";

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/test/repo",
    scmModel: "github",
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-a",
    githubWebhookConfigured: true,
    githubWebhookError: null,
    mainCommit: "main-a",
    gitArtifactId: "git-a",
    gitStatus: "ready",
    gitError: null,
    gitFormatVersion: 1,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
  };
  return Object.assign(repo, overrides);
}

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    sidebarSlot: 1,
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    status: "stopped",
    startupPlanId: null,
    branchName: "tiller/demo-env",
    branchStatus: "ready-to-merge",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-05-01T00:00:00.000Z",
    implementorAttentionToken: null,
    baseMainCommit: "main-a",
    lastKnownMainCommit: "main-a",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: "main",
    githubBaseCommitSha: "main-a",
    githubBranch: "tiller/env/demo-env",
    githubHeadCommitSha: null,
    githubPrNumber: null,
    githubPrUrl: null,
    githubPrState: null,
    githubMergedAt: null,
    githubPublishStatus: "idle",
    githubPublishOperationId: null,
    githubPublishError: null,
    githubLastPublishedAt: null,
    githubLastPublishedWorkspaceHash: null,
    githubPendingPublish: null,
  };
  return Object.assign(env, overrides);
}

function render(env: EnvMeta, repo = makeRepo()) {
  return renderToString(
    <SessionList
      repos={[repo]}
      sessions={[]}
      envs={[env]}
      hubUrl="https://hub.test"
      onShipSelect={() => undefined}
    />,
  );
}

describe("SessionList implementor cards", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  it("shows Ship for changed stopped envs", () => {
    const html = render(makeEnv());

    expect(html).toContain('class="contents">Ship</span>');
    expect(html).not.toContain("Draft PR Diff");
    expect(html).not.toContain("Draft changed");
  });

  it("gives unread implementor attention blue precedence over stopped gray", () => {
    const document = new DOMParser().parseFromString(
      render(makeEnv({
        status: "stopped",
        implementorAttentionToken: "attention-token",
      })),
      "text/html",
    );
    const status = document.querySelector('[aria-label="Status: Needs attention"]');

    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-label")).toBe("Status: Needs attention");
    expect(status?.classList.contains("bg-kumo-info")).toBe(true);
    expect(status?.classList.contains("bg-kumo-line")).toBe(false);
  });

  it("hides Ship while a changed env is running", () => {
    const html = render(makeEnv({ status: "running" }));

    expect(html).toContain('class="contents">Stop</span>');
    expect(html).not.toContain('class="contents">Ship</span>');
  });

  it("shows each workload's read-only execution backend badge on the card", () => {
    const cloudflare = new DOMParser().parseFromString(render(makeEnv()), "text/html");
    const machine = new DOMParser().parseFromString(
      render(makeEnv({ backend: "host" })),
      "text/html",
    );

    expect(
      cloudflare.querySelector('[data-testid="env-backend-badge-demo-env"]')?.textContent,
    ).toBe("Cloudflare");
    expect(
      machine.querySelector('[data-testid="env-backend-badge-demo-env"]')?.textContent,
    ).toBe("Your machine");
  });

  it("keeps Ship available for a recorded pull request", () => {
    const html = render(makeEnv({
      workspaceDirty: false,
      branchStatus: "up-to-date",
      githubPrState: "open",
      githubPrUrl: "https://github.com/test/repo/pull/7",
    }));

    expect(html).toContain('class="contents">Ship</span>');
  });

  it("hides Ship when the stopped env has nothing to ship", () => {
    const html = render(makeEnv({
      branchStatus: "up-to-date",
      workspaceDirty: false,
      githubHeadCommitSha: null,
      githubPrUrl: null,
      githubPrState: null,
      githubPublishStatus: "up-to-date",
    }));

    expect(html).not.toContain('class="contents">Ship</span>');
    expect(html).not.toContain("No changes");
    expect(html).not.toContain("Draft changed");
  });

  it("does not treat behind-main alone as something to ship", () => {
    const html = render(makeEnv({
      branchStatus: "behind-main",
      workspaceDirty: false,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    }), makeRepo({ mainCommit: "main-b", githubDefaultBranchHeadSha: "main-b" }));

    expect(html).not.toContain('class="contents">Ship</span>');
    expect(html).not.toContain("Behind default branch");
    expect(html).not.toContain("Start this env and ask the agent to pull in main");
    expect(html).not.toContain("Reset");
  });

  it("still shows Ship when a behind-main env has workspace changes", () => {
    const html = render(makeEnv({
      branchStatus: "behind-main",
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    }), makeRepo({ mainCommit: "main-b", githubDefaultBranchHeadSha: "main-b" }));

    expect(html).toContain('class="contents">Ship</span>');
    expect(html).not.toContain("Draft PR Diff");
  });

  it("links repository headers to GitHub", () => {
    const html = render(makeEnv());

    expect(html).toContain('href="https://github.com/test/repo"');
    expect(html).toContain(">test/repo</a>");
  });

  it("uses prototype option B for Plan and implementor environment navigation", () => {
    const html = render(makeEnv({ status: "running" }));
    const planIndex = html.indexOf(">Plan</a>");
    const environmentsIndex = html.indexOf("Implementor Environments");

    expect(planIndex).toBeGreaterThan(-1);
    expect(environmentsIndex).toBeGreaterThan(planIndex);
    expect(html).toContain("min-h-10 w-full");
    expect(html).toContain('href="/projects/repo-1/plan"');
    expect(html).toContain('aria-label="Add implementor environment"');
    expect(html).not.toContain("Add Env");
    expect(html).toContain("demo-env");
    expect(html).toContain("Plan:");
    expect(html).toContain("No plan");
    expect(html).not.toContain("Draft changed");
  });

  it("keeps the first implementor action within the navigation width", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[]}
      />,
    );

    expect(html).toContain('aria-label="Add the first implementor environment"');
    expect(html).toContain("min-w-0 w-full items-start gap-3 overflow-hidden");
    expect(html).toContain("whitespace-normal break-words");
    expect(html).not.toContain("min-h-32");
  });

  it("shows pending repository setup once as an indeterminate status", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo({
          gitStatus: "pending",
          githubDefaultBranchHeadSha: null,
          mainCommit: null,
          gitProgressPhase: "Reading GitHub default branch",
        })]}
        sessions={[]}
        envs={[]}
      />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const indicator = document.querySelector('[data-testid="repo-main-pending-indicator"]');

    expect(document.body.textContent?.match(/Pulling updates from GitHub/g)).toHaveLength(1);
    expect(indicator?.getAttribute("role")).toBe("status");
    expect(indicator?.getAttribute("aria-live")).toBe("polite");
    expect(indicator?.querySelector(".animate-spin")).not.toBeNull();
    expect(indicator?.textContent).toBe("Pulling updates from GitHub…");
  });

  it("uses a plain environment name header with a separate linked plan", () => {
    const html = render(makeEnv({
      startupPlanId: "plan-1",
      resolvedAuthMode: "subscription",
      status: "running",
    }));

    expect(html).toContain("Claude Code");
    expect(html).not.toContain("Subscription");
    expect(html).not.toContain("API key");
    expect(html).not.toContain("New Plan");
    expect(html).not.toContain("Workspace");
    expect(html).not.toContain("No Plan");
    expect(html).not.toContain("Branch:");
    expect(html).toContain('title="demo-env"');
    expect(html).toContain("Plan:");
    expect(html).toContain('href="/projects/repo-1/plan/plan-1"');
    expect(html).toContain("Selected plan");
    expect(html).not.toContain("test/repo</p>");
  });

  it("loads startup-plan labels from repository artifacts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      artifacts: [{
        id: "plan-1",
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-a" },
        title: "Catalog plan label",
        body: { markdown: "# Catalog plan" },
        status: "todo",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-02T00:00:00.000Z",
        version: 2,
      }],
      refs: [],
      attention: [],
    }), { status: 200 }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv({ startupPlanId: "plan-1" })]}
          hubUrl="https://hub.test"
        />,
      );
    });

    await waitFor(() => expect(container.textContent).toContain("Catalog plan label"));
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hub.test/api/repos/repo-1/artifacts",
      expect.objectContaining({ cache: "no-store" }),
    );
    act(() => root.unmount());
    container.remove();
    fetchSpy.mockRestore();
  });

  it("shows No plan beneath the plain environment name", () => {
    const html = render(makeEnv({ startupPlanId: null }));

    expect(html).toContain('title="demo-env"');
    expect(html).toContain("Plan:");
    expect(html).toContain("No plan");
  });

  it("prefers display names and disambiguates duplicate names with slugs", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[
          makeEnv({ slug: "first-env", displayName: "Shared plan", sidebarSlot: 1 }),
          makeEnv({ slug: "second-env", displayName: "Shared plan", sidebarSlot: 2 }),
        ]}
      />,
    );

    const document = new DOMParser().parseFromString(html, "text/html");
    const first = document.querySelector('[data-testid="env-card-first-env"]')?.textContent;
    const second = document.querySelector('[data-testid="env-card-second-env"]')?.textContent;
    expect(first).toContain("Shared plan");
    expect(first).toContain("Slug: first-env");
    expect(second).toContain("Shared plan");
    expect(second).toContain("Slug: second-env");
  });

  it("falls back to the slug when a legacy environment has no display name", () => {
    const html = render(makeEnv({ displayName: undefined }));

    expect(html).toContain('title="demo-env"');
    expect(html).not.toContain("Slug: demo-env");
  });

  it("confirms environment deletion in an app modal", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const onRecoverEnv = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv({ displayName: "Implement settings" })]}
          hubUrl="https://hub.test"
          onRecoverEnv={onRecoverEnv}
        />,
      );
    });

    const deleteButton = container.querySelector(
      '[aria-label="Delete Implement settings (slug: demo-env)"]',
    );
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(deleteButton!);

    const dialog = await waitFor(() => {
      const current = document.body.querySelector('[role="dialog"]');
      expect(current).not.toBeNull();
      return current;
    });
    expect(dialog?.textContent).toContain("Delete environment?");
    expect(dialog?.textContent).toContain(
      '"Implement settings" (slug: demo-env) and its container and R2 storage will be permanently deleted.',
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const cancelButton = Array.from(dialog!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Cancel");
    fireEvent.click(cancelButton!);
    await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(deleteButton!);
    const reopenedDialog = await waitFor(() => {
      const current = document.body.querySelector('[role="dialog"]');
      expect(current).not.toBeNull();
      return current;
    });
    const confirmButton = Array.from(reopenedDialog!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Delete environment");
    fireEvent.click(confirmButton!);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      "https://hub.test/api/envs/demo-env",
      { method: "DELETE", credentials: "include" },
    ));
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env", "deleting");
    await waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull());

    act(() => root.unmount());
    container.remove();
  });

  it("shows explicit slug and current sidebar slot rows in collapsed previews", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv({ displayName: "Implement settings", sidebarSlot: 7 })]}
          sidebarCollapsed
        />,
      );
    });

    fireEvent.mouseEnter(container.querySelector('[data-testid="env-card-demo-env"]')!);

    await waitFor(() => expect(document.body.textContent).toContain("Sidebar slot"));
    expect(document.body.textContent).toContain("demo-env");
    expect(document.body.textContent).toContain("#7");
    act(() => root.unmount());
    container.remove();
  });

  it("sorts the unified workload list by the persistent repo slot", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[
          makeEnv({ slug: "second", sidebarSlot: 2, branchName: "tiller/second" }),
          makeEnv({ slug: "first", sidebarSlot: 1, branchName: "tiller/first" }),
        ]}
      />,
    );

    expect(html.indexOf('data-testid="env-card-first"')).toBeLessThan(
      html.indexOf('data-testid="env-card-second"'),
    );
  });

  it("uses the persistent slot in the collapsed rail", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[makeEnv({ sidebarSlot: 7 })]}
        sidebarCollapsed
      />,
    );

    expect(html).toMatch(/tabular-nums[^>]*>7<\/span>/);
    expect(html).not.toContain(">DE</span>");
  });

  it("selects exactly one expanded environment with a persistent accent", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[
          makeEnv({ slug: "first", sidebarSlot: 1, branchName: "tiller/first" }),
          makeEnv({ slug: "second", sidebarSlot: 2, branchName: "tiller/second" }),
        ]}
        activeEnvironmentSlug="second"
      />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const selectedCards = document.querySelectorAll('[data-testid^="env-card-"][aria-current="page"]');
    const selected = document.querySelector('[data-testid="env-card-second"]');
    const ordinary = document.querySelector('[data-testid="env-card-first"]');

    expect(selectedCards).toHaveLength(1);
    expect(selected?.classList.contains("border-l-kumo-info")).toBe(true);
    expect(selected?.classList.contains("bg-kumo-info-tint")).toBe(true);
    expect(ordinary?.classList.contains("hover:bg-kumo-tint")).toBe(true);
    expect(ordinary?.classList.contains("bg-kumo-info-tint")).toBe(false);
  });

  it("applies the active treatment to the collapsed numbered slot", () => {
    const html = renderToString(
      <SessionList
        repos={[makeRepo()]}
        sessions={[]}
        envs={[makeEnv({ sidebarSlot: 7 })]}
        activeEnvironmentSlug="demo-env"
        sidebarCollapsed
      />,
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const card = document.querySelector('[data-testid="env-card-demo-env"]');
    const slot = card?.querySelector(".tabular-nums");

    expect(card?.getAttribute("aria-current")).toBe("page");
    expect(slot?.classList.contains("border-kumo-info")).toBe(true);
    expect(slot?.classList.contains("bg-kumo-info-tint")).toBe(true);
    expect(slot?.classList.contains("text-kumo-link")).toBe(true);
  });

  it("renders scheduled, completed, and interrupted Scheduled Run actions", () => {
    const scheduled = render(makeEnv({
      scheduledRun: { state: "scheduled", runAtMs: Date.now() + 60_000, timeZone: "America/Los_Angeles" },
    }));
    expect(scheduled).toContain("Scheduled · 3:00 AM");
    expect(scheduled).toContain('class="contents">Cancel</span>');

    const completed = render(makeEnv({
      scheduledRun: { state: "completed", runAtMs: Date.now() - 60_000, timeZone: "America/Los_Angeles" },
    }));
    expect(completed).toContain("Completed");
    expect(completed).toContain('class="contents">Start</span>');

    const interrupted = render(makeEnv({
      scheduledRun: { state: "interrupted", runAtMs: Date.now() - 60_000, timeZone: "America/Los_Angeles" },
    }));
    expect(interrupted).toContain("Interrupted");
    expect(interrupted).toContain('class="contents">Start</span>');
  });

  it("keeps Stop available and blocks destructive actions for cleanup-required failures", () => {
    const html = render(makeEnv({
      status: "failed",
      scheduledRun: {
        state: "failed",
        runAtMs: Date.now() - 60_000,
        timeZone: "America/Los_Angeles",
        error: "Stop dispatch failed",
        cleanupRequired: true,
      },
    }));
    expect(html).toContain("Stop dispatch failed");
    expect(html).toContain("This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.");
    expect(html).toContain('class="contents">Stop</span>');
    expect(html).not.toContain('class="contents">Start</span>');
    expect(html).toMatch(/<button[^>]*aria-label="Delete demo-env"[^>]*disabled=""/);
  });

  it("applies the Scheduled Run implementing and finalizing action matrix", () => {
    const implementing = render(makeEnv({
      status: "running",
      scheduledRun: {
        state: "running",
        stage: "implementing",
        runAtMs: Date.now() - 60_000,
        timeZone: "America/Los_Angeles",
      },
    }));
    expect(implementing).toContain("Implementing plan");
    expect(implementing).toContain('class="contents">Stop</span>');
    expect(implementing).not.toContain('class="contents">Start</span>');
    expect(implementing).toMatch(/<button[^>]*aria-label="Delete demo-env"[^>]*disabled=""/);

    const saving = render(makeEnv({
      status: "saving",
      scheduledRun: {
        state: "running",
        stage: "saving",
        runAtMs: Date.now() - 60_000,
        timeZone: "America/Los_Angeles",
      },
    }));
    expect(saving).toContain("Saving and finalizing");
    expect(saving).toContain('class="contents">Stop</span>');
    expect(saving).not.toContain('class="contents">Start</span>');
    expect(saving).toMatch(/<button[^>]*aria-label="Delete demo-env"[^>]*disabled=""/);

    const capacityCleanup = render(makeEnv({
      status: "stopped",
      scheduledRun: {
        state: "scheduled",
        stage: "saving",
        runAtMs: Date.now() + 60_000,
        timeZone: "America/Los_Angeles",
      },
    }));
    expect(capacityCleanup).toContain("Saving and finalizing");
    expect(capacityCleanup).not.toContain('class="contents">Cancel</span>');
    expect(capacityCleanup).not.toContain('class="contents">Start</span>');
    expect(capacityCleanup).toMatch(/<button[^>]*aria-label="Delete demo-env"[^>]*disabled=""/);
  });

  it("keeps ordinary Start and Delete for a clean terminal failure", () => {
    const html = render(makeEnv({
      status: "failed",
      scheduledRun: {
        state: "failed",
        runAtMs: Date.now() - 60_000,
        timeZone: "America/Los_Angeles",
        error: "workspace persistence failed",
      },
    }));
    expect(html).toContain('class="contents">Start</span>');
    expect(html).toContain('aria-label="Delete demo-env"');
    expect(html).not.toMatch(/<button[^>]*aria-label="Delete demo-env"[^>]*disabled=""/);
  });

  it("selects the environment when the card surface is clicked", async () => {
    const onPlanSelect = vi.fn();
    const onEnvSelect = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = createRoot(container);

    await act(async () => {
      root?.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv({ startupPlanId: "plan-1" })]}
          hubUrl=""
          onEnvSelect={onEnvSelect}
          onPlanSelect={onPlanSelect}
        />,
      );
    });

    const card = container.querySelector<HTMLElement>('[data-testid="env-card-demo-env"]');
    expect(card).toBeInstanceOf(HTMLElement);

    await act(async () => {
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onEnvSelect).toHaveBeenCalledWith("demo-env");
    expect(onPlanSelect).not.toHaveBeenCalled();

    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("opens plan links without selecting the env card", async () => {
    const onPlanSelect = vi.fn();
    const onEnvSelect = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root | null = createRoot(container);

    await act(async () => {
      root?.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv({ startupPlanId: "plan-1" })]}
          hubUrl=""
          onEnvSelect={onEnvSelect}
          onPlanSelect={onPlanSelect}
        />,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href="/projects/repo-1/plan/plan-1"]');
    expect(link).toBeInstanceOf(HTMLAnchorElement);

    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onPlanSelect).toHaveBeenCalledWith("repo-1", "plan-1");
    expect(onEnvSelect).not.toHaveBeenCalled();

    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("preserves native new-tab behavior on the Plan link", async () => {
    const onPlanSelect = vi.fn();
    const onRepoHomeSelect = vi.fn();
    const container = document.createElement("div");
    let root: Root | null = createRoot(container);

    await act(async () => {
      root?.render(
        <SessionList
          repos={[makeRepo()]}
          sessions={[]}
          envs={[makeEnv()]}
          hubUrl=""
          onPlanSelect={onPlanSelect}
          onRepoHomeSelect={onRepoHomeSelect}
        />,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href="/projects/repo-1/plan"]');
    expect(link).toBeInstanceOf(HTMLAnchorElement);

    const regularClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      link?.dispatchEvent(regularClick);
    });
    expect(regularClick.defaultPrevented).toBe(true);
    expect(onPlanSelect).toHaveBeenCalledWith("repo-1");
    expect(onRepoHomeSelect).not.toHaveBeenCalled();

    onPlanSelect.mockClear();
    link!.target = "_blank";
    const commandClick = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    await act(async () => {
      link?.dispatchEvent(commandClick);
    });
    expect(commandClick.defaultPrevented).toBe(false);
    expect(onPlanSelect).not.toHaveBeenCalled();
    expect(onRepoHomeSelect).not.toHaveBeenCalled();

    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    await act(async () => {
      link?.dispatchEvent(contextMenu);
    });
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(onPlanSelect).not.toHaveBeenCalled();
    expect(onRepoHomeSelect).not.toHaveBeenCalled();

    act(() => {
      root?.unmount();
    });
    root = null;
  });
});
