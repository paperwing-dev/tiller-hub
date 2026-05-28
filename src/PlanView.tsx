import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addPlanReviewer,
  createPlan,
  discardPlan,
  fetchPlanReviewers,
  fetchRepoArtifacts,
  removePlanReviewer,
  updatePlanStatus,
} from "./api";
import type { Artifact, PlanArtifact, PlanStatus, ReviewerRegistryEntry } from "../api/coordination/types";
import PlanCategorySidebar from "./PlanCategorySidebar";
import PlanReader from "./PlanReader";
import PlanChatTabs from "./PlanChatTabs";
import PlanWriterChat, { type ForwardedReviewerMessage } from "./PlanWriterChat";
import ReviewerChat from "./ReviewerChat";
import { useToast } from "./Toast";
import { getRepoLabel } from "./plan-repo";
import { listPlanArtifacts } from "./plan-artifacts";

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

export default function PlanView({
  repoId,
  repoUrl,
  repoMainCommit,
  planArtifactId,
  chatgptAvailable,
  chatgptUnavailableReason,
  mainEvent,
}: PlanViewProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [selectedPlanArtifactId, setSelectedPlanArtifactId] = useState<string | null>(planArtifactId ?? readHashPlanArtifactId());
  const [reviewersByPlan, setReviewersByPlan] = useState<Record<string, ReviewerRegistryEntry[]>>({});
  const [reviewersLoading, setReviewersLoading] = useState(false);
  const [addingReviewer, setAddingReviewer] = useState(false);
  const [activeChatTab, setActiveChatTab] = useState("writer");
  const [forwardedReviewerMessages, setForwardedReviewerMessages] = useState<Record<string, ForwardedReviewerMessage[]>>({});
  const [writerStreaming, setWriterStreaming] = useState(false);
  const [writerResetToken, setWriterResetToken] = useState(0);
  const seenMainEventRef = useRef<string | null>(null);
  const addToast = useToast();

  const plans = useMemo(() => listPlanArtifacts(artifacts), [artifacts]);
  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanArtifactId) ?? plans[0] ?? null,
    [plans, selectedPlanArtifactId],
  );
  const selectedReviewers = selectedPlan ? reviewersByPlan[selectedPlan.id] ?? [] : [];
  const selectedForwardedReviewerMessages = selectedPlan ? forwardedReviewerMessages[selectedPlan.id] ?? [] : [];

  const selectPlan = useCallback((artifactId: string | null) => {
    setSelectedPlanArtifactId(artifactId);
    setActiveChatTab("writer");
    writePlanHash(repoId, artifactId);
  }, [repoId]);

  const loadArtifacts = useCallback(async (options: { quiet?: boolean; selectId?: string | null } = {}) => {
    if (!options.quiet) setArtifactsLoading(true);
    try {
      const nextState = await fetchRepoArtifacts(HUB_URL, repoId);
      const nextPlans = listPlanArtifacts(nextState.artifacts);
      setArtifacts(nextState.artifacts);
      setSelectedPlanArtifactId((current) => {
        const preferred = options.selectId ?? current;
        if (preferred && nextPlans.some((plan) => plan.id === preferred)) {
          writePlanHash(repoId, preferred);
          return preferred;
        }
        const fallback = nextPlans[0]?.id ?? null;
        writePlanHash(repoId, fallback);
        return fallback;
      });
    } catch (error) {
      if (!options.quiet) {
        addToast({
          title: "Failed to load plans",
          body: error instanceof Error ? error.message : "Unknown error",
          variant: "error",
        });
      }
    } finally {
      if (!options.quiet) setArtifactsLoading(false);
    }
  }, [addToast, repoId]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

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
    if (!confirm(`Discard "${label}"? This permanently removes the draft plan.`)) return;

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
      setForwardedReviewerMessages((current) => {
        const next = { ...current };
        delete next[plan.id];
        return next;
      });
      if (wasSelected) {
        selectPlan(fallbackId);
      }
      addToast({ title: "Plan discarded", body: label, variant: "success", duration: 2000 });
    } catch (error) {
      addToast({
        title: "Failed to discard plan",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
      void loadArtifacts({ quiet: true });
    }
  }, [addToast, loadArtifacts, plans, repoId, selectPlan, selectedPlanArtifactId]);

  const handleAddReviewer = useCallback(async (model: string) => {
    if (!selectedPlan) return;
    if (selectedReviewers.length >= 4) {
      addToast({ title: "Reviewer limit reached", body: "Each plan can have up to four active reviewers.", variant: "warning" });
      return;
    }
    setAddingReviewer(true);
    try {
      const reviewer = await addPlanReviewer(HUB_URL, repoId, selectedPlan.id, model);
      setReviewersByPlan((current) => ({
        ...current,
        [selectedPlan.id]: [
          ...(current[selectedPlan.id] ?? []).filter((entry) => entry.threadId !== reviewer.threadId),
          reviewer,
        ],
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

  const handleResetWriter = useCallback(() => {
    setWriterResetToken((current) => current + 1);
    setActiveChatTab("writer");
  }, []);

  const handleCloseReviewer = useCallback(async (threadId: string) => {
    if (!selectedPlan) return;
    try {
      await removePlanReviewer(HUB_URL, repoId, selectedPlan.id, threadId);
      setReviewersByPlan((current) => ({
        ...current,
        [selectedPlan.id]: (current[selectedPlan.id] ?? []).filter((reviewer) => reviewer.threadId !== threadId),
      }));
      if (activeChatTab === threadId) setActiveChatTab("writer");
    } catch (error) {
      addToast({
        title: "Failed to close reviewer",
        body: error instanceof Error ? error.message : "Unknown error",
        variant: "error",
      });
    }
  }, [activeChatTab, addToast, repoId, selectedPlan]);

  const forwardReviewerMessage = useCallback((reviewerModel: string, text: string) => {
    if (!selectedPlan) return;
    setForwardedReviewerMessages((current) => ({
      ...current,
      [selectedPlan.id]: [
        ...(current[selectedPlan.id] ?? []),
        { id: crypto.randomUUID(), reviewerModel, text },
      ],
    }));
    setActiveChatTab("writer");
  }, [selectedPlan]);

  const handleForwardedMessageSent = useCallback((id: string) => {
    if (!selectedPlan) return;
    setForwardedReviewerMessages((current) => ({
      ...current,
      [selectedPlan.id]: (current[selectedPlan.id] ?? []).filter((item) => item.id !== id),
    }));
  }, [selectedPlan]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[#24292f]">{getRepoLabel(repoUrl)}</span>
            <span className="rounded border border-[#bbf7d0] bg-[#f0fdf4] px-1.5 py-0.5 text-xs text-[#15803d]">
              Plan
            </span>
          </div>
          {!chatgptAvailable && (
            <span className="max-w-md truncate text-xs text-[#92400e]">
              {chatgptUnavailableReason ?? "Writer requires ChatGPT planning availability."}
            </span>
          )}
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(340px,0.9fr)]">
          <PlanReader plan={selectedPlan} streaming={writerStreaming} />

          <div className="min-h-0 border-t border-[#d0d7de]">
            {selectedPlan ? (
              <div className="flex h-full min-h-0 flex-col">
                <PlanChatTabs
                  reviewers={selectedReviewers}
                  activeTab={activeChatTab}
                  adding={addingReviewer || reviewersLoading}
                  onActiveTabChange={setActiveChatTab}
                  onResetWriter={handleResetWriter}
                  onAddReviewer={(model) => void handleAddReviewer(model)}
                  onCloseReviewer={(threadId) => void handleCloseReviewer(threadId)}
                />
                <div className="h-full min-h-0 flex-1 overflow-hidden">
                  <div className={activeChatTab === "writer" ? "flex h-full min-h-0" : "hidden"}>
                    <PlanWriterChat
                      key={selectedPlan.id}
                      repoId={repoId}
                      planArtifactId={selectedPlan.id}
                      forwardedMessages={selectedForwardedReviewerMessages}
                      onForwardedMessageSent={handleForwardedMessageSent}
                      resetToken={writerResetToken}
                      onSaved={() => void loadArtifacts({ quiet: true, selectId: selectedPlan.id })}
                      onConflict={() => {
                        addToast({
                          title: "Plan changed elsewhere",
                          body: "The writer hit a version conflict. Refreshing the plan.",
                          variant: "warning",
                        });
                        void loadArtifacts({ quiet: true, selectId: selectedPlan.id });
                      }}
                      onStreamingChange={setWriterStreaming}
                    />
                  </div>
                  {selectedReviewers.map((reviewer) => (
                    <ReviewerChat
                      key={reviewer.threadId}
                      repoId={repoId}
                      threadId={reviewer.threadId}
                      reviewerModel={reviewer.reviewerModel}
                      hidden={activeChatTab !== reviewer.threadId}
                      onForward={(text) => forwardReviewerMessage(reviewer.reviewerModel, text)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[#57606a]">
                Create a plan to start the writer chat.
              </div>
            )}
          </div>
        </div>
      </div>

      <PlanCategorySidebar
        artifacts={artifacts}
        selectedPlanArtifactId={selectedPlan?.id ?? null}
        repoMainCommit={repoMainCommit}
        loading={artifactsLoading}
        onSelect={selectPlan}
        onNewPlan={() => void handleNewPlan()}
        onMove={(plan, status) => void handleMovePlan(plan, status)}
        onDiscard={(plan) => void handleDiscardPlan(plan)}
      />
    </div>
  );
}

function readHashPlanArtifactId(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("planArtifactId");
}

function writePlanHash(repoId: string, planArtifactId: string | null): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams();
  params.set("repoId", repoId);
  if (planArtifactId) params.set("planArtifactId", planArtifactId);
  window.history.replaceState(null, "", `#${params.toString()}`);
}

function statusLabel(status: PlanStatus): string {
  if (status === "todo") return "Plans To Do";
  if (status === "completed") return "Completed";
  if (status === "archived") return "Archived";
  return "Draft";
}
