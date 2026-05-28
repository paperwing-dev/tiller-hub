import { getLocationHintOptions } from "../helpers";
import type { Env } from "../types";
import { invalidateConfigCache } from "../setup/config";

export const SELF_HOST_STATE_KEY = "TILLER_SELF_HOST_STATE";
export const SELF_HOST_SETUP_SESSION_KEY = "TILLER_SELF_HOST_SETUP_SESSION";
export const LEGACY_GATEWAY_TUNNEL_TOKEN_KEY = "TILLER_GATEWAY_TUNNEL_TOKEN";
export const SELF_HOST_SETUP_TTL_MS = 15 * 60 * 1000;

export interface SelfHostRollbackConfig {
  workersDevHubUrl: string;
  workerServiceName: string | null;
  workersDevAliasDisabled: string | null;
  cfAccessConfigured: string | null;
  browserAccess: {
    appId: string | null;
    aud: string;
    issuer: string | null;
    jwksUrl: string | null;
    appDomain: string | null;
    appType: string | null;
    overlappingWildcardAppDomain: string | null;
    browserPolicyId: string | null;
  };
}

export interface SelfHostWorkerCustomDomainResource {
  hostname: string;
  hubUrl: string;
  service: string;
  zoneName: string;
  accountId: string;
  zoneId: string;
  domainId: string;
}

export interface SelfHostAccessResource {
  appId: string;
  aud: string;
  appDomain: string;
  issuer: string;
  jwksUrl: string | null;
  accessTeamDomain: string;
  browserPolicyId: string | null;
  serviceTokenId: string;
  serviceTokenPolicyId: string;
  clientId: string;
}

export interface SelfHostGatewayResource {
  hostname: string;
  appId: string;
  appDomain: string;
  serviceTokenPolicyId: string;
  tunnelId: string;
  tunnelName: string;
  tunnelTargetPort: number;
}

export interface SelfHostResources {
  workerCustomDomain: SelfHostWorkerCustomDomainResource;
  hubAccess: SelfHostAccessResource;
  gateway: SelfHostGatewayResource;
}

export type SelfHostSetupProgressStep =
  | "credentials-issued"
  | "docker"
  | "cloudflared"
  | "image"
  | "activate"
  | "complete"
  | "failed";

export interface SelfHostSetupProgress {
  step: SelfHostSetupProgressStep;
  message: string;
  error?: string;
  updatedAt: string;
}

export type FailedSelfHostSetupProgress = SelfHostSetupProgress & { step: "failed" };

interface SelfHostStateBase {
  schemaVersion: 2;
  attemptId: string;
  rollback: SelfHostRollbackConfig;
  resources: SelfHostResources;
  progress?: SelfHostSetupProgress;
}

export interface PendingSelfHostState extends SelfHostStateBase {
  phase: "pending";
  nonce: string;
  expiresAt: string;
  secretMaterial: {
    clientSecret: string;
    tunnelToken: string;
    enableToken: string;
  };
}

export interface PromotedSelfHostState extends SelfHostStateBase {
  phase: "promoted";
  expiresAt: string;
  secretMaterial: {
    enableToken: string;
  };
}

export interface EnabledSelfHostState extends SelfHostStateBase {
  phase: "enabled";
}

export interface FailedSelfHostState extends SelfHostStateBase {
  phase: "failed";
  progress: FailedSelfHostSetupProgress;
}

export type SelfHostState =
  | PendingSelfHostState
  | PromotedSelfHostState
  | EnabledSelfHostState
  | FailedSelfHostState;

export type SelfHostMutationExpected =
  | { state: "absent" }
  | { attemptId: string; phase: SelfHostState["phase"] };

export interface SelfHostMutationInput {
  expected: SelfHostMutationExpected;
  nextState: SelfHostState | null;
  configEntries?: Record<string, string | null>;
}

export interface SelfHostProgressMutationInput {
  expected: { attemptId: string };
  progress: SelfHostSetupProgress;
}

export type ExpirableSelfHostState = PendingSelfHostState | PromotedSelfHostState;
export type TerminalSelfHostFailureState = PendingSelfHostState | PromotedSelfHostState;

type HubConfigStore = {
  getConfig(key: string): Promise<string | undefined> | string | undefined;
  commitSelfHostMutation?(input: SelfHostMutationInput): Promise<boolean> | boolean;
  commitSelfHostProgress?(input: SelfHostProgressMutationInput): Promise<boolean> | boolean;
};

const ROLLBACK_READ_KEYS = [
  "HUB_PUBLIC_URL",
  "WORKER_SERVICE_NAME",
  "WORKERS_DEV_ALIAS_DISABLED",
  "CF_ACCESS_CONFIGURED",
  "CF_ACCESS_APP_ID",
  "CF_ACCESS_AUD",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_JWKS_URL",
  "CF_ACCESS_APP_DOMAIN",
  "CF_ACCESS_APP_TYPE",
  "CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN",
  "CF_ACCESS_BROWSER_POLICY_ID",
] as const;

const CUSTOM_DOMAIN_ACCESS_KEYS_TO_CLEAR = [
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_SERVICE_TOKEN_ID",
  "CF_ACCESS_SERVICE_TOKEN_POLICY_ID",
  "TILLER_GATEWAY_HOSTNAME",
  "CF_ACCESS_GATEWAY_APP_ID",
  "CF_ACCESS_GATEWAY_APP_DOMAIN",
  "CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID",
  "TILLER_GATEWAY_TUNNEL_ID",
  "TILLER_GATEWAY_TUNNEL_NAME",
  "TILLER_GATEWAY_TUNNEL_TARGET_PORT",
  LEGACY_GATEWAY_TUNNEL_TOKEN_KEY,
] as const;

function getHubConfigStore(env: Env): HubConfigStore {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as HubConfigStore;
}

function hasHubConfigStore(env: Env): boolean {
  return Boolean((env as unknown as { HUB?: unknown }).HUB);
}

function normalizeOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : value === null ? null : null;
}

function readFinitePort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelfHostSetupProgressStep(value: unknown): value is SelfHostSetupProgressStep {
  return value === "credentials-issued"
    || value === "docker"
    || value === "cloudflared"
    || value === "image"
    || value === "activate"
    || value === "complete"
    || value === "failed";
}

function randomSecret(): string {
  return `${crypto.randomUUID()}.${crypto.randomUUID()}`;
}

export function createSelfHostFailureProgress(
  message: string,
  options: { error?: string; updatedAt?: string } = {},
): FailedSelfHostSetupProgress {
  return {
    step: "failed",
    message,
    ...(options.error ? { error: options.error } : {}),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

export function createSelfHostSetupIds(): {
  attemptId: string;
  nonce: string;
  enableToken: string;
} {
  return {
    attemptId: crypto.randomUUID(),
    nonce: randomSecret(),
    enableToken: randomSecret(),
  };
}

export async function readConfigValue(env: Env, key: string): Promise<string | null> {
  if (!hasHubConfigStore(env)) return null;
  return normalizeOptional(await getHubConfigStore(env).getConfig(key));
}

export function accessCertsUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/cdn-cgi/access/certs`;
}

export async function readWorkersDevRollbackConfig(
  env: Env,
  workersDevHubUrl: string,
): Promise<SelfHostRollbackConfig> {
  const values: Partial<Record<(typeof ROLLBACK_READ_KEYS)[number], string | null>> = {};
  for (const key of ROLLBACK_READ_KEYS) {
    values[key] = await readConfigValue(env, key);
  }

  const aud = values.CF_ACCESS_AUD?.trim();
  if (!aud) {
    throw new Error("Self Host setup requires active workers.dev browser Access configuration.");
  }

  return {
    workersDevHubUrl: values.HUB_PUBLIC_URL?.trim() || workersDevHubUrl,
    workerServiceName: values.WORKER_SERVICE_NAME ?? null,
    workersDevAliasDisabled: values.WORKERS_DEV_ALIAS_DISABLED ?? null,
    cfAccessConfigured: values.CF_ACCESS_CONFIGURED ?? null,
    browserAccess: {
      appId: values.CF_ACCESS_APP_ID ?? null,
      aud,
      issuer: values.CF_ACCESS_TEAM_DOMAIN ?? null,
      jwksUrl: values.CF_ACCESS_JWKS_URL ?? null,
      appDomain: values.CF_ACCESS_APP_DOMAIN ?? null,
      appType: values.CF_ACCESS_APP_TYPE ?? null,
      overlappingWildcardAppDomain: values.CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN ?? null,
      browserPolicyId: values.CF_ACCESS_BROWSER_POLICY_ID ?? null,
    },
  };
}

export function rollbackConfigEntries(rollback: SelfHostRollbackConfig): Record<string, string | null> {
  const entries: Record<string, string | null> = {
    HUB_PUBLIC_URL: rollback.workersDevHubUrl,
    WORKER_SERVICE_NAME: rollback.workerServiceName,
    WORKERS_DEV_ALIAS_DISABLED: rollback.workersDevAliasDisabled,
    TILLER_DEPLOYMENT_MODE: "hosted",
    CF_ACCESS_CONFIGURED: rollback.cfAccessConfigured,
    CF_ACCESS_APP_ID: rollback.browserAccess.appId,
    CF_ACCESS_AUD: rollback.browserAccess.aud,
    CF_ACCESS_TEAM_DOMAIN: rollback.browserAccess.issuer,
    CF_ACCESS_JWKS_URL: rollback.browserAccess.jwksUrl,
    CF_ACCESS_APP_DOMAIN: rollback.browserAccess.appDomain,
    CF_ACCESS_APP_TYPE: rollback.browserAccess.appType,
    CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN: rollback.browserAccess.overlappingWildcardAppDomain,
    CF_ACCESS_BROWSER_POLICY_ID: rollback.browserAccess.browserPolicyId,
  };
  for (const key of CUSTOM_DOMAIN_ACCESS_KEYS_TO_CLEAR) {
    entries[key] = null;
  }
  return entries;
}

function parseRollback(value: unknown): SelfHostRollbackConfig | null {
  if (!isRecord(value) || !isRecord(value.browserAccess)) return null;
  const workersDevHubUrl = readString(value.workersDevHubUrl);
  const aud = readString(value.browserAccess.aud);
  if (!workersDevHubUrl || !aud) return null;
  return {
    workersDevHubUrl,
    workerServiceName: readNullableString(value.workerServiceName),
    workersDevAliasDisabled: readNullableString(value.workersDevAliasDisabled),
    cfAccessConfigured: readNullableString(value.cfAccessConfigured),
    browserAccess: {
      appId: readNullableString(value.browserAccess.appId),
      aud,
      issuer: readNullableString(value.browserAccess.issuer),
      jwksUrl: readNullableString(value.browserAccess.jwksUrl),
      appDomain: readNullableString(value.browserAccess.appDomain),
      appType: readNullableString(value.browserAccess.appType),
      overlappingWildcardAppDomain: readNullableString(value.browserAccess.overlappingWildcardAppDomain),
      browserPolicyId: readNullableString(value.browserAccess.browserPolicyId),
    },
  };
}

function parseResources(value: unknown): SelfHostResources | null {
  if (!isRecord(value) || !isRecord(value.workerCustomDomain) || !isRecord(value.hubAccess) || !isRecord(value.gateway)) {
    return null;
  }
  const workerCustomDomain = {
    hostname: readString(value.workerCustomDomain.hostname),
    hubUrl: readString(value.workerCustomDomain.hubUrl),
    service: readString(value.workerCustomDomain.service),
    zoneName: readString(value.workerCustomDomain.zoneName),
    accountId: readString(value.workerCustomDomain.accountId),
    zoneId: readString(value.workerCustomDomain.zoneId),
    domainId: readString(value.workerCustomDomain.domainId),
  };
  const hubAccess = {
    appId: readString(value.hubAccess.appId),
    aud: readString(value.hubAccess.aud),
    appDomain: readString(value.hubAccess.appDomain),
    issuer: readString(value.hubAccess.issuer),
    jwksUrl: readNullableString(value.hubAccess.jwksUrl),
    accessTeamDomain: readString(value.hubAccess.accessTeamDomain),
    browserPolicyId: readNullableString(value.hubAccess.browserPolicyId),
    serviceTokenId: readString(value.hubAccess.serviceTokenId),
    serviceTokenPolicyId: readString(value.hubAccess.serviceTokenPolicyId),
    clientId: readString(value.hubAccess.clientId),
  };
  const gateway = {
    hostname: readString(value.gateway.hostname),
    appId: readString(value.gateway.appId),
    appDomain: readString(value.gateway.appDomain),
    serviceTokenPolicyId: readString(value.gateway.serviceTokenPolicyId),
    tunnelId: readString(value.gateway.tunnelId),
    tunnelName: readString(value.gateway.tunnelName),
    tunnelTargetPort: readFinitePort(value.gateway.tunnelTargetPort),
  };
  if (
    !workerCustomDomain.hostname
    || !workerCustomDomain.hubUrl
    || !workerCustomDomain.service
    || !workerCustomDomain.zoneName
    || !workerCustomDomain.accountId
    || !workerCustomDomain.zoneId
    || !workerCustomDomain.domainId
    || !hubAccess.appId
    || !hubAccess.aud
    || !hubAccess.appDomain
    || !hubAccess.issuer
    || !hubAccess.accessTeamDomain
    || !hubAccess.serviceTokenId
    || !hubAccess.serviceTokenPolicyId
    || !hubAccess.clientId
    || !gateway.hostname
    || !gateway.appId
    || !gateway.appDomain
    || !gateway.serviceTokenPolicyId
    || !gateway.tunnelId
    || !gateway.tunnelName
    || !gateway.tunnelTargetPort
  ) {
    return null;
  }
  return {
    workerCustomDomain: workerCustomDomain as SelfHostWorkerCustomDomainResource,
    hubAccess: hubAccess as SelfHostAccessResource,
    gateway: gateway as SelfHostGatewayResource,
  };
}

function parseProgress(value: unknown): SelfHostSetupProgress | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const step = value.step;
  const message = readString(value.message);
  const updatedAt = readString(value.updatedAt);
  const error = value.error === undefined ? undefined : readString(value.error);
  if (!isSelfHostSetupProgressStep(step) || !message || !updatedAt || (value.error !== undefined && !error)) {
    return null;
  }
  if (!Number.isFinite(Date.parse(updatedAt))) return null;
  return {
    step,
    message,
    ...(error ? { error } : {}),
    updatedAt,
  };
}

export function parseSelfHostState(raw: string | undefined | null): SelfHostState | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 2) return null;
    const attemptId = readString(parsed.attemptId);
    const phase = parsed.phase;
    const rollback = parseRollback(parsed.rollback);
    const resources = parseResources(parsed.resources);
    const progress = parseProgress(parsed.progress);
    if (!attemptId || !rollback || !resources) return null;
    if (parsed.progress !== undefined && !progress) return null;

    if (phase === "pending") {
      const nonce = readString(parsed.nonce);
      const expiresAt = readString(parsed.expiresAt);
      if (!nonce || !expiresAt || !isRecord(parsed.secretMaterial)) return null;
      const clientSecret = readString(parsed.secretMaterial.clientSecret);
      const tunnelToken = readString(parsed.secretMaterial.tunnelToken);
      const enableToken = readString(parsed.secretMaterial.enableToken);
      if (!clientSecret || !tunnelToken || !enableToken) return null;
      return {
        schemaVersion: 2,
        phase,
        attemptId,
        nonce,
        expiresAt,
        rollback,
        resources,
        ...(progress ? { progress } : {}),
        secretMaterial: { clientSecret, tunnelToken, enableToken },
      };
    }

    if (phase === "promoted") {
      const expiresAt = readString(parsed.expiresAt);
      if (!expiresAt || !isRecord(parsed.secretMaterial)) return null;
      const enableToken = readString(parsed.secretMaterial.enableToken);
      if (!enableToken) return null;
      return {
        schemaVersion: 2,
        phase,
        attemptId,
        expiresAt,
        rollback,
        resources,
        ...(progress ? { progress } : {}),
        secretMaterial: { enableToken },
      };
    }

    if (phase === "enabled") {
      return {
        schemaVersion: 2,
        phase,
        attemptId,
        rollback,
        resources,
        ...(progress ? { progress } : {}),
      };
    }

    if (phase === "failed") {
      if (!progress || progress.step !== "failed") return null;
      return {
        schemaVersion: 2,
        phase,
        attemptId,
        rollback,
        resources,
        progress,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function readSelfHostState(env: Env): Promise<SelfHostState | null> {
  if (!hasHubConfigStore(env)) return null;
  const raw = await getHubConfigStore(env).getConfig(SELF_HOST_STATE_KEY);
  return parseSelfHostState(raw);
}

export function isSelfHostStateExpired(
  state: Pick<ExpirableSelfHostState, "expiresAt">,
  at = Date.now(),
): boolean {
  const expiresAt = Date.parse(state.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= at;
}

export function isSelfHostSetupInProgress(state: SelfHostState | null): boolean {
  return Boolean(state && (state.phase === "pending" || state.phase === "promoted"));
}

export function selfHostSetupWorkersDevUrl(state: SelfHostState | null): string | null {
  return state?.rollback.workersDevHubUrl?.trim() || null;
}

export function createPendingSelfHostState(input: {
  rollback: SelfHostRollbackConfig;
  resources: SelfHostResources;
  clientSecret: string;
  tunnelToken: string;
  ttlMs?: number;
}): PendingSelfHostState {
  const ids = createSelfHostSetupIds();
  const createdAtMs = Date.now();
  return {
    schemaVersion: 2,
    phase: "pending",
    attemptId: ids.attemptId,
    nonce: ids.nonce,
    expiresAt: new Date(createdAtMs + (input.ttlMs ?? SELF_HOST_SETUP_TTL_MS)).toISOString(),
    rollback: input.rollback,
    resources: input.resources,
    secretMaterial: {
      clientSecret: input.clientSecret,
      tunnelToken: input.tunnelToken,
      enableToken: ids.enableToken,
    },
  };
}

export function createFailedSelfHostState(
  state: TerminalSelfHostFailureState,
  progress: FailedSelfHostSetupProgress,
): FailedSelfHostState {
  return {
    schemaVersion: 2,
    phase: "failed",
    attemptId: state.attemptId,
    rollback: state.rollback,
    resources: state.resources,
    progress,
  };
}

export async function commitSelfHostMutation(
  env: Env,
  input: SelfHostMutationInput,
): Promise<boolean> {
  if (!hasHubConfigStore(env)) return false;
  const hub = getHubConfigStore(env);
  if (typeof hub.commitSelfHostMutation !== "function") {
    throw new Error("Self Host lifecycle storage is not available.");
  }
  const committed = await hub.commitSelfHostMutation(input);
  if (committed) invalidateConfigCache();
  return committed;
}

export async function commitSelfHostProgress(
  env: Env,
  input: SelfHostProgressMutationInput,
): Promise<boolean> {
  if (!hasHubConfigStore(env)) return false;
  const hub = getHubConfigStore(env);
  if (typeof hub.commitSelfHostProgress !== "function") {
    throw new Error("Self Host progress storage is not available.");
  }
  return await hub.commitSelfHostProgress(input);
}

export async function failSelfHostSetup(
  env: Env,
  state: TerminalSelfHostFailureState,
  progress: FailedSelfHostSetupProgress,
): Promise<SelfHostState | null> {
  const failed = createFailedSelfHostState(state, progress);
  const committed = await commitSelfHostMutation(env, {
    expected: { attemptId: state.attemptId, phase: state.phase },
    nextState: failed,
    configEntries: rollbackConfigEntries(state.rollback),
  });
  if (committed) return failed;
  return readSelfHostState(env);
}

export async function expireSelfHostStateIfNeeded(env: Env): Promise<SelfHostState | null> {
  const state = await readSelfHostState(env);
  if (!state) return null;
  if (state.phase === "enabled" || state.phase === "failed") return state;
  if (!isSelfHostStateExpired(state)) return state;

  if (state.phase === "promoted") {
    return failSelfHostSetup(
      env,
      state,
      createSelfHostFailureProgress("Self Host setup expired before it was enabled.", {
        error: "Rolled back to Hosted Tiller. Rerun setup from the workers.dev URL.",
      }),
    );
  }

  const committed = await commitSelfHostMutation(env, {
    expected: { attemptId: state.attemptId, phase: state.phase },
    nextState: null,
    configEntries: {},
  });
  if (!committed) {
    return readSelfHostState(env);
  }
  return null;
}
