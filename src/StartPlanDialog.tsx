import { useEffect, useMemo, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Link } from "react-router";
import type { Artifact } from "../api/coordination/types";
import type { EnvMeta, HarnessSettings } from "../api/types";
import type { BillingMode } from "../shared/billing";
import {
  getHarnessDefault,
  getHarnessModel,
  resolveHarnessModelAvailability,
  validateHarnessSettings,
} from "../shared/harness-catalog";
import { fetchRepoArtifacts, startEnv } from "./api";
import { planPath, projectGlobalSettingsPath } from "./dashboard-paths";
import HarnessSettingsFields from "./HarnessSettingsFields";
import MarkdownContent from "./MarkdownContent";
import { isPlanOutdatedForMain, listPlanArtifacts, renderArtifactBodyMarkdown } from "./plan-artifacts";

interface StartPlanDialogProps {
  env: EnvMeta;
  repoMainCommit: string | null;
  hubUrl: string;
  onClose: () => void;
  onStarted: () => void;
  hasClaudeSubscription?: boolean;
  hasAnthropicKey?: boolean;
  hasChatGPTAuth?: boolean;
  hasOpenAIKey?: boolean;
  workersAiConfigured?: boolean;
  chatgptAuthStatus?: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
  claudeBillingMode?: BillingMode | null;
  openaiBillingMode?: BillingMode | null;
  onRefreshSetupStatus?: () => Promise<void>;
}

export default function StartPlanDialog({
  env,
  repoMainCommit,
  hubUrl,
  onClose,
  onStarted,
  hasClaudeSubscription = false,
  hasAnthropicKey = false,
  hasChatGPTAuth = false,
  hasOpenAIKey = false,
  workersAiConfigured = false,
  chatgptAuthStatus = "missing",
  claudeBillingMode = null,
  openaiBillingMode = null,
  onRefreshSetupStatus,
}: StartPlanDialogProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(Boolean(env.startupPlanId));
  const [starting, setStarting] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [harnessSettings, setHarnessSettings] = useState<HarnessSettings>(() =>
    validateHarnessSettings(env.harness, env.harnessSettings) ?? getHarnessDefault(env.harness),
  );
  const selectedCatalogModel = getHarnessModel(env.harness, harnessSettings.model);
  const credentialStatus = {
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    hasOpenAIKey,
    workersAiConfigured,
    claudeBillingMode,
    openaiBillingMode,
    chatgptAuthStatus,
    // Exact stored placement is enforced by the server. Global machine
    // readiness cannot determine whether this workload's machine is online.
    openaiSubscriptionReady: true,
    openaiSubscriptionUnavailableReason: null,
  };
  const selectedAvailability = selectedCatalogModel
    ? resolveHarnessModelAvailability(selectedCatalogModel, env.backend, credentialStatus)
    : null;
  const isStartable = env.status === "stopped" || env.status === "failed" || env.status === "unknown";

  const planArtifacts = useMemo(() => listPlanArtifacts(artifacts), [artifacts]);
  const selectedPlan = useMemo(
    () => env.startupPlanId ? planArtifacts.find((plan) => plan.id === env.startupPlanId) ?? null : null,
    [env.startupPlanId, planArtifacts],
  );

  useEffect(() => {
    let cancelled = false;
    const loadPlans = async () => {
      if (!env.startupPlanId) {
        setArtifacts([]);
        setLoading(false);
        setPlanError(null);
        return;
      }

      setLoading(true);
      setPlanError(null);
      try {
        if (!env.repoId) {
          setArtifacts([]);
          setPlanError("This environment does not have a repo identity yet.");
          return;
        }
        const nextState = await fetchRepoArtifacts(hubUrl, env.repoId);
        if (cancelled) return;
        setArtifacts(nextState.artifacts);
      } catch (loadError) {
        if (cancelled) return;
        setPlanError(loadError instanceof Error ? loadError.message : "Failed to load plans");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void loadPlans();
    return () => {
      cancelled = true;
    };
  }, [env.repoId, env.startupPlanId, hubUrl]);

  const handleStart = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startEnv(hubUrl, env.slug, { harnessSettings });
      onStarted();
      onClose();
    } catch (caughtError) {
      setStartError(caughtError instanceof Error ? caughtError.message : "Failed to start container");
    } finally {
      setStarting(false);
    }
  };

  const selectedSpecificOutdated = selectedPlan && isPlanOutdatedForMain(selectedPlan, repoMainCommit);
  const selectedPlanHref = env.startupPlanId && env.repoId ? planPath(env.repoId, env.startupPlanId) : null;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog className="tiller-dialog-shell flex h-[calc(100vh-2rem)] max-h-[52rem] w-full max-w-2xl flex-col overflow-hidden p-0 sm:min-w-[42rem]">
        <div className="tiller-dialog-header shrink-0 border-b border-kumo-line px-5 py-4">
          <Dialog.Title className="tiller-dialog-title text-sm font-semibold text-kumo-strong">
            Start Container
          </Dialog.Title>
          <Dialog.Description className="tiller-dialog-description mt-1 text-xs text-kumo-subtle">
            The startup plan was selected when this environment was created.
          </Dialog.Description>
        </div>

        <div className="tiller-dialog-body min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="text-xs font-medium text-kumo-subtle">Repository</div>
            <div className="mt-1 text-sm text-kumo-default">
              {env.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </div>
          </div>

          {isStartable && (
            <HarnessSettingsFields
              harness={env.harness}
              backend={env.backend}
              value={harnessSettings}
              credentialStatus={credentialStatus}
              disabled={starting}
              settingsPath={projectGlobalSettingsPath(env.repoId)}
              onRefreshSettings={onRefreshSetupStatus}
              onChange={(nextSettings) => {
                setHarnessSettings(nextSettings);
                setStartError(null);
              }}
            />
          )}

          <div>
            <div className="mb-2 text-xs font-medium text-kumo-subtle">Plan</div>
            {!env.startupPlanId ? (
              <div className="rounded border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default">
                No plan
              </div>
            ) : (
              <div className="rounded border border-kumo-line bg-kumo-recessed px-3 py-3">
                <div className="text-xs font-medium text-kumo-subtle">Selected plan</div>
                {selectedPlanHref ? (
                  <Link
                    to={selectedPlanHref}
                    onClick={onClose}
                    className="mt-1 inline-flex max-w-full whitespace-normal break-words text-sm font-medium text-kumo-link hover:underline"
                  >
                    {selectedPlan ? selectedPlan.title || "Untitled plan" : "Selected plan"}
                  </Link>
                ) : (
                  <div className="mt-1 text-sm font-medium text-kumo-default">
                    {selectedPlan ? selectedPlan.title || "Untitled plan" : "Selected plan"}
                  </div>
                )}
                {loading && (
                  <div className="mt-1 text-xs text-kumo-subtle">Loading plan details...</div>
                )}
                {selectedPlan && (
                  <>
                    <div className="mt-1 text-xs text-kumo-subtle">
                      Updated {formatTimestamp(selectedPlan.updatedAt)}
                    </div>
                    {selectedSpecificOutdated && (
                      <div className="mt-2 rounded border border-kumo-warning/30 bg-kumo-warning-tint px-2 py-1.5 text-xs text-kumo-warning">
                        This plan was saved against a different main commit.
                      </div>
                    )}
                    <div
                      aria-label="Full startup plan"
                      data-testid="start-plan-body"
                      className="mt-3 max-h-[min(18rem,35vh)] overflow-y-auto rounded border border-kumo-line bg-kumo-base px-3 py-3"
                    >
                      <MarkdownContent>{renderArtifactBodyMarkdown(selectedPlan.body)}</MarkdownContent>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {planError && <p className="text-xs text-kumo-danger">{planError}</p>}
          {startError && <p className="text-xs text-kumo-danger">{startError}</p>}
        </div>

        <div className="tiller-dialog-footer flex shrink-0 justify-end gap-2 border-t border-kumo-line px-5 py-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="tiller-dialog-button tiller-dialog-button--secondary"
            onClick={onClose}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="tiller-dialog-button tiller-dialog-button--primary"
            onClick={() => void handleStart()}
            loading={starting}
            disabled={starting || !isStartable || !selectedAvailability?.available}
          >
            {starting ? "Starting..." : "Start"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
