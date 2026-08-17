const MANAGED_SECTION_VERSION = "v2";
const MANAGED_SECTION_START = `<!-- tiller:env-draft:${MANAGED_SECTION_VERSION}:start -->`;
const MANAGED_SECTION_END = `<!-- tiller:env-draft:${MANAGED_SECTION_VERSION}:end -->`;
const MAX_TITLE_LENGTH = 240;
const MAX_LISTED_FILES = 20;

export type DraftPrChangeStatus = "added" | "modified" | "deleted";

export interface DraftPrChangedFile {
  path: string;
  status: DraftPrChangeStatus;
}

export interface DraftPrContent {
  title: string;
  featureMarkdown: string;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeTitle(value: string): string {
  return truncate(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/^implementation plan\s*[:\-–—]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
    MAX_TITLE_LENGTH,
  );
}

function isUsefulTitle(value: string): boolean {
  return (
    Boolean(value) &&
    !/^(?:draft(?: plan)?|todo(?: plan)?|untitled(?: plan)?|implementation plan|new plan|plan)$/i.test(
      value,
    )
  );
}

interface MarkdownHeading {
  lineIndex: number;
  text: string;
}

function markdownHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fenceCharacter = "";
  let fenceLength = 0;

  for (const [lineIndex, line] of lines.entries()) {
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!fenceCharacter) {
        fenceCharacter = marker[0];
        fenceLength = marker.length;
      } else if (
        marker[0] === fenceCharacter &&
        marker.length >= fenceLength &&
        !fence[2].trim()
      ) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter) continue;

    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) headings.push({ lineIndex, text: heading[1] });
  }

  return headings;
}

function firstMeaningfulHeading(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const heading of markdownHeadings(lines)) {
    const title = normalizeTitle(heading.text);
    if (
      isUsefulTitle(title) &&
      !/^(?:summary|overview|goal|objective|outcome|problem|context|implementation|testing)$/i.test(
        title,
      )
    ) {
      return title;
    }
  }
  return "";
}

function normalizePath(value: string): string {
  return truncate(
    value
      .replace(/<!--.*?-->/g, " ")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .replace(/^\/+/, ""),
    1_000,
  );
}

function isSupportingPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(?:^|\/)(?:__tests__|test|tests|fixtures|docs?)(?:\/|$)/.test(lower) ||
    /(?:\.test|\.spec|_test|_spec)\.[^.]+$/.test(lower) ||
    /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(
      lower,
    ) ||
    /(?:^|\/)(?:readme|changelog|license)(?:\.|$)/.test(lower)
  );
}

function normalizeChangedFiles(
  files: readonly DraftPrChangedFile[],
): DraftPrChangedFile[] {
  const byPath = new Map<string, DraftPrChangedFile>();
  for (const file of files) {
    const path = normalizePath(file.path);
    if (path) byPath.set(path, { path, status: file.status });
  }
  return Array.from(byPath.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function fallbackTitle(envSlug: string, files: DraftPrChangedFile[]): string {
  const primary =
    files.find((file) => !isSupportingPath(file.path)) ?? files[0];
  if (!primary) return `Update ${normalizeTitle(envSlug) || "draft changes"}`;
  const verb =
    primary.status === "added"
      ? "Add"
      : primary.status === "deleted"
        ? "Remove"
        : "Update";
  return normalizeTitle(`${verb} ${primary.path}`);
}

function inlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function buildFeatureMarkdown(
  summary: string,
  files: DraftPrChangedFile[],
): string {
  const counts = {
    added: files.filter((file) => file.status === "added").length,
    modified: files.filter((file) => file.status === "modified").length,
    deleted: files.filter((file) => file.status === "deleted").length,
  };
  const countText = [
    counts.added ? `${counts.added} added` : "",
    counts.modified ? `${counts.modified} modified` : "",
    counts.deleted ? `${counts.deleted} deleted` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const listed = files.slice(0, MAX_LISTED_FILES).map((file) => {
    const label =
      file.status === "added"
        ? "Added"
        : file.status === "deleted"
          ? "Deleted"
          : "Modified";
    return `- ${label} ${inlineCode(file.path)}`;
  });
  if (files.length > listed.length) {
    listed.push(
      `- …and ${files.length - listed.length} more file${files.length - listed.length === 1 ? "" : "s"}`,
    );
  }
  return [
    "## Summary",
    "",
    summary,
    "",
    "## Changes",
    "",
    `${files.length} file${files.length === 1 ? "" : "s"} changed${countText ? ` (${countText})` : ""}.`,
    "",
    ...(listed.length ? listed : ["- No changed paths were reported."]),
  ].join("\n");
}

export function buildDraftPrContent(args: {
  envSlug: string;
  changedFiles: readonly DraftPrChangedFile[];
  planTitle?: string | null;
  planMarkdown?: string | null;
}): DraftPrContent {
  const files = normalizeChangedFiles(args.changedFiles);
  const planMarkdown = args.planMarkdown?.trim() ?? "";
  const suppliedTitle = normalizeTitle(args.planTitle ?? "");
  const title = isUsefulTitle(suppliedTitle)
    ? suppliedTitle
    : firstMeaningfulHeading(planMarkdown) ||
      fallbackTitle(args.envSlug, files);
  return {
    title,
    featureMarkdown: planMarkdown || buildFeatureMarkdown(`${title}.`, files),
  };
}

export function buildManagedPrSection(args: {
  content: DraftPrContent;
  envSlug: string;
  baseCommitSha: string | null;
  branchHeadSha: string;
  workspaceHash: string;
  defaultBranch: string | null;
  updatedAt: string;
}): string {
  return [
    MANAGED_SECTION_START,
    args.content.featureMarkdown,
    "",
    "<details>",
    "<summary>Tiller publish details</summary>",
    "",
    `- Managed section: \`${MANAGED_SECTION_VERSION}\``,
    `- Environment: ${inlineCode(args.envSlug)}`,
    `- Base: ${inlineCode(args.baseCommitSha ?? "unknown")}`,
    `- Branch head: ${inlineCode(args.branchHeadSha)}`,
    `- Workspace hash: ${inlineCode(args.workspaceHash)}`,
    `- Default branch at publish: ${inlineCode(args.defaultBranch ?? "default")}`,
    `- Updated at: ${inlineCode(args.updatedAt)}`,
    "",
    "</details>",
    MANAGED_SECTION_END,
  ].join("\n");
}

export function upsertManagedPrSection(
  existingBody: string | null,
  section: string,
): string {
  const body = existingBody?.trim() ?? "";
  if (!body) return section;
  const start = body.indexOf(MANAGED_SECTION_START);
  const end = body.lastIndexOf(MANAGED_SECTION_END);
  if (start === -1 || end === -1 || start >= end)
    return `${body}\n\n${section}`;
  return [
    body.slice(0, start).trimEnd(),
    section,
    body.slice(end + MANAGED_SECTION_END.length).trimStart(),
  ]
    .filter(Boolean)
    .join("\n\n");
}
