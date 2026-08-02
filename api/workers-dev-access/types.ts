export type AccessPrincipal =
  | { kind: "owner"; email: string }
  | { kind: "service" }
  | { kind: "local-dev" };

/** Minimal Access identity used by an installed Hub at request time. */
export interface WorkersDevAccessRuntimeTrust {
  ownerEmail: string;
  workersDevHostname: string;
  issuer: string;
  audience: string;
  serviceClientId: string;
}

/** Minimal outbound Access credential used by an installed Hub at request time. */
export interface WorkersDevAccessRuntimeCredential {
  currentSecret: string;
  tokenExpiresAt: string;
}

export interface WorkersDevAccessLifecycle {
  configured: boolean;
  workersDevHostname: string | null;
  tokenExpiresAt: string | null;
  renewalRecommended: boolean;
}
