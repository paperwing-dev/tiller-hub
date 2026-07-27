import { describe, expect, it } from "vitest";
import {
  assertManagedFileRemovalPolicy,
  buildUpdateMetadata,
} from "./generate-update-metadata.mjs";

const HUB_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IMAGE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("generate-update-metadata self-host runtime metadata", () => {
  it("embeds separate hub and runtime source ids", async () => {
    const metadata = await buildUpdateMetadata({
      "source-id": HUB_SHA,
      version: "0.2.36",
      "self-host-runtime-image-source-id": IMAGE_SHA,
      "self-host-runtime-sandbox-image": `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      "skip-previous": "true",
    });

    expect(metadata.sourceId).toBe(HUB_SHA);
    expect(metadata.selfHostRuntime).toEqual({
      imageSourceId: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
    });
  });

  it("rejects runtime images whose tag does not match imageSourceId", async () => {
    await expect(buildUpdateMetadata({
      "source-id": HUB_SHA,
      version: "0.2.36",
      "self-host-runtime-image-source-id": IMAGE_SHA,
      "self-host-runtime-sandbox-image": `docker.io/jamieatlason/tiller-sandbox:${HUB_SHA}`,
      "skip-previous": "true",
    })).rejects.toThrow("sandboxImage tag");
  });

  it("requires an explicit allowance before removing a managed cutover file", () => {
    const previous = { managedFiles: ["src/App.tsx", "src/PlanWriterChat.tsx"] };
    const next = { managedFiles: ["src/App.tsx"] };

    expect(() => assertManagedFileRemovalPolicy(previous, next)).toThrow(
      "managedFiles removed without an explicit cutover allowance: src/PlanWriterChat.tsx",
    );
    expect(() => assertManagedFileRemovalPolicy(
      previous,
      next,
      new Set(["src/PlanWriterChat.tsx"]),
    )).not.toThrow();
  });
});
