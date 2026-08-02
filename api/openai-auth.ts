import type {
  CodexAuthStatusResult,
  CodexRuntimeAuthBoundaryResult,
} from "./codex-auth-coordinator";
import type { Env } from "./types";

interface CodexAuthStub {
  exchangeCodexRuntimeAuth(rejectedAccessTokenSha256?: string): Promise<CodexRuntimeAuthBoundaryResult>;
  getCodexAuthStatus(refresh?: boolean): Promise<CodexAuthStatusResult>;
}

function codexAuth(env: Env): CodexAuthStub {
  const id = env.CODEX_AUTH.idFromName("codex-auth");
  return env.CODEX_AUTH.get(id) as unknown as CodexAuthStub;
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
