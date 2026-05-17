import { createContext, useCallback, useContext, useState, useRef } from "react";
import type { ReactNode } from "react";

type ToastVariant = "info" | "success" | "warning" | "error";

interface ToastData {
  id: number;
  title: string;
  body?: string;
  variant: ToastVariant;
}

export type AddToast = (options: {
  title: string;
  body?: string;
  variant?: ToastVariant;
  duration?: number;
}) => void;

const ToastContext = createContext<AddToast | null>(null);

const TOAST_COLORS: Record<ToastVariant, string> = {
  info: "border-blue-200 bg-blue-50",
  success: "border-green-200 bg-green-50",
  warning: "border-amber-200 bg-amber-50",
  error: "border-red-200 bg-red-50",
};

const TOAST_TEXT: Record<ToastVariant, string> = {
  info: "text-blue-700",
  success: "text-green-700",
  warning: "text-amber-700",
  error: "text-red-700",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const nextId = useRef(0);

  const addToast: AddToast = useCallback(({ title, body, variant = "info", duration = 5000 }) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, title, body, variant }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      {/* Toast container */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-lg border px-4 py-3 shadow-lg animate-slide-in ${TOAST_COLORS[toast.variant]}`}
            role="status"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className={`text-sm font-medium ${TOAST_TEXT[toast.variant]}`}>
                  {toast.title}
                </p>
                {toast.body && (
                  <p className="text-xs text-[#57606a] mt-0.5">{toast.body}</p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeToast(toast.id);
                }}
                className="text-[#57606a] hover:text-[#24292f] text-sm leading-none flex-shrink-0"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): AddToast {
  const addToast = useContext(ToastContext);
  if (!addToast) throw new Error("useToast must be used within ToastProvider");
  return addToast;
}
