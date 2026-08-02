import { exchangeOpenAIRuntimeAuth } from "./openai-auth";
import type { Env } from "./types";

export type CodexRuntimeAuthErrorCode =
  | "needs_reconnect"
  | "auth_temporarily_unavailable"
  | "runtime_inactive";

export type CodexRuntimeAuthExchange =
  | {
      ok: true;
      access_token: string;
      account_id: string;
      expires_at: string;
    }
  | {
      ok: false;
      code: CodexRuntimeAuthErrorCode;
      status: 409 | 503;
      error: string;
    };

export function normalizeRejectedAccessTokenSha256(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value.trim())) {
    throw new Error("rejected_access_token_sha256 must be a SHA-256 hex digest");
  }
  return value.trim().toLowerCase();
}

export async function parseCodexRuntimeAuthRequest(
  request: Request,
): Promise<
  | { ok: true; rejectedAccessTokenSha256: string | undefined }
  | { ok: false; response: Response }
> {
  let body: Record<string, unknown> = {};
  const text = await request.text().catch(() => null);
  if (text === null) {
    return { ok: false, response: Response.json({ error: "Request body could not be read." }, { status: 400 }) };
  }
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Request body must be a valid JSON object.");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        response: Response.json({
          error: error instanceof SyntaxError
            ? "Request body must be a valid JSON object."
            : error instanceof Error ? error.message : String(error),
        }, { status: 400 }),
      };
    }
  }
  try {
    return {
      ok: true,
      rejectedAccessTokenSha256: normalizeRejectedAccessTokenSha256(body.rejected_access_token_sha256),
    };
  } catch (error) {
    return {
      ok: false,
      response: Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }),
    };
  }
}

export function codexRuntimeAuthInactiveResponse(): Response {
  return Response.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, { status: 409 });
}

export function codexRuntimeAuthAccountChangedResponse(): Response {
  return Response.json({
    error: "The connected Codex subscription account changed during this runtime. Restart required.",
    code: "needs_reconnect",
  }, { status: 409 });
}

export function codexRuntimeAuthExchangeErrorResponse(
  result: Extract<CodexRuntimeAuthExchange, { ok: false }>,
): Response {
  return Response.json({ error: result.error, code: result.code }, { status: result.status });
}

export function codexRuntimeAuthSuccessResponse(
  result: Extract<CodexRuntimeAuthExchange, { ok: true }>,
): Response {
  return Response.json({
    access_token: result.access_token,
    account_id: result.account_id,
    expires_at: result.expires_at,
  });
}

export async function exchangeCodexRuntimeAuth(
  env: Env,
  rejectedAccessTokenSha256?: string,
): Promise<CodexRuntimeAuthExchange> {
  const result = await exchangeOpenAIRuntimeAuth(env, rejectedAccessTokenSha256);
  if (!result.ok) {
    if (result.reason === "needs_reconnect" || result.reason === "missing") {
      return {
        ok: false,
        code: "needs_reconnect",
        status: 409,
        error: result.reason === "missing"
          ? "Codex subscription login is not connected."
          : "Codex subscription login needs reconnection.",
      };
    }
    return {
      ok: false,
      code: "auth_temporarily_unavailable",
      status: 503,
      error: "Codex subscription login is temporarily unavailable.",
    };
  }
  return {
    ok: true,
    access_token: result.credential.accessToken,
    account_id: result.credential.accountId,
    expires_at: result.credential.expiresAt,
  };
}
