export const SETTINGS_TARGET_IDS = {
  executionBackend: "execution-backend",
  modelAccess: "model-access",
  claudeBilling: "claude-billing",
  openaiBilling: "openai-billing",
  claudeApiKey: "claude-api-key",
  openaiApiKey: "openai-api-key",
  claudeSubscription: "claude-subscription",
  codexSubscription: "codex-subscription",
} as const;

export type SettingsTargetId =
  (typeof SETTINGS_TARGET_IDS)[keyof typeof SETTINGS_TARGET_IDS];

const SETTINGS_TARGET_ID_SET = new Set<string>(
  Object.values(SETTINGS_TARGET_IDS),
);

export function isSettingsTargetId(
  value: string | null | undefined,
): value is SettingsTargetId {
  return typeof value === "string" && SETTINGS_TARGET_ID_SET.has(value);
}

export function parseSettingsTargetHash(hash: string): SettingsTargetId | null {
  const encoded = hash.replace(/^#/, "");
  if (!encoded) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return isSettingsTargetId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function settingsTargetHref(
  settingsPath: string,
  target: SettingsTargetId,
): string {
  return `${settingsPath}#${target}`;
}

export function focusSettingsTarget(
  target: SettingsTargetId,
  root: Pick<Document, "getElementById"> = document,
): HTMLElement | null {
  const element = root.getElementById(target);
  if (!element) return null;
  element.scrollIntoView?.({ block: "center" });
  element.focus({ preventScroll: true });
  return element;
}
