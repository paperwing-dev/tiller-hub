import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

vi.mock("partyserver", () => ({
  Server: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    getConnections(): Iterable<never> {
      return [];
    }
  },
}));

vi.mock("../setup/runtime-compatibility", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../setup/runtime-compatibility")>()),
  classifyHostRuntimeCompatibility: vi.fn(() => ({ compatible: true })),
}));

const mocks = vi.hoisted(() => ({
  inspectPredeployCleanSlate: vi.fn(async () => ({ ok: true, blockers: [] })),
}));

vi.mock("../predeploy-clean-slate", () => ({
  inspectPredeployCleanSlate: mocks.inspectPredeployCleanSlate,
}));

import { HubDO } from "../hub";
import { installedAccessBindings } from "./access-binding-fixture";
import {
  EXECUTION_MIGRATION_KEY,
  EXECUTION_SELECTION_KEY,
  LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY,
  NEW_EXECUTION_UNAVAILABLE_MESSAGE,
} from "../execution";

type SqlRow = Record<string, unknown>;

function sqlResult<T extends SqlRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray: () => rows,
    *[Symbol.iterator](): IterableIterator<T> {
      yield* rows;
    },
  };
}

class FakeSqlStorage {
  private readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...params: SQLInputValue[]) {
    if (/^\s*(select|pragma)\b/i.test(query)) {
      return sqlResult(this.db.prepare(query).all(...params) as SqlRow[]);
    }
    if (params.length > 0) {
      const result = this.db.prepare(query).run(...params);
      return sqlResult([], Number(result.changes ?? 0));
    }
    this.db.exec(query);
    return sqlResult([]);
  }

  close(): void {
    this.db.close();
  }
}

class FakeStorage {
  readonly sql = new FakeSqlStorage();

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  close(): void {
    this.sql.close();
  }
}

function createSubject(env: Record<string, unknown> = { LOCAL_DEV_ONLY_BACKEND: "1" }) {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
    acceptWebSocket: vi.fn(),
  };
  return {
    subject: new HubDO(ctx as any, env as any),
    storage,
  };
}

function legacyState() {
  return {
    schemaVersion: 3,
    phase: "enabled",
    attemptId: "attempt-1",
    rollback: {
      workersDevHubUrl: "https://demo.preview.workers.dev",
      workerServiceName: "tiller",
      cfAccessConfigured: "true",
      browserAccess: {
        aud: "canonical-aud",
        issuer: "https://team.cloudflareaccess.com",
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      },
    },
    resources: {
      workerCustomDomain: {
        hostname: "tiller.example.com",
        hubUrl: "https://tiller.example.com",
        service: "tiller",
        zoneName: "example.com",
        accountId: "account-1",
        zoneId: "zone-1",
        domainId: "domain-1",
      },
      hubAccess: {
        appId: "legacy-app",
        aud: "legacy-aud",
        issuer: "https://team.cloudflareaccess.com",
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        browserPolicyId: "browser-policy",
        serviceTokenPolicyId: "service-policy",
        clientId: "legacy-client-id",
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.inspectPredeployCleanSlate.mockReset();
  mocks.inspectPredeployCleanSlate.mockResolvedValue({ ok: true, blockers: [] });
});

describe("Hub execution configuration migration", () => {
  it("defaults to Cloudflare, atomically captures cleanup identifiers, and clears legacy state without external mutation", async () => {
    const { subject, storage } = createSubject();
    subject.setConfig("TILLER_DEPLOYMENT_MODE", "self-host");
    subject.setConfig("HUB_PUBLIC_URL", "https://tiller.example.com");
    subject.setConfig("CF_ACCESS_CLIENT_SECRET", "must-not-leak");
    subject.setConfig("TILLER_SELF_HOST_STATE", JSON.stringify(legacyState()));
    subject.setConfig("TILLER_SELF_HOST_SETUP_SESSION", "pending-secret");
    subject.setConfig("ANTHROPIC_API_KEY", "preserved");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(subject.ensureExecutionConfiguration()).resolves.toEqual({ target: "cf" });
    const config = subject.getAllConfig();
    const manifest = JSON.parse(config[LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY] ?? "null");

    expect(config[EXECUTION_MIGRATION_KEY]).toBe("1");
    expect(JSON.parse(config[EXECUTION_SELECTION_KEY] ?? "null")).toEqual({ target: "cf" });
    expect(config.ANTHROPIC_API_KEY).toBe("preserved");
    expect(config).not.toHaveProperty("TILLER_DEPLOYMENT_MODE");
    expect(config).not.toHaveProperty("HUB_PUBLIC_URL");
    expect(config).not.toHaveProperty("CF_ACCESS_CLIENT_SECRET");
    expect(manifest).toMatchObject({
      version: 1,
      customHostname: "tiller.example.com",
      workerService: "tiller",
      accountId: "account-1",
      zoneId: "zone-1",
      customDomainId: "domain-1",
      accessApplicationId: "legacy-app",
      accessPolicyIds: ["browser-policy", "service-policy"],
    });
    expect(JSON.stringify(manifest)).not.toContain("must-not-leak");
    expect(JSON.stringify(manifest)).not.toContain("legacy-client-id");
    expect(fetchSpy).not.toHaveBeenCalled();

    const capturedAt = manifest.capturedAt;
    await subject.ensureExecutionConfiguration();
    expect(JSON.parse(subject.getAllConfig()[LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY] ?? "null").capturedAt)
      .toBe(capturedAt);
    storage.close();
  });

  it("requires binding-backed Access trust without RPCing HubDO", async () => {
    const getHubStub = vi.fn(() => {
      throw new Error("HubDO must not call its own stub");
    });
    const { subject, storage } = createSubject({
      HUB: { idFromName: vi.fn(() => "hub-id"), get: getHubStub },
    });

    await expect(subject.ensureExecutionConfiguration()).rejects.toThrow(
      "Canonical workers.dev Access trust is required",
    );
    expect(getHubStub).not.toHaveBeenCalled();
    storage.close();
  });

  it("fails closed without clearing unreadable legacy cleanup state", async () => {
    const { subject, storage } = createSubject();
    subject.setConfig("TILLER_SELF_HOST_STATE", JSON.stringify({
      resources: {
        workerCustomDomain: {
          hostname: "tiller.example.com",
          service: "tiller",
          accountId: "account-1",
        },
      },
    }));
    subject.setConfig("HUB_PUBLIC_URL", "https://tiller.example.com");

    await expect(subject.ensureExecutionConfiguration()).rejects.toThrow(
      "migration stopped before clearing cleanup identifiers",
    );
    const config = subject.getAllConfig();
    expect(config).toHaveProperty("TILLER_SELF_HOST_STATE");
    expect(config.HUB_PUBLIC_URL).toBe("https://tiller.example.com");
    expect(config).not.toHaveProperty(EXECUTION_MIGRATION_KEY);
    storage.close();
  });

  it("fails closed when a previously captured cleanup manifest is invalid", async () => {
    const { subject, storage } = createSubject();
    subject.setConfig(LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY, JSON.stringify({
      version: 1,
      customHostname: "tiller.example.com",
      clientSecret: "must-not-survive-validation",
    }));
    subject.setConfig("TILLER_SELF_HOST_STATE", JSON.stringify(legacyState()));

    await expect(subject.ensureExecutionConfiguration()).rejects.toThrow(
      "cleanup manifest is invalid",
    );
    expect(subject.getAllConfig()).toHaveProperty("TILLER_SELF_HOST_STATE");
    expect(subject.getAllConfig()).not.toHaveProperty(EXECUTION_MIGRATION_KEY);
    storage.close();
  });

  it("fails closed instead of restoring Cloudflare after migration", async () => {
    const { subject, storage } = createSubject();
    subject.setConfig(EXECUTION_MIGRATION_KEY, "1");
    subject.setConfig(EXECUTION_SELECTION_KEY, JSON.stringify({
      target: "host",
      machineId: "",
    }));

    await expect(subject.ensureExecutionConfiguration()).rejects.toThrow(
      "Persisted execution backend selection is invalid",
    );
    expect(JSON.parse(subject.getAllConfig()[EXECUTION_SELECTION_KEY] ?? "null"))
      .toEqual({ target: "host", machineId: "" });
    storage.close();
  });

  it("does not overwrite a concurrent machine selection after the clean-slate scan", async () => {
    const { subject, storage } = createSubject(installedAccessBindings());
    const service = {
      machineId: "machine-1",
      displayName: "Build Mac",
      connectedAt: new Date().toISOString(),
      runnerCommandProtocol: 1 as const,
      codexRuntimeAuthProtocol: 1 as const,
      dockerAvailable: true,
      runnerAvailable: true,
      claudeSubscription: false,
      transport: "session" as const,
    };
    (subject as any).getRoutableHostService = vi.fn(() => service);
    (subject as any).readRegisteredHostService = vi.fn(() => service);

    let releaseFirstScan!: (value: { ok: true; blockers: [] }) => void;
    mocks.inspectPredeployCleanSlate
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirstScan = resolve;
      }))
      .mockResolvedValue({ ok: true, blockers: [] });

    const firstMigration = subject.ensureExecutionConfiguration();
    await vi.waitFor(() => {
      expect(mocks.inspectPredeployCleanSlate).toHaveBeenCalledTimes(1);
    });
    await expect(subject.setExecutionBackend({
      target: "host",
      expectedMachineId: "machine-1",
    })).resolves.toMatchObject({
      ok: true,
      status: { selected: { target: "host", machineId: "machine-1" } },
    });

    releaseFirstScan({ ok: true, blockers: [] });
    await expect(firstMigration).resolves.toEqual({
      target: "host",
      machineId: "machine-1",
    });
    expect(JSON.parse(subject.getAllConfig()[EXECUTION_SELECTION_KEY] ?? "null"))
      .toEqual({ target: "host", machineId: "machine-1" });
    storage.close();
  });
});

describe("Hub execution selection", () => {
  it("uses the exact ready candidate and keeps an already-selected machine idempotent while offline", async () => {
    const { subject, storage } = createSubject();
    const service = {
      machineId: "machine-1",
      displayName: "Build Mac",
      connectedAt: new Date().toISOString(),
      runnerCommandProtocol: 1 as const,
      codexRuntimeAuthProtocol: 1 as const,
      dockerAvailable: true,
      runnerAvailable: true,
      claudeSubscription: false,
      transport: "session" as const,
    };
    (subject as any).getRoutableHostService = vi.fn(() => service);
    (subject as any).readRegisteredHostService = vi.fn(() => service);

    const selected = await subject.setExecutionBackend({
      target: "host",
      expectedMachineId: "machine-1",
    });
    expect(selected).toMatchObject({
      ok: true,
      status: {
        selected: { target: "host", machineId: "machine-1" },
        executionReady: true,
      },
    });
    await expect(subject.resolveNewExecutionPlacement()).resolves.toEqual({
      backend: "host",
      machineId: "machine-1",
    });

    (subject as any).getRoutableHostService = vi.fn(() => null);
    const idempotent = await subject.setExecutionBackend({
      target: "host",
      expectedMachineId: "machine-1",
    });
    expect(idempotent).toMatchObject({
      ok: true,
      status: {
        selectedHost: { state: "offline", machineId: "machine-1" },
        executionReady: false,
      },
    });
    await expect(subject.resolveNewExecutionPlacement())
      .rejects.toThrow(NEW_EXECUTION_UNAVAILABLE_MESSAGE);
    storage.close();
  });

  it("returns a structured conflict if the candidate changed", async () => {
    const { subject, storage } = createSubject();
    (subject as any).getRoutableHostService = vi.fn(() => ({
      machineId: "machine-2",
      displayName: "Replacement",
      connectedAt: new Date().toISOString(),
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      dockerAvailable: true,
      runnerAvailable: true,
      claudeSubscription: false,
      transport: "session",
    }));
    (subject as any).readRegisteredHostService = vi.fn(() => null);

    await expect(subject.setExecutionBackend({
      target: "host",
      expectedMachineId: "machine-1",
    })).resolves.toMatchObject({
      ok: false,
      code: "execution_candidate_changed",
      status: {
        candidate: { state: "ready", machineId: "machine-2" },
      },
    });
    storage.close();
  });
});
