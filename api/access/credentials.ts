import type { Env } from "../types";
import {
  readCanonicalWorkersDevAccessTrust,
  readWorkersDevAccessCredential,
} from "../workers-dev-access/records";
import { resolveCanonicalHubOrigin } from "../canonical-origin";

export interface AccessServiceCredential {
  clientId: string;
  clientSecret: string;
  tokenExpiresAt: string | null;
}

/** Resolve the outbound credential for the active Hub URL without caching it. */
export async function readAccessServiceCredential(
  env: Env,
  hubUrl: string,
): Promise<AccessServiceCredential | null> {
  const [canonicalOrigin, trust, credential] = await Promise.all([
    resolveCanonicalHubOrigin(env),
    readCanonicalWorkersDevAccessTrust(env),
    readWorkersDevAccessCredential(env),
  ]);
  if (
    new URL(hubUrl).origin !== canonicalOrigin
    || !trust
    || !credential?.currentSecret
  ) return null;
  return {
    clientId: trust.serviceClientId,
    clientSecret: credential.currentSecret,
    tokenExpiresAt: credential.tokenExpiresAt,
  };
}
