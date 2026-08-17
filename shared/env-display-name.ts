export const MAX_ENV_DISPLAY_NAME_CODE_POINTS = 80;

export function normalizeEnvDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;

  const codePoints = Array.from(normalized);
  return codePoints.length <= MAX_ENV_DISPLAY_NAME_CODE_POINTS
    ? normalized
    : `${codePoints.slice(0, MAX_ENV_DISPLAY_NAME_CODE_POINTS - 1).join("")}…`;
}

export function deriveEnvDisplayName(
  selectedPlan: { title?: unknown } | null,
  sidebarSlot: number,
): string {
  if (!selectedPlan) return `Scratch #${sidebarSlot}`;
  return normalizeEnvDisplayName(selectedPlan.title) ?? `Plan #${sidebarSlot}`;
}
