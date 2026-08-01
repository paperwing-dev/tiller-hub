export const INSTALLER_MAINTENANCE_URL = "https://install.paperwing.dev/maintenance";

export interface InstallerMaintenanceAction {
  intent: "update" | "renew";
  label: string;
  url: string;
}

export function installerMaintenanceAction(options: {
  updateAvailable: boolean;
  latestVersion: string;
  renewAccess: boolean;
}): InstallerMaintenanceAction | null {
  if (!options.updateAvailable && !options.renewAccess) return null;

  const intent = options.renewAccess ? "renew" : "update";
  const version = options.latestVersion.trim()
    .replace(/^tiller-hub-v/i, "")
    .replace(/^v/i, "");
  const label = options.updateAvailable
    ? options.renewAccess
      ? `Renew and update to v${version}`
      : `Update to v${version}`
    : "Renew Access";
  return {
    intent,
    label,
    url: `${INSTALLER_MAINTENANCE_URL}?intent=${intent}`,
  };
}
