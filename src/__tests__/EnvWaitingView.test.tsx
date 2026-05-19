import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EnvMeta } from "../../api/types";
import { createInitialEnvScmState } from "../../api/scm/model";
import EnvWaitingView from "../EnvWaitingView";

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    status: "saving",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-old",
    }),
    ...overrides,
  };
}

describe("EnvWaitingView", () => {
  it("does not claim the container is stopped while workspace changes are saving", () => {
    const markup = renderToStaticMarkup(
      <EnvWaitingView env={makeEnv({ status: "saving" })} hubUrl="https://hub.test" />,
    );

    expect(markup).toContain("Saving changes...");
    expect(markup).toContain("Persisting workspace changes before shutdown");
    expect(markup).not.toContain("Container is stopped");
  });

  it("distinguishes stopping from the save phase after workspace persistence completes", () => {
    const markup = renderToStaticMarkup(
      <EnvWaitingView env={makeEnv({ status: "stopping" })} hubUrl="https://hub.test" />,
    );

    expect(markup).toContain("Stopping...");
    expect(markup).toContain("Workspace saved. Waiting for the container to stop");
    expect(markup).not.toContain("Container is stopped");
  });
});
