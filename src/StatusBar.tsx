import { useMemo } from "react";

interface StatusBarProps {
  connected: boolean;
  sessionActive?: boolean;
  pendingPermissions?: number;
}

export default function StatusBar({ connected, sessionActive = false, pendingPermissions = 0 }: StatusBarProps) {
  const status = useMemo(() => {
    if (!connected) {
      return {
        text: "Offline",
        dotColor: "bg-kumo-danger",
        textColor: "text-kumo-danger",
        isPulsing: false,
      };
    }

    if (!sessionActive) {
      return {
        text: "Session inactive",
        dotColor: "bg-kumo-fill",
        textColor: "text-kumo-subtle",
        isPulsing: false,
      };
    }

    if (pendingPermissions > 0) {
      return {
        text: `${pendingPermissions} permission${pendingPermissions > 1 ? "s" : ""} needed`,
        dotColor: "bg-kumo-warning",
        textColor: "text-kumo-warning",
        isPulsing: true,
      };
    }

    return {
      text: "Connected",
      dotColor: "bg-kumo-success",
      textColor: "text-kumo-success",
      isPulsing: false,
    };
  }, [connected, sessionActive, pendingPermissions]);

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-kumo-recessed border-t border-kumo-line">
      <div className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full ${status.dotColor} ${status.isPulsing ? "animate-pulse" : ""}`}
        />
        <span className={`text-xs ${status.textColor}`}>
          {status.text}
        </span>
      </div>
    </div>
  );
}
