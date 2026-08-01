export type WorkersDevAccessOperation = "bootstrap" | "renew";

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

export interface WorkersDevAccessTrustV1 extends WorkersDevAccessRuntimeTrust {
  version: 1;
  accountId: string;
  workerName: string;
  serviceTokenId: string;
  configuredAt: string;
}

/** Minimal outbound Access credential used by an installed Hub at request time. */
export interface WorkersDevAccessRuntimeCredential {
  currentSecret: string;
  tokenExpiresAt: string;
}

export interface WorkersDevAccessCredentialV1 extends WorkersDevAccessRuntimeCredential {
  version: 1;
  updatedAt: string;
}

export interface PendingWorkersDevAccessJobV1 {
  version: 1;
  jobId: string;
  operation: WorkersDevAccessOperation;
  origin: string;
  workerName: string;
  jobSecretSha256: string;
  registrationState: "registering" | "registered";
  registrationDeadline: string;
  registeredAt?: string;
  mutationStartedAt?: string;
  completionDeadline: string;
}

export interface CompletedWorkersDevAccessJobV1 {
  version: 1;
  jobId: string;
  jobSecretSha256: string;
  resultDigest: string;
  expiresAt: string;
}

export interface WorkersDevAccessBootstrapResultV1 {
  trust: WorkersDevAccessTrustV1;
  credential: WorkersDevAccessCredentialV1;
}

export interface WorkersDevAccessRenewResultV1 {
  accountId: string;
  serviceTokenId: string;
  serviceClientId: string;
  tokenExpiresAt: string;
  updatedAt: string;
}

export type WorkersDevAccessCompletionResult =
  | WorkersDevAccessBootstrapResultV1
  | WorkersDevAccessRenewResultV1;

export interface WorkersDevAccessJobAuthentication {
  jobId: string;
  jobSecret: string;
  operation: WorkersDevAccessOperation;
  origin: string;
  workerName: string;
}

export interface WorkersDevAccessLifecycle {
  configured: boolean;
  workersDevHostname: string | null;
  tokenExpiresAt: string | null;
  renewalRecommended: boolean;
}
