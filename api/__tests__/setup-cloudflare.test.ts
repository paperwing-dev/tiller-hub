import { describe, expect, it } from "vitest";
import {
  resolveWorkerServiceNameFromHostname,
} from "../setup/cloudflare";

describe("resolveWorkerServiceNameFromHostname", () => {
  it("extracts the Worker name from a workers.dev host", () => {
    expect(resolveWorkerServiceNameFromHostname("tiller-hub.preview-subdomain.workers.dev")).toBe("tiller-hub");
  });

  it("returns null for non-workers.dev hosts", () => {
    expect(resolveWorkerServiceNameFromHostname("tiller.example.com")).toBeNull();
  });

  it("rejects malformed workers.dev hostnames without an account subdomain", () => {
    expect(resolveWorkerServiceNameFromHostname("demo.workers.dev")).toBeNull();
  });
});
