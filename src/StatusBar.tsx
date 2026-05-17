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
        dotColor: "bg-red-500",
        textColor: "text-red-600",
        isPulsing: false,
      };
    }

    if (!sessionActive) {
      return {
        text: "Session inactive",
        dotColor: "bg-[#d0d7de]",
        textColor: "text-[#57606a]",
        isPulsing: false,
      };
    }

    if (pendingPermissions > 0) {
      return {
        text: `${pendingPermissions} permission${pendingPermissions > 1 ? "s" : ""} needed`,
        dotColor: "bg-amber-500",
        textColor: "text-amber-700",
        isPulsing: true,
      };
    }

    return {
      text: "Connected",
      dotColor: "bg-green-500",
      textColor: "text-green-700",
      isPulsing: false,
    };
  }, [connected, sessionActive, pendingPermissions]);

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[#f6f8fa] border-t border-[#d0d7de]">
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
