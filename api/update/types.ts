export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotesUrl: string;
}

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
