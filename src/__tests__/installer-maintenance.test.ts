import { describe, expect, it } from "vitest";
import {
  INSTALLER_MAINTENANCE_URL,
  installerMaintenanceAction,
} from "../installer-maintenance";

describe("installerMaintenanceAction", () => {
  it("builds only the supported non-authoritative intents", () => {
    expect(installerMaintenanceAction({
      updateAvailable: true,
      latestVersion: "0.3.0",
      renewAccess: false,
    })).toEqual({
      intent: "update",
      label: "Update to v0.3.0",
      url: `${INSTALLER_MAINTENANCE_URL}?intent=update`,
    });
    expect(installerMaintenanceAction({
      updateAvailable: true,
      latestVersion: "v0.3.0",
      renewAccess: true,
    })).toEqual({
      intent: "renew",
      label: "Renew and update to v0.3.0",
      url: `${INSTALLER_MAINTENANCE_URL}?intent=renew`,
    });
    expect(installerMaintenanceAction({
      updateAvailable: false,
      latestVersion: "0.3.0",
      renewAccess: true,
    })?.label).toBe("Renew Access");
    expect(installerMaintenanceAction({
      updateAvailable: false,
      latestVersion: "0.3.0",
      renewAccess: false,
    })).toBeNull();
  });
});
