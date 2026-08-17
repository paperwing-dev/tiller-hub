import type { ReactNode } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}

export default function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  busyLabel = "Working…",
  busy = false,
  onOpenChange,
  onConfirm,
}: ConfirmationDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <Dialog className="tiller-dialog-shell w-full max-w-sm overflow-hidden p-0">
        <div className="tiller-dialog-header border-b border-kumo-line px-4 py-3">
          <Dialog.Title className="tiller-dialog-title text-sm font-semibold text-kumo-strong">
            {title}
          </Dialog.Title>
          <Dialog.Description className="tiller-dialog-description mt-1 text-xs leading-5 text-kumo-subtle">
            {description}
          </Dialog.Description>
        </div>
        <div className="tiller-dialog-footer flex justify-end gap-2 px-4 py-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
