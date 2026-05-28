import { describe, expect, it } from "vitest";
import {
  VALID_TILLER_REGIONS,
  buildDeployConfig,
  deriveContainerApplicationName,
  deriveBucketName,
  ensureWranglerAccountId,
  extractBucketLocation,
  needsLiveContainerImageLookup,
  normalizeWorkerName,
  normalizeTillerRegion,
  normalizeEmailList,
  parseDotEnv,
  parseWranglerJsonOutput,
  resolveContainerImages,
  resolveWorkerName,
  rewriteContainerApplicationNames,
} from "./deploy-with-region.mjs";

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

  it("builds a protected custom-domain deploy config", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
        },
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
        customDomain: "tiller.example.com",
        workerName: "tiller-hub",
      },
    );

    expect(config.vars).toEqual({
      DO_LOCATION_HINT: "wnam",
      HUB_PUBLIC_URL: "https://tiller.example.com",
      WORKER_SERVICE_NAME: "tiller-hub",
      WORKERS_DEV_ALIAS_DISABLED: "true",
    });
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([
      {
        pattern: "tiller.example.com",
        custom_domain: true,
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
            { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 2 },
            { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
            { class_name: "OtherDO", image: "docker.io/other/image:v1", max_instances: 1 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:abc123", max_instances: 2 },
        { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 2 },
        { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
        { class_name: "OtherDO", image: "docker.io/other/image:v1", max_instances: 1 },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
    }
  });

  it("overrides the ScmBootstrapDO image when SCM_BOOTSTRAP_IMAGE_TAG is set", () => {
    const prev = process.env.SCM_BOOTSTRAP_IMAGE_TAG;
    process.env.SCM_BOOTSTRAP_IMAGE_TAG = "docker.io/jamieatlason/tiller-scm:def456";
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
            { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 2 },
            { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
        { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:def456", max_instances: 2 },
        { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:def456", max_instances: 4 },
      ]);
    } finally {
      if (prev == null) delete process.env.SCM_BOOTSTRAP_IMAGE_TAG;
      else process.env.SCM_BOOTSTRAP_IMAGE_TAG = prev;
    }
  });

  it("leaves containers unchanged when image override env vars are not set", () => {
    const prev = process.env.CONTAINER_IMAGE_TAG;
    const prevBootstrap = process.env.SCM_BOOTSTRAP_IMAGE_TAG;
    delete process.env.CONTAINER_IMAGE_TAG;
    delete process.env.SCM_BOOTSTRAP_IMAGE_TAG;
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
            { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 2 },
            { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        { class_name: "SandboxDO", image: "docker.io/jamieatlason/tiller-sandbox:stable", max_instances: 2 },
        { class_name: "ScmBootstrapDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 2 },
        { class_name: "ScmOperationDO", image: "docker.io/jamieatlason/tiller-scm:stable", max_instances: 4 },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
      if (prevBootstrap == null) delete process.env.SCM_BOOTSTRAP_IMAGE_TAG;
      else process.env.SCM_BOOTSTRAP_IMAGE_TAG = prevBootstrap;
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
            class_name: "ScmBootstrapDO",
            name: "tiller-hub-scmbootstrapdo",
            image: "docker.io/jamieatlason/tiller-scm:stable",
            max_instances: 2,
          },
          {
            class_name: "ScmOperationDO",
            name: "tiller-hub-scmoperationdo",
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
          ["tiller-hub-scmbootstrapdo", "docker.io/jamieatlason/tiller-scm:def456"],
          ["tiller-hub-scmoperationdo", "docker.io/jamieatlason/tiller-scm:def456"],
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
        class_name: "ScmBootstrapDO",
        name: "tiller-hub-scmbootstrapdo",
        image: "docker.io/jamieatlason/tiller-scm:def456",
        max_instances: 2,
      },
      {
        class_name: "ScmOperationDO",
        name: "tiller-hub-scmoperationdo",
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
      class_name: "ScmBootstrapDO",
      name: "tiller-hub-scmbootstrapdo",
      image: "docker.io/jamieatlason/tiller-scm:stable",
      max_instances: 2,
    },
    {
      class_name: "ScmOperationDO",
      name: "tiller-hub-scmoperationdo",
      image: "docker.io/jamieatlason/tiller-scm:stable",
      max_instances: 4,
    },
  ];

  it("uses explicit overrides ahead of live images", () => {
    const resolutions = resolveContainerImages(containers, {
      sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:override",
      scmBootstrapImageTag: "docker.io/jamieatlason/tiller-scm:override",
      liveContainerImages: new Map([
        ["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:live"],
        ["tiller-hub-scmbootstrapdo", "docker.io/jamieatlason/tiller-scm:live"],
        ["tiller-hub-scmoperationdo", "docker.io/jamieatlason/tiller-scm:live"],
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
          class_name: "ScmBootstrapDO",
          name: "tiller-hub-scmbootstrapdo",
          image: "docker.io/jamieatlason/tiller-scm:override",
          max_instances: 2,
        },
        source: "override",
      },
      {
        container: {
          class_name: "ScmOperationDO",
          name: "tiller-hub-scmoperationdo",
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
          class_name: "ScmBootstrapDO",
          name: "tiller-hub-scmbootstrapdo",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 2,
        },
        source: "default",
      },
      {
        container: {
          class_name: "ScmOperationDO",
          name: "tiller-hub-scmoperationdo",
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
          { class_name: "ScmBootstrapDO", name: "tiller-hub-scmbootstrapdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
          { class_name: "ScmOperationDO", name: "tiller-hub-scmoperationdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          scmBootstrapImageTag: "",
        },
      ),
    ).toBe(true);

    expect(
      needsLiveContainerImageLookup(
        [
          { class_name: "SandboxDO", name: "tiller-hub-sandboxdo", image: "docker.io/jamieatlason/tiller-sandbox:stable" },
          { class_name: "ScmBootstrapDO", name: "tiller-hub-scmbootstrapdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
          { class_name: "ScmOperationDO", name: "tiller-hub-scmoperationdo", image: "docker.io/jamieatlason/tiller-scm:stable" },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          scmBootstrapImageTag: "docker.io/jamieatlason/tiller-scm:def456",
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
    expect(parseDotEnv("TILLER_CUSTOM_DOMAIN=tiller.example.com\nTILLER_ACCESS_EMAILS=one@example.com,two@example.com\n")).toEqual({
      TILLER_CUSTOM_DOMAIN: "tiller.example.com",
      TILLER_ACCESS_EMAILS: "one@example.com,two@example.com",
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

describe("normalizeEmailList", () => {
  it("splits comma and newline separated emails", () => {
    expect(normalizeEmailList("one@example.com,\ntwo@example.com")).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });
});

describe("ensureWranglerAccountId", () => {
  it("prefers an explicit CLOUDFLARE_ACCOUNT_ID", async () => {
    const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    try {
      const result = await ensureWranglerAccountId({
        customDomain: "tiller.example.com",
        apiToken: "cfat_test",
        accountId: "acc-explicit",
      });
      expect(result).toBe("acc-explicit");
      expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-explicit");
    } finally {
      if (previous == null) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
  });

  it("falls back to the legacy default account id env", async () => {
    const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    try {
      const result = await ensureWranglerAccountId({
        customDomain: "tiller.example.com",
        apiToken: "cfat_test",
        legacyAccountId: "acc-legacy",
      });
      expect(result).toBe("acc-legacy");
      expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-legacy");
    } finally {
      if (previous == null) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
  });

  it("derives the account id from the custom domain when needed", async () => {
    const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    try {
      const result = await ensureWranglerAccountId(
        {
          customDomain: "tiller.paperwing.dev",
          apiToken: "cfat_test",
        },
        {
          resolveAccountForHostnameImpl: async () => ({
            accountId: "acc-derived",
          }),
        },
      );
      expect(result).toBe("acc-derived");
      expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-derived");
    } finally {
      if (previous == null) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
  });
});
