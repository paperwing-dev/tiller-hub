import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StopIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type {
  AgentRoute,
  PlanWriterState,
  PlanContribution,
  PlanWriterProvider,
} from "../api/coordination/types";
import type { StoredSession } from "../api/types";
import {
  dismissPlanContribution,
  fetchPlanWriter,
  incorporatePlanContribution,
  startPlanWriter,
  stopPlanWriter,
} from "./api";
import { useDashboardData } from "./DashboardDataProvider";
import TerminalView, { type TerminalViewHandle } from "./TerminalView";
import type { TerminalRecoveryState } from "./terminal-recovery";
import { planWriterTabStatus, type PlanTabStatus } from "./plan-tab-status";
import { bracketedPasteAndSubmit } from "./plan-writer-paste";
import { codexAuthModeLabel } from "./codex-auth-ui";
import { planWriterEffortLabel, type PlanWriterModelSelection } from "./PlanWriterModelPicker";

const NO_ACTIVE_TERMINAL_OWNER_ERROR = "No active terminal owner for session";
const WRITER_STOPPED_DELIVERY_ERROR = "The Plan Writer stopped before receiving the message";

interface PlanWriterPaneProps {
  repoId: string;
  planArtifactId: string;
  initialWriter: PlanWriterState;
  routes: AgentRoute[];
  selection: PlanWriterModelSelection;
  contributions: PlanContribution[];
  handoff?: PlanWriterHandoff | null;
  queuedHandoffContributionIds?: string[];
  hidden?: boolean;
  onWriterChange(writer: PlanWriterState): void;
  onTabStatusChange(status: PlanTabStatus): void;
  onArtifactChanged(): void;
  onContributionsChanged(): void;
  onHandoffSettled(handoffId: string, error?: string): void;
}

export interface PlanWriterHandoff {
  id: string;
  contributionIds: string[];
}

function syntheticTerminalSession(writer: PlanWriterState): StoredSession | null {
  if (!writer.terminalId || !writer.generation) return null;
  const now = new Date().toISOString();
  return {
    id: writer.terminalId,
    tag: "Plan Writer",
    machine_id: null,
    metadata: JSON.stringify({ terminalScope: { kind: "plan-writer", generation: writer.generation } }),
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: writer.lifecycle === "running" ? 1 : 0,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 0,
    ended_at: writer.lifecycle === "not_running" ? now : null,
    created_at: now,
    updated_at: now,
  };
}

export default function PlanWriterPane({
  repoId,
  planArtifactId,
  initialWriter,
  routes,
  selection,
  contributions,
  handoff = null,
  queuedHandoffContributionIds = [],
  hidden = false,
  onWriterChange,
  onTabStatusChange,
  onArtifactChanged,
  onContributionsChanged,
  onHandoffSettled,
}: PlanWriterPaneProps) {
  const {
    hubUrl,
    connected,
    terminalFastLane,
    liveMessageRef,
    terminalAckRef,
    planWriterHintRef,
    wsRef,
    updateLastSeq,
  } = useDashboardData();
  const [writer, setWriter] = useState(initialWriter);
  const [operation, setOperation] = useState<"starting" | "stopping" | null>(null);
  const [contributionPending, setContributionPending] = useState(false);
  const [deliveredContributionIds, setDeliveredContributionIds] = useState<Set<string>>(() => new Set());
  const [operationError, setOperationError] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [syncRefreshing, setSyncRefreshing] = useState(false);
  const [recovery, setRecovery] = useState<TerminalRecoveryState>({ status: "recovering" });
  const termRef = useRef<TerminalViewHandle>(null);
  const clientIdRef = useRef(crypto.randomUUID());
  const inputSeqRef = useRef(0);
  const controlSeqRef = useRef(0);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingInputAcksRef = useRef(new Map<number, {
    resolve: (result: { ok: boolean; error?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const activeHandoffRef = useRef<string | null>(null);
  const writerMutationVersionRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const callbackRef = useRef({ onWriterChange, onTabStatusChange, onArtifactChanged });
  callbackRef.current = { onWriterChange, onTabStatusChange, onArtifactChanged };

  const selectedRoute = routes.find((route) => route.key === selection.routeKey) ?? null;
  const selectionUsable = Boolean(
    selectedRoute?.available && selectedRoute.supportedEfforts.includes(selection.effort),
  );
  const activeRoute = routes.find((route) => (
    route.provider === writer.provider && route.model === writer.model
  )) ?? null;
  const displayedRoute = writer.lifecycle === "not_running" ? selectedRoute : activeRoute;
  const displayedEffort = writer.lifecycle === "not_running" ? selection.effort : writer.effort;
  const operationPending = operation !== null;
  const saving = syncRefreshing || writer.synchronization.state === "saving";
  const terminalSession = useMemo(() => syntheticTerminalSession(writer), [writer]);
  const terminalInteractive = writer.lifecycle === "running"
    && connected
    && terminalFastLane
    && recovery.status === "ready";

  const acceptWriter = useCallback((next: PlanWriterState) => {
    setWriter(next);
    callbackRef.current.onWriterChange(next);
  }, []);

  const acceptMutationWriter = useCallback((next: PlanWriterState) => {
    writerMutationVersionRef.current += 1;
    refreshRequestRef.current += 1;
    acceptWriter(next);
  }, [acceptWriter]);

  const handleRecoveryState = useCallback((next: TerminalRecoveryState) => {
    setRecovery(next);
    if (next.status === "ready") setTerminalError(null);
  }, []);

  const tabStatus = useMemo(() => planWriterTabStatus(writer, {
    operation,
    saving,
    connecting: !hidden && writer.lifecycle === "running" && recovery.status !== "ready",
    error: writer.lifecycle === "running" ? null : operationError ?? terminalError,
    routeLabel: displayedRoute?.label ?? null,
    effortLabel: planWriterEffortLabel(displayedEffort),
  }), [
    displayedEffort,
    displayedRoute?.label,
    hidden,
    operation,
    operationError,
    recovery,
    saving,
    terminalError,
    writer,
  ]);

  useEffect(() => {
    callbackRef.current.onTabStatusChange(tabStatus);
  }, [tabStatus]);

  const refresh = useCallback(async (includeArtifact = false): Promise<PlanWriterState | null> => {
    const request = ++refreshRequestRef.current;
    const mutationVersion = writerMutationVersionRef.current;
    const next = await fetchPlanWriter(hubUrl, repoId, planArtifactId);
    if (includeArtifact) callbackRef.current.onArtifactChanged();
    if (request !== refreshRequestRef.current || mutationVersion !== writerMutationVersionRef.current) return null;
    acceptWriter(next);
    return next;
  }, [acceptWriter, hubUrl, planArtifactId, repoId]);

  useEffect(() => {
    if (writer.lifecycle !== "starting") return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, writer.lifecycle]);

  useEffect(() => {
    setTerminalError(null);
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: WRITER_STOPPED_DELIVERY_ERROR });
    }
    pendingInputAcksRef.current.clear();
  }, [writer.terminalId]);

  useEffect(() => {
    planWriterHintRef.current = (event) => {
      if (event.repoId !== repoId || event.planArtifactId !== planArtifactId) return;
      if (event.type === "artifact") {
        setSyncRefreshing(true);
        void refresh(true).finally(() => setSyncRefreshing(false));
      } else {
        void refresh().catch(() => undefined);
      }
    };
    return () => { planWriterHintRef.current = null; };
  }, [planArtifactId, planWriterHintRef, refresh, repoId]);

  useEffect(() => {
    if (!connected) return;
    setTerminalError(null);
    termRef.current?.recover();
    void refresh(true).catch(() => undefined);
  }, [connected, refresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) void refresh(true).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  useEffect(() => {
    const terminalId = writer.terminalId;
    if (!terminalId) return;
    liveMessageRef.current = (message) => {
      if (message.sessionId !== terminalId) return;
      setTerminalError(null);
      termRef.current?.acceptMessage(message);
    };
    terminalAckRef.current = (message) => {
      if (message.sessionId !== terminalId || message.clientId !== clientIdRef.current) return;
      if (message.type === "terminal-input-ack") {
        const pending = pendingInputAcksRef.current.get(message.inputSeq);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingInputAcksRef.current.delete(message.inputSeq);
          pending.resolve({
            ok: message.ok,
            ...(message.ok ? {} : {
              error: message.error === NO_ACTIVE_TERMINAL_OWNER_ERROR
                ? WRITER_STOPPED_DELIVERY_ERROR
                : message.error ?? "Writer rejected the message",
            }),
          });
        }
      }
      if (message.ok) {
        setTerminalError(null);
      } else if (message.error === NO_ACTIVE_TERMINAL_OWNER_ERROR) {
        setTerminalError(null);
        void refresh().then((next) => {
          if (next?.lifecycle === "running") termRef.current?.recover();
        }).catch(() => undefined);
      } else {
        setTerminalError(message.error ?? "Terminal operation was rejected");
      }
    };
    return () => {
      liveMessageRef.current = null;
      terminalAckRef.current = null;
    };
  }, [liveMessageRef, refresh, terminalAckRef, writer.terminalId]);

  useEffect(() => {
    if (connected) return;
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Writer disconnected before receiving the message" });
    }
    pendingInputAcksRef.current.clear();
  }, [connected]);

  useEffect(() => () => {
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Writer closed before receiving the message" });
    }
    pendingInputAcksRef.current.clear();
  }, []);

  const sendInput = useCallback((data: string): boolean => {
    if (!terminalInteractive || !writer.terminalId) return false;
    const inputSeq = ++inputSeqRef.current;
    const sent = wsRef.current?.send({
      type: "terminal-input",
      sessionId: writer.terminalId,
      clientId: clientIdRef.current,
      inputSeq,
      data,
      ...(lastSizeRef.current ?? {}),
    }) ?? false;
    if (!sent) setTerminalError("Terminal input could not be delivered");
    return sent;
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const submitText = useCallback(async (text: string): Promise<{ ok: boolean; error?: string }> => {
    if (!terminalInteractive || !writer.terminalId) {
      return { ok: false, error: "The live Plan Writer is not ready" };
    }
    const inputSeq = ++inputSeqRef.current;
    const data = bracketedPasteAndSubmit(text);
    return await new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingInputAcksRef.current.delete(inputSeq);
        resolve({ ok: false, error: "Timed out waiting for the Plan Writer" });
      }, 15_000);
      pendingInputAcksRef.current.set(inputSeq, { resolve, timer });
      const sent = wsRef.current?.send({
        type: "terminal-input",
        sessionId: writer.terminalId!,
        clientId: clientIdRef.current,
        inputSeq,
        data,
        ...(lastSizeRef.current ?? {}),
      }) ?? false;
      if (!sent) {
        window.clearTimeout(timer);
        pendingInputAcksRef.current.delete(inputSeq);
        setTerminalError("Plan Writer input could not be delivered");
        resolve({ ok: false, error: "Plan Writer input could not be delivered" });
      }
    });
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const sendControl = useCallback((action: "resize" | "abort", size?: { cols: number; rows: number }) => {
    if (!terminalInteractive || !writer.terminalId) return false;
    const controlSeq = ++controlSeqRef.current;
    return wsRef.current?.send({
      type: "terminal-control",
      sessionId: writer.terminalId,
      clientId: clientIdRef.current,
      controlSeq,
      action,
      ...(size ?? {}),
    }) ?? false;
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const start = async () => {
    setOperation("starting");
    setOperationError(null);
    try {
      const next = await startPlanWriter(hubUrl, repoId, planArtifactId, {
        ...(selectedRoute?.provider === "claude-code" || selectedRoute?.provider === "codex"
          ? { provider: selectedRoute.provider as PlanWriterProvider }
          : {}),
        ...(selectedRoute?.model ? { model: selectedRoute.model } : {}),
        effort: selection.effort,
      });
      acceptMutationWriter(next);
      setTerminalError(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
      const next = await refresh().catch(() => null);
      if (next?.lifecycle === "running") setOperationError(null);
    } finally {
      setOperation(null);
    }
  };

  const stop = async () => {
    if (!writer.generation) return;
    setOperation("stopping");
    setOperationError(null);
    try {
      acceptMutationWriter(await stopPlanWriter(hubUrl, repoId, planArtifactId, writer.generation));
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
      const next = await refresh().catch(() => null);
      if (next?.lifecycle === "not_running") setOperationError(null);
    } finally {
      setOperation(null);
    }
  };

  const submitContributions = useCallback(async (items: PlanContribution[]): Promise<{ ok: boolean; error?: string }> => {
    const pending = items.filter((contribution) => contribution.status === "pending");
    if (pending.length === 0) return { ok: true };
    setContributionPending(true);
    setOperationError(null);
    try {
      const result = await submitText(pending.map((contribution) => contribution.text).join("\n\n---\n\n"));
      if (!result.ok) throw new Error(result.error ?? "The Plan Writer did not accept the feedback");
      setDeliveredContributionIds((current) => {
        const next = new Set(current);
        for (const contribution of pending) next.add(contribution.id);
        return next;
      });
      try {
        await Promise.all(pending.map((contribution) => (
          incorporatePlanContribution(hubUrl, repoId, planArtifactId, contribution.id)
        )));
      } catch {
        // Delivery is authoritative once the writer ACKs it. Never resend a
        // completed prompt just because the bookkeeping refresh failed.
        setOperationError("Feedback was sent, but its delivery status could not be refreshed.");
      }
      onContributionsChanged();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOperationError(message);
      return { ok: false, error: message };
    } finally {
      setContributionPending(false);
    }
  }, [hubUrl, onContributionsChanged, planArtifactId, repoId, submitText]);

  const dismissContribution = async (contribution: PlanContribution) => {
    try {
      await dismissPlanContribution(hubUrl, repoId, planArtifactId, contribution.id);
      onContributionsChanged();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (!handoff || !terminalInteractive || activeHandoffRef.current === handoff.id) return;
    const items = handoff.contributionIds
      .map((id) => contributions.find((contribution) => contribution.id === id))
      .filter((contribution): contribution is PlanContribution => Boolean(contribution));
    if (items.length !== handoff.contributionIds.length) return;
    activeHandoffRef.current = handoff.id;
    void submitContributions(items).then((result) => {
      activeHandoffRef.current = null;
      onHandoffSettled(handoff.id, result.ok ? undefined : result.error);
    });
  }, [contributions, handoff, onHandoffSettled, submitContributions, terminalInteractive]);

  if (hidden) return <div className="hidden" />;
  const showTerminal = Boolean(terminalSession && writer.lifecycle !== "starting");
  const errorNotice = operationError
    ?? terminalError
    ?? (writer.cleanupError ? `Cleanup failed: ${writer.cleanupError}` : null)
    ?? (writer.startupError ? `Startup failed: ${writer.startupError}` : null)
    ?? (writer.synchronization.state === "sync_failed"
      ? `Sync failed: ${writer.synchronization.error ?? "retry the last plan publication"}`
      : null);
  const queuedContributionIds = new Set([
    ...queuedHandoffContributionIds,
    ...(handoff?.contributionIds ?? []),
  ]);
  const pendingContributions = contributions.filter((contribution) => (
    contribution.status === "pending"
    && !queuedContributionIds.has(contribution.id)
    && !deliveredContributionIds.has(contribution.id)
  ));
  return (
    <div className="flex h-full min-h-0 flex-col bg-kumo-base">
      <div className="shrink-0 border-b border-kumo-line bg-kumo-recessed px-3 py-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate text-xs text-kumo-subtle">
            {displayedRoute && `${displayedRoute.label} · ${planWriterEffortLabel(displayedEffort)} reasoning`}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {writer.codexAuthMode && (
              <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
                {codexAuthModeLabel(writer.codexAuthMode)}
              </span>
            )}
            {writer.lifecycle === "not_running" ? (
              <button
                type="button"
                disabled={operationPending || !writer.editable || !selectionUsable}
                onClick={() => void start()}
                className="rounded bg-kumo-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Start Writer
              </button>
            ) : (
              <Tooltip
                content="Ends this writer generation and its provider conversation. The saved plan and terminal history remain; Start Writer creates a new conversation."
                side="bottom"
                align="end"
                delay={250}
                render={(
                  <button
                    type="button"
                    aria-label="Stop Plan Writer"
                    disabled={operationPending || !writer.generation}
                    onClick={() => void stop()}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-kumo-danger text-white transition-colors hover:bg-kumo-danger/85 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                )}
              >
                <StopIcon aria-hidden="true" size={14} weight="fill" />
              </Tooltip>
            )}
          </div>
        </div>
        {errorNotice && (
          <div role="alert" className="mt-1 text-xs text-kumo-danger">{errorNotice}</div>
        )}
      </div>

      {handoff && (
        <div className="shrink-0 border-b border-kumo-line bg-kumo-info/5 px-3 py-2 text-xs text-kumo-subtle">
          {terminalInteractive ? "Sending feedback to the Plan Writer…" : "Feedback is queued until the live Plan Writer is ready."}
        </div>
      )}

      {pendingContributions.length > 0 && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-kumo-line px-3 py-2">
          {pendingContributions.map((contribution) => (
            <div key={contribution.id} className="mb-2 flex items-start justify-between gap-3 last:mb-0">
              <div className="line-clamp-2 min-w-0 text-xs text-kumo-subtle">{contribution.text}</div>
              <div className="flex shrink-0 gap-1">
                <ContributionAction
                  label={contributionPending ? "Sending…" : "Send now"}
                  disabled={!terminalInteractive || contributionPending}
                  onClick={() => void submitContributions([contribution])}
                />
                <ContributionAction
                  label="Dismiss"
                  disabled={contributionPending}
                  onClick={() => void dismissContribution(contribution)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {writer.lifecycle === "starting" && (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-kumo-subtle">Starting Plan Writer…</div>
      )}
      {showTerminal && terminalSession && (
        <div className="flex min-h-0 flex-1 flex-col">
          <TerminalView
            ref={termRef}
            session={terminalSession}
            hubUrl={hubUrl}
            fontSize={12}
            updateLastSeq={updateLastSeq}
            interactive={terminalInteractive}
            onInput={sendInput}
            onResize={(cols, rows) => {
              lastSizeRef.current = { cols, rows };
              sendControl("resize", { cols, rows });
            }}
            onRecoveryState={handleRecoveryState}
          />
        </div>
      )}
      {!showTerminal && writer.lifecycle === "not_running" && (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-kumo-subtle">
          Start Writer to open a provider planning conversation.
        </div>
      )}
    </div>
  );
}

function ContributionAction({ label, onClick, disabled = false }: { label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-kumo-line bg-kumo-base px-1.5 py-1 text-[11px] text-kumo-subtle hover:bg-kumo-tint disabled:opacity-40"
    >
      {label}
    </button>
  );
}
