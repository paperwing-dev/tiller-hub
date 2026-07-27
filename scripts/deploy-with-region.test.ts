import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TILLER_REGION_PLACEHOLDER,
  VALID_TILLER_REGIONS,
  buildDeployConfig,
  deriveContainerApplicationName,
  deriveBucketName,
  extractBucketLocation,
  needsLiveContainerImageLookup,
  normalizeWorkerName,
  normalizeTillerRegion,
  parseDotEnv,
  parseJsonc,
  parseWranglerJsonOutput,
  resolveTillerRegion,
  resolveContainerImages,
  resolveWorkerName,
  rewriteContainerApplicationNames,
} from "./deploy-with-region.mjs";

describe("deploy-button region contract", () => {
  it("ships a blank required choice instead of a silent geographic default", () => {
    const wrangler = parseJsonc(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      "wrangler.jsonc",
    );
    expect(wrangler.vars?.TILLER_REGION).toBe("");

    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.cloudflare?.bindings?.TILLER_REGION?.description)
      .toMatch(/Required:.*does not choose the nearest region automatically/s);
  });

  it("keeps every maintainer deploy path on the tracked Worker name", () => {
    const wrangler = parseJsonc(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      "wrangler.jsonc",
    );
    expect(wrangler.name).toBe("tiller");

    for (const script of [
      new URL("../../../scripts/deploy.sh", import.meta.url),
      new URL("../../../scripts/release.sh", import.meta.url),
    ]) {
      expect(readFileSync(script, "utf8")).not.toContain("TILLER_WORKER_NAME=");
    }
  });
});

describe("normalizeTillerRegion", () => {
  it("accepts all supported region codes", () => {
    for (const region of VALID_TILLER_REGIONS) {
      expect(normalizeTillerRegion(region)).toBe(region);
    }
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeTillerRegion("  WNAM ")).toBe("wnam");
  });

  it("rejects unsupported values", () => {
    expect(() => normalizeTillerRegion("sam")).toThrow(/Invalid TILLER_REGION/);
  });

  it("rejects the checked-in deploy-button placeholder", () => {
    expect(() => normalizeTillerRegion(TILLER_REGION_PLACEHOLDER))
      .toThrow(/Choose one before deployment/);
  });
});

describe("resolveTillerRegion", () => {
  it("uses an explicit local or CI override before the Wrangler value", () => {
    expect(
      resolveTillerRegion(
        { vars: { TILLER_REGION: TILLER_REGION_PLACEHOLDER } },
        { TILLER_REGION: "weur" },
      ),
    ).toBe("weur");
  });

  it("uses the region selected in the deploy-button-generated config", () => {
    expect(
      resolveTillerRegion(
        { vars: { TILLER_REGION: "apac" } },
        {},
      ),
    ).toBe("apac");
  });

  it("does not silently turn a blank template value into a region", () => {
    expect(
      () => resolveTillerRegion(
        { vars: { TILLER_REGION: "" } },
        {},
      ),
    ).toThrow(/Missing TILLER_REGION/);
  });
});

describe("deriveBucketName", () => {
  it("creates a deterministic bucket name from the worker name", () => {
    expect(deriveBucketName("Paperwing Tiller Hub")).toBe("paperwing-tiller-hub-r2-d272aa20");
  });
});

describe("normalizeWorkerName", () => {
  it("accepts lowercase Worker names with hyphens", () => {
    expect(normalizeWorkerName("  tiller-hub-sage ")).toBe("tiller-hub-sage");
  });

  it("rejects names Wrangler cannot safely deploy", () => {
    expect(() => normalizeWorkerName("Tiller Hub")).toThrow(/lowercase letters/);
    expect(() => normalizeWorkerName("-tiller-hub")).toThrow(/cannot start or end/);
  });
});

describe("resolveWorkerName", () => {
  it("uses the Workers Builds override before local fallback values", () => {
    expect(
      resolveWorkerName(
        { name: "tiller-hub" },
        {
          WRANGLER_CI_OVERRIDE_NAME: "tiller-hub-maple",
          TILLER_WORKER_NAME: "tiller-hub-local",
        },
      ),
    ).toBe("tiller-hub-maple");
  });

  it("supports a local explicit Worker name override", () => {
    expect(
      resolveWorkerName(
        { name: "tiller-hub" },
        {
          TILLER_WORKER_NAME: "tiller-hub-river",
        },
      ),
    ).toBe("tiller-hub-river");
  });

  it("falls back to the root Wrangler name", () => {
    expect(resolveWorkerName({ name: "tiller-hub" }, {})).toBe("tiller-hub");
  });
});

describe("buildDeployConfig", () => {
  it.each(["tiller", "tiller-hub"])(
    "preserves public-fetch routing when deploying as %s",
    (workerName) => {
      const compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"];
      const config = buildDeployConfig(
        {
          name: "tiller",
          compatibility_flags: compatibilityFlags,
          vars: { TILLER_REGION: "wnam" },
        },
        {
          bucketName: `${workerName}-r2-12345678`,
          region: "wnam",
          workerName,
        },
      );

      expect(config.compatibility_flags).toEqual(compatibilityFlags);
    },
  );

  it("injects DO_LOCATION_HINT and BUCKET while removing TILLER_REGION", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          SOME_OTHER_VAR: "keep-me",
        },
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
      },
    );

    expect(config.vars).toEqual({
      SOME_OTHER_VAR: "keep-me",
      DO_LOCATION_HINT: "wnam",
    });
    expect(config.r2_buckets).toEqual([
      {
        binding: "BUCKET",
        bucket_name: "tiller-hub-r2-12345678",
      },
    ]);
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
  });

  it("always emits a workers.dev deployment without direct custom-domain routing", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          HUB_PUBLIC_URL: "https://tiller.example.com",
          WORKER_SERVICE_NAME: "tiller-hub",
          WORKERS_DEV_ALIAS_DISABLED: "false",
        },
        routes: [{ pattern: "tiller.example.com", custom_domain: true }],
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub",
      },
    );

    expect(config.vars).toEqual({ DO_LOCATION_HINT: "wnam" });
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toBeUndefined();
  });

  it("can rewrite the generated config to the selected Worker name", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          TILLER_WORKER_NAME: "tiller-hub-ignore-runtime",
        },
      },
      {
        bucketName: "tiller-hub-river-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub-river",
      },
    );

    expect(config.name).toBe("tiller-hub-river");
    expect(config.vars).toEqual({
      DO_LOCATION_HINT: "wnam",
    });
  });

  it("rewrites generated container application names to the selected Worker name", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: { TILLER_REGION: "wnam" },
        containers: [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
        ],
      },
      {
        bucketName: "tiller-hub-river-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub-river",
      },
    );

    expect(config.containers).toEqual([
      {
        class_name: "SandboxDO",
        name: "tiller-hub-river-sandboxdo",
        image: "docker.io/jamieatlason/tiller-sandbox:stable",
      },
    ]);
  });

  it("overrides the SandboxDO container image when CONTAINER_IMAGE_TAG is set", () => {
    const prev = process.env.CONTAINER_IMAGE_TAG;
    process.env.CONTAINER_IMAGE_TAG = "docker.io/jamieatlason/tiller-sandbox:abc123";
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
            { class_name: "PlannerRunDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 10 },
            { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
            { class_name: "OtherDO", image: "docker.io/other/image:v1", max_instances: 1 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123", max_instances: 2 },
        { class_name: "PlannerRunDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123", max_instances: 10 },
        { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
        { class_name: "OtherDO", image: "docker.io/other/image:v1", max_instances: 1 },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
    }
  });

  it("overrides the GitHubJobDO image when GITHUB_JOB_IMAGE_TAG is set", () => {
    const prev = process.env.GITHUB_JOB_IMAGE_TAG;
    process.env.GITHUB_JOB_IMAGE_TAG = "docker.io/jamieatlason/tiller-scm:def456";
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
            { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
        { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:def456", max_instances: 4 },
      ]);
    } finally {
      if (prev == null) delete process.env.GITHUB_JOB_IMAGE_TAG;
      else process.env.GITHUB_JOB_IMAGE_TAG = prev;
    }
  });

  it("leaves containers unchanged when image override env vars are not set", () => {
    const prev = process.env.CONTAINER_IMAGE_TAG;
    const prevGitHubJob = process.env.GITHUB_JOB_IMAGE_TAG;
    delete process.env.CONTAINER_IMAGE_TAG;
    delete process.env.GITHUB_JOB_IMAGE_TAG;
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
            { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
        { class_name: "GitHubJobDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
      if (prevGitHubJob == null) delete process.env.GITHUB_JOB_IMAGE_TAG;
      else process.env.GITHUB_JOB_IMAGE_TAG = prevGitHubJob;
    }
  });

  it("preserves live container images when provided", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: { TILLER_REGION: "wnam" },
        containers: [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
            max_instances: 2,
          },
          {
            class_name: "GitHubJobDO",
            name: "tiller-hub-githubjobdo",
            image: "docker.io/jamieatlason/tiller-scm:stable",
            max_instances: 4,
          },
        ],
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
        liveContainerImages: new Map([
          ["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:abc123"],
          ["tiller-hub-githubjobdo", "docker.io/jamieatlason/tiller-scm:def456"],
        ]),
      },
    );

    expect(config.containers).toEqual([
      {
        class_name: "SandboxDO",
        name: "tiller-hub-sandboxdo",
        image: "docker.io/jamieatlason/tiller-sandbox:abc123",
        max_instances: 2,
      },
      {
        class_name: "GitHubJobDO",
        name: "tiller-hub-githubjobdo",
        image: "docker.io/jamieatlason/tiller-scm:def456",
        max_instances: 4,
      },
    ]);
  });
});

describe("rewriteContainerApplicationNames", () => {
  it("derives names from class names", () => {
    expect(deriveContainerApplicationName("tiller-hub-maple", "SandboxDO")).toBe("tiller-hub-maple-sandboxdo");
  });

  it("preserves custom container names", () => {
    expect(
      rewriteContainerApplicationNames(
        [
          {
            class_name: "SandboxDO",
            name: "custom-sandbox",
            image: "docker.io/example/sandbox:stable",
          },
        ],
        {
          workerName: "tiller-hub-maple",
          previousWorkerName: "tiller-hub",
        },
      ),
    ).toEqual([
      {
        class_name: "SandboxDO",
        name: "custom-sandbox",
        image: "docker.io/example/sandbox:stable",
      },
    ]);
  });
});

describe("resolveContainerImages", () => {
  const containers = [
    {
      class_name: "SandboxDO",
      name: "tiller-hub-sandboxdo",
      image: "docker.io/jamieatlason/tiller-sandbox:stable",
      max_instances: 2,
    },
    {
      class_name: "PlannerRunDO",
      name: "tiller-hub-plannerrundo",
      image: "docker.io/jamieatlason/tiller-sandbox:stable",
      max_instances: 10,
    },
    {
      class_name: "GitHubJobDO",
      name: "tiller-hub-githubjobdo",
      image: "docker.io/jamieatlason/tiller-scm:stable",
      max_instances: 4,
    },
  ];

  it("uses explicit overrides ahead of live images", () => {
    const resolutions = resolveContainerImages(containers, {
      sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:override",
      githubJobImageTag: "docker.io/jamieatlason/tiller-scm:override",
      liveContainerImages: new Map([
        ["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:live"],
        ["tiller-hub-plannerrundo", "docker.io/jamieatlason/tiller-sandbox:live"],
        ["tiller-hub-githubjobdo", "docker.io/jamieatlason/tiller-scm:live"],
      ]),
    });

    expect(resolutions).toEqual([
      {
        container: {
          class_name: "SandboxDO",
          name: "tiller-hub-sandboxdo",
          image: "docker.io/jamieatlason/tiller-sandbox:override",
          max_instances: 2,
        },
        source: "override",
      },
      {
        container: {
          class_name: "PlannerRunDO",
          name: "tiller-hub-plannerrundo",
          image: "docker.io/jamieatlason/tiller-sandbox:override",
          max_instances: 10,
        },
        source: "override",
      },
      {
        container: {
          class_name: "GitHubJobDO",
          name: "tiller-hub-githubjobdo",
          image: "docker.io/jamieatlason/tiller-scm:override",
          max_instances: 4,
        },
        source: "override",
      },
    ]);
  });

  it("falls back to the config image when no live image matches", () => {
    const resolutions = resolveContainerImages(containers, {
      liveContainerImages: new Map([["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:live"]]),
    });

    expect(resolutions).toEqual([
      {
        container: {
          class_name: "SandboxDO",
          name: "tiller-hub-sandboxdo",
          image: "docker.io/jamieatlason/tiller-sandbox:live",
          max_instances: 2,
        },
        source: "live",
      },
      {
        container: {
          class_name: "PlannerRunDO",
          name: "tiller-hub-plannerrundo",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 10,
        },
        source: "default",
      },
      {
        container: {
          class_name: "GitHubJobDO",
          name: "tiller-hub-githubjobdo",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 4,
        },
        source: "default",
      },
    ]);
  });
});

describe("needsLiveContainerImageLookup", () => {
  it("only requires live lookup for unpinned known containers", () => {
    expect(
      needsLiveContainerImageLookup(
        [
          { class_name: "SandboxDO", name: "tiller-hub-sandboxdo", image: "docker.io/jamieatlason/tiller-sandbox:stable" },
          { class_name: "PlannerRunDO", name: "tiller-hub-plannerrundo", image: "docker.io/jamieatlason/tiller-sandbox:stable" },
          { class_name: "GitHubJobDO", name: "tiller-hub-githubjobdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          githubJobImageTag: "",
        },
      ),
    ).toBe(true);

    expect(
      needsLiveContainerImageLookup(
        [
          { class_name: "SandboxDO", name: "tiller-hub-sandboxdo", image: "docker.io/jamieatlason/tiller-sandbox:stable" },
          { class_name: "PlannerRunDO", name: "tiller-hub-plannerrundo", image: "docker.io/jamieatlason/tiller-sandbox:stable" },
          { class_name: "GitHubJobDO", name: "tiller-hub-githubjobdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          githubJobImageTag: "docker.io/jamieatlason/tiller-scm:def456",
        },
      ),
    ).toBe(false);
  });
});

describe("extractBucketLocation", () => {
  it("supports the current and fallback bucket info field names", () => {
    expect(extractBucketLocation({ location: "wnam" })).toBe("wnam");
    expect(extractBucketLocation({ locationHint: "WEUR" })).toBe("weur");
    expect(extractBucketLocation({ location_hint: "oc" })).toBe("oc");
  });
});

describe("parseDotEnv", () => {
  it("parses basic .env content", () => {
    expect(parseDotEnv("CLOUDFLARE_ACCOUNT_ID=account-123\nCONTAINER_IMAGE_TAG=image:sha\n")).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      CONTAINER_IMAGE_TAG: "image:sha",
    });
  });
});

describe("parseWranglerJsonOutput", () => {
  it("ignores Wrangler notices before JSON output", () => {
    expect(
      parseWranglerJsonOutput(
        "Cloudflare agent skills are available for: Claude Code, Cursor, Codex.\n{\"location\":\"WNAM\"}\n",
        "wrangler output",
      ),
    ).toEqual({ location: "WNAM" });
  });
});
