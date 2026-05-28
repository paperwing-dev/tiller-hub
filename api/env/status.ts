import { isEnvStatus, type EnvStatus } from "../types";

export function normalizeRunnerStatus(status?: string): EnvStatus {
  switch (status) {
    case "running":
    case "healthy":
    case "paused":
      return "running";
    case "created":
      return "creating";
    case "restarting":
      return "starting";
    case "removing":
      return "deleting";
    case "exited":
    case "dead":
    case "stopped":
      return "stopped";
    default:
      return isEnvStatus(status) ? status : "unknown";
  }
}
