export const INSTALLER_MAINTENANCE_URL = "https://install.paperwing.dev/maintenance";

export function installerMaintenanceAction(options: {
  updateAvailable: boolean;
  latestVersion: string;
}): { label: string; url: string } | null {
  if (!options.updateAvailable) return null;

  const version = options.latestVersion.trim()
    .replace(/^tiller-hub-v/i, "")
    .replace(/^v/i, "");
  return {
    label: `Update to v${version}`,
    url: `${INSTALLER_MAINTENANCE_URL}?intent=update`,
  };
}
