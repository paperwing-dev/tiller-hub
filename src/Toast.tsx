import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  Toast,
  Toasty,
  useKumoToastManager,
} from "@cloudflare/kumo/components/toast";
import {
  CheckCircleIcon,
  InfoIcon,
  WarningIcon,
  WarningOctagonIcon,
} from "@phosphor-icons/react";

type ToastVariant = "info" | "success" | "warning" | "error";

const TOAST_ICONS = {
  info: InfoIcon,
  success: CheckCircleIcon,
  warning: WarningIcon,
  error: WarningOctagonIcon,
} satisfies Record<ToastVariant, typeof InfoIcon>;

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

  return useCallback(
    ({ title, body, variant = "info", duration = 5000 }) => {
      const Icon = TOAST_ICONS[variant];

      managerRef.current.add({
        title,
        description: body,
        variant,
        timeout: duration,
        content: (
          <div
            className="flex cursor-text select-text items-start gap-2"
            data-base-ui-swipe-ignore=""
          >
            <Icon
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
              data-toast-icon
              weight="fill"
            />
            <div className="flex flex-col gap-1 overflow-hidden">
              <Toast.Title
                className="text-[0.975rem] leading-5 font-medium text-kumo-default"
                data-toast-title
              />
              <Toast.Description className="text-[0.925rem] leading-5 text-kumo-default/70" />
            </div>
          </div>
        ),
      });
    },
    [],
  );
}
