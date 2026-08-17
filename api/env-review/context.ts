import { createTwoFilesPatch } from "diff";
import type { ArtifactStoreDO } from "../coordination";
import { renderArtifactBodyMarkdown } from "../coordination";
import { TREE_HASH_EXCLUDES } from "../env/launch-config";
import { mintGitHubInstallationToken } from "../github/app";
import { normalizeGitHubDeletedPaths } from "../github/draft-overlay";
import { readBlobBytes, readCommitTree, type GitHubApiClient, type GitHubTreeEntry, type GitHubTreeSnapshot } from "../github/git-api";
import { canonicalizeGitHubRepo } from "../github/repo";
import { getArtifactStoreStub, getWorkspaceStub } from "../helpers";
import type { RepoWorkspace } from "../repo/access";
import type { Env, EnvMeta } from "../types";
import { buildReviewSnapshotTar, type ReviewSnapshotTarEntry } from "./snapshots";
import type {
  EnvReviewChangeContext,
  EnvReviewChangedFile,
  EnvReviewPlanBasis,
  EnvReviewRun,
} from "./types";

export const ENV_REVIEW_CONTEXT_LIMITS = {
  maxFiles: 25,
  maxDiffBytesPerFile: 20_000,
  maxTotalDiffBytes: 60_000,
  maxFileBytesForDiff: 200_000,
};

export const ENV_REVIEW_INSPECTION_BUNDLE_FORMAT_VERSION = 1;

export const EMPTY_ENV_REVIEW_PLAN_BASIS: EnvReviewPlanBasis = {
  source: "none",
  artifactId: null,
  version: null,
  title: null,
  markdown: null,
};

export function normalizeEnvReviewPlanBasis(
  basis: EnvReviewPlanBasis | null | undefined,
): EnvReviewPlanBasis {
  return basis ?? EMPTY_ENV_REVIEW_PLAN_BASIS;
}

export interface EnvReviewInspectionManifest {
  formatVersion: typeof ENV_REVIEW_INSPECTION_BUNDLE_FORMAT_VERSION;
  files: Array<{
    path: string;
    status: EnvReviewChangedFile["status"];
    beforeObject: string | null;
  }>;
}

export interface EnvReviewInspectionBundle {
  manifest: EnvReviewInspectionManifest;
  tarBytes: Uint8Array;
}

interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface EnvReviewWorkspaceSource {
  statWorkspaceFile(path: string): Promise<{ path: string; size: number } | null>;
  readWorkspaceFileBytes(path: string): Promise<Uint8Array | null>;
  getHashedManifest(options?: { excludePrefixes?: string[] }): Promise<ManifestEntry[]>;
  readGitHubDeletedWorkspacePaths?(): Promise<string[]>;
}

interface BaseSource {
  oldHashForPath(path: string): string | null;
  oldSizeForPath(path: string): number | null;
  readWorkspaceFileBytes(path: string): Promise<Uint8Array | null>;
  hasPath(path: string): boolean;
}

function normalizeWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function githubTreePath(path: string): string {
  return normalizeWorkspacePath(path).replace(/^\/+/, "");
}

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  const normalized = normalizeWorkspacePath(path);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeWorkspacePath(prefix).replace(/\/+$/, "");
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

function githubBaseEntry(tree: GitHubTreeSnapshot, path: string): GitHubTreeEntry | null {
  const entry = tree.entries.get(githubTreePath(path));
  return entry?.type === "blob" ? entry : null;
}

function hasBinaryBytes(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateDiff(diff: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Length(diff) <= maxBytes) return { value: diff, truncated: false };
  let value = diff.slice(0, maxBytes);
  while (utf8Length(value) > maxBytes && value.length > 0) {
    value = value.slice(0, -1);
  }
  return {
    value: `${value}\n\n[diff truncated by env review context budget]\n`,
    truncated: true,
  };
}

function buildTextDiff(path: string, oldText: string, newText: string): string {
  return createTwoFilesPatch(
    `a${normalizeWorkspacePath(path)}`,
    `b${normalizeWorkspacePath(path)}`,
    oldText,
    newText,
    "",
    "",
    { context: 4 },
  );
}

function summarize(files: EnvReviewChangedFile[]): EnvReviewChangeContext["summary"] {
  return {
    total: files.length,
    added: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
    omitted: files.filter((file) => file.omittedReason).length,
    truncated: files.filter((file) => file.truncated).length,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      oldSize: file.oldSize,
      newSize: file.newSize,
      ...(file.omittedReason ? { omittedReason: file.omittedReason } : {}),
      ...(file.truncated ? { truncated: true } : {}),
    })),
  };
}

async function readGitHubBaseSource(
  env: Env,
  repo: RepoWorkspace,
  meta: EnvMeta,
  baseCommitSha?: string | null,
  allowMetaFallback = true,
): Promise<BaseSource | null> {
  const commitSha = baseCommitSha === undefined
    ? (allowMetaFallback ? meta.githubBaseCommitSha : null)
    : baseCommitSha?.trim() || null;
  if (!commitSha) return null;
  const githubRepo = canonicalizeGitHubRepo(repo.meta.githubFullName, { allowOwnerRepo: true });
  const token = (await mintGitHubInstallationToken(env, githubRepo, { access: "read" })).token;
  const client: GitHubApiClient = { token, repo: githubRepo };
  const tree = await readCommitTree(client, commitSha);
  return {
    oldHashForPath(path: string) {
      return githubBaseEntry(tree, path)?.sha ?? null;
    },
    oldSizeForPath(path: string) {
      return githubBaseEntry(tree, path)?.size ?? null;
    },
    hasPath(path: string) {
      return Boolean(githubBaseEntry(tree, path));
    },
    async readWorkspaceFileBytes(path: string) {
      const entry = githubBaseEntry(tree, path);
      return entry ? readBlobBytes(client, entry.sha) : null;
    },
  };
}

async function readWorkspaceBaseSource(source: EnvReviewWorkspaceSource): Promise<BaseSource> {
  const manifest = await source.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES });
  const byPath = new Map(manifest.map((entry) => [normalizeWorkspacePath(entry.path), entry]));
  return {
    oldHashForPath(path: string) {
      return byPath.get(normalizeWorkspacePath(path))?.sha256 ?? null;
    },
    oldSizeForPath(path: string) {
      return byPath.get(normalizeWorkspacePath(path))?.size ?? null;
    },
    hasPath(path: string) {
      return byPath.has(normalizeWorkspacePath(path));
    },
    readWorkspaceFileBytes(path: string) {
      return source.readWorkspaceFileBytes(normalizeWorkspacePath(path));
    },
  };
}

async function buildChangedEntries(args: {
  env: Env;
  repo: RepoWorkspace;
  meta: EnvMeta;
  envWorkspace: EnvReviewWorkspaceSource;
  githubBaseCommitSha?: string | null;
  allowGitHubBaseFallback?: boolean;
}): Promise<Array<Omit<EnvReviewChangedFile, "diff" | "omittedReason" | "truncated">>> {
  const draftManifest = (await args.envWorkspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }))
    .map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path) }))
    .filter((entry) => !matchesPrefix(entry.path, TREE_HASH_EXCLUDES));

  if (args.meta.scmModel === "github") {
    const baseSource = await readGitHubBaseSource(
      args.env,
      args.repo,
      args.meta,
      args.githubBaseCommitSha,
      args.allowGitHubBaseFallback ?? true,
    );
    const deletedPaths = normalizeGitHubDeletedPaths(
      args.envWorkspace.readGitHubDeletedWorkspacePaths
        ? await args.envWorkspace.readGitHubDeletedWorkspacePaths()
        : [],
    );
    const changes = new Map<string, Omit<EnvReviewChangedFile, "diff" | "omittedReason" | "truncated">>();
    for (const entry of draftManifest) {
      const oldSize = baseSource?.oldSizeForPath(entry.path) ?? null;
      changes.set(entry.path, {
        path: entry.path,
        status: baseSource?.hasPath(entry.path) ? "modified" : "added",
        oldSize,
        newSize: entry.size,
      });
    }
    for (const path of deletedPaths) {
      if (matchesPrefix(path, TREE_HASH_EXCLUDES)) continue;
      if (!baseSource?.hasPath(path)) continue;
      changes.set(path, {
        path,
        status: "deleted",
        oldSize: baseSource.oldSizeForPath(path),
        newSize: null,
      });
    }
    return Array.from(changes.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  const repoBase = await readWorkspaceBaseSource(args.repo.workspace as unknown as EnvReviewWorkspaceSource);
  const draftByPath = new Map(draftManifest.map((entry) => [entry.path, entry]));
  const repoManifest = await args.repo.workspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES });
  const paths = Array.from(new Set([
    ...repoManifest.map((entry) => normalizeWorkspacePath(entry.path)),
    ...draftByPath.keys(),
  ])).sort((left, right) => left.localeCompare(right));
  const changes: Array<Omit<EnvReviewChangedFile, "diff" | "omittedReason" | "truncated">> = [];
  for (const path of paths) {
    const draft = draftByPath.get(path) ?? null;
    const baseHash = repoBase.oldHashForPath(path);
    if (draft && baseHash === draft.sha256) continue;
    changes.push({
      path,
      status: baseHash && draft ? "modified" : baseHash ? "deleted" : "added",
      oldSize: repoBase.oldSizeForPath(path),
      newSize: draft?.size ?? null,
    });
  }
  return changes;
}

async function enrichDiff(args: {
  env: Env;
  repo: RepoWorkspace;
  meta: EnvMeta;
  file: Omit<EnvReviewChangedFile, "diff" | "omittedReason" | "truncated">;
  envWorkspace: EnvReviewWorkspaceSource;
  baseSource: BaseSource | null;
  remainingBudget: number;
}): Promise<{ file: EnvReviewChangedFile; usedBytes: number }> {
  const { file } = args;
  if ((file.oldSize ?? 0) > ENV_REVIEW_CONTEXT_LIMITS.maxFileBytesForDiff || (file.newSize ?? 0) > ENV_REVIEW_CONTEXT_LIMITS.maxFileBytesForDiff) {
    return { file: { ...file, omittedReason: "too-large" }, usedBytes: 0 };
  }
  if (args.remainingBudget <= 0) {
    return { file: { ...file, omittedReason: "budget-exhausted" }, usedBytes: 0 };
  }

  const [oldBytes, newBytes] = await Promise.all([
    file.status === "added" ? Promise.resolve(null) : args.baseSource?.readWorkspaceFileBytes(file.path) ?? Promise.resolve(null),
    file.status === "deleted" ? Promise.resolve(null) : args.envWorkspace.readWorkspaceFileBytes(file.path),
  ]);
  if ((file.status !== "added" && !oldBytes) || (file.status !== "deleted" && !newBytes)) {
    return { file: { ...file, omittedReason: "unavailable" }, usedBytes: 0 };
  }
  if ((oldBytes && hasBinaryBytes(oldBytes)) || (newBytes && hasBinaryBytes(newBytes))) {
    return { file: { ...file, omittedReason: "binary" }, usedBytes: 0 };
  }
  const oldText = oldBytes ? decodeUtf8(oldBytes) : "";
  const newText = newBytes ? decodeUtf8(newBytes) : "";
  if (oldText === null || newText === null) {
    return { file: { ...file, omittedReason: "binary" }, usedBytes: 0 };
  }

  const rawDiff = buildTextDiff(file.path, oldText, newText);
  const perFile = truncateDiff(rawDiff, ENV_REVIEW_CONTEXT_LIMITS.maxDiffBytesPerFile);
  const total = truncateDiff(perFile.value, args.remainingBudget);
  const diff = total.value;
  const usedBytes = utf8Length(diff);
  return {
    file: {
      ...file,
      diff,
      ...(perFile.truncated || total.truncated ? { truncated: true } : {}),
      ...(total.truncated ? { omittedReason: "budget-exhausted" as const } : {}),
    },
    usedBytes,
  };
}

export async function buildEnvReviewChangeContext(args: {
  env: Env;
  repo: RepoWorkspace;
  meta: EnvMeta;
  envWorkspace?: EnvReviewWorkspaceSource;
  githubBaseCommitSha?: string | null;
  allowGitHubBaseFallback?: boolean;
}): Promise<EnvReviewChangeContext> {
  const envWorkspace = args.envWorkspace
    ?? getWorkspaceStub(args.env, args.meta.slug) as unknown as EnvReviewWorkspaceSource;
  const entries = await buildChangedEntries({
    ...args,
    envWorkspace,
    githubBaseCommitSha: args.githubBaseCommitSha,
    allowGitHubBaseFallback: args.allowGitHubBaseFallback,
  });
  const selected = entries.slice(0, ENV_REVIEW_CONTEXT_LIMITS.maxFiles);
  const baseSource = args.meta.scmModel === "github"
    ? await readGitHubBaseSource(
      args.env,
      args.repo,
      args.meta,
      args.githubBaseCommitSha,
      args.allowGitHubBaseFallback ?? true,
    )
    : await readWorkspaceBaseSource(args.repo.workspace as unknown as EnvReviewWorkspaceSource);

  let usedBudget = 0;
  const files: EnvReviewChangedFile[] = [];
  for (const entry of selected) {
    const enriched = await enrichDiff({
      ...args,
      file: entry,
      envWorkspace,
      baseSource,
      remainingBudget: ENV_REVIEW_CONTEXT_LIMITS.maxTotalDiffBytes - usedBudget,
    });
    files.push(enriched.file);
    usedBudget += enriched.usedBytes;
  }
  for (const entry of entries.slice(ENV_REVIEW_CONTEXT_LIMITS.maxFiles)) {
    files.push({ ...entry, omittedReason: "budget-exhausted" });
  }
  return {
    generatedAt: new Date().toISOString(),
    summary: summarize(files),
    files,
    limits: ENV_REVIEW_CONTEXT_LIMITS,
  };
}

/**
 * Build exact pre-change material for tool-driven review. Prompt excerpts stay
 * bounded, while this bundle lets the runtime expose every modified/deleted
 * file's complete prior bytes beside the immutable current checkout.
 */
export async function buildEnvReviewInspectionBundle(args: {
  env: Env;
  repo: RepoWorkspace;
  meta: EnvMeta;
  envWorkspace?: EnvReviewWorkspaceSource;
  githubBaseCommitSha?: string | null;
  allowGitHubBaseFallback?: boolean;
  changeContext: EnvReviewChangeContext;
}): Promise<EnvReviewInspectionBundle> {
  const envWorkspace = args.envWorkspace
    ?? getWorkspaceStub(args.env, args.meta.slug) as unknown as EnvReviewWorkspaceSource;
  const entries = args.changeContext.summary.files.map(({ path, status, oldSize, newSize }) => ({
    path,
    status,
    oldSize,
    newSize,
  }));
  const baseSource = args.meta.scmModel === "github"
    ? await readGitHubBaseSource(
      args.env,
      args.repo,
      args.meta,
      args.githubBaseCommitSha,
      args.allowGitHubBaseFallback ?? true,
    )
    : await readWorkspaceBaseSource(args.repo.workspace as unknown as EnvReviewWorkspaceSource);
  if (entries.some((entry) => entry.status !== "added") && !baseSource) {
    throw new Error("Complete pre-change review material is unavailable for this snapshot.");
  }

  const archiveEntries: ReviewSnapshotTarEntry[] = [];
  const manifest: EnvReviewInspectionManifest = {
    formatVersion: ENV_REVIEW_INSPECTION_BUNDLE_FORMAT_VERSION,
    files: [],
  };
  for (const [index, entry] of entries.entries()) {
    if (entry.status !== "deleted") {
      const current = await envWorkspace.readWorkspaceFileBytes(entry.path);
      if (!current) {
        throw new Error(`Complete review material is missing the current file ${entry.path}.`);
      }
    }
    let beforeObject: string | null = null;
    if (entry.status !== "added") {
      const before = await baseSource!.readWorkspaceFileBytes(entry.path);
      if (!before) {
        throw new Error(`Complete review material is missing the pre-change file ${entry.path}.`);
      }
      beforeObject = `objects/${String(index + 1).padStart(6, "0")}.before`;
      archiveEntries.push({ path: beforeObject, content: before });
    }
    manifest.files.push({ path: entry.path, status: entry.status, beforeObject });
  }

  const encoder = new TextEncoder();
  archiveEntries.push({
    path: "manifest.json",
    content: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  archiveEntries.push({
    path: "README.md",
    content: encoder.encode([
      "# Tiller review context",
      "",
      "This directory contains the complete pre-change side of the frozen review change set.",
      "Current files are in the repository checkout. Prior versions of modified and deleted files are under `before/` at the same relative path.",
      "`manifest.json` records every changed path and whether it was added, modified, or deleted.",
      "Use `git diff --no-index -- .tiller/review-context/before/<path> <path>` when the checkout's own Git history is unavailable.",
      "",
    ].join("\n")),
  });
  return {
    manifest,
    tarBytes: buildReviewSnapshotTar(archiveEntries, { excludePrefixes: [] }),
  };
}

export async function readEnvReviewPlanBasis(args: {
  env: Env;
  repo: RepoWorkspace;
  planArtifactId?: string | null;
}): Promise<EnvReviewPlanBasis> {
  const planArtifactId = args.planArtifactId?.trim();
  if (!planArtifactId) {
    return { source: "none", artifactId: null, version: null, title: null, markdown: null };
  }
  const artifactStore: ArtifactStoreDO = getArtifactStoreStub(
    args.env,
    args.repo.meta.repoId,
    args.repo.meta.artifactStoreGeneration,
  );
  const artifact = await artifactStore.getArtifact(planArtifactId);
  if (!artifact || artifact.type !== "plan") {
    return { source: "none", artifactId: null, version: null, title: null, markdown: null };
  }
  return {
    source: "startup-plan",
    artifactId: artifact.id,
    version: artifact.version ?? 1,
    title: artifact.title || "Untitled plan",
    markdown: renderArtifactBodyMarkdown(artifact.body),
  };
}

function taskInstruction(run: Pick<EnvReviewRun, "taskKind" | "customTask" | "roleLabel">, recipeInstructions?: string): string {
  if (recipeInstructions?.trim()) return recipeInstructions.trim();
  switch (run.taskKind) {
    case "correctness":
      return "Review for correctness, regressions, edge cases, race conditions, and missing error handling.";
    case "tests":
      return "Review test coverage. Identify missing tests, brittle assertions, and verification gaps.";
    case "architecture":
      return "Review architecture and maintainability. Identify coupling, needless abstractions, and simpler alternatives.";
    case "security":
      return "Review security and privacy risks, including injection, authz/authn, secret handling, and unsafe data flows.";
    case "custom":
      return run.customTask?.trim() || "Perform the requested custom review.";
    case "recipe-role":
      return `Perform the ${run.roleLabel} role for this code review recipe.`;
  }
}

export function buildEnvReviewPrompt(args: {
  run: EnvReviewRun;
  changeContext: EnvReviewChangeContext;
  planBasis: EnvReviewPlanBasis;
  recipeInstructions?: string;
  currentInstruction?: string;
  priorMessages?: Array<{ role: string; text: string }>;
}): string {
  const summary = args.changeContext.summary;
  const planText = args.planBasis.source === "startup-plan"
    ? [
      `Plan artifact: ${args.planBasis.title ?? "(untitled)"} (${args.planBasis.artifactId}, version ${args.planBasis.version ?? "unknown"})`,
      "",
      args.planBasis.markdown ?? "",
    ].join("\n")
    : "No pinned startup or selected plan is available. Do not invent plan-compliance claims.";
  const fileSummary = summary.files
    .map((file) => `- ${file.status}: ${file.path}`)
    .join("\n") || "- No changed files detected.";
  const diffs = args.changeContext.files
    .filter((file): file is EnvReviewChangedFile & { diff: string } => Boolean(file.diff))
    .map((file) => [
      `### ${file.path}`,
      `status: ${file.status}; navigation excerpt only`,
      "```diff",
      file.diff.trimEnd(),
      "```",
    ].join("\n"))
    .join("\n\n");
  const prior = args.priorMessages?.length
    ? args.priorMessages.map((message) => `${message.role}: ${message.text}`).join("\n\n")
    : "None.";

  return [
    "You are a Tiller live environment reviewer.",
    "The complete immutable workspace snapshot is checked out read-only in your current working directory.",
    "Read and search any relevant files before reaching conclusions. You may run non-mutating inspection commands.",
    "Do not modify, create, or delete repository files, control the harness, or ask the harness to run commands.",
    "Give brief, user-facing progress updates as you inspect and when your understanding changes. Summarize intent and conclusions; do not expose private chain-of-thought.",
    "Treat this checkout as the complete authoritative review basis for this run.",
    "Inline patch excerpts are navigation aids, not the boundary of what you can inspect. A missing excerpt does not make the current file unavailable.",
    "Use repository history or `.tiller/review-context` when exact pre-change content matters; its README and manifest cover every changed path.",
    "Return concise Markdown with only substantive, actionable findings and relevant file paths.",
    "State an inspection limitation only when it blocks a specific finding, and place it with that finding.",
    "",
    "Review assignment:",
    `- role: ${args.run.roleLabel}`,
    `Task: ${taskInstruction(args.run, args.recipeInstructions)}`,
    ...(args.currentInstruction?.trim()
      ? ["", "Current instruction:", args.currentInstruction.trim()]
      : []),
    "",
    "Changed paths:",
    fileSummary,
    "",
    "Pinned plan basis:",
    planText,
    "",
    "Prior reviewer transcript:",
    prior,
    "",
    "Inline patch excerpts:",
    diffs || "No inline patch excerpts were preloaded. Inspect the checkout directly.",
  ].join("\n");
}
