import { describe, expect, it } from "vitest";
import type { Artifact } from "../../api/coordination/types";
import {
  groupPlansByStatus,
} from "../plan-artifacts";

const BASE_BODY = {
  markdown: "## Summary\n\n{}",
};

function createArtifact(overrides: Partial<Artifact> & Pick<Artifact, "id" | "type" | "createdAt">): Artifact {
  return {
    id: overrides.id,
    repoId: "repo-1",
    type: overrides.type,
    basis: overrides.basis ?? {
      repoId: "repo-1",
      mainCommit: "commit-1",
    },
    title: overrides.title ?? "Artifact",
    body: overrides.body ?? BASE_BODY,
    createdAt: overrides.createdAt,
    ...(overrides.status ? { status: overrides.status } : {}),
    ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides.version ? { version: overrides.version } : {}),
    ...(overrides.parentArtifactId ? { parentArtifactId: overrides.parentArtifactId } : {}),
    ...(overrides.supersedesArtifactId ? { supersedesArtifactId: overrides.supersedesArtifactId } : {}),
  };
}

describe("plan artifact selectors", () => {
  it("groups plans by mutable status newest first", () => {
    const artifacts: Artifact[] = [
      createArtifact({
        id: "todo-old",
        type: "plan",
        status: "todo",
        updatedAt: "2026-03-29T00:00:00.000Z",
        createdAt: "2026-03-29T00:00:00.000Z",
      }),
      createArtifact({
        id: "todo-new",
        type: "plan",
        status: "todo",
        updatedAt: "2026-03-29T00:02:00.000Z",
        createdAt: "2026-03-29T00:01:00.000Z",
      }),
      createArtifact({
        id: "evaluating",
        type: "plan",
        status: "evaluating",
        updatedAt: "2026-03-29T00:04:00.000Z",
        createdAt: "2026-03-29T00:04:00.000Z",
      }),
      createArtifact({
        id: "archived",
        type: "plan",
        status: "archived",
        createdAt: "2026-03-29T00:03:00.000Z",
      }),
    ];

    const grouped = groupPlansByStatus(artifacts);
    expect(grouped.evaluating.map((artifact) => artifact.id)).toEqual(["evaluating"]);
    expect(grouped.todo.map((artifact) => artifact.id)).toEqual(["todo-new", "todo-old"]);
    expect(grouped.archived.map((artifact) => artifact.id)).toEqual(["archived"]);
  });
});
