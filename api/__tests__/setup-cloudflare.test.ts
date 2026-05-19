import { describe, expect, it } from "vitest";
import {
  findBestMatchingZone,
  normalizeCustomDomainHostname,
  resolveWorkerServiceNameFromHostname,
} from "../setup/cloudflare";

describe("normalizeCustomDomainHostname", () => {
  it("accepts bare hostnames", () => {
    expect(normalizeCustomDomainHostname("tiller.example.com")).toBe("tiller.example.com");
  });

  it("accepts full URLs and strips them to the hostname", () => {
    expect(normalizeCustomDomainHostname("https://tiller.example.com")).toBe("tiller.example.com");
  });

  it("rejects workers.dev hostnames", () => {
    expect(() => normalizeCustomDomainHostname("demo.workers.dev")).toThrow(/own domain/i);
  });

  it("rejects paths and ports", () => {
    expect(() => normalizeCustomDomainHostname("https://tiller.example.com:8443/path")).toThrow(/only the hostname/i);
  });
});

describe("resolveWorkerServiceNameFromHostname", () => {
  it("extracts the Worker name from a workers.dev host", () => {
    expect(resolveWorkerServiceNameFromHostname("tiller-hub.preview-subdomain.workers.dev")).toBe("tiller-hub");
  });

  it("returns null for non-workers.dev hosts", () => {
    expect(resolveWorkerServiceNameFromHostname("tiller.example.com")).toBeNull();
  });
});

describe("findBestMatchingZone", () => {
  it("chooses the longest matching zone suffix", () => {
    const zone = findBestMatchingZone("tiller.dev.example.com", [
      { id: "1", name: "example.com", account: { id: "acc-1" } },
      { id: "2", name: "dev.example.com", account: { id: "acc-1" } },
    ]);

    expect(zone?.id).toBe("2");
  });

  it("returns null when no zone matches", () => {
    expect(
      findBestMatchingZone("tiller.example.net", [
        { id: "1", name: "example.com", account: { id: "acc-1" } },
      ]),
    ).toBeNull();
  });
});
