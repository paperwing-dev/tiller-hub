import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectsHome from "../ProjectsHome";

(globalThis as typeof globalThis & { React?: typeof React }).React = React;

function render(dismissed: boolean): string {
  return renderToString(
    <ProjectsHome
      repos={[]}
      envs={[]}
      hubUrl="https://tiller.example.workers.dev"
      onboarding={{
        dismissed,
        modelReady: false,
        executionReady: true,
        machineReady: false,
      }}
      onDismissOnboarding={vi.fn(async () => undefined)}
      onOpenSettings={vi.fn()}
      onAddProject={vi.fn()}
      onOpenProject={vi.fn()}
      onProjectDeleted={vi.fn()}
    />,
  );
}

describe("optional dashboard onboarding", () => {
  it("shows derived readiness and can be dismissed", () => {
    const html = render(false);
    expect(html).toContain("Finish setting up Tiller");
    expect(html).toContain("These choices are optional");
    expect(html).toContain("Model access: <!-- -->optional");
    expect(html).toContain("Execution: <!-- -->ready");
    expect(html).toContain("Machine: <!-- -->optional");
    expect(html).toContain("Dismiss");
  });

  it("stays hidden after persisted dismissal", () => {
    expect(render(true)).not.toContain("Finish setting up Tiller");
  });
});
