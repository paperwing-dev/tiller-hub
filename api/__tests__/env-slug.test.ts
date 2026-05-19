import { describe, expect, it } from "vitest";
import { deriveEnvSlugCandidate, deriveRepoSlug } from "../env/slug";

describe("deriveRepoSlug", () => {
  it("uses the repository basename", () => {
    expect(deriveRepoSlug("https://github.com/paperwing-dev/tiller-hub")).toBe("tiller-hub");
    expect(deriveRepoSlug("https://github.com/paperwing-dev/tiller-hub.git")).toBe("tiller-hub");
  });
});

describe("deriveEnvSlugCandidate", () => {
  it("uses the repo slug for the first attempt", () => {
    expect(deriveEnvSlugCandidate("https://github.com/paperwing-dev/tiller-hub", "cf", 0)).toBe("tiller-hub");
  });

  it("uses a backend suffix on the second attempt", () => {
    expect(deriveEnvSlugCandidate("https://github.com/paperwing-dev/tiller-hub", "host", 1)).toBe("tiller-hub-host");
  });

  it("increments backend-specific duplicates after that", () => {
    expect(deriveEnvSlugCandidate("https://github.com/paperwing-dev/tiller-hub", "cf", 3)).toBe("tiller-hub-cf-3");
  });
});
