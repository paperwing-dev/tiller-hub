export type ReleaseChannel = "development" | "release";

export interface ReleaseInfo {
  schemaVersion: 1;
  channel: ReleaseChannel;
  hubVersion: string;
  /** Synthetic public snapshot commit. Required for promoted production builds. */
  releaseId?: string;
  /** Exact execution-machine runtime used by this Hub build. */
  selfHostRuntimeImage?: `docker.io/${string}@sha256:${string}`;
}

export interface StableReleaseSummary {
  releaseId: string;
  version: string;
  releaseNotesUrl: string;
}

export interface UpdateBuildDiagnostics {
  channel: ReleaseChannel;
  version: string;
  workersCiCommitSha: string | null;
  workersCiBranch: string | null;
}

export interface UpdateCheckError {
  code: "stable_release_unavailable" | "release_info_invalid";
  message: string;
  retryable: boolean;
}

export interface UpdateCheckResult {
  kind: "installer-managed" | "unmanaged";
  currentRelease: ReleaseInfo;
  stableRelease: StableReleaseSummary | null;
  updateAvailable: boolean;
  buildDiagnostics: UpdateBuildDiagnostics;
  errors: UpdateCheckError[];
}
