import { describe, expect, it } from "vitest";
import {
  INSTALLER_MAINTENANCE_URL,
  installerMaintenanceAction,
} from "../installer-maintenance";

describe("installerMaintenanceAction", () => {
  it("builds only the update maintenance action", () => {
    expect(installerMaintenanceAction({
      updateAvailable: true,
      latestVersion: "0.3.0",
    })).toEqual({
      label: "Update to v0.3.0",
      url: `${INSTALLER_MAINTENANCE_URL}?intent=update`,
    });
    expect(installerMaintenanceAction({
      updateAvailable: true,
      latestVersion: "v0.3.0",
    })).toEqual({
      label: "Update to v0.3.0",
      url: `${INSTALLER_MAINTENANCE_URL}?intent=update`,
    });
    expect(installerMaintenanceAction({
      updateAvailable: false,
      latestVersion: "0.3.0",
    })).toBeNull();
  });
});
