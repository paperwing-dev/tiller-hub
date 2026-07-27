export type WorkersDevAccessOperation = "bootstrap" | "renew";

export type AccessPrincipal =
  | { kind: "owner"; email: string }
  | { kind: "service" }
  | { kind: "local-dev" };

export interface WorkersDevAccessTrustV1 {
  version: 1;
  ownerEmail: string;
  accountId: string;
  workerName: string;
  workersDevHostname: string;
  issuer: string;
  audience: string;
  serviceTokenId: string;
  serviceClientId: string;
  configuredAt: string;
}

export interface WorkersDevAccessCredentialV1 {
  version: 1;
  currentSecret: string;
  tokenExpiresAt: string;
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
