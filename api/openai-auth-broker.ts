import type { ChatGPTAuthStatus, Env } from "./types";

export const OPENAI_TOKENS_KEY = "openai:oauth:tokens";
const OPENAI_STATUS_KEY = "openai:oauth:status";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const REFRESH_BUFFER_MS = 60_000;
const REFRESH_TIMEOUT_MS = 5_000;

interface OpenAITokenClaims {
  chatgpt_account_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface OpenAITokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface StoredOpenAIAuth {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
  expires_at: number;
}

export interface SeedOpenAIAuthInput {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

export type OpenAIAuthFailureReason = "missing" | "needs_reconnect" | "temporarily_unavailable";

export type OpenAIRuntimeAuthResult =
  | {
      ok: true;
      credential: {
        accessToken: string;
        accountId: string;
        expiresAt: string;
      };
      stored: StoredOpenAIAuth;
    }
  | { ok: false; reason: OpenAIAuthFailureReason; message: string };

/** The only credential shape permitted to cross the HubDO RPC boundary. */
export type OpenAIRuntimeAuthBoundaryResult =
  | {
      ok: true;
      credential: {
        accessToken: string;
        accountId: string;
        expiresAt: string;
      };
    }
  | { ok: false; reason: OpenAIAuthFailureReason; message: string };

export type OpenAIImportResult =
  | { ok: true; stored: StoredOpenAIAuth }
  | { ok: false; reason: Exclude<OpenAIAuthFailureReason, "missing">; message: string };

export type OpenAIImportBoundaryResult =
  | {
      ok: true;
      credential: {
        accessToken: string;
        accountId: string;
        expiresAt: string;
      };
    }
  | { ok: false; reason: Exclude<OpenAIAuthFailureReason, "missing">; message: string };

export function toOpenAIRuntimeAuthBoundary(
  result: OpenAIRuntimeAuthResult,
): OpenAIRuntimeAuthBoundaryResult {
  return result.ok
    ? { ok: true, credential: result.credential }
    : result;
}

export function toOpenAIImportBoundary(
  result: OpenAIImportResult,
): OpenAIImportBoundaryResult {
  if (!result.ok) return result;
  const accountId = result.stored.account_id;
  if (!accountId) {
    return {
      ok: false,
      reason: "needs_reconnect",
      message: "Imported OpenAI credentials do not contain a ChatGPT account identity",
    };
  }
  return {
    ok: true,
    credential: {
      accessToken: result.stored.access_token,
      accountId,
      expiresAt: new Date(result.stored.expires_at).toISOString(),
    },
  };
}

interface StoredCredentialStatus {
  status: "connected" | "needs_reconnect" | "temporarily_unavailable";
  updated_at: string;
  message?: string;
}

export interface OpenAIAuthStatusResult {
  authenticated: boolean;
  status: ChatGPTAuthStatus;
  expires_at?: number;
  account_id?: string;
}

function decodeBase64UrlJson<T>(value: string): T | undefined {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

function parseJwtClaims(token: string): OpenAITokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  return decodeBase64UrlJson<OpenAITokenClaims>(parts[1]);
}

export function extractChatGPTAccountIdFromClaims(claims: OpenAITokenClaims): string | undefined {
  const accountId = claims.chatgpt_account_id
    ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

export function extractChatGPTAccountIdFromTokens(tokens: {
  access_token: string;
  id_token?: string;
}): string | undefined {
  const idTokenAccount = tokens.id_token
    ? extractChatGPTAccountIdFromClaims(parseJwtClaims(tokens.id_token) ?? {})
    : undefined;
  const accessTokenAccount = extractChatGPTAccountIdFromClaims(parseJwtClaims(tokens.access_token) ?? {});
  if (idTokenAccount && accessTokenAccount && idTokenAccount !== accessTokenAccount) return undefined;
  return idTokenAccount ?? accessTokenAccount;
}

function expiryFromSeconds(value: unknown): number {
  const seconds = typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_EXPIRES_IN_SECONDS;
  return Date.now() + seconds * 1000;
}

export function buildSeededOpenAIAuth(input: SeedOpenAIAuthInput): StoredOpenAIAuth {
  return {
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    ...(input.id_token ? { id_token: input.id_token } : {}),
    account_id: extractChatGPTAccountIdFromTokens(input),
    expires_at: expiryFromSeconds(input.expires_in),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function permanentRefreshFailure(status: number, payload: OpenAITokenResponse): boolean {
  const error = typeof payload.error === "string" ? payload.error.toLowerCase() : "";
  return status >= 400 && status < 500 && status !== 429
    || error === "invalid_grant";
}

function responseErrorMessage(status: number, payload: OpenAITokenResponse): string {
  const description = typeof payload.error_description === "string" ? payload.error_description.trim() : "";
  const error = typeof payload.error === "string" ? payload.error.trim() : "";
  return description || error || `OpenAI token refresh failed: ${status}`;
}

export class OpenAIAuthBroker {
  private mutationTail: Promise<void> = Promise.resolve();
  private rejectedRefreshes = new Map<string, Promise<OpenAIRuntimeAuthResult>>();

  constructor(private readonly env: Pick<Env, "ENVS_KV">) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readStored(): Promise<StoredOpenAIAuth | null> {
    return await this.env.ENVS_KV.get<StoredOpenAIAuth>(OPENAI_TOKENS_KEY, "json") ?? null;
  }

  private async readStatus(): Promise<StoredCredentialStatus | null> {
    return await this.env.ENVS_KV.get<StoredCredentialStatus>(OPENAI_STATUS_KEY, "json") ?? null;
  }

  private async writeStatus(status: StoredCredentialStatus["status"], message?: string): Promise<void> {
    await this.env.ENVS_KV.put(OPENAI_STATUS_KEY, JSON.stringify({
      status,
      updated_at: new Date().toISOString(),
      ...(message ? { message } : {}),
    } satisfies StoredCredentialStatus));
  }

  private async commit(auth: StoredOpenAIAuth): Promise<void> {
    await this.env.ENVS_KV.put(OPENAI_TOKENS_KEY, JSON.stringify(auth));
    await this.writeStatus("connected");
  }

  async seedForTests(input: SeedOpenAIAuthInput): Promise<StoredOpenAIAuth> {
    return await this.enqueue(async () => {
      const stored = buildSeededOpenAIAuth(input);
      await this.commit(stored);
      return stored;
    });
  }

  private async requestRefresh(current: StoredOpenAIAuth): Promise<
    | { ok: true; auth: StoredOpenAIAuth }
    | { ok: false; reason: "needs_reconnect" | "temporarily_unavailable"; message: string }
  > {
    let response: Response;
    try {
      response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refresh_token,
          client_id: OPENAI_OAUTH_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        reason: "temporarily_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const payload = await response.json().catch(() => ({})) as OpenAITokenResponse;
    if (!response.ok) {
      const message = responseErrorMessage(response.status, payload);
      return {
        ok: false,
        reason: permanentRefreshFailure(response.status, payload) ? "needs_reconnect" : "temporarily_unavailable",
        message,
      };
    }

    const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    const rotatedRefreshToken = payload.refresh_token === undefined
      ? current.refresh_token
      : typeof payload.refresh_token === "string"
        ? payload.refresh_token.trim()
        : "";
    const idToken = payload.id_token === undefined
      ? undefined
      : typeof payload.id_token === "string"
        ? payload.id_token.trim()
        : "";
    if (!accessToken || !rotatedRefreshToken || idToken === "") {
      return { ok: false, reason: "needs_reconnect", message: "OpenAI token refresh returned invalid credentials" };
    }
    const accountId = extractChatGPTAccountIdFromTokens({
      access_token: accessToken,
      ...(idToken ? { id_token: idToken } : {}),
    });
    if (!accountId) {
      return { ok: false, reason: "needs_reconnect", message: "OpenAI credentials do not contain a ChatGPT account identity" };
    }
    return {
      ok: true,
      auth: {
        access_token: accessToken,
        refresh_token: rotatedRefreshToken,
        ...(idToken ? { id_token: idToken } : current.id_token ? { id_token: current.id_token } : {}),
        account_id: accountId,
        expires_at: expiryFromSeconds(payload.expires_in),
      },
    };
  }

  async import(input: SeedOpenAIAuthInput): Promise<OpenAIImportResult> {
    return await this.enqueue(async () => {
      const candidate = buildSeededOpenAIAuth(input);
      if (!candidate.access_token.trim() || !candidate.refresh_token.trim()) {
        return { ok: false, reason: "needs_reconnect", message: "Imported OpenAI credentials are incomplete" };
      }
      const refreshed = await this.requestRefresh(candidate);
      if (!refreshed.ok) {
        // Explicit import is allowed to replace identities, but only a fully
        // validated refresh result may replace the existing record or status.
        return refreshed;
      }
      await this.commit(refreshed.auth);
      return { ok: true, stored: refreshed.auth };
    });
  }

  private validateStoredIdentity(stored: StoredOpenAIAuth): string | null {
    const claimed = extractChatGPTAccountIdFromTokens(stored);
    const recorded = stored.account_id?.trim() ?? "";
    return claimed && recorded && claimed === recorded ? recorded : null;
  }

  private async runtimeAuthQueued(rejectedAccessTokenSha256?: string): Promise<OpenAIRuntimeAuthResult> {
    const stored = await this.readStored();
    if (!stored) return { ok: false, reason: "missing", message: "OpenAI auth not seeded" };
    const accountId = this.validateStoredIdentity(stored);
    if (!accountId || !stored.refresh_token?.trim() || !stored.access_token?.trim()) {
      await this.writeStatus("needs_reconnect", "Stored OpenAI credentials require re-import");
      return { ok: false, reason: "needs_reconnect", message: "Stored OpenAI credentials require re-import" };
    }

    const currentHash = await sha256Hex(stored.access_token);
    const rejected = rejectedAccessTokenSha256?.trim().toLowerCase();
    const forceRefresh = Boolean(rejected && rejected === currentHash);
    // A request that rejected an older token can immediately use the already
    // rotated token; it must not trigger a second refresh.
    if (rejected && rejected !== currentHash) {
      return this.success(stored, accountId);
    }
    if (!forceRefresh && stored.expires_at > Date.now() + REFRESH_BUFFER_MS) {
      return this.success(stored, accountId);
    }

    const refreshed = await this.requestRefresh(stored);
    if (!refreshed.ok) {
      await this.writeStatus(
        refreshed.reason === "needs_reconnect" ? "needs_reconnect" : "temporarily_unavailable",
        refreshed.message,
      );
      return refreshed;
    }
    if (refreshed.auth.account_id !== accountId) {
      const message = "OpenAI token refresh changed the ChatGPT account identity";
      await this.writeStatus("needs_reconnect", message);
      return { ok: false, reason: "needs_reconnect", message };
    }
    await this.commit(refreshed.auth);
    return this.success(refreshed.auth, accountId);
  }

  private success(stored: StoredOpenAIAuth, accountId: string): OpenAIRuntimeAuthResult {
    return {
      ok: true,
      stored,
      credential: {
        accessToken: stored.access_token,
        accountId,
        expiresAt: new Date(stored.expires_at).toISOString(),
      },
    };
  }

  runtimeAuth(rejectedAccessTokenSha256?: string): Promise<OpenAIRuntimeAuthResult> {
    const rejected = rejectedAccessTokenSha256?.trim().toLowerCase();
    if (!rejected) return this.enqueue(() => this.runtimeAuthQueued());
    const existing = this.rejectedRefreshes.get(rejected);
    if (existing) return existing;
    const request = this.enqueue(() => this.runtimeAuthQueued(rejected)).finally(() => {
      if (this.rejectedRefreshes.get(rejected) === request) this.rejectedRefreshes.delete(rejected);
    });
    this.rejectedRefreshes.set(rejected, request);
    return request;
  }

  async getReadOnlyStatus(): Promise<OpenAIAuthStatusResult> {
    const [stored, credentialStatus] = await Promise.all([this.readStored(), this.readStatus()]);
    if (!stored) return { authenticated: false, status: "missing" };
    const accountId = this.validateStoredIdentity(stored);
    if (!accountId || !stored.access_token?.trim() || !stored.refresh_token?.trim()) {
      return {
        authenticated: false,
        status: "needs_reconnect",
        expires_at: stored.expires_at,
        account_id: stored.account_id,
      };
    }
    if (credentialStatus?.status === "needs_reconnect" || credentialStatus?.status === "temporarily_unavailable") {
      return {
        authenticated: false,
        status: credentialStatus.status,
        expires_at: stored.expires_at,
        account_id: accountId,
      };
    }
    return {
      authenticated: true,
      status: "connected",
      expires_at: stored.expires_at,
      account_id: accountId,
    };
  }

  async getStatus(options: { refresh?: boolean } = {}): Promise<OpenAIAuthStatusResult> {
    const readonly = await this.getReadOnlyStatus();
    if (!options.refresh || readonly.status === "missing") return readonly;
    if (readonly.status === "connected" && (readonly.expires_at ?? 0) > Date.now() + REFRESH_BUFFER_MS) {
      return readonly;
    }
    const result = await this.runtimeAuth();
    if (!result.ok) {
      const stored = await this.readStored();
      return {
        authenticated: false,
        status: result.reason,
        ...(stored ? { expires_at: stored.expires_at, account_id: stored.account_id } : {}),
      };
    }
    return {
      authenticated: true,
      status: "connected",
      expires_at: result.stored.expires_at,
      account_id: result.credential.accountId,
    };
  }
}
