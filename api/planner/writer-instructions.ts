export const DEFAULT_PLAN_WRITING_INSTRUCTIONS = [
  "# Plan Writing Instructions",
  "",
  "Write the saved plan using exactly these section headings, in this order:",
  "",
  "## Title",
  "<one concise plan title, with no version number>",
  "",
  "## UX Changes",
  "<include this entire section only when UX changes apply>",
  "",
  "## Summary",
  "<short summary of the requested outcome and scope>",
  "",
  "## Key Changes",
  "<bullets for the implementation steps or concrete changes>",
  "",
  "## API and Type Changes",
  "<bullets for API, type, schema, or contract changes; write \"None.\" when none apply>",
  "",
  "## Test Plan",
  "<numbered or bulleted verification steps>",
  "",
  "Rules:",
  "- Use only the section headings from this schema, except when the user explicitly asks for a different plan format.",
  "- Start the saved plan with `## Title`; do not use a bare title line or an H1 heading.",
  "- Do not add sections named `Current State`, `Implementation`, `Verification`, or `Done Criteria`.",
  "- Put current-state context inside `## Summary` when needed.",
  "- Put implementation details inside `## Key Changes`.",
  "- Put verification and done criteria inside `## Test Plan`.",
  "- Replace each placeholder with actual plan content; do not copy placeholder text.",
  "Do not include artifact version numbers in the saved plan.",
].join("\n");

export const MAX_PLAN_WRITING_INSTRUCTIONS_CHARS = 8_000;

export function normalizeCustomPlanWritingInstructions(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === DEFAULT_PLAN_WRITING_INSTRUCTIONS) return null;
  return trimmed.slice(0, MAX_PLAN_WRITING_INSTRUCTIONS_CHARS);
}

export function effectivePlanWritingInstructions(custom: string | null | undefined): string {
  return custom?.trim() || DEFAULT_PLAN_WRITING_INSTRUCTIONS;
}
