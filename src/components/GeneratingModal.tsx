"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface GeneratingModalProps {
  open: boolean;
  label?: string;
}

export function GeneratingModal({
  open,
  label = "Generating invoice splitups",
}: GeneratingModalProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!open) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [open]);

  return (
    <Dialog open={open}>
      <DialogContent
        className="max-w-sm text-center"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <div className="flex flex-col items-center gap-4 py-6">
          <Loader2 className="h-10 w-10 animate-spin text-slate-700" />
          <div className="space-y-1">
            <p className="font-medium text-slate-800">{label}...</p>
            <p className="text-sm text-slate-500 font-mono">
              {elapsedSeconds}s elapsed
            </p>
          </div>
          <p className="text-xs text-slate-400 max-w-xs">
            This can take a little while for large batches. Please don't
            close this tab or click Generate again.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
