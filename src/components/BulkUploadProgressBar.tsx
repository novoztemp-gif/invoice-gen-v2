"use client";

interface BulkUploadProgressBarProps {
  current: number;
  total: number;
  label: string;
}

export function BulkUploadProgressBar({
  current,
  total,
  label,
}: BulkUploadProgressBarProps) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className="font-medium text-slate-700 tabular-nums">
          {current} / {total} ({pct}%)
        </span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-slate-800 transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
