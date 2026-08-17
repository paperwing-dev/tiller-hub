/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRoute, AgentSkillDefinition } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    createAgentSkill: vi.fn(),
    deleteAgentSkill: vi.fn(),
    updateAgentSkill: vi.fn(),
  };
});

const { default: SkillEditorDialog } = await import("../SkillEditorDialog");

afterEach(() => cleanup());

const health: AgentSkillDefinition = {
  id: "plan-health",
  surface: "plan",
  command: "health",
  label: "Plan Health",
  description: "Assess the current plan's risk and change size, then update its hover details with both values.",
  sharedInstructions: "",
  overviewInstructions: "",
  overviewMode: "manual",
  agents: [
    {
      id: "plan-health-assessor",
      label: "Plan Health Assessor",
      routeKey: "codex:gpt-5.5",
      effort: "high",
      instructions: "Apply both Health rubrics.\n\nAssess both values independently.",
      reportMode: "manual",
    },
  ],
  origin: "builtin",
  customized: false,
  createdAt: null,
  updatedAt: null,
};

const route: AgentRoute = {
  key: "codex:gpt-5.5",
  label: "Codex · GPT-5.5",
  harness: "codex",
  provider: "codex-api",
  model: "gpt-5.5",
  modelId: "gpt-5.5",
  supportedEfforts: ["low", "medium", "high"],
  defaultEffort: "high",
  available: true,
};

const reviewSkill: AgentSkillDefinition = {
  ...health,
  id: "review-security",
  surface: "review",
  command: "security",
  label: "Security review",
  sharedInstructions: "Apply both Health rubrics.",
  overviewMode: "auto",
  origin: "custom",
  customized: true,
  agents: [
    {
      ...health.agents[0]!,
      id: "security-reviewer",
      label: "Security reviewer",
      instructions: "Assess both values independently.",
      reportMode: "manual",
    },
    {
      ...health.agents[0]!,
      id: "quality-reviewer",
      label: "Quality reviewer",
      instructions: "Assess both values independently.",
      reportMode: "auto",
    },
  ],
};

describe("SkillEditorDialog Plan Health controls", () => {
  it("keeps Health identity and one-agent automation fixed while exposing editable fields", async () => {
    const user = userEvent.setup();
    render(
      <SkillEditorDialog
        repoId="repo-1"
        surface="plan"
        open
        skills={[health]}
        routes={[route]}
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Command")).toHaveValue("health"),
    );

    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.queryByText("Workflows")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New skill" })).toHaveClass(
      "tiller-workflow-add",
    );
    const healthRow = screen.getByText("/health").closest("button");
    expect(healthRow).not.toBeNull();
    expect(within(healthRow!).getByText("Built-in")).toBeInTheDocument();
    expect(screen.getByLabelText("Command")).toBeDisabled();
    expect(screen.getByLabelText("Command").closest('[data-slot="input-group"]'))
      .toHaveClass("tiller-workflow-command");
    expect(screen.getByLabelText("Skill name")).toBeEnabled();
    expect(screen.getByLabelText("Skill name")).toHaveClass(
      "tiller-workflow-editable",
    );
    expect(screen.getByLabelText("Description")).toBeEnabled();
    expect(screen.queryByLabelText("Common instructions")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent 1 label")).toBeEnabled();
    expect(screen.getByLabelText("Agent 1 label")).toHaveClass(
      "tiller-workflow-tab-label",
    );
    expect(screen.getByLabelText("Plan Health Assessor model")).toBeEnabled();
    expect(screen.getByLabelText("Plan Health Assessor model")).toHaveClass(
      "tiller-workflow-select",
    );
    expect(
      screen.getByLabelText("Plan Health Assessor reasoning"),
    ).toBeEnabled();
    expect(screen.getByLabelText("Agent 1 instructions")).toHaveValue(
      "Apply both Health rubrics.\n\nAssess both values independently.",
    );

    expect(screen.getByRole("button", { name: "Add agent" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove agent 1" }),
    ).toBeDisabled();
    expect(
      screen.queryByLabelText("Overview instructions"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(/default report mode/i),
    ).not.toBeInTheDocument();
    const reset = screen.getByRole("button", { name: "Reset" });
    expect(reset).toBeEnabled();
    await user.hover(reset);
    expect(await screen.findByText(
      "Restore the built-in version of this skill and discard your custom changes.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save skill" })).toBeEnabled();
  });
});

describe("SkillEditorDialog review automation controls", () => {
  it("keeps Manual, Auto, and the switch visible before hover", async () => {
    render(
      <SkillEditorDialog
        repoId="repo-1"
        surface="review"
        open
        skills={[reviewSkill]}
        routes={[route]}
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    const toggle = await screen.findByRole("switch", {
      name: "Security reviewer default report mode",
    });
    expect(screen.queryByText("Built-in")).not.toBeInTheDocument();
    expect(toggle).toHaveClass("tiller-skill-automation-switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    const group = screen.getByRole("group", {
      name: "Security reviewer default report mode",
    });
    expect(within(group).getByText("Manual")).toHaveAttribute("data-selected", "true");
    expect(within(group).getByText("Auto")).toHaveAttribute("data-selected", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByText("Manual")).toHaveAttribute("data-selected", "false");
    expect(within(group).getByText("Auto")).toHaveAttribute("data-selected", "true");
    await waitFor(() => expect(
      screen.getByLabelText("Common instructions"),
    ).toHaveValue("Apply both Health rubrics."));
  });

  it("folds common instructions into the remaining reviewer when fanout becomes single-agent", async () => {
    const user = userEvent.setup();
    render(
      <SkillEditorDialog
        repoId="repo-1"
        surface="review"
        open
        skills={[reviewSkill]}
        routes={[route]}
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByLabelText("Common instructions");
    await user.click(screen.getByRole("button", { name: "Remove agent 2" }));

    expect(screen.queryByLabelText("Common instructions")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent 1 instructions")).toHaveValue(
      "Apply both Health rubrics.\n\nAssess both values independently.",
    );
  });
});
