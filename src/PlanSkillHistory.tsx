import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPlanSkillInvocation,
  fetchPlanSkillInvocation,
  fetchPlanSkillInvocations,
  fetchReviewerMessages,
  forwardPlanSkillReports,
  sendReviewerMessage,
  type PlanSkillInvocationDetail,
} from "./api";
import type { PlanContribution, ThreadMessage } from "../api/coordination/types";

const HUB_URL = window.location.origin;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function role(message: ThreadMessage): string {
  return isRecord(message.body) && typeof message.body.role === "string" ? message.body.role : message.senderSessionId;
}

function text(message: ThreadMessage): string {
  return isRecord(message.body) && typeof message.body.text === "string" ? message.body.text : "";
}

function messageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string" ? message.body.runId : null;
}

function isActiveInvocationStatus(status: unknown): boolean {
  return status === "active" || status === "setting_up";
}

function isActiveRunStatus(status: unknown): boolean {
  return status === "queued" || status === "running" || status === "saving";
}

export default function PlanSkillHistory({
  repoId,
  planArtifactId,
  refreshToken = 0,
  onContributionsChanged,
  onForwarded,
}: {
  repoId: string;
  planArtifactId: string;
  refreshToken?: number;
  onContributionsChanged?: () => void;
  onForwarded?: (contributions: PlanContribution[]) => void;
}) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanSkillInvocationDetail | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [followup, setFollowup] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedScopeRef = useRef("");
  const forwardingActionRef = useRef<{ requestId: string; signature: string } | null>(null);

  const loadRows = useCallback(async (append = false, preserve = false) => {
    const result = await fetchPlanSkillInvocations(HUB_URL, repoId, planArtifactId, {
      limit: 10,
      cursor: append ? nextCursor : null,
    });
    setRows((current) => {
      if (append) {
        return [...current, ...result.invocations.filter((row) =>
          !current.some((existing) => existing.invocationId === row.invocationId)
        )];
      }
      if (!preserve) return result.invocations;
      return [
        ...result.invocations,
        ...current.filter((row) => !result.invocations.some((fresh) => fresh.invocationId === row.invocationId)),
      ];
    });
    setNextCursor((current) => preserve && !append && current ? current : result.nextCursor);
  }, [nextCursor, planArtifactId, repoId]);

  useEffect(() => {
    const scope = `${repoId}:${planArtifactId}`;
    const preserve = loadedScopeRef.current === scope;
    loadedScopeRef.current = scope;
    if (!preserve) {
      setRows([]);
      setSelectedId(null);
      setDetail(null);
    }
    void loadRows(false, preserve).catch(() => undefined);
  }, [planArtifactId, refreshToken, repoId]);

  useEffect(() => {
    const active = rows.some((row) => isActiveInvocationStatus(row.status));
    if (!active) return;
    const timer = window.setInterval(() => void loadRows(false, true).catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [loadRows, rows]);

  useEffect(() => {
    setSelectedMessageIds([]);
    forwardingActionRef.current = null;
  }, [selectedId]);

  const selectedInvocationActive = rows.some((row) =>
    row.invocationId === selectedId && isActiveInvocationStatus(row.status)
  );
  const selectedLinkedRunActive = detail?.invocation.invocationId === selectedId
    && detail.runs.some((run) => isActiveRunStatus(run.status));
  const shouldPollDetail = selectedInvocationActive || selectedLinkedRunActive;

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const next = await fetchPlanSkillInvocation(HUB_URL, repoId, planArtifactId, selectedId);
      if (cancelled) return;
      setDetail(next);
      setActiveThreadId((current) => next.reviewers.some((reviewer) => reviewer.threadId === current)
        ? current
        : next.reviewers[0]?.threadId ?? null);
    };
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load invocation"));
    const timer = shouldPollDetail
      ? window.setInterval(() => void load().catch(() => undefined), 2_000)
      : null;
    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [planArtifactId, repoId, selectedId, shouldPollDetail]);

  useEffect(() => {
    if (!activeThreadId) {
      setMessages([]);
      return;
    }
    void fetchReviewerMessages(HUB_URL, repoId, planArtifactId, activeThreadId)
      .then(setMessages)
      .catch(() => setMessages([]));
  }, [activeThreadId, detail?.runs, planArtifactId, repoId]);

  if (rows.length === 0) return null;

  const sendFollowup = async () => {
    if (!activeThreadId || !followup.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sendReviewerMessage(HUB_URL, repoId, planArtifactId, activeThreadId, followup.trim());
      setMessages((current) => current.some((message) => message.id === result.message.id)
        ? current
        : [...current, result.message]);
      if (result.run) {
        setDetail((current) => current ? {
          ...current,
          runs: [...current.runs.filter((run) => run.runId !== result.run!.runId), result.run!],
        } : current);
      }
      setFollowup("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to send follow-up");
    } finally {
      setBusy(false);
    }
  };

  const forward = async () => {
    if (!detail || (selectedMessageIds.length === 0 && !guidance.trim())) return;
    const payload = {
      messageIds: [...selectedMessageIds].sort(),
      guidance: guidance.trim() || null,
    };
    const signature = JSON.stringify({ invocationId: detail.invocation.invocationId, ...payload });
    const requestId = forwardingActionRef.current?.signature === signature
      ? forwardingActionRef.current.requestId
      : crypto.randomUUID();
    forwardingActionRef.current = { requestId, signature };
    setBusy(true);
    setError(null);
    try {
      const result = await forwardPlanSkillReports(HUB_URL, repoId, planArtifactId, detail.invocation.invocationId, {
        requestId,
        messageIds: payload.messageIds,
        guidance: payload.guidance,
      });
      forwardingActionRef.current = null;
      if (result.contributions.length > 0) onForwarded?.(result.contributions);
      onContributionsChanged?.();
      setSelectedMessageIds([]);
      setGuidance("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to forward reports");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-kumo-line bg-kumo-recessed">
      <div className="flex items-center gap-2 overflow-x-auto px-3 py-1.5">
        <span className="shrink-0 text-[10px] font-medium uppercase text-kumo-subtle">Plan skill history</span>
        {rows.map((row) => {
          const id = typeof row.invocationId === "string" ? row.invocationId : "";
          return (
            <button key={id} type="button" onClick={() => setSelectedId((current) => current === id ? null : id)} className={`shrink-0 rounded border px-2 py-1 text-xs ${selectedId === id ? "border-kumo-brand bg-kumo-tint" : "border-kumo-line bg-kumo-base"}`}>
              {String(row.label ?? "Skill")} · {String(row.status ?? "unknown")}
            </button>
          );
        })}
        {nextCursor && <button type="button" onClick={() => void loadRows(true)} className="shrink-0 text-xs text-kumo-info">Older</button>}
      </div>
      {detail && (
        <div className="grid max-h-64 grid-cols-[190px_minmax(0,1fr)_240px] border-t border-kumo-line bg-kumo-base">
          <aside className="overflow-y-auto border-r border-kumo-line p-2">
            {detail.reviewers.map((reviewer) => {
              const agent = detail.invocation.definitionSnapshot.agents.find((candidate) => candidate.id === reviewer.skillAgentId);
              const reviewerRuns = detail.runs.filter((candidate) => candidate.threadId === reviewer.threadId);
              const run = reviewerRuns[reviewerRuns.length - 1];
              return <button key={reviewer.threadId} type="button" onClick={() => setActiveThreadId(reviewer.threadId)} className={`mb-1 block w-full rounded px-2 py-1.5 text-left text-xs ${activeThreadId === reviewer.threadId ? "bg-kumo-tint" : "hover:bg-kumo-recessed"}`}>
                <span className="block font-medium">{agent?.label ?? "Child"}</span>
                <span className="text-[10px] uppercase text-kumo-subtle">{run?.status ?? "idle"}</span>
              </button>;
            })}
            {(detail.invocation.status === "active" || detail.invocation.status === "setting_up") && (
              <button type="button" onClick={() => void cancelPlanSkillInvocation(HUB_URL, repoId, planArtifactId, detail.invocation.invocationId).then(() => loadRows(false, true))} className="mt-2 text-xs text-kumo-danger">Cancel fanout</button>
            )}
          </aside>
          <main className="min-w-0 overflow-y-auto p-3">
            {messages.map((message) => {
              const messageText = text(message);
              if (!messageText) return null;
              const assistant = role(message) === "assistant";
              const reportRun = detail.runs.find((run) => run.runId === messageRunId(message));
              const eligible = assistant
                && reportRun?.threadId === activeThreadId
                && reportRun.status === "completed"
                && (reportRun.skillRunRole === "child_initial" || reportRun.skillRunRole === "child_followup");
              return <div key={message.id} className={`mb-2 rounded px-2 py-1.5 text-xs ${assistant ? "border border-kumo-line bg-kumo-recessed" : "ml-10 bg-kumo-brand text-white"}`}>
                <div className="whitespace-pre-wrap">{messageText}</div>
                {eligible && <label className="mt-1 flex items-center gap-1 text-[10px] text-kumo-subtle">
                  <input type="checkbox" checked={selectedMessageIds.includes(message.id)} onChange={() => setSelectedMessageIds((current) => current.includes(message.id) ? current.filter((id) => id !== message.id) : [...current, message.id])} />
                  Share with Scribe
                </label>}
              </div>;
            })}
            <div className="sticky bottom-0 flex gap-1 bg-kumo-base pt-1">
              <input value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder="Follow up on this frozen Plan basis" className="min-w-0 flex-1 rounded border border-kumo-line px-2 py-1 text-xs" />
              <button type="button" disabled={busy || !followup.trim()} onClick={() => void sendFollowup()} className="rounded border border-kumo-line px-2 text-xs disabled:opacity-40">Send</button>
            </div>
          </main>
          <aside className="border-l border-kumo-line p-3">
            <div className="text-xs font-medium text-kumo-default">Share selected findings</div>
            <textarea value={guidance} onChange={(event) => setGuidance(event.target.value)} placeholder="Optional guidance" className="mt-2 h-24 w-full resize-none rounded border border-kumo-line p-2 text-xs" />
            <button type="button" disabled={busy || (selectedMessageIds.length === 0 && !guidance.trim())} onClick={() => void forward()} className="mt-2 w-full rounded bg-kumo-brand px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40">Share with Scribe</button>
            {error && <div className="mt-2 text-xs text-kumo-danger">{error}</div>}
          </aside>
        </div>
      )}
    </div>
  );
}
