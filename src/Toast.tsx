import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";

type ToastVariant = "info" | "success" | "warning" | "error";

export type AddToast = (options: {
  title: string;
  body?: string;
  variant?: ToastVariant;
  duration?: number;
}) => void;

export function ToastProvider({ children }: { children: ReactNode }) {
  return <Toasty>{children}</Toasty>;
}

export function useToast(): AddToast {
  const manager = useKumoToastManager();
  const managerRef = useRef(manager);

  useEffect(() => {
    managerRef.current = manager;
  }, [manager]);

  return useCallback(({ title, body, variant = "info", duration = 5000 }) => {
    managerRef.current.add({
      title,
      description: body,
      variant,
      timeout: duration,
    });
  }, []);
}
