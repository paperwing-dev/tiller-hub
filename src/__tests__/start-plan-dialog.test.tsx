/**
 * @vitest-environment jsdom
 */
import React, { act, type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "../../api/coordination/types";
import type { EnvMeta } from "../../api/types";
import { createInitialEnvScmState } from "../../api/scm/model";
import StartPlanDialog from "../StartPlanDialog";

const mocks = vi.hoisted(() => ({
  fetchRepoArtifacts: vi.fn(),
  startEnv: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchRepoArtifacts: mocks.fetchRepoArtifacts,
  startEnv: mocks.startEnv,
}));

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    status: "stopped",
    ...createInitialEnvScmState({
      slug: "demo-env",
      branchName: "tiller/demo-env",
      mainCommit: "main-a",
    }),
  };
  return Object.assign(env, overrides);
}

function makePlan(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "plan-1",
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-a" },
    title: "Specific saved plan",
    body: { markdown: "Do the work." },
    status: "draft",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("StartPlanDialog", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
  let container: HTMLDivElement;
  let root: Root | null;

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
    mocks.fetchRepoArtifacts.mockReset();
    mocks.startEnv.mockReset();
    mocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [makePlan()],
      refs: [],
    });
    mocks.startEnv.mockResolvedValue({ ok: true });
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

  async function renderDialog(
    env: EnvMeta,
    props: Partial<ComponentProps<typeof StartPlanDialog>> = {},
  ) {
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <StartPlanDialog
            env={env}
            repoMainCommit="main-a"
            hubUrl="https://hub.test"
            onClose={() => undefined}
            onStarted={() => undefined}
            hasAnthropicKey
            claudeBillingMode="api"
            openaiBillingMode="api"
            {...props}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
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

  it("renders no plan as read-only and starts without a plan selection body", async () => {
    await renderDialog(makeEnv());

    const text = document.body.textContent ?? "";
    expect(text).toContain("No plan");
    expect(text).not.toContain("Choose specific plan");
    expect(document.body.querySelector('input[type="radio"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Plan"]')).toBeNull();

    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    expect(startButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.startEnv).toHaveBeenCalledWith("https://hub.test", "demo-env", {
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
    });
  });

  it("renders the complete selected plan in a scrollable preview without selection controls", async () => {
    mocks.fetchRepoArtifacts.mockResolvedValueOnce({
      artifacts: [makePlan({
        body: { markdown: "# Overview\n\nDo the work.\n\n## Final section\n\nThis must remain visible in the full plan preview." },
      })],
      refs: [],
    });
    await renderDialog(makeEnv({ startupPlanId: "plan-1" }));

    const text = document.body.textContent ?? "";
    expect(text).toContain("Specific saved plan");
    expect(text).toContain("Do the work.");
    expect(text).toContain("This must remain visible in the full plan preview.");
    expect(text).not.toContain("Choose specific plan");
    expect(document.body.querySelector('input[type="radio"]')).toBeNull();

    const planBody = document.body.querySelector<HTMLElement>('[data-testid="start-plan-body"]');
    expect(planBody).toBeInstanceOf(HTMLElement);
    expect(planBody?.className).toContain("overflow-y-auto");
    expect(planBody?.className).not.toContain("line-clamp");

    const link = document.body.querySelector<HTMLAnchorElement>('a[href="/projects/repo-1/plan/plan-1"]');
    expect(link?.textContent).toContain("Specific saved plan");
  });

  it("prefills and submits the committed settings pair", async () => {
    await renderDialog(makeEnv({
      harnessSettings: { model: "claude-fable-5", effort: "max" },
    }));

    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("Fable 5");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("max");
    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.startEnv).toHaveBeenCalledWith("https://hub.test", "demo-env", {
      harnessSettings: { model: "claude-fable-5", effort: "max" },
    });
  });

  it("clamps to the target model's highest effort through the rendered selectors", async () => {
    await renderDialog(makeEnv({
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "ultra" },
    }), { hasOpenAIKey: true });

    await chooseSelectOption("Model", "GPT-5.5");
    expect(document.body.querySelector('[aria-label="Effort"]')?.textContent).toContain("xhigh");
    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.startEnv).toHaveBeenCalledWith("https://hub.test", "demo-env", {
      harnessSettings: { model: "gpt-5.5", effort: "xhigh" },
    });
  });

  it("keeps an unavailable committed model visible and blocks Start", async () => {
    await renderDialog(makeEnv({
      harness: "opencode",
      harnessSettings: { model: "gpt-5.5", effort: "high" },
    }), {
      hasAnthropicKey: false,
      hasOpenAIKey: false,
      workersAiConfigured: true,
    });

    expect(document.body.querySelector('[aria-label="Model"]')?.textContent).toContain("GPT-5.5");
    expect(document.body.textContent).toContain("Configure the active OpenAI API key");
    expect(document.body.querySelectorAll('[data-testid="harness-model-requirement"]')).toHaveLength(1);
    const settingsLink = document.body.querySelector<HTMLAnchorElement>('[data-testid="harness-model-requirement"] a');
    expect(settingsLink).toHaveAttribute("href", "/projects/repo-1/global-settings#openai-api-key");
    expect(settingsLink).toHaveAttribute("target", "_blank");
    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start") as HTMLButtonElement | undefined;
    expect(startButton?.disabled).toBe(true);
  });

  it("does not use the current machine candidate to gate an existing workload", async () => {
    await renderDialog(makeEnv({
      backend: "host",
      executionPlacement: { backend: "host", machineId: "machine-1" },
      harness: "codex",
      harnessSettings: { model: "gpt-5.5", effort: "high" },
    }), {
      hasAnthropicKey: false,
      hasChatGPTAuth: true,
      openaiBillingMode: "subscription",
      chatgptAuthStatus: "connected",
    });

    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start") as HTMLButtonElement | undefined;
    expect(startButton?.disabled).toBe(false);
  });

  it("keeps unavailable non-selected models visible and disabled", async () => {
    await renderDialog(makeEnv({
      harness: "opencode",
      harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
    }), {
      hasAnthropicKey: false,
      hasOpenAIKey: false,
      workersAiConfigured: true,
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

  it("clears a failed Start error when either model or effort changes", async () => {
    mocks.startEnv.mockRejectedValue(new Error("Start provider rejected the request"));
    await renderDialog(makeEnv({
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    }), {
      hasAnthropicKey: false,
      hasOpenAIKey: true,
    });

    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Start provider rejected the request");

    await chooseSelectOption("Model", "GPT-5.5");
    expect(document.body.textContent).not.toContain("Start provider rejected the request");

    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Start provider rejected the request");

    await chooseSelectOption("Effort", "high");
    expect(document.body.textContent).not.toContain("Start provider rejected the request");
  });

  it("keeps a startup-plan loading error visible when the model selection changes", async () => {
    mocks.fetchRepoArtifacts.mockRejectedValueOnce(new Error("Saved plan could not be loaded"));
    await renderDialog(makeEnv({
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      startupPlanId: "plan-1",
    }), {
      hasAnthropicKey: false,
      hasOpenAIKey: true,
    });

    expect(document.body.textContent).toContain("Saved plan could not be loaded");
    await chooseSelectOption("Model", "GPT-5.5");
    expect(document.body.textContent).toContain("Saved plan could not be loaded");
  });

  it("omits Sol downgrade guidance and preserves the original provider error without retry", async () => {
    mocks.startEnv.mockRejectedValueOnce(new Error("Sol capacity unavailable for this account"));
    await renderDialog(makeEnv({
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    }), {
      hasAnthropicKey: false,
      hasOpenAIKey: true,
    });

    expect(document.body.textContent).not.toContain("Tiller will not downgrade or retry automatically");
    const startButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Start");
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.startEnv).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Sol capacity unavailable for this account");
  });

  it.each(["stopped", "unknown", "failed"] as const)(
    "exposes editable settings for a %s environment",
    async (status) => {
      await renderDialog(makeEnv({ status }));

      expect(document.body.querySelector('[aria-label="Model"]')).not.toBeNull();
      expect(document.body.querySelector('[aria-label="Effort"]')).not.toBeNull();
      const startButton = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent === "Start") as HTMLButtonElement | undefined;
      expect(startButton?.disabled).toBe(false);
    },
  );

  it.each(["creating", "starting", "running", "saving", "stopping", "deleting"] as const)(
    "does not expose editable settings for a %s environment",
    async (status) => {
      await renderDialog(makeEnv({ status }));

      expect(document.body.querySelector('[aria-label="Model"]')).toBeNull();
      expect(document.body.querySelector('[aria-label="Effort"]')).toBeNull();
      const startButton = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent === "Start") as HTMLButtonElement | undefined;
      expect(startButton?.disabled).toBe(true);
    },
  );

  it("discards local dialog state on cancellation without starting", async () => {
    const onClose = vi.fn();
    await renderDialog(makeEnv(), { onClose });
    const cancelButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel");
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.startEnv).not.toHaveBeenCalled();
  });
});
