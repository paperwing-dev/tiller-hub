import { describe, expect, it } from "vitest";
import type { FrozenOverviewPayload } from "../../coordination";
import type { RepoWorkspace } from "../../repo/access";
import type { Env, EnvMeta } from "../../types";
import {
  buildEnvReviewChangeContext,
  buildEnvReviewInspectionBundle,
  buildEnvReviewPrompt,
  EMPTY_ENV_REVIEW_PLAN_BASIS,
  type EnvReviewWorkspaceSource,
} from "../context";
import { buildEnvReviewOverviewPrompt } from "../skill-orchestration";
import { validateReviewSnapshotTar } from "../snapshots";
import type { EnvReviewChangeContext, EnvReviewPlanBasis, EnvReviewRun } from "../types";

const changeContext: EnvReviewChangeContext = {
  generatedAt: "2026-08-09T04:07:00.000Z",
  summary: {
    total: 3,
    added: 1,
    modified: 2,
    deleted: 0,
    omitted: 1,
    truncated: 1,
    files: [
      {
        path: "/packages/hub/api/routes.ts",
        status: "modified",
        oldSize: 100,
        newSize: 120,
      },
      {
        path: "/packages/hub/src/App.tsx",
        status: "modified",
        oldSize: 200,
        newSize: 240,
        omittedReason: "budget-exhausted",
      },
      {
        path: "/packages/hub/src/NewPanel.tsx",
        status: "added",
        oldSize: null,
        newSize: 80,
        truncated: true,
      },
    ],
  },
  files: [
    {
      path: "/packages/hub/api/routes.ts",
      status: "modified",
      oldSize: 100,
      newSize: 120,
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      path: "/packages/hub/src/App.tsx",
      status: "modified",
      oldSize: 200,
      newSize: 240,
      omittedReason: "budget-exhausted",
    },
    {
      path: "/packages/hub/src/NewPanel.tsx",
      status: "added",
      oldSize: null,
      newSize: 80,
      diff: "@@ -0,0 +1 @@\n+panel",
      truncated: true,
    },
  ],
  limits: {
    maxFiles: 25,
    maxDiffBytesPerFile: 20_000,
    maxTotalDiffBytes: 60_000,
    maxFileBytesForDiff: 200_000,
  },
};

const planBasis: EnvReviewPlanBasis = {
  source: "startup-plan",
  artifactId: "plan-1",
  version: 3,
  title: "Route cleanup",
  markdown: "# Route cleanup\n\nKeep route behavior stable.",
};

const run = {
  runId: "run-1",
  threadId: "thread-1",
  envSlug: "env-1",
  repoId: "repo-1",
  mainSessionId: "session-1",
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  roleLabel: "Bug Reviewer",
  taskKind: "recipe-role",
  customTask: null,
  recipeInstructions: "Review shared contracts.\n\nFind correctness bugs.",
  status: "queued",
  preparationOpId: "op-1",
  preparation: null,
  changeContext,
  planBasis,
  prompt: null,
  runtime: null,
  startedAt: "2026-08-09T04:07:00.000Z",
  queuedAt: null,
  completedAt: null,
  error: null,
  lastContactAt: null,
  skillInvocationId: "invocation-1",
  skillAgentId: "bugs",
  skillRunRole: "report_initial",
  skillDefinitionSnapshot: null,
  frozenOverview: null,
} satisfies EnvReviewRun;

describe("environment review prompts", () => {
  it("snapshots initial and follow-up prompts after common and role instructions are composed once", () => {
    const snapshotRun = {
      ...run,
      roleLabel: "Focused Reviewer",
      recipeInstructions: "Common guidance.\n\nRole guidance.",
    };
    const emptyChanges: EnvReviewChangeContext = {
      summary: { total: 0, added: 0, modified: 0, deleted: 0, omitted: 0, truncated: 0, files: [] },
      files: [],
      limits: changeContext.limits,
    };
    const initial = buildEnvReviewPrompt({
      run: snapshotRun,
      changeContext: emptyChanges,
      planBasis: EMPTY_ENV_REVIEW_PLAN_BASIS,
      recipeInstructions: snapshotRun.recipeInstructions,
    });
    expect(initial).toBe(`You are a Tiller live environment reviewer.
The complete immutable workspace snapshot is checked out read-only in your current working directory.
Read and search any relevant files before reaching conclusions. You may run non-mutating inspection commands.
Do not modify, create, or delete repository files, control the harness, or ask the harness to run commands.
Give brief, user-facing progress updates as you inspect and when your understanding changes. Summarize intent and conclusions; do not expose private chain-of-thought.
Treat this checkout as the complete authoritative review basis for this run.
Inline patch excerpts are navigation aids, not the boundary of what you can inspect. A missing excerpt does not make the current file unavailable.
Use repository history or \`.tiller/review-context\` when exact pre-change content matters; its README and manifest cover every changed path.
Return concise Markdown with only substantive, actionable findings and relevant file paths.
State an inspection limitation only when it blocks a specific finding, and place it with that finding.

Review assignment:
- role: Focused Reviewer
Task: Common guidance.

Role guidance.

Changed paths:
- No changed files detected.

Pinned plan basis:
No pinned startup or selected plan is available. Do not invent plan-compliance claims.

Prior reviewer transcript:
None.

Inline patch excerpts:
No inline patch excerpts were preloaded. Inspect the checkout directly.`);

    const followUp = buildEnvReviewPrompt({
      run: snapshotRun,
      changeContext: emptyChanges,
      planBasis: EMPTY_ENV_REVIEW_PLAN_BASIS,
      recipeInstructions: snapshotRun.recipeInstructions,
      currentInstruction: "Re-check the latest user concern.",
      priorMessages: [
        { role: "user", text: "Earlier question." },
        { role: "assistant", text: "Earlier answer." },
      ],
    });
    expect(followUp).toBe(initial
      .replace(
        "Role guidance.\n\nChanged paths:",
        "Role guidance.\n\nCurrent instruction:\nRe-check the latest user concern.\n\nChanged paths:",
      )
      .replace(
        "Prior reviewer transcript:\nNone.",
        "Prior reviewer transcript:\nuser: Earlier question.\n\nassistant: Earlier answer.",
      ));
  });

  it("directs child reviewers to inspect the checkout without exposing operational caveat boilerplate", () => {
    const prompt = buildEnvReviewPrompt({
      run,
      changeContext,
      planBasis,
      recipeInstructions: run.recipeInstructions ?? undefined,
      priorMessages: [{ role: "user", text: "Pay attention to route precedence." }],
    });

    expect(prompt).toContain("complete immutable workspace snapshot");
    expect(prompt).toContain("Read and search any relevant files");
    expect(prompt).toContain("brief, user-facing progress updates");
    expect(prompt).toContain("do not expose private chain-of-thought");
    expect(prompt).toContain("A missing excerpt does not make the current file unavailable");
    expect(prompt).toContain("State an inspection limitation only when it blocks a specific finding");
    expect(prompt).toContain("Review shared contracts.\n\nFind correctness bugs.");
    expect(prompt).toContain("- modified: /packages/hub/src/App.tsx");
    expect(prompt).not.toContain("budget-exhausted");
    expect(prompt).not.toContain("truncated");
    expect(prompt).toContain("Pay attention to route precedence.");
    expect(prompt).toContain("Keep route behavior stable.");

    expect(prompt).not.toContain("Stale-feedback warning");
    expect(prompt).not.toContain("Treat findings as advisory and stale");
    expect(prompt).not.toContain("advisory");
    expect(prompt).not.toContain("snapshot-age");
    expect(prompt).not.toContain("coverage caveat");
    expect(prompt).not.toContain("2026-08-09");
    expect(prompt).not.toContain("uploaded bytes");
    expect(prompt).not.toContain("Model: codex/gpt-5.6-sol");
    expect(prompt).not.toContain("max total diff bytes");
  });

  it("gives Overview only frozen reports and synthesis instructions", () => {
    const payload: FrozenOverviewPayload = {
      invocationId: "invocation-1",
      skillId: "code-review",
      skillLabel: "Code Review",
      mode: "auto",
      reports: [{
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
        agentId: "bugs",
        agentLabel: "Bug Reviewer",
        text: "The route order can shadow the static handler.",
      }],
      failureNotices: [{
        agentId: "tests",
        agentLabel: "Test Reviewer",
        status: "failed",
        error: "Provider unavailable",
      }],
      guidance: "Prioritize correctness.",
      overviewInstructions: "Keep only high-confidence findings.",
      frozenAt: "2026-08-09T04:08:00.000Z",
    };

    const prompt = buildEnvReviewOverviewPrompt(payload);

    expect(prompt).toContain("Synthesize only the frozen Reports below");
    expect(prompt).toContain("brief, user-facing progress updates");
    expect(prompt).toContain("Keep only high-confidence findings.");
    expect(prompt).toContain("The route order can shadow the static handler.");
    expect(prompt).toContain("Provider unavailable");
    expect(prompt).toContain("Prioritize correctness.");
    expect(prompt).not.toContain("Inline patch excerpts");
    expect(prompt).not.toContain("Pinned plan basis");
    expect(prompt).not.toContain(payload.frozenAt);
    expect(prompt).not.toContain("advisory");
    expect(prompt).not.toContain("snapshot-age");
  });

  it("packages exact pre-change bytes for every modified and deleted path", async () => {
    const encoder = new TextEncoder();
    const baseFiles = new Map([
      ["/added.txt", null],
      ["/deleted.txt", encoder.encode("deleted before\n")],
      ["/modified.txt", encoder.encode("modified before\n")],
      ["/same.txt", encoder.encode("same\n")],
    ]);
    const currentFiles = new Map([
      ["/added.txt", encoder.encode("added now\n")],
      ["/modified.txt", encoder.encode("modified now\n")],
      ["/same.txt", encoder.encode("same\n")],
    ]);
    const source = (files: Map<string, Uint8Array | null>, hashes: Record<string, string>): EnvReviewWorkspaceSource => ({
      async statWorkspaceFile(path) {
        const content = files.get(path) ?? null;
        return content ? { path, size: content.byteLength } : null;
      },
      async readWorkspaceFileBytes(path) {
        return files.get(path) ?? null;
      },
      async getHashedManifest() {
        return Object.entries(hashes).map(([path, sha256]) => ({
          path,
          sha256,
          size: files.get(path)?.byteLength ?? 0,
        }));
      },
    });
    const base = source(baseFiles, {
      "/deleted.txt": "deleted-before",
      "/modified.txt": "modified-before",
      "/same.txt": "same",
    });
    const current = source(currentFiles, {
      "/added.txt": "added-now",
      "/modified.txt": "modified-now",
      "/same.txt": "same",
    });
    const exactChangeContext = await buildEnvReviewChangeContext({
      env: {} as Env,
      repo: { workspace: base } as unknown as RepoWorkspace,
      meta: { slug: "env-1", scmModel: "workspace" } as EnvMeta,
      envWorkspace: current,
    });
    const bundle = await buildEnvReviewInspectionBundle({
      env: {} as Env,
      repo: { workspace: base } as unknown as RepoWorkspace,
      meta: { slug: "env-1", scmModel: "workspace" } as EnvMeta,
      envWorkspace: current,
      changeContext: exactChangeContext,
    });
    const validated = await validateReviewSnapshotTar(bundle.tarBytes);
    const manifest = JSON.parse(new TextDecoder().decode(validated.entries.get("/manifest.json"))) as {
      files: Array<{ path: string; status: string; beforeObject: string | null }>;
    };

    expect(manifest.files).toEqual([
      { path: "/added.txt", status: "added", beforeObject: null },
      { path: "/deleted.txt", status: "deleted", beforeObject: "objects/000002.before" },
      { path: "/modified.txt", status: "modified", beforeObject: "objects/000003.before" },
    ]);
    expect(new TextDecoder().decode(validated.entries.get("/objects/000002.before"))).toBe("deleted before\n");
    expect(new TextDecoder().decode(validated.entries.get("/objects/000003.before"))).toBe("modified before\n");
  });
});
