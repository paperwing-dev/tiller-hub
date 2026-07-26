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
import type {
  EnvReviewChangeContext,
  EnvReviewChangedFile,
  EnvReviewPlanBasis,
  EnvReviewPreparationResult,
  EnvReviewRun,
} from "./types";

export const ENV_REVIEW_CONTEXT_LIMITS = {
  maxFiles: 25,
  maxDiffBytesPerFile: 20_000,
  maxTotalDiffBytes: 60_000,
  maxFileBytesForDiff: 200_000,
};

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
  preparation: EnvReviewPreparationResult;
  changeContext: EnvReviewChangeContext;
  planBasis: EnvReviewPlanBasis;
  recipeInstructions?: string;
  priorMessages?: Array<{ role: string; text: string }>;
}): string {
  const summary = args.changeContext.summary;
  const planText = args.planBasis.source === "startup-plan"
    ? [
      `Plan artifact: ${args.planBasis.title ?? "(untitled)"} (${args.planBasis.artifactId}, version ${args.planBasis.version ?? "unknown"})`,
      "",
      args.planBasis.markdown ?? "",
    ].join("\n")
    : "No startup or selected plan is available. For plan-compliance review, explicitly state that no plan basis was available.";
  const fileSummary = summary.files.map((file) => {
    const suffix = file.omittedReason
      ? ` (${file.omittedReason}${file.truncated ? ", truncated" : ""})`
      : file.truncated
        ? " (truncated)"
        : "";
    return `- ${file.status}: ${file.path}${suffix}`;
  }).join("\n") || "- No changed files detected.";
  const diffs = args.changeContext.files.map((file) => {
    if (file.diff) {
      return [`### ${file.path}`, `status: ${file.status}`, "```diff", file.diff.trimEnd(), "```"].join("\n");
    }
    return [`### ${file.path}`, `status: ${file.status}`, `diff omitted: ${file.omittedReason ?? "unavailable"}`].join("\n");
  }).join("\n\n");
  const prior = args.priorMessages?.length
    ? args.priorMessages.map((message) => `${message.role}: ${message.text}`).join("\n\n")
    : "None.";

  return [
    "You are a Tiller live environment reviewer.",
    "You are read-only and advisory. Do not attempt to edit files, control the harness, or ask the harness to run commands.",
    "Return concise Markdown findings. Prioritize actionable issues with file paths where possible.",
    "",
    `Reviewer role: ${args.run.roleLabel}`,
    `Model: ${args.run.provider}/${args.run.model}`,
    `Task: ${taskInstruction(args.run, args.recipeInstructions)}`,
    "",
    "Stale-feedback warning:",
    `This review is based on a workspace snapshot prepared at ${args.preparation.completedAt}. The live harness may have changed after that. Treat findings as advisory and stale until the user decides what to send.`,
    "",
    "Preparation metadata:",
    `- op id: ${args.preparation.opId}`,
    `- changed files uploaded: ${args.preparation.changedCount}`,
    `- deleted files: ${args.preparation.deletedCount}`,
    `- uploaded bytes: ${args.preparation.uploadedBytes}`,
    "",
    "Changed-file summary:",
    `- total: ${summary.total}`,
    `- added: ${summary.added}`,
    `- modified: ${summary.modified}`,
    `- deleted: ${summary.deleted}`,
    `- omitted/truncated: ${summary.omitted}/${summary.truncated}`,
    fileSummary,
    "",
    "Context limits:",
    `- max files: ${args.changeContext.limits.maxFiles}`,
    `- max diff bytes per file: ${args.changeContext.limits.maxDiffBytesPerFile}`,
    `- max total diff bytes: ${args.changeContext.limits.maxTotalDiffBytes}`,
    "Omitted, binary, too-large, and truncated diffs are explicitly marked above and below.",
    "",
    "Plan basis:",
    planText,
    "",
    "Prior reviewer transcript:",
    prior,
    "",
    "Budgeted diffs:",
    diffs || "No inline diffs are available.",
  ].join("\n");
}
