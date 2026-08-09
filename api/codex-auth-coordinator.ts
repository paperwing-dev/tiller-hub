import type { ChatGPTAuthStatus } from "./types";

export const CODEX_AUTH_RECORD_KEY = "codex-auth:record:v1";
export const AUTH_CONNECT_GRANTS_KEY = "auth-connect:grants:v1";
export const CODEX_AUTH_MAX_JSON_BYTES = 64 * 1_024;
export const AUTH_CONNECT_GRANT_TTL_MS = 5 * 60_000;
const AUTH_CONNECT_MAX_STORED_GRANTS = 64;
const REFRESH_EARLY_MS = 5 * 60_000;
const RUNTIME_MIN_VALIDITY_MS = 15_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 2 * 60_000;

export type AuthConnectProvider = "codex" | "claude";
export type AuthConnectProviderStatus = "pending" | "success" | "error";
export interface AuthConnectStatusResult {
  status: AuthConnectProviderStatus | "expired";
  providers: Partial<Record<AuthConnectProvider, AuthConnectProviderStatus>>;
  error?: string;
}
export type CodexAuthDurableStatus =
  | "connected"
  | "needs_reconnect"
  | "temporarily_unavailable";

export interface CodexAuthProjection {
  accessToken: string;
  accountId: string;
  expiresAt: number;
}

export interface CodexAuthRecordV1 {
  version: 1;
  revision: number;
  status: CodexAuthDurableStatus;
  authJson: string;
  projected: CodexAuthProjection;
  connectedAt: string;
  updatedAt: string;
  refreshedAt: string;
  errorCode?: CodexAuthSanitizedErrorCode;
  failureCount?: number;
  retryAt?: number;
}

export type CodexAuthSanitizedErrorCode =
  | "provider_rejected"
  | "account_mismatch"
  | "invalid_credentials"
  | "invalid_refresh_result"
  | "helper_timeout"
  | "helper_unavailable";

export type CodexAuthFailureReason =
  | "missing"
  | "needs_reconnect"
  | "temporarily_unavailable";

export type CodexRuntimeAuthBoundaryResult =
  | {
      ok: true;
      credential: {
        accessToken: string;
        accountId: string;
        expiresAt: string;
      };
    }
  | { ok: false; reason: CodexAuthFailureReason; message: string };

export type CodexConnectBoundaryResult =
  | Extract<CodexRuntimeAuthBoundaryResult, { ok: true }>
  | { ok: false; reason: "needs_reconnect" | "temporarily_unavailable"; message: string };

export interface CodexAuthStatusResult {
  authenticated: boolean;
  status: ChatGPTAuthStatus;
  expires_at?: number;
  account_id?: string;
}

export type CodexAuthHelperResult =
  | {
      version: 1;
      ok: true;
      auth_json: string;
      projected: CodexAuthProjection;
    }
  | {
      version: 1;
      ok: false;
      error: { code: string };
    };

export interface CodexAuthStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface CodexAuthCoordinatorOptions {
  store: CodexAuthStore;
  runHelper(authJson: string): Promise<CodexAuthHelperResult>;
  scheduleRefresh(at: Date, expectedRevision: number): Promise<void>;
  createGrant(): string;
  now?: () => number;
}

interface StoredAuthConnectGrantV1 {
  version: 1;
  hash: string;
  provider: AuthConnectProvider;
  expiresAt: number;
  consumedAt: number | null;
  connectionId?: string;
  result?: Exclude<AuthConnectProviderStatus, "pending">;
  error?: string;
}

interface StoredAuthConnectGrantSetV1 {
  version: 1;
  grants: StoredAuthConnectGrantV1[];
}

function isStoredAuthConnectGrant(value: unknown): value is StoredAuthConnectGrantV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return grant.version === 1
    && typeof grant.hash === "string"
    && /^[0-9a-f]{64}$/.test(grant.hash)
    && (grant.provider === "codex" || grant.provider === "claude")
    && typeof grant.expiresAt === "number"
    && Number.isSafeInteger(grant.expiresAt)
    && (grant.consumedAt === null
      || (typeof grant.consumedAt === "number" && Number.isSafeInteger(grant.consumedAt)))
    && (grant.connectionId === undefined || isAuthConnectConnectionId(grant.connectionId))
    && (grant.result === undefined || grant.result === "success" || grant.result === "error")
    && (grant.error === undefined || (typeof grant.error === "string" && grant.error.length <= 512));
}

function isAuthConnectConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isProjection(value: unknown): value is CodexAuthProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  return typeof projection.accessToken === "string"
    && Boolean(projection.accessToken.trim())
    && typeof projection.accountId === "string"
    && Boolean(projection.accountId.trim())
    && typeof projection.expiresAt === "number"
    && Number.isSafeInteger(projection.expiresAt)
    && projection.expiresAt > 0;
}

export function isCodexAuthHelperResult(value: unknown): value is CodexAuthHelperResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || typeof result.ok !== "boolean") return false;
  if (result.ok) {
    return typeof result.auth_json === "string" && isProjection(result.projected);
  }
  return Boolean(
    result.error
    && typeof result.error === "object"
    && !Array.isArray(result.error)
    && typeof (result.error as { code?: unknown }).code === "string",
  );
}

function helperFailureCode(code: string): {
  errorCode: CodexAuthSanitizedErrorCode;
  permanent: boolean;
} {
  switch (code) {
    case "provider_rejected":
      return { errorCode: "provider_rejected", permanent: true };
    case "account_mismatch":
      return { errorCode: "account_mismatch", permanent: true };
    case "invalid_input":
    case "unsupported_auth_mode":
    case "invalid_credentials":
      return { errorCode: "invalid_credentials", permanent: true };
    case "invalid_refresh_result":
      return { errorCode: "invalid_refresh_result", permanent: false };
    case "refresh_timeout":
      return { errorCode: "helper_timeout", permanent: false };
    default:
      return { errorCode: "helper_unavailable", permanent: false };
  }
}

function failureMessage(reason: CodexAuthFailureReason): string {
  switch (reason) {
    case "missing": return "Codex subscription login is not connected";
    case "needs_reconnect": return "Codex subscription login needs reconnection";
    case "temporarily_unavailable": return "Codex subscription login is temporarily unavailable";
  }
}

export class CodexAuthCoordinator {
  private mutationTail: Promise<void> = Promise.resolve();
  private refreshInFlight: {
    expectedRevision: number | undefined;
    promise: Promise<CodexRuntimeAuthBoundaryResult>;
  } | null = null;
  private rejectedRefreshInFlight: {
    accessToken: string;
    promise: Promise<CodexRuntimeAuthBoundaryResult>;
  } | null = null;
  private rejectedAccessToken: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: CodexAuthCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private readRecord(): Promise<CodexAuthRecordV1 | undefined> {
    return this.options.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
  }

  private async writeRecord(record: CodexAuthRecordV1): Promise<void> {
    await this.options.store.put(CODEX_AUTH_RECORD_KEY, record);
  }

  private success(
    record: CodexAuthRecordV1,
  ): Extract<CodexRuntimeAuthBoundaryResult, { ok: true }> {
    return {
      ok: true,
      credential: {
        accessToken: record.projected.accessToken,
        accountId: record.projected.accountId,
        expiresAt: new Date(record.projected.expiresAt).toISOString(),
      },
    };
  }

  private failure(reason: CodexAuthFailureReason): CodexRuntimeAuthBoundaryResult {
    return { ok: false, reason, message: failureMessage(reason) };
  }

  private async scheduleForRecord(record: CodexAuthRecordV1): Promise<void> {
    const refreshAt = Math.max(this.now() + 1_000, record.projected.expiresAt - REFRESH_EARLY_MS);
    await this.options.scheduleRefresh(new Date(refreshAt), record.revision);
  }

  private async scheduleRetry(record: CodexAuthRecordV1): Promise<void> {
    if (!record.retryAt) throw new Error("Codex auth retry time is missing");
    await this.options.scheduleRefresh(new Date(record.retryAt), record.revision);
  }

  private retryAt(failureCount: number, now: number): number {
    const backoff = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * (2 ** Math.min(3, Math.max(1, failureCount) - 1)),
    );
    return now + backoff;
  }

  private async publishRefreshFailure(
    current: CodexAuthRecordV1,
    options: {
      errorCode: CodexAuthSanitizedErrorCode;
      permanent: boolean;
      rejectedCurrentToken: boolean;
      now: number;
    },
  ): Promise<CodexRuntimeAuthBoundaryResult> {
    const cachedStillValid = current.projected.expiresAt > options.now + RUNTIME_MIN_VALIDITY_MS;
    const cachedUsable = !options.rejectedCurrentToken
      && current.status === "connected"
      && cachedStillValid;
    const failureCount = (current.failureCount ?? 0) + 1;
    const record: CodexAuthRecordV1 = {
      ...current,
      revision: current.revision + 1,
      status: options.permanent
        ? "needs_reconnect"
        : cachedUsable ? "connected" : "temporarily_unavailable",
      updatedAt: new Date(options.now).toISOString(),
      errorCode: options.errorCode,
      failureCount,
      ...(!options.permanent ? { retryAt: this.retryAt(failureCount, options.now) } : {}),
    };
    if (options.permanent) delete record.retryAt;

    // Schedule first so a later scheduling failure can never turn an already
    // published transition into an exception. If this best-effort alarm fails,
    // retryAt still lets an authenticated request recover the record on demand.
    if (!options.permanent) await this.scheduleRetry(record).catch(() => undefined);
    await this.writeRecord(record);
    return cachedUsable && !options.permanent
      ? this.success(record)
      : this.failure(options.permanent ? "needs_reconnect" : "temporarily_unavailable");
  }

  async connect(authJson: string): Promise<CodexConnectBoundaryResult> {
    if (!authJson.trim() || byteLength(authJson) > CODEX_AUTH_MAX_JSON_BYTES) {
      return { ok: false, reason: "needs_reconnect", message: failureMessage("needs_reconnect") };
    }
    return await this.enqueue(async () => {
      let helper: CodexAuthHelperResult;
      try {
        helper = await this.options.runHelper(authJson);
      } catch {
        return { ok: false, reason: "temporarily_unavailable", message: failureMessage("temporarily_unavailable") };
      }
      if (!helper.ok) {
        const mapped = helperFailureCode(helper.error.code);
        const reason = mapped.permanent ? "needs_reconnect" : "temporarily_unavailable";
        return { ok: false, reason, message: failureMessage(reason) };
      }
      if (
        byteLength(helper.auth_json) > CODEX_AUTH_MAX_JSON_BYTES
        || helper.projected.expiresAt <= this.now() + RUNTIME_MIN_VALIDITY_MS
      ) {
        return { ok: false, reason: "needs_reconnect", message: failureMessage("needs_reconnect") };
      }
      const current = await this.readRecord();
      const nowIso = new Date(this.now()).toISOString();
      const record: CodexAuthRecordV1 = {
        version: 1,
        revision: (current?.revision ?? 0) + 1,
        status: "connected",
        authJson: helper.auth_json,
        projected: helper.projected,
        connectedAt: nowIso,
        updatedAt: nowIso,
        refreshedAt: nowIso,
      };
      // A scheduled callback for an unpublished revision is harmless: its
      // revision check observes the current record and performs no mutation.
      await this.scheduleForRecord(record).catch(() => undefined);
      await this.writeRecord(record);
      this.rejectedAccessToken = null;
      return this.success(record);
    });
  }

  private async refreshQueued(
    expectedRevision?: number,
    rejectedAccessToken?: string,
  ): Promise<CodexRuntimeAuthBoundaryResult> {
    const current = await this.readRecord();
    if (!current) return this.failure("missing");
    if (rejectedAccessToken && current.projected.accessToken !== rejectedAccessToken) {
      if (current.status === "needs_reconnect") return this.failure("needs_reconnect");
      return current.status === "connected" && current.projected.expiresAt > this.now()
        ? this.success(current)
        : this.failure("temporarily_unavailable");
    }
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      if (current.status === "needs_reconnect") return this.failure("needs_reconnect");
      if (current.projected.expiresAt > this.now()) return this.success(current);
      return this.failure("temporarily_unavailable");
    }
    if (current.status === "needs_reconnect") return this.failure("needs_reconnect");
    const rejectedCurrentToken = rejectedAccessToken === current.projected.accessToken;

    let helper: CodexAuthHelperResult;
    try {
      helper = await this.options.runHelper(current.authJson);
    } catch {
      helper = { version: 1, ok: false, error: { code: "refresh_failed" } };
    }
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    if (!helper.ok) {
      const mapped = helperFailureCode(helper.error.code);
      return await this.publishRefreshFailure(current, {
        errorCode: mapped.errorCode,
        permanent: mapped.permanent,
        rejectedCurrentToken,
        now,
      });
    }
    const refreshMadeProgress = helper.projected.accessToken !== current.projected.accessToken
      && helper.projected.expiresAt > current.projected.expiresAt;
    const invalidResult = byteLength(helper.auth_json) > CODEX_AUTH_MAX_JSON_BYTES
      || helper.projected.expiresAt <= now + RUNTIME_MIN_VALIDITY_MS
      || !refreshMadeProgress;
    const accountChanged = helper.projected.accountId !== current.projected.accountId;
    if (invalidResult || accountChanged) {
      const permanent = accountChanged;
      return await this.publishRefreshFailure(current, {
        errorCode: permanent ? "account_mismatch" : "invalid_refresh_result",
        permanent,
        rejectedCurrentToken,
        now,
      });
    }

    const record: CodexAuthRecordV1 = {
      ...current,
      revision: current.revision + 1,
      status: "connected",
      authJson: helper.auth_json,
      projected: helper.projected,
      updatedAt: nowIso,
      refreshedAt: nowIso,
    };
    delete record.errorCode;
    delete record.failureCount;
    delete record.retryAt;
    await this.scheduleForRecord(record).catch(() => undefined);
    await this.writeRecord(record);
    this.rejectedAccessToken = null;
    return this.success(record);
  }

  private refresh(expectedRevision?: number): Promise<CodexRuntimeAuthBoundaryResult> {
    const inFlight = this.refreshInFlight;
    if (inFlight && inFlight.expectedRevision === expectedRevision) {
      return inFlight.promise;
    }
    const refresh = this.enqueue(() => this.refreshQueued(expectedRevision)).finally(() => {
      if (this.refreshInFlight?.promise === refresh) this.refreshInFlight = null;
    });
    this.refreshInFlight = { expectedRevision, promise: refresh };
    return refresh;
  }

  private refreshRejectedToken(
    record: CodexAuthRecordV1,
  ): Promise<CodexRuntimeAuthBoundaryResult> {
    const inFlight = this.rejectedRefreshInFlight;
    if (inFlight?.accessToken === record.projected.accessToken) {
      return inFlight.promise;
    }
    this.rejectedAccessToken = record.projected.accessToken;
    const refresh = this.enqueue(() => this.refreshQueued(
      undefined,
      record.projected.accessToken,
    )).catch(() => this.failure("temporarily_unavailable")).finally(() => {
      if (this.rejectedRefreshInFlight?.promise === refresh) {
        this.rejectedRefreshInFlight = null;
      }
    });
    this.rejectedRefreshInFlight = { accessToken: record.projected.accessToken, promise: refresh };
    return refresh;
  }

  async scheduledRefresh(expectedRevision: number): Promise<void> {
    await this.refresh(expectedRevision);
  }

  async exchange(rejectedAccessTokenSha256?: string): Promise<CodexRuntimeAuthBoundaryResult> {
    const record = await this.readRecord();
    if (!record) return this.failure("missing");
    if (record.status === "needs_reconnect") return this.failure("needs_reconnect");
    if (record.status === "temporarily_unavailable") {
      if (record.retryAt && record.retryAt > this.now()) {
        return this.failure("temporarily_unavailable");
      }
      return await this.refresh(record.revision);
    }
    const rejected = rejectedAccessTokenSha256?.trim().toLowerCase();
    if (!rejected && record.projected.accessToken === this.rejectedAccessToken) {
      return this.failure("temporarily_unavailable");
    }
    if (rejected) {
      const currentHash = await sha256Hex(record.projected.accessToken);
      if (rejected !== currentHash) {
        return record.projected.accessToken !== this.rejectedAccessToken
          && record.projected.expiresAt > this.now()
          ? this.success(record)
          : this.failure("temporarily_unavailable");
      }
      return await this.refreshRejectedToken(record);
    }
    if (record.projected.expiresAt > this.now() + RUNTIME_MIN_VALIDITY_MS) {
      return this.success(record);
    }
    return await this.refresh(record.revision);
  }

  async status(refresh = false): Promise<CodexAuthStatusResult> {
    if (refresh) await this.exchange();
    const record = await this.readRecord();
    if (!record) return { authenticated: false, status: "missing" };
    const unexpired = record.projected.expiresAt > this.now() + RUNTIME_MIN_VALIDITY_MS;
    const tokenRejected = record.projected.accessToken === this.rejectedAccessToken;
    const status: ChatGPTAuthStatus = record.status === "connected" && unexpired && !tokenRejected
      ? (this.refreshInFlight ? "refreshing" : "connected")
      : record.status === "needs_reconnect"
        ? "needs_reconnect"
        : "temporarily_unavailable";
    return {
      authenticated: status === "connected" || status === "refreshing",
      status,
      expires_at: record.projected.expiresAt,
      account_id: record.projected.accountId,
    };
  }

  async issueGrants(
    providers: AuthConnectProvider[],
    connectionId?: string,
  ): Promise<Record<AuthConnectProvider, string | undefined>> {
    if (connectionId !== undefined && !isAuthConnectConnectionId(connectionId)) {
      throw new Error("Invalid authentication connection ID");
    }
    const unique = [...new Set(providers)];
    const result: Record<AuthConnectProvider, string | undefined> = { codex: undefined, claude: undefined };
    await this.enqueue(async () => {
      const now = this.now();
      const stored = await this.options.store.get<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY);
      const retained = stored?.version === 1 && Array.isArray(stored.grants)
        ? stored.grants.filter((grant) => isStoredAuthConnectGrant(grant) && grant.expiresAt > now)
        : [];
      const issued: StoredAuthConnectGrantV1[] = [];
      for (const provider of unique) {
        const grant = this.options.createGrant();
        const hash = await sha256Hex(grant);
        const record: StoredAuthConnectGrantV1 = {
          version: 1,
          hash,
          provider,
          expiresAt: now + AUTH_CONNECT_GRANT_TTL_MS,
          consumedAt: null,
          ...(connectionId ? { connectionId } : {}),
        };
        issued.push(record);
        result[provider] = grant;
      }
      const keepCount = Math.max(0, AUTH_CONNECT_MAX_STORED_GRANTS - issued.length);
      await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
        version: 1,
        grants: [
          ...(keepCount === 0 ? [] : retained.slice(-keepCount)),
          ...issued,
        ].slice(-AUTH_CONNECT_MAX_STORED_GRANTS),
      });
    });
    return result;
  }

  async consumeGrant(provider: AuthConnectProvider, grant: string): Promise<boolean> {
    if (!grant.trim() || grant.length > 256) return false;
    return await this.enqueue(async () => {
      const hash = await sha256Hex(grant.trim());
      const now = this.now();
      const stored = await this.options.store.get<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY);
      const storedSetIsValid = stored?.version === 1 && Array.isArray(stored.grants);
      const storedGrantCount = storedSetIsValid ? stored.grants.length : 0;
      const grants = storedSetIsValid
        ? stored.grants.filter((record) => isStoredAuthConnectGrant(record) && record.expiresAt > now)
        : [];
      const record = grants.find((candidate) => candidate.hash === hash);
      if (
        !record
        || record.version !== 1
        || record.hash !== hash
        || record.provider !== provider
        || record.consumedAt !== null
      ) {
        if (stored && (!storedSetIsValid || grants.length !== storedGrantCount)) {
          await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
            version: 1,
            grants,
          });
        }
        return false;
      }
      record.consumedAt = now;
      await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
        version: 1,
        grants,
      });
      return true;
    });
  }

  async recordGrantResult(
    provider: AuthConnectProvider,
    grant: string,
    result: Exclude<AuthConnectProviderStatus, "pending">,
    error?: string,
  ): Promise<boolean> {
    if (!grant.trim() || grant.length > 256) return false;
    return await this.enqueue(async () => {
      const hash = await sha256Hex(grant.trim());
      const now = this.now();
      const stored = await this.options.store.get<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY);
      const storedSetIsValid = stored?.version === 1 && Array.isArray(stored.grants);
      const storedGrantCount = storedSetIsValid ? stored.grants.length : 0;
      const grants = storedSetIsValid
        ? stored.grants.filter((record) => isStoredAuthConnectGrant(record) && record.expiresAt > now)
        : [];
      const record = grants.find((candidate) => candidate.hash === hash);
      if (
        !record
        || record.provider !== provider
        || record.consumedAt === null
        || !record.connectionId
      ) {
        if (stored && (!storedSetIsValid || grants.length !== storedGrantCount)) {
          await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
            version: 1,
            grants,
          });
        }
        return false;
      }
      record.result = result;
      const sanitizedError = error?.trim().slice(0, 512);
      if (result === "error" && sanitizedError) record.error = sanitizedError;
      else delete record.error;
      await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
        version: 1,
        grants,
      });
      return true;
    });
  }

  async connectionStatus(connectionId: string): Promise<AuthConnectStatusResult> {
    if (!isAuthConnectConnectionId(connectionId)) {
      return { status: "expired", providers: {} };
    }
    return await this.enqueue(async () => {
      const now = this.now();
      const stored = await this.options.store.get<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY);
      const storedSetIsValid = stored?.version === 1 && Array.isArray(stored.grants);
      const storedGrantCount = storedSetIsValid ? stored.grants.length : 0;
      const grants = storedSetIsValid
        ? stored.grants.filter((record) => isStoredAuthConnectGrant(record) && record.expiresAt > now)
        : [];
      if (stored && (!storedSetIsValid || grants.length !== storedGrantCount)) {
        await this.options.store.put<StoredAuthConnectGrantSetV1>(AUTH_CONNECT_GRANTS_KEY, {
          version: 1,
          grants,
        });
      }
      const connectionGrants = grants.filter((record) => record.connectionId === connectionId);
      if (connectionGrants.length === 0) return { status: "expired", providers: {} };

      const providers: Partial<Record<AuthConnectProvider, AuthConnectProviderStatus>> = {};
      for (const record of connectionGrants) {
        providers[record.provider] = record.result ?? "pending";
      }
      const failed = connectionGrants.find((record) => record.result === "error");
      if (failed) {
        return {
          status: "error",
          providers,
          ...(failed.error ? { error: failed.error } : {}),
        };
      }
      return {
        status: connectionGrants.every((record) => record.result === "success") ? "success" : "pending",
        providers,
      };
    });
  }
}
