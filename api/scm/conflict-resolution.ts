import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { Env } from "../types";

const MERGE_RESOLUTION_MODEL = "@cf/nvidia/nemotron-3-120b-a12b";
const MAX_CONFLICT_FILES = 8;
const MAX_CONFLICT_SIDE_CHARS = 16_000;
const MAX_TOTAL_CONFLICT_CHARS = 48_000;

export interface MergeConflictPayload {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export interface MergeConflictResolution {
  path: string;
  content: string | null;
}

const resolutionSchema = z.object({
  resolutions: z.array(z.object({
    path: z.string().trim().min(1),
    content: z.string().nullable(),
  })).min(1).max(MAX_CONFLICT_FILES),
});

function parseResolutionResponse(text: string): { resolutions: MergeConflictResolution[] } | null {
  try {
    return resolutionSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function formatConflictSide(label: string, value: string | null): string {
  if (value === null) {
    return `${label}: <missing>`;
  }
  return `${label}:\n\`\`\`\n${value}\n\`\`\``;
}

function buildMergeConflictResolutionPrompt(conflicts: MergeConflictPayload[]): string {
  const sections = conflicts.map((conflict) => [
    `Path: ${conflict.path}`,
    formatConflictSide("Base", conflict.base),
    formatConflictSide("Ours", conflict.ours),
    formatConflictSide("Theirs", conflict.theirs),
  ].join("\n\n"));

  return [
    "Resolve git merge conflicts conservatively.",
    "Return JSON only with this shape:",
    '{ "resolutions": [ { "path": "relative/path", "content": "full resolved file contents or null to delete the file" } ] }',
    "Rules:",
    "- Return one resolution for every input path and no extras.",
    "- Preserve valid behavior from both ours and theirs when possible.",
    "- Prefer minimal edits over rewrites.",
    "- Do not include markdown fences or commentary.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}

function buildMergeConflictResolutionRepairPrompt(raw: string): string {
  return [
    "Repair the following merge-conflict resolution response into valid JSON.",
    "Return JSON only with this shape:",
    '{ "resolutions": [ { "path": "relative/path", "content": "full resolved file contents or null" } ] }',
    "",
    raw,
  ].join("\n");
}

function validateConflictPayload(conflicts: MergeConflictPayload[]): void {
  if (conflicts.length === 0) {
    throw new Error("At least one conflicted file is required.");
  }
  if (conflicts.length > MAX_CONFLICT_FILES) {
    throw new Error(`Too many conflicted files for AI resolution (${conflicts.length}).`);
  }

  let totalChars = 0;
  for (const conflict of conflicts) {
    if (!conflict.path || conflict.path.startsWith("/") || conflict.path.includes("\0")) {
      throw new Error(`Invalid conflicted path: ${conflict.path || "<empty>"}`);
    }
    for (const side of [conflict.base, conflict.ours, conflict.theirs]) {
      if (side && side.length > MAX_CONFLICT_SIDE_CHARS) {
        throw new Error(`Conflicted file ${conflict.path} is too large for AI resolution.`);
      }
      totalChars += side?.length ?? 0;
    }
  }

  if (totalChars > MAX_TOTAL_CONFLICT_CHARS) {
    throw new Error("Conflicted content is too large for AI resolution.");
  }
}

function validateResolvedPaths(
  requested: MergeConflictPayload[],
  parsed: { resolutions: MergeConflictResolution[] },
): { resolutions: MergeConflictResolution[] } {
  const requestedPaths = new Set(requested.map((conflict) => conflict.path));
  const resolvedPaths = new Set(parsed.resolutions.map((resolution) => resolution.path));
  if (resolvedPaths.size !== requestedPaths.size) {
    throw new Error("AI merge resolution did not return the expected number of files.");
  }
  for (const path of requestedPaths) {
    if (!resolvedPaths.has(path)) {
      throw new Error(`AI merge resolution omitted ${path}.`);
    }
  }
  for (const path of resolvedPaths) {
    if (!requestedPaths.has(path)) {
      throw new Error(`AI merge resolution returned an unexpected path: ${path}.`);
    }
  }
  return parsed;
}

async function repairResolutionJson(env: Env, prompt: string): Promise<string> {
  const workersAI = createWorkersAI({ binding: env.AI });
  const repaired = await generateText({
    model: workersAI.chat(MERGE_RESOLUTION_MODEL),
    system: "Repair malformed model output into valid JSON. Return JSON only with no markdown fences.",
    prompt,
  });
  return repaired.text.trim();
}

export async function resolveMergeConflictsWithAi(
  env: Env,
  conflicts: MergeConflictPayload[],
): Promise<{ model: string; resolutions: MergeConflictResolution[] }> {
  validateConflictPayload(conflicts);
  const workersAI = createWorkersAI({ binding: env.AI });
  const prompt = buildMergeConflictResolutionPrompt(conflicts);
  let resolutionText = (await generateText({
    model: workersAI.chat(MERGE_RESOLUTION_MODEL),
    system: "You are a careful software merge assistant. Return JSON only.",
    prompt,
  })).text.trim();

  let parsed = parseResolutionResponse(resolutionText);
  if (!parsed) {
    resolutionText = await repairResolutionJson(env, buildMergeConflictResolutionRepairPrompt(resolutionText));
    parsed = parseResolutionResponse(resolutionText);
  }
  if (!parsed) {
    throw new Error("AI merge resolution returned invalid JSON.");
  }

  const validated = validateResolvedPaths(conflicts, parsed);
  return {
    model: MERGE_RESOLUTION_MODEL,
    resolutions: validated.resolutions,
  };
}
