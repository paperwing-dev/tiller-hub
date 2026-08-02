import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Select } from "@cloudflare/kumo/components/select";
import type { Artifact } from "../api/coordination/types";
import type {
  EnvHarness,
  HarnessSettings,
  RepoMeta,
} from "../api/types";
import {
  getHarnessDefault,
  getHarnessModel,
  resolveHarnessModelAvailability,
} from "../shared/harness-catalog";
import type { BillingMode } from "../shared/billing";
import {
  fetchExecutionStatus,
  fetchRepoArtifacts,
  type CreateEnvOptions,
  type ExecutionStatus,
  type GitHubRepositorySelection,
  type StartupPlanSelection,
} from "./api";
import { getHarnessBadgeLabel } from "./env-harness";
import { NEW_EXECUTION_UNAVAILABLE_MESSAGE } from "./env-display";
import HarnessSettingsFields from "./HarnessSettingsFields";
import MarkdownContent from "./MarkdownContent";
import { isPlanOutdatedForMain, listPlanArtifacts, renderArtifactBodyMarkdown } from "./plan-artifacts";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";
import { githubRepositoryKey, useGitHubRepositories } from "./useGitHubRepositories";

// ── NewRepoDialog ────────────────────────────────────────────────

export const REPOSITORY_PAGE_SIZE = 5;

export function getRepositoryPagination(
  totalItems: number,
  requestedPage: number,
  pageSize = REPOSITORY_PAGE_SIZE,
): {
  page: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  hasPrevious: boolean;
  hasNext: boolean;
} {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const safeTotal = Math.max(0, totalItems);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = Math.min((page - 1) * safePageSize, safeTotal);
  const endIndex = Math.min(startIndex + safePageSize, safeTotal);
  return {
    page,
    totalPages,
    startIndex,
    endIndex,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

interface NewRepoDialogProps {
  onClose: () => void;
  hubUrl: string;
  repos: RepoMeta[];
  onCreate: (selection: GitHubRepositorySelection) => Promise<void>;
}

export function NewRepoDialog({ onClose, hubUrl, repos, onCreate }: NewRepoDialogProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedKey, setSelectedKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubRepositories = useGitHubRepositories(hubUrl);
  const { repositories, warnings, loading: loadingRepositories } = githubRepositories;
  const existingRepoIds = useMemo(() => new Set(repos.map((repo) => repo.repoId)), [repos]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRepositories = useMemo(
    () => repositories.filter((repo) => repo.fullName.toLowerCase().includes(normalizedQuery)),
    [repositories, normalizedQuery],
  );
  const pagination = getRepositoryPagination(visibleRepositories.length, page);
  const pageRepositories = useMemo(
    () => visibleRepositories.slice(pagination.startIndex, pagination.endIndex),
    [pagination.endIndex, pagination.startIndex, visibleRepositories],
  );
  const selected = pageRepositories.find((repo) => repoKey(repo) === selectedKey) ?? null;
  const canPage = !loading && !loadingRepositories;

  useEffect(() => {
    setPage((current) => getRepositoryPagination(visibleRepositories.length, current).page);
  }, [visibleRepositories.length]);

  useEffect(() => {
    const currentSelection = pageRepositories.find((repo) => repoKey(repo) === selectedKey);
    if (currentSelection && !existingRepoIds.has(String(currentSelection.repositoryId))) return;

    const firstAvailable = pageRepositories.find((repo) => !existingRepoIds.has(String(repo.repositoryId)));
    setSelectedKey(firstAvailable ? repoKey(firstAvailable) : "");
  }, [existingRepoIds, pageRepositories, selectedKey]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setPage(1);
  };

  const goToPreviousPage = () => {
    setPage(getRepositoryPagination(visibleRepositories.length, pagination.page - 1).page);
  };
  const goToNextPage = () => {
    setPage(getRepositoryPagination(visibleRepositories.length, pagination.page + 1).page);
  };

  useEffect(() => {
    setError(githubRepositories.error);
  }, [githubRepositories.error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || existingRepoIds.has(String(selected.repositoryId))) return;

    setLoading(true);
    setError(null);
    try {
      await onCreate(selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog className="w-full max-w-md p-0">
        <div className="border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-sm font-semibold text-kumo-strong">Add Repository</Dialog.Title>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4">
          <Input
            label="GitHub Repository"
            type="text"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search selected repositories"
            autoFocus
            disabled={loading || loadingRepositories}
            className="w-full"
          />
          <div className="mt-3 max-h-64 overflow-auto rounded border border-kumo-line bg-kumo-base">
            {loadingRepositories ? (
              <div className="px-3 py-3 text-xs text-kumo-subtle">Loading repositories...</div>
            ) : visibleRepositories.length > 0 ? (
              pageRepositories.map((repo) => {
                const key = repoKey(repo);
                const alreadyAdded = existingRepoIds.has(String(repo.repositoryId));
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-center gap-3 border-b border-kumo-line px-3 py-2 last:border-b-0 ${alreadyAdded ? "bg-kumo-recessed opacity-60" : "hover:bg-kumo-tint"}`}
                  >
                    <input
                      type="radio"
                      name="github-repo"
                      checked={selectedKey === key}
                      onChange={() => setSelectedKey(key)}
                      disabled={loading || alreadyAdded}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-kumo-default">{repo.fullName}</span>
                      <span className="block truncate text-[11px] text-kumo-subtle">
                        {alreadyAdded ? "Already added" : repo.private ? "Private" : "Public"}
                        {repo.defaultBranch ? ` · ${repo.defaultBranch}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })
            ) : (
              <div className="px-3 py-3 text-xs text-kumo-subtle">
                {repositories.length === 0 ? "No repositories available" : "No repositories match your search"}
              </div>
            )}
          </div>
          {visibleRepositories.length > 0 && pagination.totalPages > 1 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-kumo-subtle">
              <span>
                {pagination.startIndex + 1}-{pagination.endIndex} of {visibleRepositories.length}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={goToPreviousPage}
                  disabled={!canPage || !pagination.hasPrevious}
                >
                  Previous
                </Button>
                <span className="whitespace-nowrap">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={goToNextPage}
                  disabled={!canPage || !pagination.hasNext}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {warnings.length > 0 && (
            <p className="mt-2 text-xs text-kumo-warning">
              {warnings[0]?.message}
            </p>
          )}
          {error && (
            <p className="mt-2 text-xs text-kumo-danger">{error}</p>
          )}
          <div className="flex justify-end gap-2 mt-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={loading}
              disabled={loading || loadingRepositories || !selected || existingRepoIds.has(String(selected.repositoryId))}
            >
              {loading ? "Adding..." : "Add"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function repoKey(repo: GitHubRepositorySelection): string {
  return githubRepositoryKey(repo);
}

// ── NewEnvDialog ─────────────────────────────────────────────────

interface NewEnvDialogProps {
  onClose: () => void;
  hubUrl: string;
  hasClaudeSubscription?: boolean;
  hasAnthropicKey?: boolean;
  hasChatGPTAuth?: boolean;
  chatgptAuthStatus?: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
  hasOpenAIKey?: boolean;
  claudeBillingMode?: BillingMode | null;
  openaiBillingMode?: BillingMode | null;
  workersAiConfigured?: boolean;
  enabledHarnesses: EnvHarness[];
  repo: RepoMeta;
  onCreate: (options: CreateEnvOptions) => Promise<void>;
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

export function getNextLocalThreeAm(now = new Date()): { runAtMs: number; timeZone: string } {
  const runAt = new Date(now);
  runAt.setHours(3, 0, 0, 0);
  if (runAt.getTime() <= now.getTime()) runAt.setDate(runAt.getDate() + 1);
  return {
    runAtMs: runAt.getTime(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export function getScheduledRunRequirementError(options: {
  harness: EnvHarness;
  executionReady: boolean;
  openaiBillingMode: "subscription" | "api" | null;
  hasOpenAIKey: boolean;
  chatgptAuthStatus: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
}): string | null {
  if (!options.executionReady) return NEW_EXECUTION_UNAVAILABLE_MESSAGE;
  if (options.harness !== "codex") return "Scheduled Runs require the Codex harness.";
  if (options.openaiBillingMode === "api") {
    return options.hasOpenAIKey
      ? null
      : "Configure an OpenAI API key before scheduling a run.";
  }
  if (options.openaiBillingMode !== "subscription") {
    return "Select an OpenAI billing mode in Global Settings before scheduling a run.";
  }
  if (options.chatgptAuthStatus !== "connected" && options.chatgptAuthStatus !== "refreshing") {
    return options.chatgptAuthStatus === "temporarily_unavailable"
      ? "Codex subscription authentication is temporarily unavailable."
      : "Connect Codex subscription authentication before scheduling a run.";
  }
  return null;
}

export function getInitialEnvHarnessSelection(enabledHarnesses: EnvHarness[]): EnvHarness {
  return enabledHarnesses.includes("opencode")
    ? "opencode"
    : enabledHarnesses[0] ?? "claude-code";
}

export function getNewEnvHarnessDefault(harness: EnvHarness): HarnessSettings {
  return harness === "opencode"
    ? { model: "gpt-5.6-sol", effort: "xhigh" }
    : getHarnessDefault(harness);
}

export function NewEnvDialog({
  onClose,
  hubUrl,
  hasClaudeSubscription = false,
  hasAnthropicKey = false,
  hasChatGPTAuth = false,
  chatgptAuthStatus = "missing",
  hasOpenAIKey = false,
  claudeBillingMode = null,
  openaiBillingMode = null,
  workersAiConfigured = false,
  enabledHarnesses,
  repo,
  onCreate,
}: NewEnvDialogProps) {
  const initialHarness = getInitialEnvHarnessSelection(enabledHarnesses);
  const [harness, setHarness] = useState<EnvHarness>(initialHarness);
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettings>(() =>
    getNewEnvHarnessDefault(initialHarness),
  );
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatus | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [planChoice, setPlanChoice] = useState<"none" | "specific">("none");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [scheduleTonight, setScheduleTonight] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backend = executionStatus?.selected.target ?? "cf";
  const executionReady = executionStatus?.executionReady ?? false;
  const repoMainReady = isRepoMainReady(repo);
  const repoMainDetail = getRepoMainStatusDetail(repo);
  const selectedCatalogModel = getHarnessModel(harness, harnessSettings.model);
  const credentialStatus = {
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    hasOpenAIKey,
    workersAiConfigured,
    claudeBillingMode,
    openaiBillingMode,
    chatgptAuthStatus,
    openaiSubscriptionReady: executionReady,
    openaiSubscriptionUnavailableReason: executionReady
      ? null
      : NEW_EXECUTION_UNAVAILABLE_MESSAGE,
  };
  const selectedAvailability = selectedCatalogModel
    ? resolveHarnessModelAvailability(selectedCatalogModel, backend, credentialStatus)
    : null;
  const credentialError = selectedAvailability?.message ?? null;
  const planArtifacts = useMemo(
    () => listPlanArtifacts(artifacts).filter((plan) => plan.status === "todo"),
    [artifacts],
  );
  const selectedPlan = useMemo(
    () => planArtifacts.find((plan) => plan.id === selectedPlanId) ?? planArtifacts[0] ?? null,
    [planArtifacts, selectedPlanId],
  );
  const visibleError = error;
  const scheduledRunRequirementError = getScheduledRunRequirementError({
    harness,
    executionReady,
    openaiBillingMode,
    hasOpenAIKey,
    chatgptAuthStatus,
  });

  useEffect(() => {
    let cancelled = false;
    const loadPlans = async () => {
      setPlansLoading(true);
      setPlansError(null);
      try {
        const nextState = await fetchRepoArtifacts(hubUrl, repo.repoId);
        if (cancelled) return;
        setArtifacts(nextState.artifacts);
      } catch (loadError) {
        if (cancelled) return;
        setArtifacts([]);
        setPlansError(loadError instanceof Error ? loadError.message : "Failed to load plans");
      } finally {
        if (!cancelled) setPlansLoading(false);
      }
    };

    void loadPlans();
    return () => {
      cancelled = true;
    };
  }, [hubUrl, repo.repoId]);

  useEffect(() => {
    let cancelled = false;
    void fetchExecutionStatus(hubUrl)
      .then((status) => {
        if (!cancelled) setExecutionStatus(status);
      })
      .catch(() => {
        if (!cancelled) setExecutionStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hubUrl]);

  useEffect(() => {
    setSelectedPlanId((current) => {
      if (current && planArtifacts.some((plan) => plan.id === current)) return current;
      return planArtifacts[0]?.id ?? "";
    });
  }, [planArtifacts]);

  useEffect(() => {
    if (!enabledHarnesses.includes(harness)) {
      const nextHarness = getInitialEnvHarnessSelection(enabledHarnesses);
      setHarness(nextHarness);
      setHarnessSettings(getNewEnvHarnessDefault(nextHarness));
    }
  }, [enabledHarnesses, harness]);

  useEffect(() => {
    setError(null);
  }, [harness, planChoice, selectedPlanId]);

  useEffect(() => {
    if (planChoice !== "specific" || !selectedPlan || scheduledRunRequirementError) setScheduleTonight(false);
  }, [scheduledRunRequirementError, planChoice, selectedPlan]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (credentialError) return;
    const planSelection: StartupPlanSelection = planChoice === "specific"
      ? selectedPlan
        ? { mode: "specific", artifactId: selectedPlan.id }
        : { mode: "none" }
      : { mode: "none" };
    if (planChoice === "specific" && !selectedPlan) {
      setError("Choose a plan before creating the environment.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onCreate({
        harness,
        planSelection,
        harnessSettings,
        schedule: scheduleTonight ? getNextLocalThreeAm() : undefined,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog className="flex h-[calc(100vh-2rem)] max-h-[52rem] w-full max-w-2xl flex-col overflow-hidden p-0">
        <div className="border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="text-sm font-semibold text-kumo-strong">New Environment</Dialog.Title>
          <Dialog.Description className="text-xs text-kumo-subtle mt-0.5">{repoLabel(repo.repoUrl)}</Dialog.Description>
        </div>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!repoMainReady && (
            <div className="mb-3 rounded border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-kumo-warning">
                {getRepoMainStatusLabel(repo)}
              </div>
              <p className="mt-1 text-xs text-kumo-warning">
                {repoMainDetail}
              </p>
            </div>
          )}
          <label className="block text-xs font-medium text-kumo-subtle mb-1.5">
            Harness
          </label>
          <Select
            aria-label="Harness"
            className="w-full"
            value={harness}
            onValueChange={(value) => {
              const nextHarness = (value ?? getInitialEnvHarnessSelection(enabledHarnesses)) as EnvHarness;
              setHarness(nextHarness);
              setHarnessSettings(getNewEnvHarnessDefault(nextHarness));
            }}
            disabled={loading}
            renderValue={(value) => getHarnessBadgeLabel(value as EnvHarness)}
          >
            {enabledHarnesses.map((enabledHarness) => (
              <Select.Option key={enabledHarness} value={enabledHarness}>
                {getHarnessBadgeLabel(enabledHarness)}
              </Select.Option>
            ))}
          </Select>
          <HarnessSettingsFields
            className="mt-3"
            harness={harness}
            backend={backend}
            value={harnessSettings}
            credentialStatus={credentialStatus}
            disabled={loading}
            onChange={(nextSettings) => {
              setHarnessSettings(nextSettings);
              setError(null);
            }}
          />
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-medium text-kumo-subtle">Startup Plan</div>
            {plansLoading ? (
              <div className="rounded border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
                Loading plans...
              </div>
            ) : (
              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-3 rounded border border-kumo-line px-3 py-2">
                  <input
                    type="radio"
                    name={`new-env-plan-choice-${repo.repoId}`}
                    value="none"
                    checked={planChoice === "none"}
                    onChange={() => setPlanChoice("none")}
                    disabled={loading}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-kumo-default">No plan</span>
                    <span className="block text-xs text-kumo-subtle">
                      Best for quick debugging, small changes, or exploratory work that does not need a saved plan.
                    </span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded border border-kumo-line px-3 py-2">
                  <input
                    type="radio"
                    name={`new-env-plan-choice-${repo.repoId}`}
                    value="specific"
                    checked={planChoice === "specific"}
                    onChange={() => setPlanChoice("specific")}
                    disabled={planArtifacts.length === 0 || loading}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-kumo-default">Select from Plans to Do</span>
                    <Select
                      aria-label="Startup Plan"
                      className="mt-2 w-full"
                      size="sm"
                      value={selectedPlanId}
                      onValueChange={(value) => setSelectedPlanId(value ?? "")}
                      disabled={planChoice !== "specific" || planArtifacts.length === 0 || loading}
                      renderValue={(value) => {
                        const plan = planArtifacts.find((candidate) => candidate.id === value);
                        return plan ? planOptionLabel(plan, repo.mainCommit ?? null) : "";
                      }}
                    >
                      {planArtifacts.map((plan) => (
                        <Select.Option key={plan.id} value={plan.id}>
                          {planOptionLabel(plan, repo.mainCommit ?? null)}
                        </Select.Option>
                      ))}
                    </Select>
                    {plansError && (
                      <span className="mt-2 block text-xs text-kumo-warning">{plansError}</span>
                    )}
                    {!plansError && planArtifacts.length === 0 && (
                      <span className="mt-2 block text-xs text-kumo-subtle">No plans marked To do</span>
                    )}
                  </span>
                </label>
              </div>
            )}
          </div>
          {selectedPlan && planChoice === "specific" && !plansLoading && (
            <div className="mt-3 rounded border border-kumo-line bg-kumo-recessed px-3 py-3">
              <div className="text-xs font-medium text-kumo-subtle">Selected plan</div>
              <div className="mt-1 text-sm font-medium text-kumo-default">{selectedPlan.title || "Untitled plan"}</div>
              <div className="mt-1 text-xs text-kumo-subtle">
                Updated {formatTimestamp(selectedPlan.updatedAt)}
              </div>
              {isPlanOutdatedForMain(selectedPlan, repo.mainCommit ?? null) && (
                <div className="mt-2 rounded border border-kumo-warning/30 bg-kumo-warning-tint px-2 py-1.5 text-xs text-kumo-warning">
                  This plan was saved against a different main commit. You can still create with it because it was explicitly selected.
                </div>
              )}
              <div className="mt-3 max-h-[min(18rem,35vh)] overflow-y-auto rounded border border-kumo-line bg-kumo-base px-3 py-3">
                <MarkdownContent>{renderArtifactBodyMarkdown(selectedPlan.body)}</MarkdownContent>
              </div>
            </div>
          )}
          {selectedPlan && planChoice === "specific" && !plansLoading && (
            <div className="mt-3 rounded border border-kumo-line bg-kumo-recessed px-3 py-2">
              <label className={`flex items-start gap-3 ${scheduledRunRequirementError ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={scheduleTonight}
                  onChange={(event) => setScheduleTonight(event.target.checked)}
                  disabled={loading || Boolean(scheduledRunRequirementError)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-kumo-default">Schedule: run tonight at 3:00 AM</span>
                  <span className="block text-xs text-kumo-subtle">Create the stopped environment now and start it unattended at the next local 3:00 AM.</span>
                </span>
              </label>
              {scheduledRunRequirementError && (
                <p className="mt-2 text-xs text-kumo-warning">{scheduledRunRequirementError}</p>
              )}
            </div>
          )}
            {visibleError && (
              <p className="mt-2 text-xs text-kumo-danger">{visibleError}</p>
            )}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line px-5 py-4">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={loading}
              disabled={loading || !repoMainReady || Boolean(credentialError)}
            >
              {loading ? "Creating..." : !repoMainReady ? "Waiting for Main..." : scheduleTonight ? "Schedule" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

function planOptionLabel(plan: Artifact, repoMainCommit: string | null): string {
  return `${plan.title || "Untitled plan"}${isPlanOutdatedForMain(plan, repoMainCommit) ? " (main mismatch)" : ""}`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
