import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchHostStatus, type HostStatus } from './api';

interface ConnectionsBadgeProps {
  hubUrl: string;
  hubConnected: boolean;
  hostRefreshNonce: number;
  showHost: boolean;
}

function formatRelative(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diffMs = Math.max(0, now - t);
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function truncateMid(value: string, max = 16): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function describeHostStatus(hostStatus: HostStatus | null, hostError: string | null): {
  title: string;
  detail: string;
  dotClassName: string;
} {
  if (hostError) {
    return {
      title: 'Host: status unavailable',
      detail: 'Could not fetch host status from the hub.',
      dotClassName: 'bg-[#d0d7de]',
    };
  }

  switch (hostStatus?.state ?? 'not-registered') {
    case 'registered-offline':
      return {
        title: 'Host: registered, offline',
        detail: 'The hub still has a registered host, but the live connection is offline.',
        dotClassName: 'bg-red-500',
      };
    case 'connected-no-gateway':
      return {
        title: 'Host: connected, gateway not configured',
        detail: 'The host is connected, but it has not published a browser gateway.',
        dotClassName: 'bg-[#d4a72c]',
      };
    case 'gateway-unavailable':
      return {
        title: 'Host: connected, gateway unavailable',
        detail: 'The host is connected and has gateway config, but the live gateway is not available.',
        dotClassName: 'bg-[#d4a72c]',
      };
    case 'gateway-available':
      return {
        title: 'Host: connected, gateway available',
        detail: 'The host is connected and the published gateway is available.',
        dotClassName: 'bg-green-500',
      };
    case 'not-registered':
    default:
      return {
        title: 'Host: not registered',
        detail: 'No host machine has registered with this hub.',
        dotClassName: 'bg-[#d0d7de]',
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
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showHost) {
      setHostStatus(null);
      setHostError(null);
      return undefined;
    }
    let cancelled = false;
    fetchHostStatus(hubUrl)
      .then((status) => {
        if (cancelled) return;
        setHostStatus(status);
        setHostError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHostError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [hubUrl, hostRefreshNonce, showHost]);

  useEffect(() => {
    if (!open) return;
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(tick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!(e.target instanceof Node)) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDocClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const hostState = describeHostStatus(hostStatus, hostError);

  const title = useMemo(() => {
    const hubText = hubConnected ? 'Hub: connected' : 'Hub: offline';
    if (!showHost) return hubText;
    const hostText = hostState.title;
    return `${hubText} · ${hostText}`;
  }, [hubConnected, hostState.title, showHost]);

  return (
    <div ref={rootRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#57606a] hover:bg-[#eaeef2]"
      >
        <span className="inline-flex items-center gap-1">
          <span
            className={`inline-block h-2 w-2 rounded-full ${hubConnected ? 'bg-green-500' : 'bg-red-500'}`}
          />
          <span>Hub</span>
        </span>
        {showHost && (
          <span className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-2 w-2 rounded-full ${hostState.dotClassName}`}
            />
            <span>Host</span>
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-md border border-[#d0d7de] bg-white shadow-lg text-left">
          <div className="px-3 py-2 border-b border-[#eaeef2]">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${hubConnected ? 'bg-green-500' : 'bg-red-500'}`}
              />
              <span className="text-xs font-semibold text-[#24292f]">Hub</span>
              <span className="ml-auto text-[11px] text-[#57606a]">
                {hubConnected ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>

          {showHost && (
            <div className="px-3 py-2">
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${hostState.dotClassName}`}
                />
                <span className="text-xs font-semibold text-[#24292f]">Host</span>
              </div>
              <p className="mt-1 text-[11px] text-[#57606a]">
                {hostState.detail}
              </p>

              <HostConnectionDetails
                hostStatus={hostStatus}
                hostError={hostError}
                now={now}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HostConnectionDetails({
  hostStatus,
  hostError,
  now,
}: {
  hostStatus: HostStatus | null;
  hostError: string | null;
  now: number;
}) {
  const machine = hostStatus?.machine ?? null;

  return (
    <>
      {machine && (
        <dl className="mt-2 space-y-1 text-[11px]">
          <div className="flex items-center gap-2">
            <dt className="w-20 text-[#57606a]">Machine</dt>
            <dd
              className="flex-1 font-mono text-[#24292f] truncate"
              title={machine.machineId}
            >
              {truncateMid(machine.machineId, 20)}
            </dd>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(machine.machineId);
              }}
              className="text-[#57606a] hover:text-[#24292f]"
              title="Copy machine id"
            >
              ⧉
            </button>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-20 text-[#57606a]">Since</dt>
            <dd className="flex-1 text-[#24292f]" title={machine.connectedAt}>
              {formatRelative(machine.connectedAt, now)}
            </dd>
          </div>
        </dl>
      )}

      {hostError && (
        <p className="mt-2 text-[11px] text-red-600" title={hostError}>
          Could not fetch host status.
        </p>
      )}
    </>
  );
}
