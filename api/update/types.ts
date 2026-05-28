export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentUpdate: TillerUpdateMetadata;
  latestUpdate: TillerUpdateMetadata;
  buildDiagnostics: UpdateBuildDiagnostics;
  hubRepo: HubUpdateRepoState;
  updateMethod: "github_repo" | "connect_hub_repo" | "advanced_repair";
  issue?: UpdateIssue;
  releaseNotesUrl: string;
}

export interface TillerUpdateMetadata {
  schemaVersion: 1;
  channel: "deploy-button";
  updateMode: "full-source";
  sourceRepo: "paperwing-dev/tiller-hub";
  sourceId: string;
  version: string;
  label: string;
  managedFiles: string[];
}

export interface UpdateBuildDiagnostics {
  version: string;
  workersCiCommitSha: string | null;
  workersCiBranch: string | null;
}

export type HubUpdateRepoStatus = "detected" | "missing" | "ambiguous" | "not_checked";

export interface HubUpdateRepoCandidate {
  owner: string;
  repo: string;
  fullName: string;
  label: string;
  repoId: number;
  installationId: number;
  branch: string;
  private: boolean;
  defaultBranch: string | null;
  sourceId: string;
}

export interface HubUpdateRepoDetected {
  status: "detected";
  owner: string;
  repo: string;
  fullName: string;
  label: string;
  repoId: number;
  installationId: number;
  branch: string;
  lastDetectedAt: string;
  detectedBy: "auto" | "manual" | "selection";
}

export interface HubUpdateRepoMissing {
  status: "missing";
  lastDetectedAt: string | null;
}

export interface HubUpdateRepoAmbiguous {
  status: "ambiguous";
  lastDetectedAt: string;
  candidates: HubUpdateRepoCandidate[];
}

export interface HubUpdateRepoNotChecked {
  status: "not_checked";
  lastDetectedAt: null;
}

export type HubUpdateRepoState =
  | HubUpdateRepoDetected
  | HubUpdateRepoMissing
  | HubUpdateRepoAmbiguous
  | HubUpdateRepoNotChecked;

export interface UpdateIssue {
  code:
    | "hub_repo_not_configured"
    | "hub_repo_ambiguous"
    | "not_a_tiller_hub_repo"
    | "managed_files_removed"
    | "advanced_repair_required"
    | "update_branch_moved"
    | "direct_update_rejected"
    | "update_check_failed";
  message: string;
  retryable?: boolean;
}

export type UpdateApplyResult =
  | {
      ok: true;
      status: "queued";
      expectedSourceId: string;
      commitSha: string;
    }
  | {
      ok: true;
      status: "noop";
      expectedSourceId: string;
    }
  | {
      ok: false;
      status:
        | "hub_repo_not_configured"
        | "not_a_tiller_hub_repo"
        | "managed_files_removed"
        | "advanced_repair_required"
        | "update_branch_moved"
        | "direct_update_rejected";
      error: string;
      retryable?: boolean;
      missingManagedFiles?: string[];
    };

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets?: GitHubReleaseAsset[];
}

export interface UpdateRelease {
  tagName: string;
  version: string;
  releaseNotesUrl: string;
  assets: GitHubReleaseAsset[];
}

export interface DurableObjectMigration {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  deleted_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>;
}

export interface ManifestDurableObjectBinding {
  type: "durable_object_namespace";
  name: string;
  class_name: string;
}

export interface ManifestKvBinding {
  type: "kv_namespace";
  name: string;
  title_suffix: string;
}

export interface ManifestR2Binding {
  type: "r2_bucket";
  name: string;
  name_derive: "worker";
}

export interface ManifestAiBinding {
  type: "ai";
  name: string;
}

export interface ManifestAssetsBinding {
  type: "assets";
  name: string;
}

export interface ManifestWorkerLoaderBinding {
  type: "worker_loader";
  name: string;
}

export interface ManifestPlainTextBinding {
  type: "plain_text";
  name: string;
  text: string;
}

export type UpdateManifestBinding =
  | ManifestDurableObjectBinding
  | ManifestKvBinding
  | ManifestR2Binding
  | ManifestAiBinding
  | ManifestAssetsBinding
  | ManifestWorkerLoaderBinding
  | ManifestPlainTextBinding;

export interface UpdateManifestContainer {
  class_name: string;
  app_name_suffix: string;
  image: string;
  max_instances: number;
  instance_type: string;
}

export interface UpdateManifest {
  version: string;
  compatibility_date: string;
  compatibility_flags: string[];
  migrations: DurableObjectMigration[];
  bindings: UpdateManifestBinding[];
  containers: UpdateManifestContainer[];
}
