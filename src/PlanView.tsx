import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import {
  fetchRepoArtifacts,
  integrateArtifactReviews,
  runArtifactReviewRound,
  setRepoRef,
} from "./api";
import HostedChatTranscript from "./HostedChatTranscript";
import { useToast } from "./Toast";
import type { Artifact, ArtifactRef } from "../api/coordination/types";
import {
  getApprovedPlanRef,
  listCurrentPlanDraftArtifacts,
  listReviewArtifactsForDraft,
  getDraftVersion,
  isPlanOutdatedForMain,
} from "./plan-artifacts";
import {
  PLAN_DEFAULT_MODEL,
  PLAN_MODEL_OPTIONS,
  coercePlanModelSelection,
  getPlanModelLabel,
  isChatGPTPlanModel,
  isPlanModelId,
  type PlanModelId,
} from "./plan-models";
import { getPlanChatName, getRepoLabel } from "./plan-repo";
import { getHostedToolOutputFingerprint } from "./hosted-chat";

interface PlanViewProps {
  repoId: string;
  repoUrl: string;
  repoMainCommit: string | null;
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
const MODEL_STORAGE_KEY = "tiller-hub:selected-plan-model";

function readStoredPreferredPlanModel(): PlanModelId {
  if (typeof window === "undefined") return PLAN_DEFAULT_MODEL;
  const stored = window.localStorage.getItem(MODEL_STORAGE_KEY);
  return isPlanModelId(stored) ? stored : PLAN_DEFAULT_MODEL;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function PlanView({
  repoId,
  repoUrl,
  repoMainCommit,
  chatgptAvailable,
  chatgptUnavailableReason,
  mainEvent,
}: PlanViewProps) {
  const [input, setInput] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [refs, setRefs] = useState<ArtifactRef[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [reviewingDraftId, setReviewingDraftId] = useState<string | null>(null);
  const [integratingDraftId, setIntegratingDraftId] = useState<string | null>(null);
  const [approvingDraftId, setApprovingDraftId] = useState<string | null>(null);
  const [expandedReviewIds, setExpandedReviewIds] = useState<Set<string>>(new Set());
  const preferredModelRef = useRef<PlanModelId>(readStoredPreferredPlanModel());
  const [selectedModel, setSelectedModel] = useState<PlanModelId>(() =>
    coercePlanModelSelection(preferredModelRef.current, { chatgptAvailable }),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seenRevisionNoticeRef = useRef<string | null>(null);
  const addToast = useToast();

  const agent = useAgent({
    agent: "plan-chat",
    name: getPlanChatName(repoId),
  });

  const {
    messages,
    sendMessage,
    setMessages,
    clearHistory,
    status,
    error,
  } = useAgentChat({
    agent,
    body: () => ({ selectedModel, repoUrl }),
  });

  const latestSavedArtifactKey = useMemo(
    () => getHostedToolOutputFingerprint(messages, "save_artifact"),
    [messages],
  );
  const approvedPlanRef = useMemo(() => getApprovedPlanRef(refs), [refs]);
  const planDrafts = useMemo(() => listCurrentPlanDraftArtifacts(artifacts, refs), [artifacts, refs]);
  const selectedDraft =
    planDrafts.find((artifact) => artifact.id === selectedDraftId) ?? planDrafts[0] ?? null;
  const reviewArtifacts = useMemo(
    () => listReviewArtifactsForDraft(artifacts, selectedDraft?.id ?? null),
    [artifacts, selectedDraft?.id],
  );
  const selectedDraftOutdated =
    !!selectedDraft &&
    isPlanOutdatedForMain(selectedDraft, repoMainCommit);

  const loading = !agent.identified && messages.length === 0;
  const streaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    const nextModel = coercePlanModelSelection(preferredModelRef.current, { chatgptAvailable });
    if (nextModel !== selectedModel) {
      setSelectedModel(nextModel);
    }
  }, [chatgptAvailable, selectedModel]);

  const loadArtifacts = useCallback(
    async ({
      quiet = false,
      preferNewest = false,
    }: {
      quiet?: boolean;
      preferNewest?: boolean;
    } = {}) => {
      if (!quiet) setArtifactsLoading(true);

      try {
        const nextState = await fetchRepoArtifacts(HUB_URL, repoId);
        const nextDrafts = listCurrentPlanDraftArtifacts(nextState.artifacts, nextState.refs);
        setArtifacts(nextState.artifacts);
        setRefs(nextState.refs);
        setSelectedDraftId((current) => {
          if (preferNewest) {
            return nextDrafts[0]?.id ?? null;
          }
          if (current && nextDrafts.some((artifact) => artifact.id === current)) {
            return current;
          }
          return nextDrafts[0]?.id ?? null;
        });
      } catch (loadError) {
        if (!quiet) {
          addToast({
            title: "Failed to load plan artifacts",
            body: loadError instanceof Error ? loadError.message : "Unknown error",
            variant: "error",
          });
        }
      } finally {
        if (!quiet) setArtifactsLoading(false);
      }
    },
    [addToast, repoId],
  );

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  useEffect(() => {
    if (streaming) return;

    const timeout = window.setTimeout(() => {
      void loadArtifacts({ quiet: true });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [loadArtifacts, messages.length, streaming]);

  useEffect(() => {
    if (!latestSavedArtifactKey) return;
    void loadArtifacts({ quiet: true, preferNewest: true });
  }, [latestSavedArtifactKey, loadArtifacts]);

  useEffect(() => {
    if (!mainEvent || mainEvent.repoId !== repoId) return;
    const noticeKey = `${mainEvent.repoId}:${mainEvent.currentMainCommit ?? "unknown"}`;
    if (seenRevisionNoticeRef.current === noticeKey) return;
    seenRevisionNoticeRef.current = noticeKey;
    setMessages((current) => [
      ...current,
      {
        id: `repo-main-${noticeKey}`,
        role: "assistant",
        parts: [{
          type: "text",
          text: `Main changed${mainEvent.sourceEnvSlug ? ` from env ${mainEvent.sourceEnvSlug}` : ""}. Drafts based on the previous main are now outdated.`,
        }],
      } as UIMessage,
    ]);
    void loadArtifacts({ quiet: true });
  }, [loadArtifacts, mainEvent, repoId, setMessages]);

  const handleSend = useCallback(() => {
    const message = input.trim();
    if (!message || streaming) return;

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: message }],
    });
    setInput("");
    inputRef.current?.focus();
  }, [input, sendMessage, streaming]);

  const handleRunReviewRound = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "This draft was created against an older main commit.",
        variant: "warning",
      });
      return;
    }

    setReviewingDraftId(selectedDraft.id);
    try {
      const result = await runArtifactReviewRound(HUB_URL, repoId, selectedDraft.id);
      addToast({
        title: "Review round completed",
        body: `${result.reviews.length} model reviews saved for ${selectedDraft.title}`,
        variant: "success",
      });
      setExpandedReviewIds(
        new Set(result.reviews.map((review) => review.id)),
      );
      await loadArtifacts({ quiet: true });
    } catch (reviewError) {
      addToast({
        title: "Failed to run review round",
        body: reviewError instanceof Error ? reviewError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setReviewingDraftId(null);
    }
  }, [addToast, loadArtifacts, repoId, selectedDraft, selectedDraftOutdated]);

  const handleIntegrateReviews = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "This draft was created against an older main commit.",
        variant: "warning",
      });
      return;
    }
    if (reviewArtifacts.length === 0) {
      addToast({
        title: "No reviews yet",
        body: "Run a review round first so the planner has feedback to integrate.",
        variant: "warning",
      });
      return;
    }

    setIntegratingDraftId(selectedDraft.id);
    try {
      const result = await integrateArtifactReviews(HUB_URL, repoId, selectedDraft.id, {
        selectedModel,
      });

      setMessages((current) => [
        ...current,
        {
          id: `integration-${crypto.randomUUID()}`,
          role: "assistant",
          parts: [{ type: "text", text: result.reply }],
        } as UIMessage,
      ]);

      addToast({
        title: result.skipped ? "No grounded review issues" : "Reviews integrated",
        body: result.skipped
          ? "The draft stayed unchanged because the review feedback did not survive grounding checks."
          : `${result.groundedIssueCount} grounded review issue${result.groundedIssueCount === 1 ? "" : "s"} considered.`,
        variant: result.skipped ? "warning" : "success",
      });

      await loadArtifacts({ quiet: true, preferNewest: !result.skipped });
    } catch (integrationError) {
      addToast({
        title: "Failed to integrate reviews",
        body: integrationError instanceof Error ? integrationError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setIntegratingDraftId(null);
    }
  }, [addToast, loadArtifacts, repoId, reviewArtifacts.length, selectedDraft, selectedDraftOutdated, selectedModel, setMessages]);

  const handleApprove = useCallback(async () => {
    if (!selectedDraft) return;
    if (selectedDraftOutdated) {
      addToast({
        title: "Draft is outdated",
        body: "Start a new draft on the current main commit before approving.",
        variant: "warning",
      });
      return;
    }

    setApprovingDraftId(selectedDraft.id);
    try {
      await setRepoRef(
        HUB_URL,
        repoId,
        "approved-plan",
        selectedDraft.id,
        approvedPlanRef?.version,
      );
      addToast({
        title: "Plan approved",
        body: `${selectedDraft.title} is now the approved plan reference for this repo.`,
        variant: "success",
      });
      await loadArtifacts({ quiet: true });
    } catch (approveError) {
      addToast({
        title: "Failed to approve plan",
        body: approveError instanceof Error ? approveError.message : "Unknown error",
        variant: "error",
      });
    } finally {
      setApprovingDraftId(null);
    }
  }, [addToast, approvedPlanRef?.version, loadArtifacts, repoId, selectedDraft, selectedDraftOutdated]);

  const toggleExpandedReview = useCallback((id: string) => {
    setExpandedReviewIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[#24292f]">{getRepoLabel(repoUrl)}</span>
            <span className="rounded border border-[#bbf7d0] bg-[#f0fdf4] px-1.5 py-0.5 text-xs text-[#15803d]">
              Plan
            </span>
            {repoMainCommit && (
              <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-xs text-[#57606a]">
                {repoMainCommit}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-[#57606a]">Starting model</label>
            <select
              value={selectedModel}
              onChange={(event) => {
                const nextModel = event.target.value as PlanModelId;
                preferredModelRef.current = nextModel;
                window.localStorage.setItem(MODEL_STORAGE_KEY, nextModel);
                setSelectedModel(nextModel);
              }}
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#24292f]"
              disabled={streaming}
            >
              {PLAN_MODEL_OPTIONS.map((option) => (
                <option
                  key={option.id}
                  value={option.id}
                  disabled={isChatGPTPlanModel(option.id) && !chatgptAvailable}
                >
                  {option.label}
                </option>
              ))}
            </select>
            {!chatgptAvailable && (
              <span className="max-w-xs text-xs text-[#57606a]">
                {chatgptUnavailableReason ?? "ChatGPT planning requires a published Tiller Host gateway."}
              </span>
            )}
            <button
              onClick={() => void handleRunReviewRound()}
              disabled={
                !selectedDraft ||
                streaming ||
                reviewingDraftId === selectedDraft?.id ||
                integratingDraftId === selectedDraft?.id
              }
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {reviewingDraftId === selectedDraft?.id ? "Reviewing..." : "Run review round"}
            </button>
            <button
              onClick={() => void handleIntegrateReviews()}
              disabled={
                !selectedDraft ||
                reviewArtifacts.length === 0 ||
                streaming ||
                integratingDraftId === selectedDraft?.id
              }
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-40"
            >
              {integratingDraftId === selectedDraft?.id ? "Integrating..." : "Integrate reviews"}
            </button>
            <button
              onClick={() => void clearHistory()}
              className="rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa]"
            >
              Reset chat
            </button>
          </div>
        </div>

        <HostedChatTranscript
          messages={messages}
          loading={loading}
          error={error}
          status={status}
          emptyState="Start planning here. Drafts, reviews, and approvals will stay scoped to this repo."
        />

        <div className="border-t border-[#d0d7de] bg-white px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs text-[#57606a]">
            <span>Planner model</span>
            <span>{getPlanModelLabel(selectedModel)}</span>
          </div>
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Describe the plan you want to build..."
              rows={1}
              className="flex-1 resize-none rounded-lg border border-[#d0d7de] px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#0969da]"
              disabled={streaming}
            />
            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className="rounded-lg bg-[#0969da] px-4 py-2 text-sm font-medium text-white hover:bg-[#0860c4] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <aside className="hidden w-[340px] flex-col border-l border-[#d0d7de] bg-[#fbfbfc] xl:flex">
        <div className="flex items-center justify-between border-b border-[#d0d7de] px-4 py-3">
          <div>
            <div className="text-sm font-medium text-[#24292f]">Draft Plans</div>
            <div className="text-xs text-[#57606a]">
              Approved plans leave this view and become available when starting a container.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleApprove()}
              disabled={
                !selectedDraft ||
                streaming ||
                integratingDraftId === selectedDraft?.id ||
                approvingDraftId === selectedDraft?.id
              }
              className="rounded bg-[#0969da] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0860c4] disabled:opacity-40"
            >
              {approvingDraftId === selectedDraft?.id ? "Approving..." : "Approve"}
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <div className="min-h-0 overflow-y-auto border-b border-[#d0d7de]">
            {artifactsLoading && planDrafts.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[#57606a]">Loading draft plans...</div>
            ) : planDrafts.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[#57606a]">
                No draft plans yet. Start planning to create one.
              </div>
            ) : (
              planDrafts.map((draft) => {
                const selected = draft.id === selectedDraft?.id;
                const reviews = listReviewArtifactsForDraft(artifacts, draft.id);
                const draftOutdated =
                  isPlanOutdatedForMain(draft, repoMainCommit);

                return (
                  <button
                    key={draft.id}
                    onClick={() => setSelectedDraftId(draft.id)}
                    className={`flex w-full flex-col gap-1 border-b border-[#eef1f4] px-4 py-3 text-left hover:bg-white ${
                      selected ? "bg-white" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-[#24292f]">
                        {draft.title}
                      </span>
                      <span className="rounded border border-[#d0d7de] bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#57606a]">
                        {draftOutdated ? "outdated" : `v${getDraftVersion(artifacts, draft)}`}
                      </span>
                    </div>
                    <div className="line-clamp-2 text-xs text-[#57606a]">{draft.body.summary}</div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[#8c959f]">
                      <span>{getPlanModelLabel(draft.body.model)}</span>
                      <span>{draft.basis.mainCommit ?? "unknown main"} · {formatTimestamp(draft.createdAt)}</span>
                    </div>
                    {reviews.length > 0 && (
                      <div className="text-[11px] text-[#57606a]">
                        Reviewed by {reviews.map((review) => getPlanModelLabel(review.body.model)).join(", ")}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className="min-h-0 overflow-y-auto px-4 py-4">
            {selectedDraft ? (
              <div className="space-y-4">
                <div>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-[#24292f]">
                      {selectedDraft.title}
                    </div>
                    <div className="mt-1 text-xs text-[#57606a]">
                      {getPlanModelLabel(selectedDraft.body.model)} · {formatTimestamp(selectedDraft.createdAt)}
                    </div>
                  </div>
                  <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#57606a]">
                      {selectedDraftOutdated ? "Outdated" : "Draft"}
                  </span>
                </div>
                </div>

                <section>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                    Summary
                  </div>
                  <div className="whitespace-pre-wrap text-sm text-[#24292f]">
                    {selectedDraft.body.summary}
                  </div>
                </section>

                <section>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                    Proposed Plan
                  </div>
                  <div className="whitespace-pre-wrap rounded border border-[#e1e4e8] bg-white p-2 text-sm text-[#24292f]">
                    {selectedDraft.body.proposedPlan}
                  </div>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                      Review Feedback
                    </div>
                    <div className="text-[11px] text-[#57606a]">
                      {reviewArtifacts.length} review{reviewArtifacts.length === 1 ? "" : "s"}
                    </div>
                  </div>

                  {reviewArtifacts.length === 0 ? (
                    <div className="rounded border border-dashed border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#57606a]">
                      No review feedback yet. Run a review round to see which models disagree with this plan.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {reviewArtifacts.map((review) => {
                        const expanded = expandedReviewIds.has(review.id);
                        return (
                          <div key={review.id} className="rounded border border-[#d0d7de] bg-white">
                            <button
                              onClick={() => toggleExpandedReview(review.id)}
                              className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
                            >
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-[#24292f]">
                                  {getPlanModelLabel(review.body.model)}
                                </div>
                                <div className="mt-1 text-xs text-[#57606a]">{review.body.summary}</div>
                                {(review.body.reviewIssueStats || review.body.reviewMeta) && (
                                  <div className="mt-1 text-[11px] text-[#8c959f]">
                                    {review.body.reviewIssueStats
                                      ? `${review.body.reviewIssueStats.kept} grounded issue${review.body.reviewIssueStats.kept === 1 ? "" : "s"} kept`
                                      : "No grounded issues kept"}
                                    {review.body.reviewIssueStats && review.body.reviewIssueStats.dropped > 0
                                      ? `, ${review.body.reviewIssueStats.dropped} dropped`
                                      : ""}
                                    {review.body.reviewMeta?.toolCallCount
                                      ? `, ${review.body.reviewMeta.toolCallCount} code inspection step${review.body.reviewMeta.toolCallCount === 1 ? "" : "s"}`
                                      : ""}
                                    {review.body.reviewMeta?.retriedForToolUse
                                      ? ", retried for code inspection"
                                      : ""}
                                    {review.body.reviewMeta?.repaired ? ", repaired output" : ""}
                                    {review.body.reviewMeta?.truncated
                                      ? ", response truncated"
                                      : review.body.reviewMeta?.finishReason &&
                                          review.body.reviewMeta.finishReason !== "stop"
                                        ? `, finish: ${review.body.reviewMeta.finishReason}`
                                        : ""}
                                  </div>
                                )}
                              </div>
                              <span className="shrink-0 text-[11px] text-[#57606a]">
                                {expanded ? "Hide response" : "Show full response"}
                              </span>
                            </button>
                            {expanded && (
                              <div className="border-t border-[#e1e4e8] px-3 py-2">
                                {review.body.findings.length > 0 && (
                                  <div className="mb-3">
                                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                                      Key Findings
                                    </div>
                                    <ul className="list-disc space-y-1 pl-4 text-sm text-[#24292f]">
                                      {review.body.findings.map((finding) => (
                                        <li key={finding}>{finding}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#e1e4e8] bg-[#f6f8fa] p-2 text-xs text-[#24292f]">
                                  {review.body.proposedPlan}
                                </pre>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <div className="text-sm text-[#57606a]">
                Select a draft plan to inspect its review feedback.
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
