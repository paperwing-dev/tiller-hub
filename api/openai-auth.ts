import type {
  CodexAuthStatusResult,
  CodexRuntimeAuthBoundaryResult,
} from "./codex-auth-coordinator";
import type { Env } from "./types";
import { getDurableObjectStub } from "./durable-object";

export const DEFAULT_OPENAI_MODEL = "gpt-5.5";

interface CodexAuthStub {
  exchangeCodexRuntimeAuth(rejectedAccessTokenSha256?: string): Promise<CodexRuntimeAuthBoundaryResult>;
  getCodexAuthStatus(refresh?: boolean): Promise<CodexAuthStatusResult>;
}

function codexAuth(env: Env): CodexAuthStub {
  return getDurableObjectStub<CodexAuthStub>(env, env.CODEX_AUTH, "codex-auth");
}

export function exchangeOpenAIRuntimeAuth(
  env: Env,
  rejectedAccessTokenSha256?: string,
): Promise<CodexRuntimeAuthBoundaryResult> {
  return codexAuth(env).exchangeCodexRuntimeAuth(rejectedAccessTokenSha256);
}

export function getStatus(env: Env): Promise<CodexAuthStatusResult> {
  return codexAuth(env).getCodexAuthStatus(true);
}

export function getReadOnlyStatus(env: Env): Promise<CodexAuthStatusResult> {
  return codexAuth(env).getCodexAuthStatus(false);
}
