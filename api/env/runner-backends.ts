import { createCloudflareRunnerBackend } from "./runner-backend-cf";
import { createHostRunnerBackend } from "./runner-backend-host";
import type { RunnerBackend, RunnerBackendKind } from "./runner-backend";
import type { Env } from "../types";

export async function getRunnerBackend(env: Env, kind: RunnerBackendKind): Promise<RunnerBackend> {
  switch (kind) {
    case "cf":
      return createCloudflareRunnerBackend(env);
    case "host":
      return await createHostRunnerBackend(env);
  }
}
