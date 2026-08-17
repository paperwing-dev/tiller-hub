/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlanChatInput from "../PlanChatInput";
import type { AgentSkillDefinition } from "../api";

const skills: AgentSkillDefinition[] = [{
  id: "code-review",
  surface: "review",
  command: "code-review",
  label: "Code Review",
  description: "Run focused reviewers.",
  sharedInstructions: "Review the workspace.",
  overviewInstructions: "Deduplicate findings.",
  overviewMode: "auto",
  agents: ["bugs", "simplification", "plan"].map((id) => ({
    id,
    label: id,
    instructions: `Review ${id}.`,
    routeKey: "opencode:kimi-k2.7-code",
    effort: "high",
    reportMode: "auto",
  })),
  origin: "builtin",
  customized: false,
  createdAt: null,
  updatedAt: null,
}, {
  id: "security-review",
  surface: "review",
  command: "security-review",
  label: "Security Review",
  description: "Review trust boundaries.",
  sharedInstructions: "Review security.",
  overviewInstructions: "Prioritize concrete issues.",
  overviewMode: "auto",
  agents: [{
    id: "security",
    label: "Security",
    instructions: "Review security.",
    routeKey: "codex:gpt-5.5",
    effort: "high",
    reportMode: "manual",
  }],
  origin: "custom",
  customized: true,
  createdAt: null,
  updatedAt: null,
}];

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("PlanChatInput skill commands", () => {
  it("opens and filters the prototype-style slash popup", () => {
    render(<PlanChatInput placeholder="Message or type / for skills" onSend={vi.fn()} skills={skills} onInvokeSkill={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "/" } });
    expect(screen.getByRole("button", { name: /code-review/i })).toHaveTextContent("3 agents");
    expect(screen.getByText("Run focused reviewers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /security-review/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "/sec" } });
    expect(screen.queryByRole("button", { name: /code-review/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /security-review/i })).toBeInTheDocument();
  });

  it("invokes a skill by click and preserves the draft when invocation fails", async () => {
    const onInvokeSkill = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<PlanChatInput placeholder="Message" onSend={vi.fn()} skills={skills} onInvokeSkill={onInvokeSkill} />);
    const composer = screen.getByLabelText("Message");

    fireEvent.change(composer, { target: { value: "/code" } });
    fireEvent.click(screen.getByRole("button", { name: /code-review/i }));
    await waitFor(() => expect(onInvokeSkill).toHaveBeenCalledWith(skills[0]));
    expect(composer).toHaveValue("/code");

    fireEvent.click(screen.getByRole("button", { name: /code-review/i }));
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("invokes the matching command on Enter and sends ordinary text normally", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const onInvokeSkill = vi.fn().mockResolvedValue(true);
    render(<PlanChatInput placeholder="Message" onSend={onSend} skills={skills} onInvokeSkill={onInvokeSkill} />);
    const composer = screen.getByLabelText("Message");

    fireEvent.change(composer, { target: { value: "/code-review" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(onInvokeSkill).toHaveBeenCalledWith(skills[0]));
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: "Please inspect this" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Please inspect this"));
  });

  it("allows skill invocation while an ordinary message is blocked by a busy reviewer", async () => {
    const onSend = vi.fn();
    const onInvokeSkill = vi.fn().mockResolvedValue(true);
    render(
      <PlanChatInput
        busy
        busyPlaceholder="Run a /skill or wait"
        placeholder="Message"
        onSend={onSend}
        skills={skills}
        onInvokeSkill={onInvokeSkill}
      />,
    );
    const composer = screen.getByLabelText("Message");

    expect(composer).toHaveAttribute("placeholder", "Run a /skill or wait");
    fireEvent.change(composer, { target: { value: "ordinary message" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: "/security-review" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(onInvokeSkill).toHaveBeenCalledWith(skills[1]));
  });

  it("restores a scoped draft after remount and clears it after a successful send", async () => {
    const draftStorageKey = "tiller:test:reviewer-draft";
    const onSend = vi.fn().mockResolvedValue(true);
    const first = render(
      <PlanChatInput
        placeholder="Message"
        draftStorageKey={draftStorageKey}
        onSend={onSend}
      />,
    );

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Recovered after reload" } });
    expect(window.sessionStorage.getItem(draftStorageKey)).toBe("Recovered after reload");
    first.unmount();

    render(
      <PlanChatInput
        placeholder="Message"
        draftStorageKey={draftStorageKey}
        onSend={onSend}
      />,
    );
    const restored = screen.getByLabelText("Message");
    expect(restored).toHaveValue("Recovered after reload");

    fireEvent.keyDown(restored, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Recovered after reload"));
    expect(restored).toHaveValue("");
    expect(window.sessionStorage.getItem(draftStorageKey)).toBeNull();
  });

  it("keeps the durable draft while an optimistic send is unresolved", async () => {
    let resolveSend!: (result: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveSend = resolve;
    }));
    const draftStorageKey = "tiller:test:pending-reviewer-draft";
    render(
      <PlanChatInput
        placeholder="Message"
        draftStorageKey={draftStorageKey}
        optimisticClear
        onSend={onSend}
      />,
    );
    const composer = screen.getByLabelText("Message");
    fireEvent.change(composer, { target: { value: "Do not lose this" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(composer).toHaveValue("");
    expect(window.sessionStorage.getItem(draftStorageKey)).toBe("Do not lose this");

    resolveSend(true);
    await waitFor(() => expect(window.sessionStorage.getItem(draftStorageKey)).toBeNull());
  });
});
