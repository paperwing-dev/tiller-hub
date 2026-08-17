export function isEnvRunningStatus(status?: string | null): boolean {
  return status === "running";
}

export function canStopEnvStatus(status?: string | null): boolean {
  return isEnvRunningStatus(status) || status === "starting";
}

export function shouldSelectLiveSessionForEnvStatus(status?: string | null): boolean {
  return status === "starting" || isEnvRunningStatus(status);
}

export function shouldShowEnvWaitingViewForStatus(status?: string | null): boolean {
  return (
    status === "creating" ||
    status === "saving" ||
    status === "stopping" ||
    status === "stopped" ||
    status === "failed" ||
    status === "deleting"
  );
}
