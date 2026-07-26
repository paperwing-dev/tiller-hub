import type {
  PlanWriterState,
  ObservedPlanPublication,
  PlanWriterProvider,
  ReviewerRegistryEntry,
} from "../coordination";
import { MAX_PLAN_MARKDOWN_BYTES } from "../coordination/planning";

export const MAX_PLAN_PUBLICATION_BYTES = MAX_PLAN_MARKDOWN_BYTES;
export const MAX_PROVIDER_IDENTIFIER_BYTES = 256;

const textEncoder = new TextEncoder();

function boundedIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  const bytes = textEncoder.encode(trimmed).byteLength;
  if (!trimmed || bytes > MAX_PROVIDER_IDENTIFIER_BYTES || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`${label} must be a non-empty identifier no larger than ${MAX_PROVIDER_IDENTIFIER_BYTES} bytes`);
  }
  return trimmed;
}

export function normalizePlanWriterIdentifier(value: string, label: string): string {
  return boundedIdentifier(value, label);
}

/** Normalize a provider's complete plan without aggressive planner-output cleanup. */
export function normalizeObservedPlanMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").replace(/(?:\n[ \t]*)+$/u, "");
  if (!normalized.trim()) throw new Error("Published plan Markdown cannot be empty");
  if (textEncoder.encode(normalized).byteLength + 1 > MAX_PLAN_PUBLICATION_BYTES) {
    throw new Error(`Published plan Markdown exceeds ${MAX_PLAN_PUBLICATION_BYTES} UTF-8 bytes`);
  }
  return `${normalized}\n`;
}

export function normalizeCanonicalPlanForDigest(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").replace(/(?:\n[ \t]*)+$/u, "");
  return normalized ? `${normalized}\n` : "";
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function normalizeObservedPlanPublication(
  input: ObservedPlanPublication,
): Promise<ObservedPlanPublication> {
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new Error("generation must be a positive integer");
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  const markdown = normalizeObservedPlanMarkdown(input.markdown);
  const bodyDigest = await sha256Hex(markdown);
  if (input.bodyDigest.trim().toLowerCase() !== bodyDigest) {
    throw new Error("bodyDigest does not match the normalized Markdown");
  }
  return {
    ...input,
    repoId: boundedIdentifier(input.repoId, "repoId"),
    planArtifactId: boundedIdentifier(input.planArtifactId, "planArtifactId"),
    providerConversationId: boundedIdentifier(input.providerConversationId, "providerConversationId"),
    providerEventId: boundedIdentifier(input.providerEventId, "providerEventId"),
    markdown,
    bodyDigest,
  };
}

function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

/** Deterministic from the sole writer identity; bounded for Hub session IDs. */
export function planWriterTerminalId(repoId: string, planArtifactId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) throw new Error("generation must be a positive integer");
  return `plan-writer-${stableHash(`${repoId}\0${planArtifactId}`)}-${generation}`;
}

export function isPlanWriterProvider(value: unknown): value is PlanWriterProvider {
  return value === "claude-code" || value === "codex";
}

export function derivePlanWriterState(
  writer: ReviewerRegistryEntry | null,
  editable: boolean,
): PlanWriterState {
  const generation = writer?.generation ?? null;
  const active = Boolean(writer && !writer.stoppedAt && !writer.startupError && !writer.cleanupError);
  const lifecycle = !active
    ? "not_running"
    : writer?.runtime && writer.status === "running" && writer.providerConversationId
      ? "running"
      : "starting";
  const synchronizationError = writer?.synchronizationError?.trim() || null;
  return {
    lifecycle,
    generation,
    provider: isPlanWriterProvider(writer?.provider) ? writer.provider : null,
    model: writer?.model ?? null,
    effort: writer?.effort ?? null,
    basisCommit: writer?.basisCommit ?? null,
    terminalId: generation && writer
      ? planWriterTerminalId(writer.repoId, writer.planArtifactId, generation)
      : null,
    ...(writer?.codexAuthMode ? { codexAuthMode: writer.codexAuthMode } : {}),
    ...(writer?.stopReason ? { stopReason: writer.stopReason } : {}),
    ...(writer?.startupError ? { startupError: writer.startupError } : {}),
    ...(writer?.cleanupError ? { cleanupError: writer.cleanupError } : {}),
    synchronization: synchronizationError
      ? { state: "sync_failed", error: synchronizationError }
      : { state: "up_to_date" },
    editable,
  };
}
