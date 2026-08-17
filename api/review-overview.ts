import type { FrozenOverviewPayload } from "./coordination";

export function buildSkillOverviewPrompt(payload: FrozenOverviewPayload): string {
  const reports = payload.reports
    .map((report) =>
      [
        `### ${report.agentLabel}`,
        `Attribution: agent ${report.agentId}, run ${report.runId}, message ${report.messageId}`,
        report.text,
      ].join("\n"),
    )
    .join("\n\n");
  const failures = payload.failureNotices
    .map(
      (notice) =>
        `- ${notice.agentLabel} (${notice.agentId}): ${notice.status}${notice.error ? ` — ${notice.error}` : ""}`,
    )
    .join("\n");
  return [
    `You are the ${payload.skillLabel} Overview reviewer.`,
    "Synthesize only the frozen Reports below into one concise review.",
    "Deduplicate findings, reconcile disagreements, preserve useful attribution, and recommend only work worth doing.",
    "Give brief, user-facing progress updates as you synthesize. Summarize intent and conclusions; do not expose private chain-of-thought.",
    "Do not re-review the workspace or introduce findings that are absent from the Reports.",
    "Remove report-level boilerplate from the Reports.",
    "Retain an inspection limitation only when it is tied to a specific included finding and materially affects that finding.",
    "Return concise Markdown with substantive findings first. If no actionable finding survives synthesis, say so directly.",
    "",
    "Overview instructions:",
    payload.overviewInstructions.trim() ||
      "Deduplicate the included Reports and preserve attribution.",
    "",
    "Included Reports:",
    reports || "None.",
    "",
    "Initial Report failure notices:",
    failures || "None.",
    "",
    "User guidance:",
    payload.guidance ?? "None.",
  ].join("\n");
}
