import React from "react";
import { Loader } from "@cloudflare/kumo/components/loader";

interface LoadingIndicatorProps {
  label?: string;
  className?: string;
  size?: "sm" | "base" | "lg" | number;
}

export default function LoadingIndicator({
  label = "Loading",
  className = "",
  size = "base",
}: LoadingIndicatorProps) {
  return (
    <div className={`flex items-center justify-center text-kumo-subtle ${className}`.trim()}>
      <Loader size={size} aria-label={label} />
    </div>
  );
}
