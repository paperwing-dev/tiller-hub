import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import {
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
  removePlanReviewer,
  savePlan,
  sendReviewerMessageToWriter,
  updatePlanStatus,
  updateRepoPlanWriterSettings,
} from "./api";
import type { AgentRoute, AgentSkillDefinition, RepoPlanWriterSettings } from "./api";
import type {
  Artifact,
  PlanArtifact,
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
import ReviewerChat from "./ReviewerChat";
import type { AddReviewerAction } from "./AddReviewerMenu";
import { useToast } from "./Toast";
import { getRepoLabel } from "./plan-repo";
import { listPlanArtifacts } from "./plan-artifacts";
import { planPath } from "./dashboard-paths";
import SkillEditorDialog from "./SkillEditorDialog";
import PlanSkillHistory from "./PlanSkillHistory";
import LoadingIndicator from "./LoadingIndicator";
import PlanWriterPane, { type PlanWriterHandoff } from "./PlanWriterPane";
import PlanWriterModelPicker, { type PlanWriterModelSelection } from "./PlanWriterModelPicker";
import ResizablePlanPanes from "./ResizablePlanPanes";
import {
  newestReviewerRun,
  planReviewerFinishedAckStorageKey,
  planWriterTabStatus,
  readPlanReviewerFinishedAcks,
  removePlanReviewerFinishedAcks,
  reviewerTabStatus,
  writePlanReviewerFinishedAcks,
  type PlanTabStatus,
} from "./plan-tab-status";

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
  detail: "Start the Writer when you are ready.",
};

export default function PlanView({
  repoId,
  repoUrl,
  repoMainCommit,
  planArtifactId,
  chatgptAvailable,
  chatgptUnavailableReason,
  mainEvent,
}: PlanViewProps) {
  const navigate = useNavigate();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsLoadState, setArtifactsLoadState] = useState<ArtifactLoadState>("loading");
  const [reviewersByPlan, setReviewersByPlan] = useState<Record<string, ReviewerRegistryEntry[]>>({});
  const [contributionsByPlan, setContributionsByPlan] = useState<Record<string, PlanContribution[]>>({});
  const [plannerProviders, setPlannerProviders] = useState<PlannerProviderMetadata[]>([]);
  const [skillRoutes, setSkillRoutes] = useState<AgentRoute[]>([]);
  const [planAgentSkills, setPlanAgentSkills] = useState<AgentSkillDefinition[]>([]);
  const [repoWriterSettings, setRepoWriterSettings] = useState<RepoPlanWriterSettings | null>(null);
  const [writerSettingsOpen, setWriterSettingsOpen] = useState(false);
  const [writerSettingsDraft, setWriterSettingsDraft] = useState<{
    routeKey: string;
    effort: RepoPlanWriterSettings["effort"];
    fastMode: boolean;
    planFormat: string;
  }>({ routeKey: "", effort: "high", fastMode: false, planFormat: "" });
  const [reviewersLoading, setReviewersLoading] = useState(false);
  const [addingReviewer, setAddingReviewer] = useState(false);
  const [activeChatTab, setActiveChatTab] = useState("writer");
  const [reviewerRunsByPlan, setReviewerRunsByPlan] = useState<
    Record<string, Record<string, PlannerRun | null>>
  >({});
  const [completionAckVersion, setCompletionAckVersion] = useState(0);
  const completionAckFallbackRef = useRef<Record<string, Record<string, string>>>({});
  const [writerTabStatus, setWriterTabStatus] = useState<PlanTabStatus>(NOT_STARTED_WRITER_STATUS);
  const [planSkillsOpen, setPlanSkillsOpen] = useState(false);
  const [writerSelection, setWriterSelection] = useState<PlanWriterModelSelection>({
    routeKey: "",
    effort: "high",
  });
  const [writerHandoffs, setWriterHandoffs] = useState<PlanWriterHandoff[]>([]);
  const [writerMode, setWriterMode] = useState<{
    planArtifactId: string;
    writer: PlanWriterState;
  } | null>(null);
  const seenMainEventRef = useRef<string | null>(null);
  const addToast = useToast();

  const selectedPlanArtifactId = planArtifactId ?? null;
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
  const writerProviders = useMemo(
    () => plannerProviders.filter((provider) => provider.capabilities.writer),
    [plannerProviders],
  );
  const writerRouteOptions = useMemo(
    () => skillRoutes.filter((route) => writerProviders.some((provider) => provider.id === route.provider)),
    [skillRoutes, writerProviders],
  );
  const defaultWriterSelection = useMemo(() => {
    const route = writerRouteOptions.find((candidate) => candidate.available) ?? writerRouteOptions[0];
    return route ? { routeKey: route.key, effort: route.defaultEffort } : null;
  }, [writerRouteOptions]);
  const selectedReviewerAcks = useMemo(() => {
    if (!selectedPlan) return {};
    const scope = planReviewerFinishedAckStorageKey(repoId, selectedPlan.id);
    return {
      ...(completionAckFallbackRef.current[scope] ?? {}),
      ...(readPlanReviewerFinishedAcks(getSessionStorage(), repoId, selectedPlan.id) ?? {}),
    };
  }, [completionAckVersion, repoId, selectedPlan]);
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
        acknowledgedRunId: selectedReviewerAcks[reviewer.threadId] ?? null,
        modelLabel,
        effortLabel,
      }));
    }
    return statuses;
  }, [plannerProviders, selectedReviewerAcks, selectedReviewerRuns, selectedReviewers]);
  const acknowledgeReviewerFinished = useCallback((planId: string, threadId: string, runId: string) => {
    const scope = planReviewerFinishedAckStorageKey(repoId, planId);
    const current = {
      ...(completionAckFallbackRef.current[scope] ?? {}),
      ...(readPlanReviewerFinishedAcks(getSessionStorage(), repoId, planId) ?? {}),
    };
    if (current[threadId] === runId) return;
    const next = { ...current, [threadId]: runId };
    completionAckFallbackRef.current[scope] = next;
    writePlanReviewerFinishedAcks(getSessionStorage(), repoId, planId, next);
    setCompletionAckVersion((version) => version + 1);
  }, [repoId]);
  const forgetReviewerFinished = useCallback((planId: string, threadId: string) => {
    const scope = planReviewerFinishedAckStorageKey(repoId, planId);
    const current = {
      ...(completionAckFallbackRef.current[scope] ?? {}),
      ...(readPlanReviewerFinishedAcks(getSessionStorage(), repoId, planId) ?? {}),
    };
    if (!(threadId in current)) return;
    const next = { ...current };
    delete next[threadId];
    completionAckFallbackRef.current[scope] = next;
    writePlanReviewerFinishedAcks(getSessionStorage(), repoId, planId, next);
    setCompletionAckVersion((version) => version + 1);
  }, [repoId]);
  const forgetPlanFinished = useCallback((planId: string) => {
    const scope = planReviewerFinishedAckStorageKey(repoId, planId);
    delete completionAckFallbackRef.current[scope];
    removePlanReviewerFinishedAcks(getSessionStorage(), repoId, planId);
    setCompletionAckVersion((version) => version + 1);
  }, [repoId]);

  useEffect(() => {
    if (!defaultWriterSelection) return;
    setWriterSelection((current) => current.routeKey ? current : defaultWriterSelection);
  }, [defaultWriterSelection]);

  useEffect(() => {
    if (!repoWriterSettings) return;
    const route = skillRoutes.find((candidate) => candidate.key === repoWriterSettings.routeKey);
    if (route) setWriterSelection({ routeKey: route.key, effort: repoWriterSettings.effort });
  }, [repoWriterSettings, skillRoutes]);

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
    setPlanSkillsOpen(false);
    setWriterHandoffs([]);
  }, [planArtifactId, repoId]);

  useEffect(() => {
    const artifactId = selectedPlan?.id;
    if (!artifactId) {
      setWriterMode(null);
      setWriterTabStatus(NOT_STARTED_WRITER_STATUS);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setWriterMode(null);
    setWriterTabStatus(NOT_STARTED_WRITER_STATUS);
    const probe = async () => {
      try {
        const writer = await fetchPlanWriter(HUB_URL, repoId, artifactId);
        if (cancelled) return;
        setWriterMode({ planArtifactId: artifactId, writer });
        setWriterTabStatus(planWriterTabStatus(writer));
      } catch {
        if (!cancelled) retryTimer = setTimeout(() => void probe(), 3_000);
      }
    };
    void probe();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [repoId, selectedPlan?.id]);

  useEffect(() => {
    if (!selectedPlan || activeChatTab === "writer") return;
    const activeStatus = selectedReviewerTabStatuses.get(activeChatTab);
    if (activeStatus?.kind !== "finished" || !activeStatus.runId) return;
    acknowledgeReviewerFinished(selectedPlan.id, activeChatTab, activeStatus.runId);
  }, [activeChatTab, acknowledgeReviewerFinished, selectedPlan, selectedReviewerTabStatuses]);

  useEffect(() => {
    if (artifactsLoadState !== "loaded" || !planArtifactId) return;
    if (plans.some((plan) => plan.id === planArtifactId)) return;
    navigate(planPath(repoId), { replace: true });
  }, [artifactsLoadState, navigate, planArtifactId, plans, repoId]);

  const selectPlan = useCallback((artifactId: string | null, options: { replace?: boolean } = {}) => {
    setActiveChatTab("writer");
    navigate(planPath(repoId, artifactId), { replace: options.replace ?? false });
  }, [navigate, repoId]);

  const loadArtifacts = useCallback(async (options: { quiet?: boolean; selectId?: string | null } = {}) => {
    if (!options.quiet) setArtifactsLoadState("loading");
    try {
      const nextState = await fetchRepoArtifacts(HUB_URL, repoId);
      const nextPlans = listPlanArtifacts(nextState.artifacts);
      setArtifacts(nextState.artifacts);
      setArtifactsLoadState("loaded");
      if ("selectId" in options) {
        const requested = options.selectId ?? null;
        if (requested && nextPlans.some((plan) => plan.id === requested)) {
          navigate(planPath(repoId, requested), { replace: true });
        } else if (requested) {
          navigate(planPath(repoId), { replace: true });
        }
      }
    } catch (error) {
      if (!options.quiet) setArtifactsLoadState("error");
      if (!options.quiet) {
        addToast({
          title: "Failed to load plans",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      }
    }
  }, [addToast, navigate, repoId]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  useEffect(() => {
    let cancelled = false;
    void fetchPlannerProviders(HUB_URL, repoId)
      .then((result) => {
        if (cancelled) return;
        setPlannerProviders(result.providers);
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
    void loadPlanAgentSkills();
    void fetchRepoPlanWriterSettings(HUB_URL, repoId)
      .then((settings) => {
        setRepoWriterSettings(settings);
        setWriterSettingsDraft({
          routeKey: settings.routeKey,
          effort: settings.effort,
          fastMode: settings.fastMode,
          planFormat: settings.planFormat,
        });
      })
      .catch((error) => addToast({
        title: "Failed to load Plan Writer Settings",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      }));
  }, [addToast, loadPlanAgentSkills, repoId]);

  useEffect(() => {
    if (!selectedPlan || reviewersByPlan[selectedPlan.id]) return;
    let cancelled = false;
    setReviewersLoading(true);
    void fetchPlanReviewers(HUB_URL, repoId, selectedPlan.id)
      .then((reviewers) => {
        if (cancelled) return;
        setReviewersByPlan((current) => ({ ...current, [selectedPlan.id]: reviewers }));
      })
      .catch((error) => {
        if (cancelled) return;
        addToast({
          title: "Failed to load reviewers",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      })
      .finally(() => {
        if (!cancelled) setReviewersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addToast, repoId, reviewersByPlan, selectedPlan]);

  const loadContributions = useCallback(async (planId: string, options: { quiet?: boolean } = {}) => {
    try {
      const contributions = await fetchPlanContributions(HUB_URL, repoId, planId);
      setContributionsByPlan((current) => ({ ...current, [planId]: contributions }));
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
    addToast({
      title: "Main changed",
      body: mainEvent.sourceEnvSlug
        ? `Canonical main advanced from ${mainEvent.sourceEnvSlug}.`
        : "Canonical main advanced.",
      variant: "warning",
    });
    void loadArtifacts({ quiet: true });
  }, [addToast, loadArtifacts, mainEvent, repoId]);

  const handleNewPlan = useCallback(async () => {
    try {
      const artifact = await createPlan(HUB_URL, repoId);
      setArtifacts((current) => [artifact, ...current]);
      selectPlan(artifact.id);
    } catch (error) {
      addToast({
        title: "Failed to create plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [addToast, repoId, selectPlan]);

  const handleSavePlan = useCallback(async (planId: string, markdown: string) => {
    try {
      const updated = await savePlan(HUB_URL, repoId, planId, markdown);
      setArtifacts((current) => current.map((artifact) => (
        artifact.id === updated.id && (artifact.version ?? 1) <= (updated.version ?? 1)
          ? updated
          : artifact
      )));
    } catch (error) {
      void loadArtifacts({ quiet: true });
      throw error;
    }
  }, [loadArtifacts, repoId]);

  const openRepoWriterSettings = useCallback(() => {
    if (repoWriterSettings) {
      setWriterSettingsDraft({
        routeKey: repoWriterSettings.routeKey,
        effort: repoWriterSettings.effort,
        fastMode: repoWriterSettings.fastMode,
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
      const route = skillRoutes.find((candidate) => candidate.key === settings.routeKey);
      if (route) setWriterSelection({ routeKey: route.key, effort: settings.effort });
    } catch (error) {
      addToast({
        title: "Failed to save Plan Writer Settings",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [addToast, repoId, skillRoutes, writerSettingsDraft]);

  const handleMovePlan = useCallback(async (plan: PlanArtifact, status: PlanStatus) => {
    if ((plan.status ?? "draft") === status) return;
    try {
      const updated = await updatePlanStatus(HUB_URL, repoId, plan.id, status, plan.version);
      setArtifacts((current) => current.map((artifact) => artifact.id === updated.id ? updated : artifact));
      addToast({ title: "Plan moved", body: statusLabel(status), variant: "success", duration: 2000 });
    } catch (error) {
      addToast({
        title: "Failed to move plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      void loadArtifacts({ quiet: true });
    }
  }, [addToast, loadArtifacts, repoId]);

  const handleDiscardPlan = useCallback(async (plan: PlanArtifact) => {
    if ((plan.status ?? "draft") !== "draft") return;
    const label = plan.title || "Untitled plan";
    if (!confirm(`Delete "${label}"? This permanently removes the draft plan.`)) return;

    const wasSelected = selectedPlanArtifactId === plan.id;
    const fallbackId = wasSelected ? plans.find((candidate) => candidate.id !== plan.id)?.id ?? null : selectedPlanArtifactId;
    try {
      await discardPlan(HUB_URL, repoId, plan.id, plan.version);
      setArtifacts((current) => current.filter((artifact) => artifact.id !== plan.id));
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
      forgetPlanFinished(plan.id);
      if (wasSelected) {
        selectPlan(fallbackId, { replace: true });
      }
      addToast({ title: "Plan deleted", body: label, variant: "success", duration: 2000 });
    } catch (error) {
      addToast({
        title: "Couldn't delete plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      void loadArtifacts({ quiet: true });
    }
  }, [addToast, forgetPlanFinished, loadArtifacts, plans, repoId, selectPlan, selectedPlanArtifactId]);

  const handleAddReviewer = useCallback(async (input: AddReviewerAction) => {
    if (!selectedPlan) return;
    if (selectedReviewers.length >= 4) {
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
  }, [addToast, repoId, selectedPlan, selectedReviewers.length]);

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
      setReviewersByPlan((current) => ({
        ...current,
        [selectedPlan.id]: (current[selectedPlan.id] ?? []).filter((reviewer) => reviewer.threadId !== threadId),
      }));
      setReviewerRunsByPlan((current) => {
        const planRuns = current[selectedPlan.id];
        if (!planRuns || !(threadId in planRuns)) return current;
        const nextPlanRuns = { ...planRuns };
        delete nextPlanRuns[threadId];
        return { ...current, [selectedPlan.id]: nextPlanRuns };
      });
      forgetReviewerFinished(selectedPlan.id, threadId);
      if (activeChatTab === threadId) setActiveChatTab("writer");
    } catch (error) {
      addToast({
        title: "Failed to close reviewer",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [activeChatTab, addToast, forgetReviewerFinished, repoId, selectedPlan]);

  const sendContributionsToWriter = useCallback((contributions: PlanContribution[]) => {
    if (!selectedPlan || contributions.length === 0) return;
    setContributionsByPlan((current) => {
      const byId = new Map((current[selectedPlan.id] ?? []).map((contribution) => [contribution.id, contribution]));
      for (const contribution of contributions) byId.set(contribution.id, contribution);
      return { ...current, [selectedPlan.id]: [...byId.values()] };
    });
    const contributionIds = contributions
      .filter((contribution) => contribution.status === "pending")
      .map((contribution) => contribution.id);
    if (contributionIds.length > 0) {
      setWriterHandoffs((current) => {
        const queued = new Set(current.flatMap((handoff) => handoff.contributionIds));
        const unqueuedIds = contributionIds.filter((id) => !queued.has(id));
        return unqueuedIds.length > 0
          ? [...current, { id: crypto.randomUUID(), contributionIds: unqueuedIds }]
          : current;
      });
    }
    setActiveChatTab("writer");
  }, [selectedPlan]);

  const forwardReviewerMessage = useCallback(async (reviewer: ReviewerRegistryEntry, messageId: string) => {
    try {
      if (!selectedPlan) throw new Error("No plan selected");
      const result = await sendReviewerMessageToWriter(
        HUB_URL,
        repoId,
        selectedPlan.id,
        reviewer.threadId,
        messageId,
      );
      sendContributionsToWriter([result.contribution]);
    } catch (error) {
      addToast({
        title: "Feedback not sent to writer",
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
        title: "Feedback not sent to writer",
        body: error,
        variant: "error",
      });
      return;
    }
    addToast({
      title: "Feedback sent to writer",
      body: "The live Plan Writer is working on it now.",
      variant: "success",
      duration: 2500,
    });
  }, [addToast]);

  const sentReviewerMessageIdsByThread = useMemo(() => {
    const byThread = new Map<string, Set<string>>();
    for (const contribution of selectedContributions) {
      if (contribution.sourceKind !== "reviewer_message" || !contribution.sourceThreadId || !contribution.sourceMessageId) {
        continue;
      }
      const set = byThread.get(contribution.sourceThreadId) ?? new Set<string>();
      set.add(contribution.sourceMessageId);
      byThread.set(contribution.sourceThreadId, set);
    }
    return byThread;
  }, [selectedContributions]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-kumo-line bg-kumo-recessed px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-kumo-default">{getRepoLabel(repoUrl)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={openRepoWriterSettings}
              disabled={!repoWriterSettings}
              title={repoWriterSettings ? "Repository Plan Writer model, reasoning effort, Fast mode, and Plan Format" : "Plan Writer Settings are loading"}
              className="rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint disabled:opacity-50"
            >
              Plan Writer Settings
            </button>
            <button
              type="button"
              onClick={() => void handleNewPlan()}
              className="rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
            >
              New Plan
            </button>
          </div>
        </div>

        <ResizablePlanPanes
          artifact={selectedPlan ? (
            <PlanReader
              key={selectedPlan.id}
              plan={selectedPlan}
              saving={selectedWriterMode?.writer.synchronization.state === "saving"}
              onSave={(markdown) => handleSavePlan(selectedPlan.id, markdown)}
            />
          ) : (
            <PlanSelectionState
              loading={artifactsLoading && !!selectedPlanArtifactId}
              error={artifactsLoadError}
              missing={artifactsLoadState === "loaded" && !!selectedPlanArtifactId}
              onRetry={() => void loadArtifacts()}
            />
          )}
          reviewers={(
            <div className="h-full min-h-0">
              {selectedPlan ? (
                <div className="flex h-full min-h-0 flex-col">
                  <PlanChatTabs
                    reviewers={selectedReviewers}
                    providers={plannerProviders}
                    activeTab={activeChatTab}
                    writerTabStatus={writerTabStatus}
                    reviewerTabStatuses={selectedReviewerTabStatuses}
                    adding={addingReviewer || reviewersLoading}
                    onActiveTabChange={setActiveChatTab}
                    onOpenPlanSkills={() => setPlanSkillsOpen(true)}
                    onAddReviewer={(model) => void handleAddReviewer(model)}
                    onCloseReviewer={(threadId) => void handleCloseReviewer(threadId)}
                  />
                  <PlanSkillHistory
                    repoId={repoId}
                    planArtifactId={selectedPlan.id}
                    onContributionsChanged={() => void loadContributions(selectedPlan.id, { quiet: true })}
                    onForwarded={sendContributionsToWriter}
                  />
                  <div className="h-full min-h-0 flex-1 overflow-hidden">
                    {selectedWriterMode ? (
                      <PlanWriterPane
                        key={selectedPlan.id}
                        repoId={repoId}
                        planArtifactId={selectedPlan.id}
                        initialWriter={selectedWriterMode.writer}
                        routes={writerRouteOptions}
                        selection={writerSelection}
                        contributions={selectedContributions}
                        handoff={writerHandoffs[0] ?? null}
                        queuedHandoffContributionIds={writerHandoffs.flatMap((handoff) => handoff.contributionIds)}
                        hidden={activeChatTab !== "writer"}
                        onWriterChange={(writer) => setWriterMode({
                          planArtifactId: selectedPlan.id,
                          writer,
                        })}
                        onTabStatusChange={setWriterTabStatus}
                        onArtifactChanged={() => void loadArtifacts({ quiet: true, selectId: selectedPlan.id })}
                        onContributionsChanged={() => void loadContributions(selectedPlan.id, { quiet: true })}
                        onHandoffSettled={settleWriterHandoff}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <LoadingIndicator label="Loading Plan Writer" />
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
                        hidden={activeChatTab !== reviewer.threadId}
                        sentMessageIds={sentReviewerMessageIdsByThread.get(reviewer.threadId) ?? new Set()}
                        onLatestRunChange={(run) => handleReviewerRunChange(
                          selectedPlan.id,
                          reviewer.threadId,
                          run,
                        )}
                        onForward={(messageId) => forwardReviewerMessage(reviewer, messageId)}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
                  Create a plan to start a Plan Writer or reviewer.
                </div>
              )}
            </div>
          )}
        />
      </div>

      <PlanCategorySidebar
        artifacts={artifacts}
        selectedPlanArtifactId={selectedPlanArtifactId}
        repoMainCommit={repoMainCommit}
        loading={artifactsLoading}
        onSelect={selectPlan}
        onMove={(plan, status) => void handleMovePlan(plan, status)}
        onDiscard={(plan) => void handleDiscardPlan(plan)}
      />
      <SkillEditorDialog
        repoId={repoId}
        surface="plan"
        open={planSkillsOpen}
        skills={planAgentSkills}
        routes={skillRoutes}
        onOpenChange={setPlanSkillsOpen}
        onChanged={loadPlanAgentSkills}
      />
      <Dialog.Root open={writerSettingsOpen} onOpenChange={setWriterSettingsOpen}>
        <Dialog className="flex h-[calc(100vh-2rem)] max-h-[52rem] w-full max-w-2xl flex-col overflow-hidden p-0">
          <div className="border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">Plan Writer Settings</Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-kumo-subtle">
              Repository defaults are frozen when a new Plan Writer generation starts.
            </Dialog.Description>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <PlanWriterModelPicker
              routes={writerRouteOptions}
              providers={plannerProviders}
              value={writerSettingsDraft}
              onChange={(selection) => setWriterSettingsDraft((draft) => ({ ...draft, ...selection }))}
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
          <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => setWriterSettingsOpen(false)}>Cancel</Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
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

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function plannerEffortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra High";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
