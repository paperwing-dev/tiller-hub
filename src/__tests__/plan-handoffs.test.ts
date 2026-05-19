import { describe, expect, it } from "vitest";
import type { Artifact, ArtifactRef } from "../../api/coordination/types";
import {
  getApprovedPlanRef,
  listCurrentPlanDraftArtifacts,
  listReviewArtifactsForDraft,
} from "../plan-artifacts";

const BASE_BODY = {
  summary: "Summary",
  findings: [],
  relevantFiles: [],
  openQuestions: [],
  proposedPlan: "{}",
  memoryRefs: [],
  model: "gpt-5.4",
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

  it("tracks approval through the approved-plan ref", () => {
    const refs: ArtifactRef[] = [
      {
        repoId: "repo-1",
        name: "approved-plan",
        artifactId: "approved-current",
        version: 2,
        updatedAt: "2026-03-29T00:02:00.000Z",
      },
    ];

    expect(getApprovedPlanRef(refs)?.artifactId).toBe("approved-current");
  });
});
