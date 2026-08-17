import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import {
  ApiActionError,
  ApiReadTimeoutError,
  acknowledgePlanAttention,
  addPlanReviewer,
  createPlan,
  discardPlan,
  fetchPlanContributions,
  fetchAgentSkills,
  fetchRepoPlanWriterSettings,
  fetchPlanWriter,
  fetchPlannerProviders,
  fetchPlanReviewers,
  fetchRepoArtifacts,
  createScribeHandoff,
  invokePlanSkill,
  isApiAuthenticationError,
  removePlanReviewer,
  savePlan,
  updatePlanStatus,
  updateRepoPlanWriterSettings,
} from "./api";
import type { AgentRoute, AgentSkillDefinition, RepoPlanWriterSettings } from "./api";
import type {
  Artifact,
  PlanArtifact,
  PlanAttentionItem,
  PlanContribution,
  PlannerRun,
  PlannerProviderMetadata,
  PlanStatus,
  ReviewerRegistryEntry,
  PlanWriterState,
} from "../api/coordination/types";
import PlanCategorySidebar from "./PlanCategorySidebar";
import PlanReader from "./PlanReader";
import PlanChatTabs from "./PlanChatTabs";
import ReviewerChat, { type ReviewerMessageHandoffStatus } from "./ReviewerChat";
import type { AddReviewerAction } from "./AddReviewerMenu";
import { useToast } from "./Toast";
import { listPlanArtifacts } from "./plan-artifacts";
import { planPath, projectGlobalSettingsPath } from "./dashboard-paths";
import SkillEditorDialog from "./SkillEditorDialog";
import LoadingIndicator from "./LoadingIndicator";
import PlanWriterPane, {
  type PlanContributionPresentation,
  type PlanWriterHandoff,
} from "./PlanWriterPane";
import PlanWriterModelPicker, { type PlanWriterModelSelection } from "./PlanWriterModelPicker";
import ResizablePlanPanes from "./ResizablePlanPanes";
import ProjectWorkspaceChrome from "./ProjectWorkspaceChrome";
import {
  implementationHasUnreadUpdate,
  implementationNeedsAttention,
} from "./ImplementationsSidebar";
import { SETTINGS_TARGET_IDS, settingsTargetHref } from "./settings-targets";
import {
  newestReviewerRun,
  planWriterTabStatus,
  reviewerTabStatus,
  type PlanTabStatus,
} from "./plan-tab-status";
import { useDashboardData } from "./DashboardDataProvider";
import { useSerializedRefresh } from "./useSerializedRefresh";
import ConfirmationDialog from "./ConfirmationDialog";

interface PlanViewProps {
  repoId: string;
  repoUrl: string;
  repoMainCommit: string | null;
  planArtifactId?: string | null;
  chatgptAvailable: boolean;
  chatgptUnavailableReason: string | null;
  mainEvent?: {
    repoId: string;
    repoUrl: string;
    previousMainCommit: string | null;
    currentMainCommit: string | null;
    sourceEnvSlug?: string | null;
  } | null;
}

const HUB_URL = window.location.origin;
type ArtifactLoadState = "loading" | "loaded" | "error";
const NOT_STARTED_WRITER_STATUS: PlanTabStatus = {
  kind: "idle",
  label: "Not started",
  detail: "Start the Scribe when you are ready.",
};
const SCRIBE_PROBE_RETRY_DELAYS_MS = [0, 3_000, 6_000, 12_000, 24_000] as const;

interface ScopedPlanWriterHandoff extends PlanWriterHandoff {
  repoId: string;
  planArtifactId: string;
}

function planScopeKey(repoId: string, planArtifactId: string): string {
  return JSON.stringify([repoId, planArtifactId]);
}

function isRetryableScribeProbeError(error: unknown): boolean {
  if (isApiAuthenticationError(error)) return false;
  if (error instanceof ApiActionError) {
    const status = error.status;
    return status === 408 || status === 425 || status === 429 || Boolean(status && status >= 500);
  }
  return error instanceof TypeError
    || error instanceof ApiReadTimeoutError
    || (error instanceof DOMException && error.name === "AbortError");
}

function isDefinitivePlanSkillInvokeFailure(error: unknown): boolean {
  if (!(error instanceof ApiActionError) || error.retryable) return false;
  if (error.code === "skill_setup_incomplete" || error.code === "skill_command_persistence_failed") {
    return false;
  }
  const status = error.status;
  return Boolean(
    status
    && status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429,
  );
}

function attentionRequestKey(repoId: string, item: PlanAttentionItem): string {
  return JSON.stringify([repoId, item.planArtifactId, item.sourceKind, item.sourceId, item.token]);
}

export default function PlanView({
  repoId,
  repoMainCommit,
  planArtifactId,
  chatgptAvailable,
  chatgptUnavailableReason,
  mainEvent,
}: PlanViewProps) {
  const navigate = useNavigate();
  const dashboard = useDashboardData();
  const { connected, planArtifactHintRef } = dashboard;
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [attention, setAttention] = useState<PlanAttentionItem[]>([]);
  const [artifactsLoadState, setArtifactsLoadState] = useState<ArtifactLoadState>("loading");
  const [reviewersByPlan, setReviewersByPlan] = useState<Record<string, ReviewerRegistryEntry[]>>({});
  const [contributionsByPlan, setContributionsByPlan] = useState<Record<string, PlanContribution[]>>({});
  const [plannerProviders, setPlannerProviders] = useState<PlannerProviderMetadata[]>([]);
  const [writerRoutes, setWriterRoutes] = useState<AgentRoute[]>([]);
  const [skillRoutes, setSkillRoutes] = useState<AgentRoute[]>([]);
  const [planAgentSkills, setPlanAgentSkills] = useState<AgentSkillDefinition[]>([]);
  const [repoWriterSettings, setRepoWriterSettings] = useState<RepoPlanWriterSettings | null>(null);
  const [writerSettingsOpen, setWriterSettingsOpen] = useState(false);
  const [pendingDiscardPlan, setPendingDiscardPlan] = useState<PlanArtifact | null>(null);
  const [discardingPlan, setDiscardingPlan] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [writerSettingsDraft, setWriterSettingsDraft] = useState<{
    routeKey: string;
    effort: RepoPlanWriterSettings["effort"];
    planFormat: string;
  }>({ routeKey: "", effort: "high", planFormat: "" });
  const [reviewersLoading, setReviewersLoading] = useState(false);
  const [addingReviewer, setAddingReviewer] = useState(false);
  const [reviewerDialogOpen, setReviewerDialogOpen] = useState(false);
  const [activeChatTab, setActiveChatTab] = useState("writer");
  const [reviewerMessageFocus, setReviewerMessageFocus] = useState<{
    threadId: string;
    messageId: string;
    requestId: string;
  } | null>(null);
  const [reviewerRunsByPlan, setReviewerRunsByPlan] = useState<
    Record<string, Record<string, PlannerRun | null>>
  >({});
  const [writerTabStatus, setWriterTabStatus] = useState<PlanTabStatus>(NOT_STARTED_WRITER_STATUS);
  const [planSkillsOpen, setPlanSkillsOpen] = useState(false);
  const [planSkillHistoryRefreshToken, setPlanSkillHistoryRefreshToken] = useState(0);
  const [writerSelection, setWriterSelection] = useState<PlanWriterModelSelection>({
    routeKey: "",
    effort: "high",
  });
  const [writerHandoffs, setWriterHandoffs] = useState<ScopedPlanWriterHandoff[]>([]);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [writerProbeError, setWriterProbeError] = useState<string | null>(null);
  const [writerProbeGeneration, setWriterProbeGeneration] = useState(0);
  const [writerMode, setWriterMode] = useState<{
    planArtifactId: string;
    writer: PlanWriterState;
  } | null>(null);
  const selectedPlanArtifactIdRef = useRef<string | null>(planArtifactId ?? null);
  const seenMainEventRef = useRef<string | null>(null);
  const planSkillRequestRef = useRef(new Map<string, string>());
  const scribeHandoffRequestRef = useRef(new Map<string, string>());
  const artifactLoadAcceptedRef = useRef(false);
  const currentRepoIdRef = useRef(repoId);
  const documentVisibleRef = useRef(documentVisible);
  const reviewerLoadRequestRef = useRef(new Map<string, number>());
  const reviewerLoadingPlanRef = useRef<string | null>(null);
  const reviewersByPlanRef = useRef(reviewersByPlan);
  const contributionLoadRequestRef = useRef(new Map<string, number>());
  const locallyAddedContributionIdsRef = useRef(new Map<string, Set<string>>());
  const previousConnectedRef = useRef(connected);
  const attentionAcknowledgementRequestsRef = useRef(new Set<string>());
  const writerProbeRef = useRef({ key: "", attempt: 0, terminal: false });
  const planHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPlanHintIdsRef = useRef(new Set<string>());
  const addToast = useToast();
  reviewersByPlanRef.current = reviewersByPlan;
  currentRepoIdRef.current = repoId;
  documentVisibleRef.current = documentVisible;

  const selectedPlanArtifactId = planArtifactId ?? null;
  selectedPlanArtifactIdRef.current = selectedPlanArtifactId;
  const artifactsLoading = artifactsLoadState === "loading";
  const artifactsLoadError = artifactsLoadState === "error";
  const plans = useMemo(() => listPlanArtifacts(artifacts), [artifacts]);
  const selectedPlan = useMemo(
    () => selectedPlanArtifactId
      ? plans.find((plan) => plan.id === selectedPlanArtifactId) ?? null
      : null,
    [plans, selectedPlanArtifactId],
  );
  const selectedReviewers = selectedPlan ? reviewersByPlan[selectedPlan.id] ?? [] : [];
  const selectedReviewerRuns = selectedPlan ? reviewerRunsByPlan[selectedPlan.id] ?? {} : {};
  const selectedContributions = selectedPlan ? contributionsByPlan[selectedPlan.id] ?? [] : [];
  const selectedWriterMode = selectedPlan && writerMode?.planArtifactId === selectedPlan.id
    ? writerMode
    : null;
  const selectedWriterHandoffs = useMemo(() => selectedPlan
    ? writerHandoffs.filter((handoff) => (
      handoff.repoId === repoId && handoff.planArtifactId === selectedPlan.id
    ))
    : [], [repoId, selectedPlan, writerHandoffs]);
  const activePlanIds = useMemo(() => new Set(plans
    .filter((plan) => plan.status !== "completed" && plan.status !== "archived")
    .map((plan) => plan.id)), [plans]);
  const attentionPlanIds = useMemo(() => new Set(attention
    .filter((item) => activePlanIds.has(item.planArtifactId))
    .map((item) => item.planArtifactId)), [activePlanIds, attention]);
  const planUpdateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of attention) {
      if (!activePlanIds.has(item.planArtifactId)) continue;
      counts[item.planArtifactId] = (counts[item.planArtifactId] ?? 0) + 1;
    }
    return counts;
  }, [activePlanIds, attention]);
  const selectedPlanAttention = useMemo(() => selectedPlan
    ? attention.filter((item) => item.planArtifactId === selectedPlan.id)
    : [], [attention, selectedPlan]);
  const selectedScribeHasAttention = selectedPlanAttention.some((item) => item.sourceKind === "scribe");
  const pendingScribeCount = selectedContributions.filter((contribution) => contribution.status === "pending").length;
  const contributionPresentations = useMemo(() => {
    const reviewerThreads = new Set(selectedReviewers.map((reviewer) => reviewer.threadId));
    const skillLabels = new Map(planAgentSkills.map((skill) => [skill.command, skill.label]));
    const presentations = new Map<string, PlanContributionPresentation>();
    for (const contribution of selectedContributions) {
      const modelLabel = plannerModelDisplayName(plannerProviders, contribution.provider, contribution.model);
      const skillLabel = contribution.skill ? skillLabels.get(contribution.skill) ?? contribution.skill : null;
      const sourceLabel = contribution.sourceKind === "curated_reviewer_handoff"
        ? "User-curated reviewer handoff"
        : contribution.sourceKind === "skill_overview"
          ? `${skillLabel ?? "Plan Skill"} Overview`
        : contribution.sourceKind === "skill_guidance"
          ? "Your Plan Skill guidance"
          : `${modelLabel} reviewer`;
      presentations.set(contribution.id, {
        sourceLabel,
        ...(contribution.sourceKind === "curated_reviewer_handoff" && contribution.sourceRefs.length > 1
          ? { sourceDetail: `${contribution.sourceRefs.length} selected reviewer messages` }
          : skillLabel ? { sourceDetail: `${skillLabel} Plan Skill` } : {}),
        canViewSource: (contribution.sourceKind === "reviewer_message"
          && Boolean(contribution.sourceThreadId && reviewerThreads.has(contribution.sourceThreadId))
          && Boolean(contribution.sourceMessageId))
          || (contribution.sourceKind === "skill_overview"
            && Boolean(contribution.sourceThreadId && reviewerThreads.has(contribution.sourceThreadId))
            && Boolean(contribution.sourceMessageId))
          || (contribution.sourceKind === "curated_reviewer_handoff"
            && contribution.sourceRefs.some((source) => reviewerThreads.has(source.threadId))),
      });
    }
    return presentations;
  }, [planAgentSkills, plannerProviders, selectedContributions, selectedReviewers]);
  const reviewerMessageHandoffStatuses = useMemo(() => {
    const byThread = new Map<string, Map<string, ReviewerMessageHandoffStatus>>();
    for (const contribution of selectedContributions) {
      const sources = contribution.sourceKind === "curated_reviewer_handoff"
        ? contribution.sourceRefs
        : contribution.sourceKind === "reviewer_message" && contribution.sourceThreadId && contribution.sourceMessageId
          ? [{ threadId: contribution.sourceThreadId, messageId: contribution.sourceMessageId }]
          : [];
      for (const source of sources) {
        const statuses = byThread.get(source.threadId) ?? new Map<string, ReviewerMessageHandoffStatus>();
        statuses.set(source.messageId, contribution.status === "pending"
          ? "waiting"
          : contribution.status === "incorporated"
            ? "shared"
            : "removed");
        byThread.set(source.threadId, statuses);
      }
    }
    return byThread;
  }, [selectedContributions]);
  const writerRouteOptions = writerRoutes;
  const defaultWriterSelection = useMemo(() => {
    const route = writerRouteOptions.find((candidate) => candidate.available) ?? writerRouteOptions[0];
    return route ? { routeKey: route.key, effort: route.defaultEffort } : null;
  }, [writerRouteOptions]);
  const selectedReviewerTabStatuses = useMemo(() => {
    const statuses = new Map<string, PlanTabStatus>();
    for (const reviewer of selectedReviewers) {
      const hasLatestRun = Object.prototype.hasOwnProperty.call(selectedReviewerRuns, reviewer.threadId);
      const latestRun = hasLatestRun ? selectedReviewerRuns[reviewer.threadId] : undefined;
      const provider = plannerProviders.find((candidate) => candidate.id === reviewer.provider);
      const modelLabel = provider?.models.find((candidate) => candidate.id === reviewer.model)?.displayName
        ?? reviewer.model;
      const effort = latestRun?.input?.effort ?? reviewer.effort;
      const effortLabel = effort
        ? provider?.efforts.find((candidate) => candidate.id === effort)?.displayName ?? plannerEffortLabel(effort)
        : null;
      statuses.set(reviewer.threadId, reviewerTabStatus({
        reviewer,
        latestRun,
        hasUnreadResult: selectedPlanAttention.some((item) => (
          item.sourceKind === "reviewer"
          && item.sourceId === reviewer.threadId
          && item.token === (latestRun?.runId ?? reviewer.runId)
        )),
        modelLabel,
        effortLabel,
      }));
    }
    return statuses;
  }, [plannerProviders, selectedPlanAttention, selectedReviewerRuns, selectedReviewers]);

  useEffect(() => {
    if (!defaultWriterSelection) return;
    setWriterSelection((current) => current.routeKey ? current : defaultWriterSelection);
  }, [defaultWriterSelection]);

  useEffect(() => {
    if (!repoWriterSettings) return;
    const route = writerRoutes.find((candidate) => candidate.key === repoWriterSettings.routeKey);
    if (route) setWriterSelection({ routeKey: route.key, effort: repoWriterSettings.effort });
  }, [repoWriterSettings, writerRoutes]);

  useEffect(() => {
    if (!writerSelection.routeKey) return;
    const route = writerRouteOptions.find((candidate) => candidate.key === writerSelection.routeKey);
    if (!route) {
      if (defaultWriterSelection) setWriterSelection(defaultWriterSelection);
      return;
    }
    if (route.supportedEfforts.includes(writerSelection.effort)) return;
    setWriterSelection({ routeKey: route.key, effort: route.defaultEffort });
  }, [defaultWriterSelection, writerRouteOptions, writerSelection]);

  useEffect(() => {
    setActiveChatTab("writer");
    setReviewerDialogOpen(false);
    setReviewerMessageFocus(null);
    setPlanSkillsOpen(false);
  }, [planArtifactId, repoId]);

  useEffect(() => {
    const artifactId = selectedPlan?.id;
    if (!artifactId) {
      setWriterMode(null);
      setWriterTabStatus(NOT_STARTED_WRITER_STATUS);
      setWriterProbeError(null);
      writerProbeRef.current = { key: "", attempt: 0, terminal: false };
      return;
    }
    const probeKey = `${repoId}:${artifactId}:${writerProbeGeneration}`;
    if (writerProbeRef.current.key !== probeKey) {
      writerProbeRef.current = { key: probeKey, attempt: 0, terminal: false };
      setWriterMode(null);
      setWriterTabStatus(NOT_STARTED_WRITER_STATUS);
      setWriterProbeError(null);
    }
    if (!documentVisible || !online || writerProbeRef.current.terminal) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let requestController: AbortController | null = null;
    const probe = async () => {
      const attempt = writerProbeRef.current.attempt;
      requestController = new AbortController();
      try {
        const writer = await fetchPlanWriter(HUB_URL, repoId, artifactId, requestController.signal);
        if (cancelled || writerProbeRef.current.key !== probeKey) return;
        setWriterMode({ planArtifactId: artifactId, writer });
        setWriterTabStatus(planWriterTabStatus(writer));
        setWriterProbeError(null);
        writerProbeRef.current.attempt = 0;
        writerProbeRef.current.terminal = false;
      } catch (probeError) {
        if (cancelled || writerProbeRef.current.key !== probeKey) return;
        const canRetry = isRetryableScribeProbeError(probeError);
        if (!canRetry || attempt >= SCRIBE_PROBE_RETRY_DELAYS_MS.length - 1) {
          writerProbeRef.current.terminal = true;
          setWriterProbeError(
            probeError instanceof Error ? probeError.message : "Failed to load Scribe",
          );
          return;
        }
        const nextAttempt = attempt + 1;
        writerProbeRef.current.attempt = nextAttempt;
        retryTimer = setTimeout(
          () => void probe(),
          SCRIBE_PROBE_RETRY_DELAYS_MS[nextAttempt],
        );
      } finally {
        requestController = null;
      }
    };
    void probe();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      requestController?.abort();
    };
  }, [documentVisible, online, repoId, selectedPlan?.id, writerProbeGeneration]);

  const selectPlan = useCallback((artifactId: string | null, options: { replace?: boolean } = {}) => {
    if (artifactId === selectedPlanArtifactId) setActiveChatTab("writer");
    navigate(planPath(repoId, artifactId), { replace: options.replace ?? false });
  }, [navigate, repoId, selectedPlanArtifactId]);

  const loadReviewers = useCallback(async (
    planId: string,
    options: { quiet?: boolean } = {},
  ): Promise<void> => {
    const request = (reviewerLoadRequestRef.current.get(planId) ?? 0) + 1;
    reviewerLoadRequestRef.current.set(planId, request);
    if (!options.quiet) {
      reviewerLoadingPlanRef.current = planId;
      setReviewersLoading(true);
    }
    try {
      const reviewers = await fetchPlanReviewers(HUB_URL, repoId, planId);
      if (
        currentRepoIdRef.current !== repoId
        || reviewerLoadRequestRef.current.get(planId) !== request
      ) return;
      setReviewersByPlan((current) => ({ ...current, [planId]: reviewers }));
    } catch (error) {
      if (
        !options.quiet
        && currentRepoIdRef.current === repoId
        && reviewerLoadRequestRef.current.get(planId) === request
      ) {
        addToast({
          title: "Failed to load reviewers",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      }
    } finally {
      if (
        currentRepoIdRef.current === repoId
        && reviewerLoadRequestRef.current.get(planId) === request
        && reviewerLoadingPlanRef.current === planId
      ) {
        reviewerLoadingPlanRef.current = null;
        setReviewersLoading(false);
      }
    }
  }, [addToast, repoId]);

  const performSelectedReviewerRefresh = useCallback(async (): Promise<void> => {
    const planId = selectedPlanArtifactIdRef.current;
    if (!planId) return;
    await loadReviewers(planId, {
      quiet: Object.prototype.hasOwnProperty.call(reviewersByPlanRef.current, planId),
    });
  }, [loadReviewers]);
  const { invalidateAndWait: invalidateSelectedReviewers } = useSerializedRefresh(
    performSelectedReviewerRefresh,
  );

  const performArtifactRefresh = useCallback(async ({ isCurrent }: { isCurrent: () => boolean }) => {
    const requestRepoId = repoId;
    const nextState = await fetchRepoArtifacts(HUB_URL, requestRepoId);
    if (isCurrent() && currentRepoIdRef.current === requestRepoId) {
      artifactLoadAcceptedRef.current = true;
      setArtifacts(nextState.artifacts);
      setAttention(nextState.attention);
      setArtifactsLoadState("loaded");
    }
    return nextState;
  }, [repoId]);
  const {
    refresh: refreshArtifactRead,
    invalidateAndWait: invalidateArtifacts,
  } = useSerializedRefresh(performArtifactRefresh);

  const loadArtifacts = useCallback(async (
    options: { quiet?: boolean; dirty?: boolean } = {},
  ): Promise<void> => {
    if (!options.quiet && !artifactLoadAcceptedRef.current) setArtifactsLoadState("loading");
    try {
      if (options.dirty) await invalidateArtifacts();
      else await refreshArtifactRead();
    } catch (error) {
      if (currentRepoIdRef.current !== repoId) return;
      if (!artifactLoadAcceptedRef.current) setArtifactsLoadState("error");
      if (!options.quiet) {
        addToast({
          title: "Failed to load plans",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      }
    }
  }, [addToast, invalidateArtifacts, refreshArtifactRead, repoId]);

  useEffect(() => {
    artifactLoadAcceptedRef.current = false;
    setArtifacts([]);
    setAttention([]);
    setArtifactsLoadState("loading");
    void loadArtifacts({ dirty: true });
  }, [loadArtifacts, repoId]);

  useEffect(() => {
    if (artifactsLoadState !== "loaded" || !planArtifactId) return;
    if (plans.some((plan) => plan.id === planArtifactId)) return;
    navigate(planPath(repoId), { replace: true });
  }, [artifactsLoadState, navigate, planArtifactId, plans, repoId]);

  useEffect(() => {
    planArtifactHintRef.current = (hintRepoId, hintPlanArtifactId) => {
      if (hintRepoId !== repoId) return;
      if (!documentVisibleRef.current) {
        return;
      }
      pendingPlanHintIdsRef.current.add(hintPlanArtifactId);
      if (planHintTimerRef.current) clearTimeout(planHintTimerRef.current);
      planHintTimerRef.current = setTimeout(() => {
        planHintTimerRef.current = null;
        if (currentRepoIdRef.current !== hintRepoId) return;
        const pendingPlanIds = new Set(pendingPlanHintIdsRef.current);
        pendingPlanHintIdsRef.current.clear();
        void loadArtifacts({ quiet: true, dirty: true });
        const selectedPlanId = selectedPlanArtifactIdRef.current;
        if (selectedPlanId && pendingPlanIds.has(selectedPlanId)) {
          setPlanSkillHistoryRefreshToken((current) => current + 1);
          void invalidateSelectedReviewers();
        }
        for (const pendingPlanId of pendingPlanIds) {
          if (
            pendingPlanId !== selectedPlanId
            && Object.prototype.hasOwnProperty.call(reviewersByPlanRef.current, pendingPlanId)
          ) {
            void loadReviewers(pendingPlanId, { quiet: true });
          }
        }
      }, 100);
    };
    return () => {
      planArtifactHintRef.current = null;
      if (planHintTimerRef.current) clearTimeout(planHintTimerRef.current);
      planHintTimerRef.current = null;
      pendingPlanHintIdsRef.current.clear();
    };
  }, [invalidateSelectedReviewers, loadArtifacts, loadReviewers, planArtifactHintRef, repoId, selectedPlanArtifactId]);

  useEffect(() => {
    const wasConnected = previousConnectedRef.current;
    previousConnectedRef.current = connected;
    if (connected && !wasConnected) {
      if (documentVisibleRef.current) {
        void loadArtifacts({ quiet: true, dirty: true });
        if (selectedPlanArtifactIdRef.current) void invalidateSelectedReviewers();
      }
    }
  }, [connected, invalidateSelectedReviewers, loadArtifacts]);

  useEffect(() => {
    const handleVisibility = () => {
      const visible = !document.hidden;
      documentVisibleRef.current = visible;
      setDocumentVisible(visible);
      if (visible) {
        void loadArtifacts({ quiet: true, dirty: true });
        if (selectedPlanArtifactIdRef.current) void invalidateSelectedReviewers();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [invalidateSelectedReviewers, loadArtifacts]);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const acknowledgeAttentionItem = useCallback(async (item: PlanAttentionItem) => {
    const requestRepoId = repoId;
    const requestKey = attentionRequestKey(requestRepoId, item);
    if (attentionAcknowledgementRequestsRef.current.has(requestKey)) return;
    attentionAcknowledgementRequestsRef.current.add(requestKey);
    let responded = false;
    try {
      const result = await acknowledgePlanAttention(HUB_URL, requestRepoId, item.planArtifactId, item);
      if (currentRepoIdRef.current !== requestRepoId) return;
      responded = true;
      if (result === "acknowledged") {
        setAttention((current) => current.filter((candidate) => !(
          candidate.planArtifactId === item.planArtifactId
          && candidate.sourceKind === item.sourceKind
          && candidate.sourceId === item.sourceId
          && candidate.token === item.token
        )));
      }
    } catch {
      // Attention is advisory; the next event, reconnect, or visibility refresh retries convergence.
    } finally {
      if (!responded) attentionAcknowledgementRequestsRef.current.delete(requestKey);
      if (responded && currentRepoIdRef.current === requestRepoId) {
        void loadArtifacts({ quiet: true, dirty: true });
      }
    }
  }, [loadArtifacts, repoId]);

  useEffect(() => {
    const currentKeys = new Set(attention.map((item) => attentionRequestKey(repoId, item)));
    for (const requestKey of attentionAcknowledgementRequestsRef.current) {
      if (!currentKeys.has(requestKey)) attentionAcknowledgementRequestsRef.current.delete(requestKey);
    }
  }, [attention, repoId]);

  useEffect(() => {
    if (!artifactLoadAcceptedRef.current || !selectedPlan || !documentVisible) return;
    const relevant = selectedPlanAttention.filter((item) => activeChatTab === "writer"
      ? item.sourceKind === "scribe"
      : item.sourceKind === "reviewer" && item.sourceId === activeChatTab);
    for (const item of relevant) void acknowledgeAttentionItem(item);
  }, [acknowledgeAttentionItem, activeChatTab, documentVisible, selectedPlan, selectedPlanAttention]);

  useEffect(() => {
    let cancelled = false;
    void fetchPlannerProviders(HUB_URL, repoId)
      .then((result) => {
        if (cancelled) return;
        setPlannerProviders(result.providers);
        setWriterRoutes(result.writerRoutes ?? []);
        setSkillRoutes(result.skillRoutes ?? []);
      })
      .catch((error) => {
        if (cancelled) return;
        addToast({
          title: "Failed to load planner providers",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [addToast, repoId]);

  const loadPlanAgentSkills = useCallback(async () => {
    try {
      setPlanAgentSkills(await fetchAgentSkills(HUB_URL, repoId, "plan"));
    } catch (error) {
      addToast({
        title: "Failed to load Plan skills",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [addToast, repoId]);

  useEffect(() => {
    let cancelled = false;
    setRepoWriterSettings(null);
    void loadPlanAgentSkills();
    void fetchRepoPlanWriterSettings(HUB_URL, repoId)
      .then((settings) => {
        if (cancelled) return;
        setRepoWriterSettings(settings);
        setWriterSelection({ routeKey: settings.routeKey, effort: settings.effort });
        setWriterSettingsDraft({
          routeKey: settings.routeKey,
          effort: settings.effort,
          planFormat: settings.planFormat,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        addToast({
          title: "Failed to load Scribe Settings",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      });
    return () => { cancelled = true; };
  }, [addToast, loadPlanAgentSkills, repoId]);

  const runPlanSkill = useCallback(async (skill: AgentSkillDefinition, parentThreadId: string) => {
    if (!selectedPlan) return false;
    const actionKey = `${selectedPlan.id}:${parentThreadId}:${skill.id}`;
    const requestId = planSkillRequestRef.current.get(actionKey) ?? crypto.randomUUID();
    planSkillRequestRef.current.set(actionKey, requestId);
    try {
      const result = await invokePlanSkill(HUB_URL, repoId, selectedPlan.id, skill.id, requestId);
      planSkillRequestRef.current.delete(actionKey);
      await invalidateSelectedReviewers();
      setActiveChatTab(result.invocation.parentThreadId);
      addToast({ title: `${skill.label} started`, variant: "success" });
      return result;
    } catch (error) {
      if (isDefinitivePlanSkillInvokeFailure(error)) {
        planSkillRequestRef.current.delete(actionKey);
      }
      addToast({
        title: `Failed to run /${skill.command}`,
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      return false;
    }
  }, [addToast, invalidateSelectedReviewers, repoId, selectedPlan]);

  useEffect(() => {
    if (!selectedPlan || reviewersByPlan[selectedPlan.id]) return;
    void invalidateSelectedReviewers();
  }, [invalidateSelectedReviewers, reviewersByPlan, selectedPlan]);

  useEffect(() => {
    if (activeChatTab === "writer" || !selectedPlan) return;
    if (selectedReviewers.some((reviewer) => reviewer.threadId === activeChatTab)) return;
    setActiveChatTab("writer");
  }, [activeChatTab, selectedPlan, selectedReviewers]);

  const loadContributions = useCallback(async (planId: string, options: { quiet?: boolean } = {}) => {
    const scopeKey = planScopeKey(repoId, planId);
    const request = (contributionLoadRequestRef.current.get(scopeKey) ?? 0) + 1;
    contributionLoadRequestRef.current.set(scopeKey, request);
    try {
      const contributions = await fetchPlanContributions(HUB_URL, repoId, planId);
      if (contributionLoadRequestRef.current.get(scopeKey) !== request) return;
      const protectedIds = new Set(locallyAddedContributionIdsRef.current.get(scopeKey) ?? []);
      setContributionsByPlan((current) => {
        const byId = new Map(contributions.map((contribution) => [contribution.id, contribution]));
        for (const contribution of current[planId] ?? []) {
          if (protectedIds.has(contribution.id) && !byId.has(contribution.id)) {
            byId.set(contribution.id, contribution);
          }
        }
        return { ...current, [planId]: [...byId.values()] };
      });
      const remainingProtectedIds = locallyAddedContributionIdsRef.current.get(scopeKey);
      if (remainingProtectedIds) {
        for (const contribution of contributions) remainingProtectedIds.delete(contribution.id);
        if (remainingProtectedIds.size === 0) locallyAddedContributionIdsRef.current.delete(scopeKey);
      }
    } catch (error) {
      if (!options.quiet) {
        addToast({
          title: "Failed to load contributions",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      }
    }
  }, [addToast, repoId]);

  useEffect(() => {
    if (!selectedPlan || contributionsByPlan[selectedPlan.id]) return;
    void loadContributions(selectedPlan.id);
  }, [contributionsByPlan, loadContributions, selectedPlan]);

  useEffect(() => {
    if (!mainEvent || mainEvent.repoId !== repoId) return;
    const key = `${mainEvent.repoId}:${mainEvent.currentMainCommit ?? "unknown"}`;
    if (seenMainEventRef.current === key) return;
    seenMainEventRef.current = key;
    void loadArtifacts({ quiet: true, dirty: true });
  }, [loadArtifacts, mainEvent, repoId]);

  const handleNewPlan = useCallback(async () => {
    if (creatingPlan) return;
    setCreatingPlan(true);
    try {
      const artifact = await createPlan(HUB_URL, repoId);
      setArtifacts((current) => [artifact, ...current.filter((candidate) => candidate.id !== artifact.id)]);
      selectPlan(artifact.id);
      void loadArtifacts({ quiet: true, dirty: true });
    } catch (error) {
      addToast({
        title: "Failed to create plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setCreatingPlan(false);
    }
  }, [addToast, creatingPlan, loadArtifacts, repoId, selectPlan]);

  const handleSavePlan = useCallback(async (planId: string, markdown: string) => {
    try {
      const updated = await savePlan(HUB_URL, repoId, planId, markdown);
      setArtifacts((current) => current.map((artifact) => (
        artifact.id === updated.id && (artifact.version ?? 1) <= (updated.version ?? 1)
          ? updated
          : artifact
      )));
      void loadArtifacts({ quiet: true, dirty: true });
    } catch (error) {
      void loadArtifacts({ quiet: true, dirty: true });
      throw error;
    }
  }, [loadArtifacts, repoId]);

  const openRepoWriterSettings = useCallback(() => {
    if (repoWriterSettings) {
      setWriterSettingsDraft({
        routeKey: repoWriterSettings.routeKey,
        effort: repoWriterSettings.effort,
        planFormat: repoWriterSettings.planFormat,
      });
    }
    setWriterSettingsOpen(true);
  }, [repoWriterSettings]);

  const saveRepoWriterSettings = useCallback(async () => {
    try {
      const settings = await updateRepoPlanWriterSettings(HUB_URL, repoId, writerSettingsDraft);
      setRepoWriterSettings(settings);
      setWriterSettingsOpen(false);
      const route = writerRoutes.find((candidate) => candidate.key === settings.routeKey);
      if (route) setWriterSelection({ routeKey: route.key, effort: settings.effort });
    } catch (error) {
      addToast({
        title: "Failed to save Scribe Settings",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [addToast, repoId, writerRoutes, writerSettingsDraft]);

  const handleMovePlan = useCallback(async (plan: PlanArtifact, status: PlanStatus) => {
    if (plan.status === status) return;
    try {
      const updated = await updatePlanStatus(HUB_URL, repoId, plan.id, status, plan.version);
      setArtifacts((current) => current.map((candidate) => (
        candidate.id === updated.id ? updated : candidate
      )));
      if (status === "completed" || status === "archived") {
        setAttention((current) => current.filter((item) => item.planArtifactId !== plan.id));
      }
      void loadArtifacts({ quiet: true, dirty: true });
      addToast({
        title: "Plan moved",
        body: updated.cleanupWarning ?? statusLabel(status),
        variant: "success",
        duration: updated.cleanupPending ? 5000 : 2000,
      });
    } catch (error) {
      addToast({
        title: "Failed to move plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      void loadArtifacts({ quiet: true, dirty: true });
    }
  }, [addToast, loadArtifacts, repoId]);

  const handleDiscardPlan = useCallback((plan: PlanArtifact) => {
    if (plan.status !== "draft") return;
    setPendingDiscardPlan(plan);
  }, []);

  const confirmDiscardPlan = useCallback(async () => {
    const plan = pendingDiscardPlan;
    if (!plan || plan.status !== "draft" || discardingPlan) return;
    const label = plan.title || "Untitled plan";
    const wasSelected = selectedPlanArtifactId === plan.id;
    setDiscardingPlan(true);
    try {
      const discarded = await discardPlan(HUB_URL, repoId, plan.id, plan.version);
      setArtifacts((current) => current.filter((candidate) => candidate.id !== plan.id));
      setAttention((current) => current.filter((item) => item.planArtifactId !== plan.id));
      setReviewersByPlan((current) => {
        const next = { ...current };
        delete next[plan.id];
        return next;
      });
      setContributionsByPlan((current) => {
        const next = { ...current };
        delete next[plan.id];
        return next;
      });
      setReviewerRunsByPlan((current) => {
        if (!(plan.id in current)) return current;
        const next = { ...current };
        delete next[plan.id];
        return next;
      });
      if (wasSelected) {
        selectPlan(null, { replace: true });
      }
      void loadArtifacts({ quiet: true, dirty: true });
      addToast({
        title: "Plan discarded",
        body: discarded.cleanupWarning ?? label,
        variant: "success",
        duration: discarded.cleanupPending ? 5000 : 2000,
      });
    } catch (error) {
      addToast({
        title: "Couldn't discard plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      void loadArtifacts({ quiet: true, dirty: true });
    } finally {
      setDiscardingPlan(false);
      setPendingDiscardPlan(null);
    }
  }, [addToast, discardingPlan, loadArtifacts, pendingDiscardPlan, repoId, selectPlan, selectedPlanArtifactId]);

  const handleAddReviewer = useCallback(async (input: AddReviewerAction) => {
    if (!selectedPlan) return;
    if (selectedReviewers.filter((reviewer) => reviewer.nodeKind === "generic").length >= 4) {
      addToast({ title: "Reviewer limit reached", body: "Each plan can have up to four active reviewers.", variant: "warning" });
      return;
    }
    setAddingReviewer(true);
    try {
      const { reviewer } = await addPlanReviewer(HUB_URL, repoId, selectedPlan.id, {
        provider: input.provider,
        model: input.model,
        effort: input.effort,
      });
      setReviewersByPlan((current) => ({
        ...current,
        [selectedPlan.id]: [
          ...(current[selectedPlan.id] ?? []).filter((entry) => entry.threadId !== reviewer.threadId),
          reviewer,
        ],
      }));
      setReviewerRunsByPlan((current) => ({
        ...current,
        [selectedPlan.id]: {
          ...(current[selectedPlan.id] ?? {}),
          [reviewer.threadId]: null,
        },
      }));
      setActiveChatTab(reviewer.threadId);
    } catch (error) {
      addToast({
        title: "Failed to add reviewer",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setAddingReviewer(false);
    }
  }, [addToast, repoId, selectedPlan, selectedReviewers]);

  const handleReviewerRunChange = useCallback((planId: string, threadId: string, run: PlannerRun | null) => {
    setReviewerRunsByPlan((current) => {
      const currentPlanRuns = current[planId] ?? {};
      const currentRun = currentPlanRuns[threadId];
      const nextRun = newestReviewerRun(currentRun, run);
      if (Object.prototype.hasOwnProperty.call(currentPlanRuns, threadId) && nextRun === currentRun) {
        return current;
      }
      return {
        ...current,
        [planId]: {
          ...currentPlanRuns,
          [threadId]: nextRun,
        },
      };
    });
  }, []);

  const handleCloseReviewer = useCallback(async (threadId: string) => {
    if (!selectedPlan) return;
    try {
      await removePlanReviewer(HUB_URL, repoId, selectedPlan.id, threadId);
      const removedThreadIds = new Set(
        selectedReviewers
          .filter(
            (reviewer) =>
              reviewer.threadId === threadId ||
              reviewer.skillRootThreadId === threadId,
          )
          .map((reviewer) => reviewer.threadId),
      );
      setReviewersByPlan((current) => ({
        ...current,
        [selectedPlan.id]: (current[selectedPlan.id] ?? []).filter(
          (reviewer) => !removedThreadIds.has(reviewer.threadId),
        ),
      }));
      setReviewerRunsByPlan((current) => {
        const planRuns = current[selectedPlan.id];
        if (!planRuns || ![...removedThreadIds].some((id) => id in planRuns)) return current;
        const nextPlanRuns = { ...planRuns };
        for (const id of removedThreadIds) delete nextPlanRuns[id];
        return { ...current, [selectedPlan.id]: nextPlanRuns };
      });
      setAttention((current) => current.filter((item) => !(
        item.planArtifactId === selectedPlan.id
        && item.sourceKind === "reviewer"
        && removedThreadIds.has(item.sourceId)
      )));
      if (activeChatTab === threadId) setActiveChatTab("writer");
      void loadArtifacts({ quiet: true, dirty: true });
    } catch (error) {
      addToast({
        title: "Failed to close reviewer",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [activeChatTab, addToast, loadArtifacts, repoId, selectedPlan, selectedReviewers]);

  const sendContributionsToWriter = useCallback((
    targetRepoId: string,
    targetPlanArtifactId: string,
    contributions: PlanContribution[],
  ) => {
    if (contributions.length === 0) return;
    const scopeKey = planScopeKey(targetRepoId, targetPlanArtifactId);
    const protectedIds = locallyAddedContributionIdsRef.current.get(scopeKey) ?? new Set<string>();
    for (const contribution of contributions) protectedIds.add(contribution.id);
    locallyAddedContributionIdsRef.current.set(scopeKey, protectedIds);
    setContributionsByPlan((current) => {
      const byId = new Map((current[targetPlanArtifactId] ?? []).map((contribution) => [contribution.id, contribution]));
      for (const contribution of contributions) byId.set(contribution.id, contribution);
      return { ...current, [targetPlanArtifactId]: [...byId.values()] };
    });
    const contributionIds = contributions
      .filter((contribution) => contribution.status === "pending")
      .map((contribution) => contribution.id);
    if (contributionIds.length > 0) {
      setWriterHandoffs((current) => {
        const queued = new Set(current
          .filter((handoff) => (
            handoff.repoId === targetRepoId && handoff.planArtifactId === targetPlanArtifactId
          ))
          .flatMap((handoff) => handoff.contributionIds));
        const unqueuedIds = contributionIds.filter((id) => !queued.has(id));
        return unqueuedIds.length > 0
          ? [...current, {
              id: crypto.randomUUID(),
              repoId: targetRepoId,
              planArtifactId: targetPlanArtifactId,
              contributionIds: unqueuedIds,
            }]
          : current;
      });
    }
    if (
      currentRepoIdRef.current === targetRepoId
      && selectedPlanArtifactIdRef.current === targetPlanArtifactId
    ) setActiveChatTab("writer");
  }, []);

  const createReviewerHandoff = useCallback(async (
    sources: Array<{ threadId: string; messageId: string }>,
    content: string,
  ) => {
    try {
      if (!selectedPlan) throw new Error("No plan selected");
      const signature = JSON.stringify({ planId: selectedPlan.id, sources, content });
      const requestId = scribeHandoffRequestRef.current.get(signature) ?? crypto.randomUUID();
      scribeHandoffRequestRef.current.set(signature, requestId);
      const result = await createScribeHandoff(HUB_URL, repoId, selectedPlan.id, { requestId, sources, content });
      scribeHandoffRequestRef.current.delete(signature);
      sendContributionsToWriter(
        result.contribution.repoId,
        result.contribution.planArtifactId,
        [result.contribution],
      );
    } catch (error) {
      addToast({
        title: "Context not shared with Scribe",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      throw error;
    }
  }, [addToast, repoId, selectedPlan, sendContributionsToWriter]);

  const settleWriterHandoff = useCallback((handoffId: string, error?: string) => {
    setWriterHandoffs((current) => current.filter((handoff) => handoff.id !== handoffId));
    if (error) {
      addToast({
        title: "Context still waiting for Scribe",
        body: `${error} It remains available in the Scribe context tray.`,
        variant: "error",
      });
      return;
    }
    addToast({
      title: "Context delivered to Scribe",
      body: "The Scribe received the reviewer context.",
      variant: "success",
      duration: 2500,
    });
  }, [addToast]);

  const viewContributionSource = useCallback((contributionId: string) => {
    const contribution = selectedContributions.find((candidate) => candidate.id === contributionId);
    const source = contribution?.sourceRefs.find((candidate) => (
      selectedReviewers.some((reviewer) => reviewer.threadId === candidate.threadId)
    )) ?? (contribution?.sourceThreadId && contribution.sourceMessageId
      ? { threadId: contribution.sourceThreadId, messageId: contribution.sourceMessageId }
      : null);
    if (!source || !selectedReviewers.some((reviewer) => reviewer.threadId === source.threadId)) return;
    setReviewerMessageFocus({
      threadId: source.threadId,
      messageId: source.messageId,
      requestId: crypto.randomUUID(),
    });
    setActiveChatTab(source.threadId);
  }, [selectedContributions, selectedReviewers]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ProjectWorkspaceChrome
        repoId={repoId}
        activeView="plans"
        planCount={plans.length}
        planUpdateCount={attentionPlanIds.size}
        implementationCount={(dashboard.envs ?? []).filter((env) => env.repoId === repoId).length}
        implementationAttentionCount={(dashboard.envs ?? []).filter((env) => (
          env.repoId === repoId && implementationNeedsAttention(env)
        )).length}
        implementationUpdateCount={(dashboard.envs ?? []).filter((env) => (
          env.repoId === repoId && implementationHasUnreadUpdate(env)
        )).length}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="tiller-workspace-sidebar-shell flex w-80 shrink-0 border-r border-kumo-line bg-kumo-recessed">
        <PlanCategorySidebar
          artifacts={artifacts}
          selectedPlanArtifactId={selectedPlanArtifactId}
          repoMainCommit={repoMainCommit}
          loading={artifactsLoading}
          simplified
          width={320}
          attentionPlanIds={attentionPlanIds}
          reviewerUpdateCounts={planUpdateCounts}
          creatingPlan={creatingPlan}
          onCreatePlan={() => void handleNewPlan()}
          onPrefetch={(artifactId) => {
            if (
              Object.prototype.hasOwnProperty.call(reviewersByPlanRef.current, artifactId)
              || reviewerLoadRequestRef.current.has(artifactId)
            ) return;
            void loadReviewers(artifactId, { quiet: true });
          }}
          onSelect={selectPlan}
          onMove={(plan, status) => void handleMovePlan(plan, status)}
          onDiscard={handleDiscardPlan}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {artifactsLoadState === "loaded" && plans.length === 0 ? (
          <PlanEmptyState
            creating={creatingPlan}
            onCreate={() => void handleNewPlan()}
          />
        ) : <ResizablePlanPanes
          documentFirst
          artifact={selectedPlan ? (
            <PlanReader
              key={selectedPlan.id}
              plan={selectedPlan}
              saving={selectedWriterMode?.writer.synchronization.state === "saving"}
              showStatus
              blueprint
              onSave={(markdown) => handleSavePlan(selectedPlan.id, markdown)}
              onStatusChange={(status) => void handleMovePlan(selectedPlan, status)}
              onDiscard={() => handleDiscardPlan(selectedPlan)}
            />
          ) : (
            <PlanSelectionState
              loading={artifactsLoading && !!selectedPlanArtifactId}
              error={artifactsLoadError}
              missing={artifactsLoadState === "loaded" && !!selectedPlanArtifactId}
              onRetry={() => void loadArtifacts({ dirty: true })}
            />
          )}
          reviewers={(
            <div className="tiller-plan-agent-surface h-full min-h-0">
              {selectedPlan ? (
                <div className="flex h-full min-h-0 flex-row">
                  <PlanChatTabs
                    reviewers={selectedReviewers}
                    providers={plannerProviders}
                    activeTab={activeChatTab}
                    writerTabStatus={writerTabStatus}
                    writerNeedsAttention={selectedScribeHasAttention}
                    pendingScribeCount={pendingScribeCount}
                    reviewerTabStatuses={selectedReviewerTabStatuses}
                    adding={addingReviewer || reviewersLoading}
                    reviewerDialogOpen={reviewerDialogOpen}
                    onActiveTabChange={setActiveChatTab}
                    onReviewerDialogOpenChange={setReviewerDialogOpen}
                    onOpenPlanSkills={() => setPlanSkillsOpen(true)}
                    onAddReviewer={(model) => void handleAddReviewer(model)}
                    skills={planAgentSkills}
                    onInvokeSkill={(skill) => void runPlanSkill(skill, "root")}
                    onCloseReviewer={(threadId) => void handleCloseReviewer(threadId)}
                    onWriterSettings={openRepoWriterSettings}
                    compact
                  />
                  <div className="order-1 h-full min-h-0 flex-1 overflow-hidden">
                    {selectedWriterMode ? (
                      <div className={`${activeChatTab === "writer" ? "flex" : "hidden"} h-full min-h-0 flex-col`}>
                        <div className="min-h-0 flex-1 overflow-hidden">
                          <PlanWriterPane
                            key={selectedPlan.id}
                            repoId={repoId}
                            planArtifactId={selectedPlan.id}
                            initialWriter={selectedWriterMode.writer}
                            routes={writerRouteOptions}
                            selection={writerSelection}
                            contributions={selectedContributions}
                            contributionPresentations={contributionPresentations}
                            handoff={selectedWriterHandoffs[0] ?? null}
                            queuedHandoffContributionIds={selectedWriterHandoffs.flatMap((handoff) => handoff.contributionIds)}
                            canAddReviewer={selectedReviewers.filter((reviewer) => reviewer.nodeKind === "generic").length < 4}
                            onWriterChange={(writer) => {
                              if (selectedPlanArtifactIdRef.current !== selectedPlan.id) return;
                              setWriterMode({ planArtifactId: selectedPlan.id, writer });
                            }}
                            onTabStatusChange={(status) => {
                              if (selectedPlanArtifactIdRef.current === selectedPlan.id) setWriterTabStatus(status);
                            }}
                            onContributionsChanged={() => void loadContributions(selectedPlan.id, { quiet: true })}
                            onHandoffSettled={settleWriterHandoff}
                            onViewContributionSource={viewContributionSource}
                            onAddReviewer={() => setReviewerDialogOpen(true)}
                            onOpenSettings={openRepoWriterSettings}
                            settingsAvailable={repoWriterSettings?.repoId === repoId}
                            compact
                          />
                        </div>
                      </div>
                    ) : writerProbeError ? (
                      <div className="flex h-full items-center justify-center p-6">
                        <div className="max-w-sm text-center" role="alert">
                          <p className="text-sm font-medium text-kumo-default">Scribe could not be loaded.</p>
                          <p className="mt-1 text-xs text-kumo-subtle">{writerProbeError}</p>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                              setWriterProbeError(null);
                              setWriterProbeGeneration((current) => current + 1);
                            }}
                          >
                            Retry
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <LoadingIndicator label="Loading Scribe" />
                      </div>
                    )}
                    {selectedReviewers.map((reviewer) => (
                      <ReviewerChat
                        key={reviewer.threadId}
                        repoId={repoId}
                        planArtifactId={selectedPlan.id}
                        threadId={reviewer.threadId}
                        provider={reviewer.provider}
                        model={reviewer.model}
                        nodeKind={reviewer.nodeKind}
                        skillRootThreadId={reviewer.skillRootThreadId}
                        runHint={{
                          runId: reviewer.runId ?? null,
                          status: reviewer.status ?? null,
                          updatedAt: reviewer.updatedAt,
                        }}
                        hidden={activeChatTab !== reviewer.threadId}
                        skills={reviewer.nodeKind === "generic" ? planAgentSkills : []}
                        disabled={selectedPlan.status === "completed" || selectedPlan.status === "archived"}
                        disabledReason={(selectedPlan.status === "completed" || selectedPlan.status === "archived")
                          ? "Completed or archived plans cannot start reviewer work."
                          : null}
                        onInvokeSkill={reviewer.nodeKind === "generic" ? runPlanSkill : undefined}
                        planSkillHistoryRefreshToken={planSkillHistoryRefreshToken}
                        handoffStatuses={reviewerMessageHandoffStatuses.get(reviewer.threadId)}
                        focusMessage={reviewerMessageFocus?.threadId === reviewer.threadId
                          ? {
                              messageId: reviewerMessageFocus.messageId,
                              requestId: reviewerMessageFocus.requestId,
                            }
                          : null}
                        onLatestRunChange={(run) => handleReviewerRunChange(
                          selectedPlan.id,
                          reviewer.threadId,
                          run,
                        )}
                        onHandoff={createReviewerHandoff}
                        compact
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
                  Create a plan to start a Scribe or add a reviewer.
                </div>
              )}
            </div>
          )}
        />}
      </div>
      </div>
      <SkillEditorDialog
        repoId={repoId}
        surface="plan"
        open={planSkillsOpen}
        skills={planAgentSkills}
        routes={skillRoutes}
        onOpenChange={setPlanSkillsOpen}
        onChanged={loadPlanAgentSkills}
      />
      <ConfirmationDialog
        open={pendingDiscardPlan !== null}
        title="Discard draft plan?"
        description={`"${pendingDiscardPlan?.title || "Untitled plan"}" will be permanently removed.`}
        confirmLabel="Discard plan"
        busyLabel="Discarding…"
        busy={discardingPlan}
        onOpenChange={(open) => {
          if (!open) setPendingDiscardPlan(null);
        }}
        onConfirm={confirmDiscardPlan}
      />
      <Dialog.Root open={writerSettingsOpen} onOpenChange={setWriterSettingsOpen}>
        <Dialog className="tiller-dialog-shell tiller-reviewer-dialog flex h-[calc(100vh-2rem)] max-h-[52rem] w-full max-w-3xl flex-col overflow-hidden p-0 sm:w-[calc(100vw-2rem)]">
          <div className="tiller-dialog-header border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="tiller-dialog-title text-sm font-semibold text-kumo-strong">Scribe Settings</Dialog.Title>
            <Dialog.Description className="tiller-dialog-description mt-0.5 text-xs text-kumo-subtle">
              Repository defaults are frozen when a new Scribe generation starts.
            </Dialog.Description>
          </div>
          <div className="tiller-dialog-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <PlanWriterModelPicker
              routes={writerRouteOptions}
              providers={plannerProviders}
              value={writerSettingsDraft}
              onChange={(selection) => setWriterSettingsDraft((draft) => ({ ...draft, ...selection }))}
              settingsHref={settingsTargetHref(
                projectGlobalSettingsPath(repoId),
                SETTINGS_TARGET_IDS.modelAccess,
              )}
            />
            <label className="flex min-h-72 flex-1 flex-col text-xs font-medium text-kumo-subtle">
              <span className="mb-1.5 block">Plan Format</span>
              <textarea
                value={writerSettingsDraft.planFormat}
                onChange={(event) => setWriterSettingsDraft((draft) => ({ ...draft, planFormat: event.target.value }))}
                className="min-h-72 w-full flex-1 resize-none rounded border border-kumo-line bg-kumo-recessed p-3 font-mono text-xs leading-5 text-kumo-default"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="tiller-dialog-footer flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
            <Button className="tiller-dialog-button tiller-dialog-button--secondary" type="button" variant="secondary" size="sm" onClick={() => setWriterSettingsOpen(false)}>Cancel</Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="tiller-dialog-button tiller-dialog-button--primary"
              onClick={() => void saveRepoWriterSettings()}
              disabled={!writerSettingsDraft.routeKey || !writerSettingsDraft.planFormat.trim()}
            >
              Save
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

function PlanEmptyState({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="max-w-sm px-6 text-center">
        <h2 className="text-sm font-semibold text-kumo-default">Create your first plan</h2>
        <p className="mt-2 text-sm leading-6 text-kumo-subtle">
          Start a plan to explore and organize the work for this project.
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="mt-4"
          loading={creating}
          disabled={creating}
          onClick={onCreate}
        >
          {creating ? "Creating…" : "Create plan"}
        </Button>
      </div>
    </div>
  );
}

function PlanSelectionState({
  loading,
  error,
  missing,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  missing: boolean;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="border border-kumo-line bg-kumo-recessed px-4 py-3 text-center">
          <p className="text-sm font-medium text-kumo-default">Plans could not be loaded.</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (loading) {
    return <LoadingIndicator label="Loading plan" className="min-h-0 flex-1" />;
  }
  const message = missing
      ? "Plan not found."
      : "Select or create a plan.";
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-kumo-subtle">
      {message}
    </div>
  );
}

function statusLabel(status: PlanStatus): string {
  if (status === "evaluating") return "Evaluating";
  if (status === "todo") return "To Do";
  if (status === "completed") return "Done";
  if (status === "archived") return "Archived";
  return "Draft";
}

function plannerModelDisplayName(
  providers: PlannerProviderMetadata[],
  providerId: string,
  modelId: string,
): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.models.find((candidate) => candidate.id === modelId)?.displayName ?? modelId;
}

function plannerEffortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra High";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
