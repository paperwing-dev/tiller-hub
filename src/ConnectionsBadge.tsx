import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  EXECUTION_STATUS_CHANGED_EVENT,
  fetchExecutionStatus,
  type ExecutionStatus,
} from './api';

interface ConnectionsBadgeProps {
  hubUrl: string;
  hubConnected: boolean;
  hostRefreshNonce: number;
  showHost: boolean;
}

function truncateMid(value: string, max = 16): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function describeHostStatus(execution: ExecutionStatus | null, hostError: string | null): {
  title: string;
  detail: string;
  dotClassName: string;
} {
  if (hostError) {
    return {
      title: 'Machine: status unavailable',
      detail: 'Could not fetch execution status from the Hub.',
      dotClassName: 'bg-kumo-fill',
    };
  }

  const hostStatus = execution?.selected.target === 'host'
    ? execution.selectedHost
    : execution?.candidate ?? null;
  if (!hostStatus) {
    return {
      title: 'Machine: not connected',
      detail: 'No execution machine is connected to this Hub.',
      dotClassName: 'bg-kumo-fill',
    };
  }
  switch (hostStatus.state) {
    case 'offline': {
      const candidate = execution?.candidate;
      const candidateDetail = candidate
        && candidate.state !== 'not_connected'
        && candidate.machineId !== hostStatus.machineId
        ? candidate.state === 'ready'
          ? `${candidate.displayName} is connected but not selected.`
          : `${candidate.displayName} is connected but needs an update (${candidate.code.replaceAll('_', ' ')}).`
        : null;
      return {
        title: 'Machine: selected, offline',
        detail: [
          'The selected execution machine is offline.',
          candidateDetail,
        ].filter(Boolean).join(' '),
        dotClassName: 'bg-kumo-danger',
      };
    }
    case 'incompatible':
      return {
        title: 'Machine: update required',
        detail: `Update this execution machine (${hostStatus.code.replaceAll('_', ' ')}).`,
        dotClassName: 'bg-kumo-warning',
      };
    case 'ready':
      return {
        title: 'Machine: connected and ready',
        detail: `${hostStatus.displayName} is ready.`,
        dotClassName: 'bg-kumo-success',
      };
    case 'not_connected':
    default:
      return {
        title: 'Machine: not connected',
        detail: 'No execution machine is connected to this Hub.',
        dotClassName: 'bg-kumo-fill',
      };
  }
}

export default function ConnectionsBadge({
  hubUrl,
  hubConnected,
  hostRefreshNonce,
  showHost,
}: ConnectionsBadgeProps) {
  const [open, setOpen] = useState(false);
  const [execution, setExecution] = useState<ExecutionStatus | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const executionRevisionRef = useRef(0);

  useEffect(() => {
    if (!showHost) {
      setExecution(null);
      setHostError(null);
      return undefined;
    }
    let cancelled = false;
    const executionRevision = executionRevisionRef.current;
    fetchExecutionStatus(hubUrl)
      .then((status) => {
        if (cancelled || executionRevision !== executionRevisionRef.current) return;
        setExecution(status);
        setHostError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || executionRevision !== executionRevisionRef.current) return;
        setHostError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [hubUrl, hostRefreshNonce, showHost]);

  useEffect(() => {
    const handleExecutionStatusChanged = (event: Event) => {
      const status = (event as CustomEvent<ExecutionStatus>).detail;
      if (!status) return;
      executionRevisionRef.current += 1;
      setExecution(status);
      setHostError(null);
    };
    window.addEventListener(EXECUTION_STATUS_CHANGED_EVENT, handleExecutionStatusChanged);
    return () => {
      window.removeEventListener(EXECUTION_STATUS_CHANGED_EVENT, handleExecutionStatusChanged);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const hostState = describeHostStatus(execution, hostError);
  const showMachine = showHost && execution?.selected.target === 'host';

  const title = useMemo(() => {
    const hubText = hubConnected ? 'Hub: connected' : 'Hub: offline';
    if (!showMachine) return hubText;
    const hostText = hostState.title;
    return `${hubText} · ${hostText}`;
  }, [hubConnected, hostState.title, showMachine]);

  return (
    <div
      ref={rootRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={title}
        aria-expanded={open}
        className="tiller-connections-trigger inline-flex h-7 items-center gap-1.5 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle hover:bg-kumo-tint"
      >
        <span className="inline-flex items-center gap-1">
          <span
            className={`inline-block h-2 w-2 rounded-full ${hubConnected ? 'bg-kumo-success' : 'bg-kumo-danger'}`}
          />
          <span>Hub</span>
        </span>
        {showMachine && (
          <span className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-2 w-2 rounded-full ${hostState.dotClassName}`}
            />
            <span>Machine</span>
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute right-0 top-full mt-1 z-20 rounded-md border border-kumo-line bg-kumo-elevated shadow-lg text-left ${showMachine ? 'w-72' : 'w-max min-w-36'}`}
        >
          <div
            className={`px-3 py-2 ${showMachine ? 'border-b border-kumo-hairline' : ''}`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${hubConnected ? 'bg-kumo-success' : 'bg-kumo-danger'}`}
              />
              <span className="text-xs font-semibold text-kumo-default">Hub</span>
              <span className="ml-auto text-[11px] text-kumo-subtle">
                {hubConnected ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>

          {showMachine && (
            <div className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${hostState.dotClassName}`}
                />
                <span className="text-xs font-semibold text-kumo-default">Your machine</span>
              </div>
              <p className="mt-1 text-[11px] text-kumo-subtle">
                {hostState.detail}
              </p>

              <HostConnectionDetails
                execution={execution}
                hostError={hostError}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HostConnectionDetails({
  execution,
  hostError,
}: {
  execution: ExecutionStatus | null;
  hostError: string | null;
}) {
  const candidate = execution?.candidate ?? null;
  const machine = execution?.selectedHost
    ?? (candidate && candidate.state !== "not_connected" ? candidate : null);

  return (
    <>
      {machine && (
        <dl className="mt-2 space-y-1 text-[11px]">
          <div className="flex items-center gap-2">
            <dt className="w-20 text-kumo-subtle">Machine</dt>
            <dd
              className="flex-1 font-mono text-kumo-default truncate"
              title={machine.machineId}
            >
              {truncateMid(machine.machineId, 20)}
            </dd>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(machine.machineId);
              }}
              className="text-kumo-subtle hover:text-kumo-default"
              title="Copy machine id"
            >
              ⧉
            </button>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-20 text-kumo-subtle">Name</dt>
            <dd className="flex-1 truncate text-kumo-default">{machine.displayName}</dd>
          </div>
        </dl>
      )}

      {hostError && (
        <p className="mt-2 text-[11px] text-kumo-danger" title={hostError}>
          Could not fetch execution status.
        </p>
      )}
    </>
  );
}
