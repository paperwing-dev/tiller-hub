import {
  normalizeSelfHostDeployRecord,
  parseManagedSelfHostRuntime,
  validateManagedSelfHostRuntime,
} from "./self-host-runtime-contract.mjs";

export { parseManagedSelfHostRuntime, validateManagedSelfHostRuntime };

export function parseDevelopmentSelfHostDeployRecord(value) {
  try {
    const record = normalizeSelfHostDeployRecord(value);
    return {
      imageSourceId: record.imageCommitSha,
      sandboxImage: record.sandboxImage,
    };
  } catch {
    return null;
  }
}

export function resolveSelfHostRuntimeChannel(command, buildChannel) {
  return command === "serve" || buildChannel === "development"
    ? "development"
    : "release";
}

export function replaceSelfHostRuntimeMetadata(metadata, runtime) {
  const { selfHostRuntime: _embeddedRuntime, ...withoutEmbeddedRuntime } = metadata;
  return runtime
    ? { ...withoutEmbeddedRuntime, selfHostRuntime: runtime }
    : withoutEmbeddedRuntime;
}

export function resolveSelfHostRuntimeBuildInput({
  env = process.env,
  buildChannel,
  developmentRuntime = null,
  embeddedRuntime = null,
  required = false,
}) {
  const imageSourceId = env.TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID?.trim() ?? "";
  const sandboxImage = env.TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE?.trim() ?? "";
  if (buildChannel !== "development" && (imageSourceId || sandboxImage)) {
    throw new Error(
      "TILLER_SELF_HOST_RUNTIME_* overrides are only supported for development builds; release builds use embedded runtime metadata.",
    );
  }
  const explicitRuntime = buildChannel === "development" && (imageSourceId || sandboxImage)
      ? validateManagedSelfHostRuntime(
        { imageSourceId, sandboxImage },
        "machine runtime metadata override",
      )
    : null;
  const resolved = buildChannel === "development"
    ? explicitRuntime ?? developmentRuntime
    : embeddedRuntime;
  const validated = resolved ? validateManagedSelfHostRuntime(resolved) : null;
  if (required && !validated) {
    throw new Error(
      buildChannel === "development"
        ? "Machine runtime metadata is required for deployment. Supply matching TILLER_SELF_HOST_RUNTIME_* overrides or run the maintainer deployment/update path to create .update-self-host-deploy-record.json."
        : "Machine runtime metadata is required for release builds and must be embedded in the Hub release metadata.",
    );
  }
  return validated;
}
