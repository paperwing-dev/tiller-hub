/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import userEvent from "@testing-library/user-event";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepositorySelection } from "../api";
import type { Artifact } from "../../api/coordination/types";
import type { RepoMeta } from "../../api/types";

const useGitHubRepositoriesMock = vi.hoisted(() => vi.fn());
const apiMocks = vi.hoisted(() => ({
  fetchExecutionStatus: vi.fn(),
  fetchRepoArtifacts: vi.fn(),
}));

vi.mock("../useGitHubRepositories", () => ({
  githubRepositoryKey: (selection: { installationId: number; repositoryId: number }) =>
    `${selection.installationId}:${selection.repositoryId}`,
  useGitHubRepositories: useGitHubRepositoriesMock,
}));

vi.mock("../api", () => ({
  fetchExecutionStatus: apiMocks.fetchExecutionStatus,
  fetchRepoArtifacts: apiMocks.fetchRepoArtifacts,
}));

import {
  getInitialEnvHarnessSelection,
  getNewEnvHarnessDefault,
  getRepositoryPagination,
  getScheduledRunRequirementError,
  LAST_ENV_HARNESS_STORAGE_KEY,
  NewEnvDialog,
  NewRepoDialog,
  REPOSITORY_PAGE_SIZE,
} from "../NewEnvDialog";

const repo: RepoMeta = {
  repoId: "repo-1",
  artifactStoreGeneration: null,
  repoUrl: "https://github.com/example/repo",
  scmModel: "github",
  githubInstallationId: 7,
  githubFullName: "example/repo",
  githubDefaultBranch: "main",
  githubDefaultBranchHeadSha: "main-sha",
  githubWebhookConfigured: true,
  githubWebhookError: null,
  mainCommit: "main-sha",
  gitArtifactId: null,
  gitStatus: "ready",
  gitError: null,
  gitFormatVersion: 1,
  gitProgressPhase: null,
  gitProgressStartedAt: null,
  gitProgressUpdatedAt: null,
  gitLastBootstrapDurationMs: null,
  gitLastBootstrapTimings: null,
  createdAt: "2026-04-13T00:00:00.000Z",
  updatedAt: "2026-04-13T00:00:00.000Z",
  bootstrappedFromRef: "HEAD",
};

function makePlan(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "plan-1",
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-sha" },
    title: "Checkout polish plan",
    body: { markdown: "Make checkout better." },
    status: "todo",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

function makeGitHubRepository(index: number): GitHubRepositorySelection {
  const name = `repo-${String(index).padStart(2, "0")}`;
  return {
    repositoryId: index,
    installationId: 7,
    fullName: `owner/${name}`,
    repoUrl: `https://github.com/owner/${name}`,
    private: false,
    defaultBranch: "main",
  };
}

describe("getInitialEnvHarnessSelection", () => {
  it("prefers the last enabled harness and otherwise falls back to Open Code", () => {
    expect(getInitialEnvHarnessSelection(["claude-code", "codex", "opencode"], "codex")).toBe("codex");
    expect(getInitialEnvHarnessSelection(["claude-code", "opencode"], "codex")).toBe("opencode");
    expect(getInitialEnvHarnessSelection(["claude-code", "opencode"], "unknown")).toBe("opencode");
    expect(getInitialEnvHarnessSelection(["claude-code", "codex", "opencode"])).toBe("opencode");
    expect(getInitialEnvHarnessSelection(["claude-code", "codex"])).toBe("claude-code");
    expect(getNewEnvHarnessDefault("opencode")).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
    expect(getNewEnvHarnessDefault("opencode", "cf", {
      hasOpenAIKey: false,
      openaiBillingMode: "api",
      workersAiConfigured: true,
    })).toEqual({ model: "kimi-k2.7-code", effort: "high" });
    expect(getNewEnvHarnessDefault("opencode", "cf", {
      hasOpenAIKey: true,
      openaiBillingMode: "api",
      workersAiConfigured: true,
    })).toEqual({ model: "gpt-5.6-sol", effort: "xhigh" });
  });
});

describe("getScheduledRunRequirementError", () => {
  const ready = {
    harness: "codex" as const,
    executionReady: true,
    openaiBillingMode: "subscription" as const,
    hasOpenAIKey: false,
    chatgptAuthStatus: "connected" as const,
  };

  it("keeps scheduler eligibility aligned with the selected backend and billing mode", () => {
    expect(getScheduledRunRequirementError({ ...ready, executionReady: false }))
      .toContain("selected execution backend is unavailable");
    expect(getScheduledRunRequirementError({ ...ready, harness: "claude-code" })).toContain("Codex harness");
    expect(getScheduledRunRequirementError({ ...ready, chatgptAuthStatus: "needs_reconnect" })).toContain("subscription authentication");
    expect(getScheduledRunRequirementError({
      ...ready,
      chatgptAuthStatus: "needs_reconnect",
      hasOpenAIKey: true,
    })).toContain("subscription authentication");
    expect(getScheduledRunRequirementError({
      ...ready,
      openaiBillingMode: "api",
      chatgptAuthStatus: "missing",
      hasOpenAIKey: true,
    })).toBeNull();
    expect(getScheduledRunRequirementError(ready)).toBeNull();
    expect(getScheduledRunRequirementError({ ...ready, chatgptAuthStatus: "refreshing" })).toBeNull();
  });
});

describe("getRepositoryPagination", () => {
  it("clamps pages and reports the displayed item range", () => {
    expect(getRepositoryPagination(26, 99)).toEqual({
      page: 6,
      totalPages: 6,
      startIndex: 25,
      endIndex: 26,
      hasPrevious: true,
      hasNext: false,
    });
    expect(getRepositoryPagination(0, 3)).toEqual({
      page: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: 0,
      hasPrevious: false,
      hasNext: false,
    });
  });
});

// Kumo dialogs render through a portal into document.body, so the rendering
// tests below mount with createRoot and assert against the live document.
const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
let container: HTMLDivElement;
let root: Root | null = null;

function setupDom() {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
    document.body.innerHTML = "";
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button"))
    .find((button) => button.textContent === text);
}

async function chooseSelectOption(label: string, optionText: string): Promise<void> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const trigger = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();
  await act(async () => {
    await user.click(trigger!);
  });
  const option = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((candidate) => candidate.textContent?.startsWith(optionText));
  expect(option).not.toBeUndefined();
  await act(async () => {
    await user.click(option!);
  });
}

async function openSelectOptions(label: string): Promise<HTMLElement[]> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const trigger = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();
  await act(async () => {
    await user.click(trigger!);
  });
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));
}

function isDisabledOption(option: HTMLElement): boolean {
  return option.getAttribute("aria-disabled") === "true" || option.hasAttribute("data-disabled");
}

describe("NewRepoDialog", () => {
  setupDom();

  beforeEach(() => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: [],
      warnings: [],
      repositorySelection: "unknown",
      loading: false,
      error: null,
    });
  });

  it("links to fixed GitHub access management in a new tab and closes the dialog", async () => {
    const onClose = vi.fn();
    act(() => {
      root?.render(
        <NewRepoDialog
          onClose={onClose}
          hubUrl="http://localhost:5173"
          repos={[]}
          githubAppConfigured
          onCreate={vi.fn(async () => undefined)}
        />,
      );
    });

    const link = Array.from(document.body.querySelectorAll<HTMLAnchorElement>("a"))
      .find((candidate) => candidate.textContent === "Manage GitHub access");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link).toHaveAttribute("href", "/api/github/manage");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveClass("tiller-github-access-button");

    await act(async () => {
      await userEvent.setup({ pointerEventsCheck: 0 }).click(link!);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("links an unconfigured Hub to GitHub App setup", () => {
    act(() => {
      root?.render(
        <NewRepoDialog
          onClose={vi.fn()}
          hubUrl="http://localhost:5173"
          repos={[]}
          githubAppConfigured={false}
          onCreate={vi.fn(async () => undefined)}
        />,
      );
    });

    const link = Array.from(document.body.querySelectorAll<HTMLAnchorElement>("a"))
      .find((candidate) => candidate.textContent === "Set up GitHub access");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    expect(link).toHaveAttribute("href", "/api/github/manifest/setup");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("renders only the first page of selected repositories with pagination controls", () => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: Array.from({ length: REPOSITORY_PAGE_SIZE + 1 }, (_, index) => makeGitHubRepository(index + 1)),
      warnings: [],
      repositorySelection: "selected",
      loading: false,
      error: null,
    });

    act(() => {
      root?.render(
        <NewRepoDialog
          onClose={vi.fn()}
          hubUrl="https://hub.example.com"
          repos={[]}
          githubAppConfigured
          onCreate={vi.fn(async () => undefined)}
        />,
      );
    });

    const text = bodyText();
    expect(text).toContain("owner/repo-01");
    expect(text).toContain("owner/repo-05");
    expect(text).not.toContain("owner/repo-06");
    expect(text).toContain("1-5 of 6");
    expect(text).toContain("Page 1 of 2");
    expect(findButtonByText("Previous")).toBeInstanceOf(HTMLButtonElement);
    expect(findButtonByText("Next")).toBeInstanceOf(HTMLButtonElement);
  });

  it("hides pagination controls when the filtered repository list fits on one page", () => {
    useGitHubRepositoriesMock.mockReturnValue({
      repositories: Array.from({ length: REPOSITORY_PAGE_SIZE }, (_, index) => makeGitHubRepository(index + 1)),
      warnings: [],
      repositorySelection: "selected",
      loading: false,
      error: null,
    });

    act(() => {
      root?.render(
        <NewRepoDialog
          onClose={vi.fn()}
          hubUrl="https://hub.example.com"
          repos={[]}
          githubAppConfigured
          onCreate={vi.fn(async () => undefined)}
        />,
      );
    });

    const text = bodyText();
    expect(text).not.toContain("Page 1 of 1");
    expect(text).not.toContain("1-5 of 5");
  });
});

describe("NewEnvDialog", () => {
  setupDom();

  beforeEach(() => {
    window.localStorage.removeItem(LAST_ENV_HARNESS_STORAGE_KEY);
    apiMocks.fetchExecutionStatus.mockReset();
    apiMocks.fetchExecutionStatus.mockResolvedValue({
      selected: { target: "cf" },
      selectedHost: null,
      candidate: { state: "not_connected" },
      executionReady: true,
    });
    apiMocks.fetchRepoArtifacts.mockReset();
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [makePlan()],
      refs: [],
    });
  });

  function renderNewEnvDialog(props: Partial<React.ComponentProps<typeof NewEnvDialog>> = {}) {
    act(() => {
      root?.render(
        <NewEnvDialog
          onClose={vi.fn()}
          hubUrl="https://hub.example.com"
          enabledHarnesses={["codex", "claude-code", "opencode"]}
          claudeBillingMode="api"
          openaiBillingMode="api"
          repo={repo}
          onCreate={vi.fn(async () => undefined)}
          {...props}
        />,
      );
    });
  }

  it("does not expose a per-workload execution backend control", () => {
    renderNewEnvDialog({ hasOpenAIKey: true });

    const backendTrigger = document.body.querySelector('[aria-label="Execution Backend"]');
    expect(backendTrigger).toBeNull();
    expect(bodyText()).not.toContain("Cloudflare Containers");
    expect(bodyText()).not.toContain("Your machine");
  });

  it("hides the Codex auth selector when auth is configured", () => {
    renderNewEnvDialog({ hasOpenAIKey: true, enabledHarnesses: ["codex"] });

    const text = bodyText();
    expect(text).not.toContain("Codex Auth");
    expect(text).not.toContain("choose auth automatically");
  });

  it("hides the Codex auth selector when API key auth is configured", () => {
    renderNewEnvDialog({ hasOpenAIKey: true, enabledHarnesses: ["codex"] });

    const text = bodyText();
    expect(text).not.toContain("Codex Auth");
    expect(text).not.toContain("uses OPENAI_API_KEY");
  });

  it("links a blocking credential error to the exact settings row without disabling harness selection", async () => {
    const onRefreshSetupStatus = vi.fn(async () => undefined);
    renderNewEnvDialog({ onRefreshSetupStatus });

    expect(bodyText()).toContain("Configure the active OpenAI API key");
    expect(document.body.querySelectorAll('[data-testid="harness-model-requirement"]')).toHaveLength(1);
    const settingsLink = document.body.querySelector<HTMLAnchorElement>('[data-testid="harness-model-requirement"] a');
    expect(settingsLink).toHaveAttribute("href", "/projects/repo-1/global-settings#openai-api-key");
    expect(settingsLink).toHaveAttribute("target", "_blank");
    expect(settingsLink).toHaveAttribute("rel", "noreferrer");

    act(() => {
      settingsLink?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(onRefreshSetupStatus).toHaveBeenCalledOnce();

    const harnessTrigger = document.body.querySelector<HTMLElement>('[aria-label="Harness"]');
    expect(harnessTrigger).not.toBeNull();
    expect(harnessTrigger?.getAttribute("disabled")).toBeNull();
    expect(harnessTrigger?.getAttribute("aria-disabled")).not.toBe("true");

    const submitButton = findButtonByText("Create");
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);
    expect(submitButton?.disabled).toBe(true);
  });

  it("links an incompatible API model to the billing-mode selector", () => {
    renderNewEnvDialog({
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
      openaiBillingMode: "subscription",
    });

    const settingsLink = document.body.querySelector<HTMLAnchorElement>('[data-testid="harness-model-requirement"] a');
    expect(settingsLink).toHaveAttribute("href", "/projects/repo-1/global-settings#openai-billing");
    expect(settingsLink?.textContent).toContain("Open OpenAI billing settings");
  });

  it("keeps unavailable non-selected models visible and disabled", async () => {
    renderNewEnvDialog({
      enabledHarnesses: ["opencode"],
      workersAiConfigured: true,
      hasOpenAIKey: false,
    });

    const options = await openSelectOptions("Model");
    const sol = options.find((option) => option.textContent?.startsWith("GPT-5.6 Sol"));
    const gpt55 = options.find((option) => option.textContent?.startsWith("GPT-5.5"));
    const kimi = options.find((option) => option.textContent?.startsWith("Kimi K2.7 Code"));

    expect(sol?.textContent).toContain("Configure the active OpenAI API key");
    expect(gpt55?.textContent).toContain("Configure the active OpenAI API key");
    expect(isDisabledOption(sol!)).toBe(true);
    expect(isDisabledOption(gpt55!)).toBe(true);
    expect(isDisabledOption(kimi!)).toBe(false);
  });

  it("defaults to the only model available for the selected harness", () => {
    renderNewEnvDialog({
      enabledHarnesses: ["opencode"],
      workersAiConfigured: true,
      hasOpenAIKey: false,
    });

    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("Kimi K2.7 Code");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("high");
    expect(document.body.querySelector('[data-testid="harness-model-requirement"]')).toBeNull();
  });

  it("clears a failed Create error when either model or effort changes", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("Create provider rejected the request");
    });
    renderNewEnvDialog({ hasOpenAIKey: true, onCreate });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bodyText()).toContain("Create provider rejected the request");

    await chooseSelectOption("Model", "GPT-5.5");
    expect(bodyText()).not.toContain("Create provider rejected the request");

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bodyText()).toContain("Create provider rejected the request");

    await chooseSelectOption("Effort", "high");
    expect(bodyText()).not.toContain("Create provider rejected the request");
    expect(window.localStorage.getItem(LAST_ENV_HARNESS_STORAGE_KEY)).toBeNull();
  });

  it("defaults to Open Code with GPT-5.6 and renders compact Model and Effort selectors", () => {
    renderNewEnvDialog({ hasOpenAIKey: true });

    const harness = document.body.querySelector('[aria-label="Harness"]');
    const model = document.body.querySelector('[aria-label="Model"]');
    const effort = document.body.querySelector('[aria-label="Effort"]');
    expect(harness?.textContent).toContain("Open Code");
    expect(model?.textContent).toContain("GPT-5.6 Sol");
    expect(effort?.textContent).toContain("xhigh");
    expect(harness!.compareDocumentPosition(model as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model!.compareDocumentPosition(effort as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bodyText()).not.toContain("Tiller will not downgrade or retry automatically");
    expect(document.body.querySelector('[role="dialog"]')).toHaveClass(
      "h-[calc(100vh-2rem)]",
      "max-h-[52rem]",
      "max-w-3xl",
      "sm:w-[calc(100vw-2rem)]",
    );
  });

  it("defaults to the last successfully used harness", () => {
    window.localStorage.setItem(LAST_ENV_HARNESS_STORAGE_KEY, "codex");
    renderNewEnvDialog({ hasOpenAIKey: true });

    expect(document.body.querySelector('[aria-label="Harness"]')?.textContent).toContain("Codex");
  });

  it("retains a supported effort when the rendered model selection changes", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, onCreate });

    await chooseSelectOption("Model", "GPT-5.5");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("xhigh");
    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "none" },
      harnessSettings: { model: "gpt-5.5", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("updates the harness and its catalog default together when multiple models are available", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, hasAnthropicKey: true, onCreate });

    await chooseSelectOption("Harness", "Claude Code");
    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("Opus 4.8");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("xhigh");
    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({
      harness: "claude-code",
      planSelection: { mode: "none" },
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
      schedule: undefined,
    });
    expect(window.localStorage.getItem(LAST_ENV_HARNESS_STORAGE_KEY)).toBe("claude-code");
  });

  it("updates a changed harness to its only available model", async () => {
    window.localStorage.setItem(LAST_ENV_HARNESS_STORAGE_KEY, "codex");
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({
      enabledHarnesses: ["codex", "opencode"],
      workersAiConfigured: true,
      hasOpenAIKey: false,
      onCreate,
    });

    await chooseSelectOption("Harness", "Open Code");
    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("Kimi K2.7 Code");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("high");
    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "none" },
      harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
      schedule: undefined,
    });
    expect(window.localStorage.getItem(LAST_ENV_HARNESS_STORAGE_KEY)).toBe("opencode");
  });

  it("hides Fast mode for new Codex implementors", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({
      enabledHarnesses: ["codex"],
      hasOpenAIKey: true,
      onCreate,
    });

    const fastMode = document.body.querySelector<HTMLInputElement>('input[aria-label="Fast mode"]');
    expect(fastMode).toBeNull();
    expect(bodyText()).not.toContain("Runs the selected model faster at a higher usage rate.");

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "codex",
      planSelection: { mode: "none" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("hides Fast mode for new Claude Code Opus implementors", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({
      enabledHarnesses: ["claude-code"],
      claudeBillingMode: "subscription",
      hasClaudeSubscription: true,
      onCreate,
    });

    const fastMode = document.body.querySelector<HTMLInputElement>('input[aria-label="Fast mode"]');
    expect(fastMode).toBeNull();

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "claude-code",
      planSelection: { mode: "none" },
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("does not offer Fast mode for OpenCode implementors", () => {
    renderNewEnvDialog({ enabledHarnesses: ["opencode"], hasOpenAIKey: true });
    expect(document.body.querySelector('input[aria-label="Fast mode"]')).toBeNull();
  });

  it("removes Fast mode when a Claude Code implementor selects an unsupported model", async () => {
    renderNewEnvDialog({
      enabledHarnesses: ["claude-code"],
      claudeBillingMode: "api",
      hasAnthropicKey: true,
    });

    await chooseSelectOption("Model", "Fable 5");
    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("Fable 5");
    expect(document.body.querySelector('input[aria-label="Fast mode"]')).toBeNull();
  });

  it("closes without remembering a harness when Create is cancelled", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, hasAnthropicKey: true, onClose, onCreate });

    await chooseSelectOption("Harness", "Claude Code");

    await act(async () => {
      findButtonByText("Cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LAST_ENV_HARNESS_STORAGE_KEY)).toBeNull();
  });

  it("defaults startup plan selection to no plan", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, onCreate });

    await act(async () => {
      await Promise.resolve();
    });

    const noPlanRadio = document.body.querySelector<HTMLInputElement>('input[name="new-env-plan-choice-repo-1"][value="none"]');
    expect(noPlanRadio?.checked).toBe(true);

    const submitButton = findButtonByText("Create");
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "none" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("removes startup plan selection from Start Fresh", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, hideStartupPlan: true, onCreate });

    expect(bodyText()).not.toContain("Startup Plan");
    expect(document.body.querySelector('[aria-label="Startup Plan"]')).toBeNull();
    expect(apiMocks.fetchRepoArtifacts).not.toHaveBeenCalled();

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "none" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("removes the no-plan choice from the Start With Plan modal", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({
      hasOpenAIKey: true,
      initialPlanChoice: "specific",
      onCreate,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(bodyText()).not.toContain("No plan");
    expect(bodyText()).toContain("Plan to implement");
    expect(document.body.querySelector('input[name="new-env-plan-choice-repo-1"]')).toBeNull();

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      planSelection: { mode: "specific", artifactId: "plan-1" },
    }));
  });

  it("submits a selected saved startup plan", async () => {
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, onCreate });

    await act(async () => {
      await Promise.resolve();
    });

    const specificRadio = document.body.querySelector<HTMLInputElement>('input[name="new-env-plan-choice-repo-1"][value="specific"]');
    expect(specificRadio).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      specificRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(bodyText()).toContain("Checkout polish plan");

    const submitButton = findButtonByText("Create");
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "specific", artifactId: "plan-1" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("wraps long selected plan titles in the selector and preview", async () => {
    const longTitle = `Long plan title ${"unbroken".repeat(30)}`;
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [makePlan({ title: longTitle })],
      refs: [],
    });
    renderNewEnvDialog({ hasOpenAIKey: true });

    await act(async () => {
      await Promise.resolve();
    });

    const specificRadio = document.body.querySelector<HTMLInputElement>(
      'input[name="new-env-plan-choice-repo-1"][value="specific"]',
    );
    await act(async () => {
      specificRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const planTrigger = document.body.querySelector<HTMLElement>('[aria-label="Startup Plan"]');
    expect(planTrigger).toHaveClass("h-auto", "min-h-6.5");
    expect(planTrigger?.querySelector(".break-words")).toHaveTextContent(longTitle);

    const selectedTitle = document.body.querySelector<HTMLElement>('[data-testid="selected-plan-title"]');
    expect(selectedTitle).toHaveClass("whitespace-normal", "break-words");
    expect(selectedTitle).toHaveTextContent(longTitle);
  });

  it("hides scheduling for a selected startup plan", async () => {
    const onCreate = vi.fn(async () => undefined);
    apiMocks.fetchExecutionStatus.mockResolvedValue({
      selected: { target: "host", machineId: "machine-1" },
      selectedHost: { state: "ready", machineId: "machine-1", displayName: "studio-mac" },
      candidate: { state: "ready", machineId: "machine-1", displayName: "studio-mac" },
      executionReady: true,
    });
    renderNewEnvDialog({
      hasChatGPTAuth: true,
      chatgptAuthStatus: "connected",
      enabledHarnesses: ["codex"],
      openaiBillingMode: "subscription",
      onCreate,
    });

    await act(async () => {
      await Promise.resolve();
    });
    const specificRadio = document.body.querySelector<HTMLInputElement>(
      'input[name="new-env-plan-choice-repo-1"][value="specific"]',
    );
    await act(async () => {
      specificRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.querySelector('input[aria-label="Fast mode"]')).toBeNull();
    expect(bodyText()).not.toContain("Schedule: run tonight at 3:00 AM");
    expect(findButtonByText("Schedule")).toBeUndefined();

    await act(async () => {
      findButtonByText("Create")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "codex",
      planSelection: { mode: "specific", artifactId: "plan-1" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });

  it("only offers To do plans for startup selection", async () => {
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [
        makePlan({
          id: "draft-plan",
          title: "Draft plan",
          status: "draft",
          updatedAt: "2026-04-16T00:00:00.000Z",
        }),
        makePlan({
          id: "completed-plan",
          title: "Completed plan",
          status: "completed",
          updatedAt: "2026-04-15T00:00:00.000Z",
        }),
        makePlan({
          id: "todo-plan",
          title: "Todo plan",
          status: "todo",
          body: { markdown: "# Todo plan\n\n- Step one" },
          updatedAt: "2026-04-14T00:00:00.000Z",
        }),
      ],
      refs: [],
    });
    const onCreate = vi.fn(async () => undefined);
    renderNewEnvDialog({ hasOpenAIKey: true, onCreate });

    await act(async () => {
      await Promise.resolve();
    });

    const specificRadio = document.body.querySelector<HTMLInputElement>('input[name="new-env-plan-choice-repo-1"][value="specific"]');
    await act(async () => {
      specificRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const text = bodyText();
    expect(text).toContain("Todo plan");
    expect(text).toContain("Step one");
    expect(text).not.toContain("Draft plan");
    expect(text).not.toContain("Completed plan");
    expect(text).toContain("Select from Plans to Do");
    expect(text).not.toContain("Choose specific plan");
    expect(document.body.querySelector("h1")?.textContent).toBe("Todo plan");
    expect(document.body.querySelector("li")?.textContent).toBe("Step one");

    const submitButton = findButtonByText("Create");
    await act(async () => {
      submitButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreate).toHaveBeenCalledWith({
      harness: "opencode",
      planSelection: { mode: "specific", artifactId: "todo-plan" },
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      schedule: undefined,
    });
  });
});
