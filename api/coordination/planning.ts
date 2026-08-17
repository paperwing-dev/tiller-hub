import type {
  Artifact,
  PlanArtifact,
  PlanArtifactBody,
} from "./types";

export const MAX_PLAN_MARKDOWN_BYTES = 1024 * 1024;
export const PLAN_MARKDOWN_NORMALIZATION_VERSION = 1 as const;

export type PlanMarkdownNormalizationVersion =
  typeof PLAN_MARKDOWN_NORMALIZATION_VERSION;

/** Canonical representation used by every plan-content writer and comparison. */
export function normalizePlanMarkdown(markdown: string): string {
  const lineNormalized = markdown.replace(/\r\n?/g, "\n");
  if (!lineNormalized.trim()) return "";
  const normalized = lineNormalized.replace(/(?:\n[ \t]*)+$/u, "");
  return normalized ? `${normalized}\n` : "";
}

export function normalizePlanMarkdownAtVersion(
  markdown: string,
  version: PlanMarkdownNormalizationVersion,
): string {
  if (version !== PLAN_MARKDOWN_NORMALIZATION_VERSION) {
    throw new Error(`Unsupported plan Markdown normalization version: ${version}`);
  }
  return normalizePlanMarkdown(markdown);
}

const ATX_HEADING_PATTERN = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/u;
const FENCE_PATTERN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u;

function normalizeHeadingText(value: string): string {
  return value.replace(/[ \t]+#+[ \t]*$/u, "").trim();
}

export function derivePlanTitleFromMarkdown(markdown: string): string {
  let fence: { marker: string; length: number } | null = null;
  let readingTitleSection = false;

  for (const line of markdown.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) {
        fence = { marker: marker[0]!, length: marker.length };
      } else if (
        marker[0] === fence.marker
        && marker.length >= fence.length
        && !fenceMatch[2]!.trim()
      ) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const heading = ATX_HEADING_PATTERN.exec(line);
    if (heading) {
      const headingText = normalizeHeadingText(heading[2]!);
      if (heading[1]!.length === 1) return headingText;
      readingTitleSection = /^title:?$/iu.test(headingText);
      continue;
    }

    if (readingTitleSection && line.trim()) return line.trim();
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function renderArtifactBodyMarkdown(body: unknown): string {
  if (isRecord(body) && typeof body.markdown === "string") {
    return body.markdown;
  }
  return "";
}

function toPlanArtifactBody(body: unknown): PlanArtifactBody {
  return {
    markdown: renderArtifactBodyMarkdown(body),
  };
}

export function asPlanArtifact(artifact: Artifact | null | undefined): PlanArtifact | null {
  if (!artifact || artifact.type !== "plan") return null;
  return {
    ...artifact,
    type: "plan",
    body: toPlanArtifactBody(artifact.body),
  };
}
