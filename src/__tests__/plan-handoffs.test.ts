import { describe, expect, it } from "vitest";
import type { Artifact } from "../../api/coordination/types";
import {
  groupPlansByStatus,
  listCurrentPlanDraftArtifacts,
  listReviewArtifactsForDraft,
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

describe("listReviewArtifactsForDraft", () => {
  it("returns reviews for the selected draft newest first", () => {
    const artifacts: Artifact[] = [
      createArtifact({
        id: "review-active",
        type: "review",
        title: "Review active",
        createdAt: "2026-03-29T00:00:00.000Z",
        parentArtifactId: "draft-1",
      }),
      createArtifact({
        id: "review-newer",
        type: "review",
        title: "Review newer",
        createdAt: "2026-03-29T00:01:00.000Z",
        parentArtifactId: "draft-1",
      }),
      createArtifact({
        id: "review-other",
        type: "review",
        title: "Review other",
        createdAt: "2026-03-29T00:02:00.000Z",
        parentArtifactId: "draft-2",
      }),
    ];

    expect(listReviewArtifactsForDraft(artifacts, "draft-1").map((artifact) => artifact.id)).toEqual([
      "review-newer",
      "review-active",
    ]);
  });
});

describe("plan artifact selectors", () => {
  it("hides drafts missing their canonical main commit from active draft lists", () => {
    const artifacts: Artifact[] = [
      createArtifact({
        id: "draft-current",
        type: "plan",
        title: "Current draft",
        createdAt: "2026-03-29T00:00:00.000Z",
        basis: { repoId: "repo-1", mainCommit: "commit-2" },
      }),
      createArtifact({
        id: "draft-missing-main",
        type: "plan",
        title: "Missing main",
        createdAt: "2026-03-29T00:01:00.000Z",
        basis: { repoId: "repo-1", mainCommit: null },
      }),
      createArtifact({
        id: "draft-missing-main-2",
        type: "plan",
        title: "Missing main 2",
        createdAt: "2026-03-29T00:02:00.000Z",
        basis: { repoId: "repo-1", mainCommit: null },
      }),
    ];

    expect(listCurrentPlanDraftArtifacts(artifacts, []).map((artifact) => artifact.id)).toEqual([
      "draft-current",
    ]);
  });

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
        id: "archived",
        type: "plan",
        status: "archived",
        createdAt: "2026-03-29T00:03:00.000Z",
      }),
    ];

    const grouped = groupPlansByStatus(artifacts);
    expect(grouped.todo.map((artifact) => artifact.id)).toEqual(["todo-new", "todo-old"]);
    expect(grouped.archived.map((artifact) => artifact.id)).toEqual(["archived"]);
  });
});
