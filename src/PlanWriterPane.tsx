import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlayIcon, StopIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type {
  AgentRoute,
  PlanWriterState,
  PlanContribution,
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
import TerminalView, {
  type TerminalResizeRequest,
  type TerminalViewHandle,
} from "./TerminalView";
import type { TerminalRecoveryState } from "./terminal-recovery";
import { planWriterTabStatus, type PlanTabStatus } from "./plan-tab-status";
import { bracketedPasteAndSubmit, bracketedTerminalPaste } from "./plan-writer-paste";
import { codexAuthModeLabel } from "./codex-auth-ui";
import { planWriterEffortLabel, type PlanWriterModelSelection } from "./PlanWriterModelPicker";
import { PLAN_AGENT_LABEL } from "./plan-agent-copy";
import { EnvironmentLaunchIllustration } from "./EnvWaitingView";
import { getHarnessBadgeLabel } from "./env-harness";

const NO_ACTIVE_TERMINAL_OWNER_ERROR = "No active terminal owner for session";
const WRITER_STOPPED_DELIVERY_ERROR = "The Scribe stopped before receiving the message";
const SCRIBE_INPUT_NOT_DELIVERED_ERROR = "The Scribe terminal disconnected. Your last input was not delivered.";
const SCRIBE_TERMINAL_UNAVAILABLE_ERROR = "The Scribe terminal disconnected. Input is paused until it reconnects.";
const SCRIBE_TERMINAL_STILL_UNAVAILABLE_ERROR = "The Scribe workload is running, but its terminal has not reconnected.";
const SLOW_SCRIBE_START_MS = 120_000;

interface TerminalOwnerIssue {
  terminalId: string;
  generation: number;
  message: string;
}

function formatScribeWaitTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export interface PlanContributionPresentation {
  sourceLabel: string;
  sourceDetail?: string;
  canViewSource: boolean;
}

const EMPTY_CONTRIBUTION_PRESENTATIONS: ReadonlyMap<string, PlanContributionPresentation> = new Map();

interface PlanWriterPaneProps {
  repoId: string;
  planArtifactId: string;
  initialWriter: PlanWriterState;
  routes: AgentRoute[];
  selection: PlanWriterModelSelection;
  contributions: PlanContribution[];
  contributionPresentations?: ReadonlyMap<string, PlanContributionPresentation>;
  handoff?: PlanWriterHandoff | null;
  queuedHandoffContributionIds?: string[];
  hidden?: boolean;
  compact?: boolean;
  canAddReviewer?: boolean;
  onWriterChange(writer: PlanWriterState): void;
  onTabStatusChange(status: PlanTabStatus): void;
  onContributionsChanged(): void;
  onHandoffSettled(handoffId: string, error?: string): void;
  onViewContributionSource?(contributionId: string): void;
  onAddReviewer?(): void;
  onOpenSettings?(): void;
  settingsAvailable?: boolean;
}

export interface PlanWriterHandoff {
  id: string;
  contributionIds: string[];
}

const RECOVERING_TERMINAL_STATE: TerminalRecoveryState = { status: "recovering" };

function syntheticTerminalSession(writer: PlanWriterState): StoredSession | null {
  if (!writer.terminalId || !writer.generation) return null;
  const now = new Date().toISOString();
  return {
    id: writer.terminalId,
    tag: "Scribe",
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
  contributionPresentations = EMPTY_CONTRIBUTION_PRESENTATIONS,
  handoff = null,
  queuedHandoffContributionIds = [],
  hidden = false,
  compact = false,
  canAddReviewer = true,
  onWriterChange,
  onTabStatusChange,
  onContributionsChanged,
  onHandoffSettled,
  onViewContributionSource,
  onAddReviewer,
  onOpenSettings,
  settingsAvailable = true,
}: PlanWriterPaneProps) {
  const {
    hubUrl,
    connected,
    terminalFastLane,
    terminalMetrics,
    liveMessageRef,
    terminalAckRef,
    planWriterRefreshHintRef,
    wsRef,
    updateLastSeq,
  } = useDashboardData();
  const [writer, setWriter] = useState(initialWriter);
  const [operation, setOperation] = useState<"starting" | "stopping" | null>(null);
  const [contributionPending, setContributionPending] = useState(false);
  const [startupContributionIds, setStartupContributionIds] = useState<string[]>([]);
  const [deliveredContributionIds, setDeliveredContributionIds] = useState<Set<string>>(() => new Set());
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalOwnerIssue, setTerminalOwnerIssue] = useState<TerminalOwnerIssue | null>(null);
  const [ownerRecoveryPending, setOwnerRecoveryPending] = useState(false);
  const [ownerRecoveryError, setOwnerRecoveryError] = useState<string | null>(null);
  const [localStartupStartedAtMs, setLocalStartupStartedAtMs] = useState<number | null>(null);
  const [terminalRecovery, setTerminalRecovery] = useState<{
    terminalId: string | null;
    state: TerminalRecoveryState;
  }>({ terminalId: initialWriter.terminalId, state: RECOVERING_TERMINAL_STATE });
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
  const attemptedHandoffIdRef = useRef<string | null>(null);
  const preparedHandoffIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const writerMutationVersionRef = useRef(0);
  const refreshRequestRef = useRef(0);
  const refreshQueuedRef = useRef(false);
  const refreshInFlightRef = useRef<Promise<PlanWriterState | null> | null>(null);
  const callbackRef = useRef({ onWriterChange, onTabStatusChange });
  callbackRef.current = { onWriterChange, onTabStatusChange };

  const selectedRoute = routes.find((route) => route.key === selection.routeKey) ?? null;
  const selectionUsable = Boolean(
    selectedRoute?.available && selectedRoute.supportedEfforts.includes(selection.effort),
  );
  const activeRoute = routes.find((route) => (
    route.provider === writer.provider
    && route.model === writer.model
    && Boolean(writer.effort && route.supportedEfforts.includes(writer.effort))
  )) ?? null;
  const displayedRoute = writer.lifecycle === "not_running" ? selectedRoute : activeRoute;
  const displayedEffort = writer.lifecycle === "not_running" ? selection.effort : writer.effort;
  const activeTerminalOwnerIssue = writer.lifecycle === "running"
    && terminalOwnerIssue?.terminalId === writer.terminalId
    && terminalOwnerIssue.generation === writer.generation
    ? terminalOwnerIssue
    : null;
  const operationPending = operation !== null || ownerRecoveryPending;
  const saving = writer.synchronization.state === "saving";
  const terminalSession = useMemo(() => syntheticTerminalSession(writer), [writer]);
  const recovery = terminalRecovery.terminalId === writer.terminalId
    ? terminalRecovery.state
    : RECOVERING_TERMINAL_STATE;
  const terminalReady = connected && terminalFastLane && recovery.status === "ready";
  const terminalInteractive = writer.lifecycle === "running"
    && terminalReady
    && !activeTerminalOwnerIssue;
  const terminalRecoveryError = recovery.status === "fault"
    ? `Terminal recovery stopped (${recovery.code.replace(/_/g, " ")}).`
    : null;
  const connectingDetail = !connected
    ? "The Hub connection is offline. Reconnecting to the live Scribe."
    : !terminalFastLane
      ? "Waiting for live terminal controls."
      : "Restoring live Scribe output.";
  const handoffContributionIds = useMemo(() => new Set([
    ...queuedHandoffContributionIds,
    ...(handoff?.contributionIds ?? []),
  ]), [handoff?.contributionIds, queuedHandoffContributionIds]);
  const queuedContributionIds = useMemo(() => new Set([
    ...handoffContributionIds,
    ...startupContributionIds,
  ]), [handoffContributionIds, startupContributionIds]);
  const pendingContributions = useMemo(() => contributions.filter((contribution) => (
    contribution.status === "pending" && !deliveredContributionIds.has(contribution.id)
  )), [contributions, deliveredContributionIds]);

  const acceptWriter = useCallback((next: PlanWriterState) => {
    if (!mountedRef.current) return;
    setWriter(next);
    callbackRef.current.onWriterChange(next);
  }, []);

  const acceptMutationWriter = useCallback((next: PlanWriterState) => {
    writerMutationVersionRef.current += 1;
    refreshRequestRef.current += 1;
    acceptWriter(next);
  }, [acceptWriter]);

  const handleRecoveryState = useCallback((next: TerminalRecoveryState) => {
    setTerminalRecovery({ terminalId: writer.terminalId, state: next });
    if (next.status === "ready" && !activeTerminalOwnerIssue) setTerminalError(null);
  }, [activeTerminalOwnerIssue, writer.terminalId]);

  const tabStatus = useMemo(() => planWriterTabStatus(writer, {
    operation,
    saving,
    connecting: writer.lifecycle === "running" && recovery.status !== "fault" && !terminalReady,
    connectingDetail,
    error: writer.lifecycle === "running"
      ? activeTerminalOwnerIssue?.message ?? terminalRecoveryError
      : operationError ?? terminalError,
    routeLabel: displayedRoute?.label ?? null,
    effortLabel: planWriterEffortLabel(displayedEffort),
  }), [
    connectingDetail,
    activeTerminalOwnerIssue?.message,
    displayedEffort,
    displayedRoute?.label,
    operation,
    operationError,
    recovery,
    saving,
    terminalReady,
    terminalError,
    terminalRecoveryError,
    writer,
  ]);

  useEffect(() => {
    callbackRef.current.onTabStatusChange(tabStatus);
  }, [tabStatus]);

  const performRefresh = useCallback(async (): Promise<PlanWriterState | null> => {
    const request = ++refreshRequestRef.current;
    const mutationVersion = writerMutationVersionRef.current;
    const next = await fetchPlanWriter(hubUrl, repoId, planArtifactId);
    if (
      !mountedRef.current
      || request !== refreshRequestRef.current
      || mutationVersion !== writerMutationVersionRef.current
    ) return null;
    acceptWriter(next);
    return next;
  }, [acceptWriter, hubUrl, planArtifactId, repoId]);

  const refresh = useCallback((): Promise<PlanWriterState | null> => {
    refreshQueuedRef.current = true;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;

    const drain = async (): Promise<PlanWriterState | null> => {
      let latest: PlanWriterState | null = null;
      let lastError: unknown = null;
      while (mountedRef.current && refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        try {
          latest = await performRefresh();
          lastError = null;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return latest;
    };

    const pending: Promise<PlanWriterState | null> = drain().finally(() => {
      if (refreshInFlightRef.current === pending) refreshInFlightRef.current = null;
      if (mountedRef.current && refreshQueuedRef.current) {
        void refresh().catch(() => undefined);
      }
    });
    refreshInFlightRef.current = pending;
    return pending;
  }, [performRefresh]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshQueuedRef.current = false;
      refreshRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (writer.lifecycle !== "starting") return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, writer.lifecycle]);

  useEffect(() => {
    setTerminalError(null);
    setTerminalOwnerIssue(null);
    setOwnerRecoveryPending(false);
    setOwnerRecoveryError(null);
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: WRITER_STOPPED_DELIVERY_ERROR });
    }
    pendingInputAcksRef.current.clear();
  }, [writer.generation, writer.terminalId]);

  useEffect(() => {
    const terminalId = writer.terminalId;
    if (!terminalId) return;
    const clientId = clientIdRef.current;
    return () => {
      wsRef.current?.send({
        type: "terminal-detach",
        sessionId: terminalId,
        clientId,
      });
    };
  }, [writer.terminalId]);

  useEffect(() => {
    planWriterRefreshHintRef.current = (hintRepoId, hintPlanArtifactId) => {
      if (hintRepoId !== repoId || hintPlanArtifactId !== planArtifactId) return;
      void refresh().catch(() => undefined);
    };
    return () => { planWriterRefreshHintRef.current = null; };
  }, [planArtifactId, planWriterRefreshHintRef, refresh, repoId]);

  useEffect(() => {
    if (!connected) return;
    setTerminalError(null);
    termRef.current?.recover();
    void refresh().catch(() => undefined);
  }, [connected, refresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) void refresh().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  useEffect(() => {
    const terminalId = writer.terminalId;
    if (!terminalId) return;
    liveMessageRef.current = (message) => {
      if (message.sessionId !== terminalId) return;
      setTerminalOwnerIssue((current) => (
        current?.terminalId === terminalId && current.generation === writer.generation
          ? null
          : current
      ));
      setOwnerRecoveryError(null);
      setTerminalError(null);
      termRef.current?.acceptMessage(message);
    };
    terminalAckRef.current = (message) => {
      if (message.sessionId !== terminalId || message.clientId !== clientIdRef.current) return;
      if (message.type === "terminal-input-ack") {
        termRef.current?.markInputAcknowledged?.(message.inputSeq, message.ok);
        const pending = pendingInputAcksRef.current.get(message.inputSeq);
        if (pending) {
          window.clearTimeout(pending.timer);
          pendingInputAcksRef.current.delete(message.inputSeq);
          pending.resolve({
            ok: message.ok,
            ...(message.ok ? {} : {
              error: message.error === NO_ACTIVE_TERMINAL_OWNER_ERROR
                ? WRITER_STOPPED_DELIVERY_ERROR
                : message.error ?? "Scribe rejected the message",
            }),
          });
        }
      }
      if (message.ok) {
        setTerminalOwnerIssue((current) => (
          current?.terminalId === terminalId && current.generation === writer.generation
            ? null
            : current
        ));
        setOwnerRecoveryError(null);
        setTerminalError(null);
      } else if (message.error === NO_ACTIVE_TERMINAL_OWNER_ERROR) {
        const ownerError = message.type === "terminal-input-ack"
          ? SCRIBE_INPUT_NOT_DELIVERED_ERROR
          : SCRIBE_TERMINAL_UNAVAILABLE_ERROR;
        if (writer.generation !== null) {
          setTerminalOwnerIssue({
            terminalId,
            generation: writer.generation,
            message: ownerError,
          });
        }
        setOwnerRecoveryError(null);
        setTerminalError(ownerError);
        void refresh().catch(() => undefined);
      } else {
        setTerminalError(message.error ?? "Terminal operation was rejected");
      }
    };
    return () => {
      liveMessageRef.current = null;
      terminalAckRef.current = null;
    };
  }, [liveMessageRef, refresh, terminalAckRef, writer.generation, writer.terminalId]);

  useEffect(() => {
    if (connected) return;
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Scribe disconnected before receiving the message" });
    }
    pendingInputAcksRef.current.clear();
  }, [connected]);

  useEffect(() => () => {
    for (const pending of pendingInputAcksRef.current.values()) {
      window.clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Scribe closed before receiving the message" });
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
    else termRef.current?.markInputEnqueued?.(inputSeq);
    return sent;
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const pasteIntoCodex = useCallback((text: string) => {
    sendInput(bracketedTerminalPaste(text));
  }, [sendInput]);

  const submitText = useCallback(async (text: string): Promise<{ ok: boolean; error?: string }> => {
    if (!terminalInteractive || !writer.terminalId) {
      return { ok: false, error: "The live Scribe is not ready" };
    }
    const inputSeq = ++inputSeqRef.current;
    const data = bracketedPasteAndSubmit(text);
    return await new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingInputAcksRef.current.delete(inputSeq);
        resolve({ ok: false, error: "Timed out waiting for the Scribe" });
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
        setTerminalError("Scribe input could not be delivered");
        resolve({ ok: false, error: "Scribe input could not be delivered" });
      } else {
        termRef.current?.markInputEnqueued?.(inputSeq);
      }
    });
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const sendControl = useCallback((
    action: "resize" | "abort",
    size?: { cols: number; rows: number },
    request?: TerminalResizeRequest,
  ) => {
    if (!terminalInteractive || !writer.terminalId) return false;
    const controlSeq = ++controlSeqRef.current;
    return wsRef.current?.send({
      type: "terminal-control",
      sessionId: writer.terminalId,
      clientId: clientIdRef.current,
      controlSeq,
      action,
      ...(size ?? {}),
      ...(request?.claim !== undefined ? { claim: request.claim } : {}),
    }) ?? false;
  }, [terminalInteractive, writer.terminalId, wsRef]);

  const requestWriterStart = useCallback((): Promise<PlanWriterState> => (
    startPlanWriter(
      hubUrl,
      repoId,
      planArtifactId,
      settingsAvailable && selectionUsable && selectedRoute
        ? { routeKey: selectedRoute.key, effort: selection.effort }
        : {},
    )
  ), [
    hubUrl,
    planArtifactId,
    repoId,
    selectedRoute,
    selection.effort,
    selectionUsable,
    settingsAvailable,
  ]);

  const ensureWriter = useCallback(async (): Promise<PlanWriterState> => {
    const next = await requestWriterStart();
    acceptMutationWriter(next);
    setTerminalError(null);
    return next;
  }, [
    acceptMutationWriter,
    requestWriterStart,
  ]);

  const retryTerminal = useCallback(() => {
    setTerminalOwnerIssue(null);
    setOwnerRecoveryError(null);
    setTerminalError(null);
    termRef.current?.recover();
  }, []);

  const checkAndRecoverTerminal = useCallback(async () => {
    if (!writer.terminalId || writer.generation === null || ownerRecoveryPending) return;
    const checkedTerminalId = writer.terminalId;
    const checkedGeneration = writer.generation;
    setOwnerRecoveryPending(true);
    setOwnerRecoveryError(null);
    setOperationNotice(null);
    try {
      const next = await requestWriterStart();
      acceptMutationWriter(next);
      if (next.lifecycle === "not_running") {
        throw new Error(next.startupError ?? "The Scribe could not be recovered");
      }
      const sameGeneration = next.generation === checkedGeneration
        && next.terminalId === checkedTerminalId;
      if (next.lifecycle === "running" && sameGeneration) {
        setTerminalOwnerIssue({
          terminalId: checkedTerminalId,
          generation: checkedGeneration,
          message: SCRIBE_TERMINAL_STILL_UNAVAILABLE_ERROR,
        });
        setTerminalError(SCRIBE_TERMINAL_STILL_UNAVAILABLE_ERROR);
        termRef.current?.recover();
      } else {
        setTerminalOwnerIssue(null);
        setTerminalError(null);
      }
    } catch (error) {
      setOwnerRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setOwnerRecoveryPending(false);
    }
  }, [
    acceptMutationWriter,
    ownerRecoveryPending,
    requestWriterStart,
    writer.generation,
    writer.terminalId,
  ]);

  const start = async () => {
    setTerminalOwnerIssue(null);
    setOwnerRecoveryError(null);
    setTerminalError(null);
    setStartupContributionIds(pendingContributions
      .filter((contribution) => !handoffContributionIds.has(contribution.id))
      .map((contribution) => contribution.id));
    setOperation("starting");
    setLocalStartupStartedAtMs(Date.now());
    setOperationError(null);
    setOperationNotice(null);
    try {
      const next = await ensureWriter();
      if (next.lifecycle !== "starting") setLocalStartupStartedAtMs(null);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
      const next = await refresh().catch(() => null);
      if (next?.lifecycle === "running") {
        setOperationError(null);
        setLocalStartupStartedAtMs(null);
      } else {
        setStartupContributionIds([]);
      }
    } finally {
      setOperation(null);
    }
  };

  const stop = async () => {
    if (!writer.generation) return;
    setOperation("stopping");
    setOperationError(null);
    setOperationNotice(null);
    try {
      const next = await stopPlanWriter(hubUrl, repoId, planArtifactId, writer.generation);
      acceptMutationWriter(next);
      setTerminalOwnerIssue(null);
      setOwnerRecoveryError(null);
      setTerminalError(null);
      if (next.cleanupPending) {
        setOperationNotice(next.cleanupWarning ?? "Scribe abandoned. Workload cleanup is continuing in the background.");
      }
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
      const prompt = pending.map((contribution) => formatContributionForScribe(
        contribution,
        contributionPresentations.get(contribution.id),
      )).join("\n\n---\n\n");
      const result = await submitText(prompt);
      if (!result.ok) throw new Error(result.error ?? "The Scribe did not accept the shared context");
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
        setOperationError("Context was shared, but its delivery status could not be refreshed.");
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
  }, [contributionPresentations, hubUrl, onContributionsChanged, planArtifactId, repoId, submitText]);

  const dismissContribution = async (contribution: PlanContribution) => {
    try {
      await dismissPlanContribution(hubUrl, repoId, planArtifactId, contribution.id);
      onContributionsChanged();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (
      !handoff
      || operation !== null
      || attemptedHandoffIdRef.current === handoff.id
    ) return;
    attemptedHandoffIdRef.current = handoff.id;
    setOperation("starting");
    setOperationError(null);
    setOperationNotice(null);
    void ensureWriter().then((next) => {
      if (!mountedRef.current) return;
      if (next.lifecycle === "not_running") {
        throw new Error(next.startupError ?? "The Scribe could not be started");
      }
      preparedHandoffIdRef.current = handoff.id;
    }).catch((error) => {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setOperationError(message);
      void refresh().catch(() => null);
      onHandoffSettled(handoff.id, message);
    }).finally(() => {
      if (mountedRef.current) setOperation(null);
    });
  }, [ensureWriter, handoff, onHandoffSettled, operation, refresh]);

  useEffect(() => {
    if (
      !handoff
      || preparedHandoffIdRef.current !== handoff.id
      || activeHandoffRef.current === handoff.id
    ) return;
    const error = writer.lifecycle === "not_running"
      ? writer.startupError ?? "The Scribe stopped before receiving the message"
      : writer.lifecycle === "running" && recovery.status === "fault"
        ? terminalRecoveryError ?? "The live Scribe terminal could not be restored"
        : null;
    if (!error) return;
    preparedHandoffIdRef.current = null;
    setOperationError(error);
    onHandoffSettled(handoff.id, error);
  }, [handoff, onHandoffSettled, recovery.status, terminalRecoveryError, writer.lifecycle, writer.startupError]);

  useEffect(() => {
    if (
      !handoff
      || preparedHandoffIdRef.current !== handoff.id
      || !terminalInteractive
      || activeHandoffRef.current === handoff.id
    ) return;
    const items = handoff.contributionIds
      .map((id) => contributions.find((contribution) => contribution.id === id))
      .filter((contribution): contribution is PlanContribution => Boolean(contribution));
    if (items.length !== handoff.contributionIds.length) return;
    activeHandoffRef.current = handoff.id;
    void submitContributions(items).then((result) => {
      activeHandoffRef.current = null;
      preparedHandoffIdRef.current = null;
      onHandoffSettled(handoff.id, result.ok ? undefined : result.error);
    });
  }, [contributions, handoff, onHandoffSettled, submitContributions, terminalInteractive]);

  useEffect(() => {
    if (!terminalInteractive || startupContributionIds.length === 0 || activeHandoffRef.current) return;
    const items = startupContributionIds
      .map((id) => contributions.find((contribution) => contribution.id === id))
      .filter((contribution): contribution is PlanContribution => Boolean(contribution));
    if (items.length !== startupContributionIds.length) return;
    activeHandoffRef.current = "scribe-startup";
    void submitContributions(items).then(() => {
      activeHandoffRef.current = null;
      setStartupContributionIds([]);
    });
  }, [contributions, startupContributionIds, submitContributions, terminalInteractive]);

  const showLaunchAnimation = writer.lifecycle === "starting" || operation === "starting";
  const startupUpdatedAtMs = writer.lifecycle === "starting" && writer.startup?.updatedAt
    ? Date.parse(writer.startup.updatedAt)
    : localStartupStartedAtMs;
  const [startupElapsedMs, setStartupElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (!showLaunchAnimation || startupUpdatedAtMs == null || !Number.isFinite(startupUpdatedAtMs)) {
      setStartupElapsedMs(null);
      return undefined;
    }
    const updateElapsed = () => {
      const elapsed = Date.now() - startupUpdatedAtMs;
      setStartupElapsedMs(elapsed >= 0 ? elapsed : null);
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [showLaunchAnimation, startupUpdatedAtMs]);

  useEffect(() => {
    if (!showLaunchAnimation) setLocalStartupStartedAtMs(null);
  }, [showLaunchAnimation]);

  const launchHarness = displayedRoute?.harness ?? writer.provider;
  const launchConfiguration = [
    launchHarness ? getHarnessBadgeLabel(launchHarness) : null,
    displayedRoute?.label ?? writer.model,
    displayedEffort ? `${planWriterEffortLabel(displayedEffort)} effort` : null,
    writer.codexAuthMode ? codexAuthModeLabel(writer.codexAuthMode) : null,
  ].filter((value): value is string => Boolean(value));
  const launchStepLabel = operation === "stopping"
    ? "Stopping"
    : writer.startup?.stage === "launching"
      ? "Connecting"
      : "Requesting";
  const launchStepMessage = operation === "stopping"
    ? "Abandoning this Scribe start and cleaning up its runtime…"
    : writer.startup?.stage === "launching"
      ? `Waiting for ${launchHarness ? getHarnessBadgeLabel(launchHarness) : "the Scribe"} to open its terminal…`
      : "Reserving a Scribe session for this plan…";
  const slowStartup = startupElapsedMs != null && startupElapsedMs >= SLOW_SCRIBE_START_MS;
  const showTerminal = Boolean(terminalSession && !showLaunchAnimation);

  useEffect(() => {
    const terminalId = writer.terminalId;
    if (!connected || !terminalFastLane || hidden || !showTerminal || !terminalId) return;
    wsRef.current?.send({
      type: "reconnect",
      sessionId: terminalId,
      lastSeq: 0,
      revive: false,
      replay: false,
    });
  }, [connected, hidden, showTerminal, terminalFastLane, writer.terminalId, wsRef]);
  const needsAbandon = writer.lifecycle === "not_running" && Boolean(writer.cleanupError && writer.generation);
  const errorNotice = activeTerminalOwnerIssue
    ? null
    : operationError
    ?? terminalError
    ?? (writer.cleanupError ? `Cleanup failed: ${writer.cleanupError}` : null)
    ?? (writer.startupError ? `Startup failed: ${writer.startupError}` : null)
    ?? (writer.synchronization.state === "sync_failed"
      ? `Sync failed: ${writer.synchronization.error ?? "retry the last plan publication"}`
      : null);
  const startControl = (
    <button
      type="button"
      aria-label={compact ? `Start ${PLAN_AGENT_LABEL}` : undefined}
      disabled={operationPending || !writer.editable || !selectionUsable}
      onClick={() => void start()}
      className={compact
        ? "tiller-square-button tiller-square-button--primary tiller-square-button--icon-label disabled:opacity-50"
        : "rounded bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"}
    >
      {compact ? (
        <>
          <PlayIcon className="size-3.5" weight="fill" aria-hidden="true" />
          <span>Start {PLAN_AGENT_LABEL}</span>
        </>
      ) : pendingContributions.length > 0
        ? `Start Scribe and share ${pendingContributions.length} ${pendingContributions.length === 1 ? "item" : "items"}`
        : "Start Scribe in Plan Mode"}
    </button>
  );
  return (
    <div className={`${hidden ? "hidden" : "flex"} h-full min-h-0 flex-col bg-kumo-base`}>
      {!compact && <div className="shrink-0 border-b border-kumo-line bg-kumo-recessed px-3 py-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 truncate text-xs text-kumo-subtle">
              Interactive Plan Mode{displayedRoute && ` · ${displayedRoute.label} · ${planWriterEffortLabel(displayedEffort)} reasoning`}
            </div>
            {writer.codexAuthMode && (
              <span className="shrink-0 rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
                {codexAuthModeLabel(writer.codexAuthMode)}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                disabled={!settingsAvailable}
                title={settingsAvailable ? "Repository Scribe model, reasoning effort, and Plan Format" : "Scribe Settings are loading"}
                className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50"
              >
                Scribe Settings
              </button>
            )}
            {writer.lifecycle === "not_running" && showTerminal && !needsAbandon ? (
              <button
                type="button"
                disabled={operationPending || !writer.editable || !selectionUsable}
                onClick={() => void start()}
                className="rounded bg-kumo-brand px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                {pendingContributions.length > 0
                  ? `Start Scribe and share ${pendingContributions.length}`
                  : "Start Scribe"}
              </button>
            ) : writer.lifecycle !== "not_running" || needsAbandon ? (
              <Tooltip
                content="Abandons this Scribe generation immediately. The saved plan and terminal history remain, and workload cleanup continues in the background."
                side="bottom"
                align="end"
                delay={250}
                render={(
                  <button
                    type="button"
                    aria-label="Abandon Scribe"
                    disabled={operationPending || !writer.generation}
                    onClick={() => void stop()}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-kumo-danger text-white transition-colors hover:bg-kumo-danger/85 disabled:cursor-not-allowed disabled:opacity-40"
                  />
                )}
              >
                <StopIcon aria-hidden="true" size={14} weight="fill" />
              </Tooltip>
            ) : null}
          </div>
        </div>
        {errorNotice && (
          <div role="alert" className="mt-1 text-xs text-kumo-danger">{errorNotice}</div>
        )}
        {!errorNotice && operationNotice && (
          <div role="status" className="mt-1 text-xs text-kumo-subtle">{operationNotice}</div>
        )}
      </div>}
      {compact && errorNotice && (
        <div role="alert" className="shrink-0 border-b border-kumo-line px-3 py-2 text-xs text-kumo-danger">
          {errorNotice}
        </div>
      )}
      {compact && !errorNotice && operationNotice && (
        <div role="status" className="shrink-0 border-b border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
          {operationNotice}
        </div>
      )}

      {activeTerminalOwnerIssue && (
        <div
          role="alert"
          data-testid="scribe-terminal-unavailable"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-kumo-line bg-kumo-warning/5 px-3 py-2"
        >
          <span className="min-w-0 text-xs text-kumo-danger">
            {activeTerminalOwnerIssue.message}
            {operationError && ` ${operationError}`}
            {ownerRecoveryError && ` Recovery check failed: ${ownerRecoveryError}`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={operationPending}
              onClick={retryTerminal}
              className="rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50"
            >
              Try again
            </button>
            <button
              type="button"
              disabled={operationPending}
              onClick={() => void checkAndRecoverTerminal()}
              className="rounded bg-kumo-brand px-2.5 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ownerRecoveryPending ? "Checking…" : "Check & recover"}
            </button>
          </div>
        </div>
      )}

      {!compact && pendingContributions.length > 0 && (
        <div data-testid="scribe-context-tray" className="max-h-44 shrink-0 overflow-y-auto border-b border-kumo-line bg-kumo-info/5 px-3 py-2">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-kumo-default">From reviewers</div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
              {pendingContributions.length} waiting
            </div>
          </div>
          {pendingContributions.map((contribution) => {
            const presentation = contributionPresentations.get(contribution.id);
            const queued = queuedContributionIds.has(contribution.id);
            return (
              <div key={contribution.id} className="mb-2 rounded border border-kumo-line bg-kumo-base px-2.5 py-2 last:mb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-kumo-default">
                      {presentation?.sourceLabel ?? "Shared plan context"}
                    </div>
                    {(presentation?.sourceDetail || contribution.sourcePlanVersion) && (
                      <div className="mt-0.5 truncate text-[10px] text-kumo-subtle">
                        {[presentation?.sourceDetail, contribution.sourcePlanVersion
                          ? `Plan v${contribution.sourcePlanVersion}`
                          : null].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    <div className="mt-1 line-clamp-2 text-xs text-kumo-subtle">{contribution.text}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {presentation?.canViewSource && onViewContributionSource && (
                      <ContributionAction
                        label="View conversation"
                        disabled={contributionPending}
                        onClick={() => onViewContributionSource(contribution.id)}
                      />
                    )}
                    {queued ? (
                      <span className="px-1.5 py-1 text-[11px] text-kumo-info">
                        {terminalInteractive && contributionPending ? "Sharing…" : "Waiting for Scribe"}
                      </span>
                    ) : terminalInteractive ? (
                      <ContributionAction
                        label={contributionPending ? "Sharing…" : "Share now"}
                        disabled={contributionPending}
                        onClick={() => void submitContributions([contribution])}
                      />
                    ) : (
                      <span className="px-1.5 py-1 text-[11px] text-kumo-subtle">Waiting for Scribe</span>
                    )}
                    <ContributionAction
                      label="Dismiss"
                      disabled={contributionPending || queued}
                      onClick={() => void dismissContribution(contribution)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showLaunchAnimation && (
        <div className="tiller-scribe-launch-surface flex min-h-0 flex-1 flex-col px-5 py-4">
          <h2 className="shrink-0 text-[14px] font-semibold text-kumo-strong">
            {operation === "stopping" ? `Stopping ${PLAN_AGENT_LABEL}` : `Starting ${PLAN_AGENT_LABEL}`}
          </h2>
          <p className="mt-1 shrink-0 text-[12px] leading-5 text-kumo-subtle">
            Preparing a live planning terminal.
            {startupElapsedMs != null && (
              <span data-testid="scribe-startup-elapsed" className="ml-1 tabular-nums">
                Waiting {formatScribeWaitTime(startupElapsedMs)}.
              </span>
            )}
          </p>
          {launchConfiguration.length > 0 && (
            <div className="tiller-launch-runtime-viewport" aria-label={launchConfiguration.join("; ")}>
              <div className="tiller-launch-runtime-line">
                <span>{launchConfiguration.join(" · ")}</span>
                <span className="tiller-launch-runtime-caret" aria-hidden="true" />
              </div>
            </div>
          )}
          <EnvironmentLaunchIllustration compact />
          <div
            data-testid="scribe-launch-status"
            className="tiller-launch-current-step tiller-launch-current-step--action shrink-0 border-t border-kumo-line pt-3 text-left"
          >
            <span className="tiller-launch-current-step-label">{launchStepLabel}</span>
            <span className="min-w-0 truncate text-[12px] text-kumo-subtle">
              Current: {launchStepMessage}
            </span>
            {writer.lifecycle === "starting" && (
              <button
                type="button"
                disabled={operationPending || !writer.generation}
                onClick={() => void stop()}
                className="tiller-launch-current-step-action rounded border border-kumo-danger/40 bg-kumo-base px-2.5 py-1.5 text-[12px] font-medium text-kumo-danger disabled:cursor-not-allowed disabled:opacity-40"
              >
                {operation === "stopping" ? "Abandoning…" : "Abandon start"}
              </button>
            )}
          </div>
          {slowStartup && operation !== "stopping" && (
            <p role="status" className="mt-3 shrink-0 text-[12px] leading-5 text-kumo-subtle">
              The Scribe has not connected yet. You can keep waiting or abandon this start.
            </p>
          )}
        </div>
      )}
      {showTerminal && terminalSession && (
        <div className="tiller-scribe-terminal-surface flex min-h-0 flex-1 flex-col">
          <TerminalView
            ref={termRef}
            session={terminalSession}
            hubUrl={hubUrl}
            fontSize={compact ? 14 : 12}
            updateLastSeq={updateLastSeq}
            interactive={terminalInteractive}
            metricsEnabled={terminalMetrics}
            visible={!hidden}
            onInput={sendInput}
            onPaste={writer.provider === "codex" ? pasteIntoCodex : undefined}
            onResize={(cols, rows, request) => {
              lastSizeRef.current = { cols, rows };
              sendControl("resize", { cols, rows }, request);
            }}
            onRecoveryState={handleRecoveryState}
          />
        </div>
      )}
      {compact && showTerminal && writer.lifecycle === "running" && (
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-kumo-line bg-kumo-recessed px-3">
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-kumo-subtle">
            <span
              className={`size-1.5 shrink-0 rotate-45 ${activeTerminalOwnerIssue
                ? "bg-kumo-danger"
                : "bg-[var(--paperwing-signal-live)]"}`}
              aria-hidden="true"
            />
            <span className="truncate">
              {activeTerminalOwnerIssue
                ? `${PLAN_AGENT_LABEL} terminal unavailable · history is read-only`
                : terminalInteractive
                  ? `${PLAN_AGENT_LABEL} is live · ready for input`
                  : `${PLAN_AGENT_LABEL} is live · reconnecting`}
            </span>
          </div>
          <button
            type="button"
            aria-label={`Stop ${PLAN_AGENT_LABEL}`}
            disabled={operationPending || !writer.generation}
            onClick={() => void stop()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 border border-kumo-danger/40 px-2.5 text-[12px] font-semibold text-kumo-danger hover:bg-kumo-danger-tint disabled:cursor-not-allowed disabled:opacity-40"
          >
            <StopIcon className="size-3" weight="fill" aria-hidden="true" />
            <span>Stop {PLAN_AGENT_LABEL}</span>
          </button>
        </div>
      )}
      {!showTerminal && writer.lifecycle === "not_running" && !showLaunchAnimation && (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center">
          <div className={compact ? "w-fit max-w-sm text-left" : "max-w-lg"}>
            <div className="text-sm font-medium text-kumo-default">{compact ? `Start ${PLAN_AGENT_LABEL}` : "Start an interactive Scribe session"}</div>
            <p className="mt-1 text-xs leading-5 text-kumo-subtle">
              {compact
                ? `${PLAN_AGENT_LABEL} reads this plan and helps refine it.`
                : "The Scribe uses the native provider TUI in Plan Mode to converse with you, show live harness output, and update this plan. Reviewers can advise and run Plan Skills without editing it."}
            </p>
            <div className={`mt-4 flex flex-wrap items-center gap-2 ${compact ? "justify-start" : "justify-center"}`}>
              {startControl}
              {canAddReviewer && onAddReviewer && (
                <button
                  type="button"
                  onClick={onAddReviewer}
                  className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
                >
                  + Reviewer
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {compact && showTerminal && writer.lifecycle === "not_running" && (
        <div className="flex shrink-0 items-center border-t border-kumo-line bg-kumo-base px-3 py-2">
          {needsAbandon ? (
            <button
              type="button"
              aria-label="Abandon Scribe"
              disabled={operationPending || !writer.generation}
              onClick={() => void stop()}
              className="tiller-square-button tiller-square-button--secondary tiller-square-button--icon-label text-kumo-danger disabled:opacity-50"
            >
              <StopIcon className="size-3.5" weight="fill" aria-hidden="true" />
              <span>Abandon {PLAN_AGENT_LABEL}</span>
            </button>
          ) : startControl}
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

export function formatContributionForScribe(
  contribution: PlanContribution,
  presentation?: PlanContributionPresentation,
): string {
  const metadata = [
    `Source: ${presentation?.sourceLabel ?? "Shared plan context"}`,
    ...(presentation?.sourceDetail ? [`Context: ${presentation.sourceDetail}`] : []),
    ...(contribution.sourcePlanVersion ? [`Plan version: ${contribution.sourcePlanVersion}`] : []),
  ];
  return [
    "## Context shared with the Scribe",
    ...metadata,
    "",
    contribution.text.trim(),
  ].join("\n");
}
