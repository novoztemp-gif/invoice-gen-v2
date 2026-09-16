"use client";

import { AlertCircle } from "lucide-react";
import { StockAllocationShortfall } from "@/lib/services/debtors-creditors/types";

interface ShortfallErrorPanelProps {
  shortfalls: StockAllocationShortfall[];
}

function formatAmount(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ShortfallErrorPanel({ shortfalls }: ShortfallErrorPanelProps) {
  if (shortfalls.length === 0) return null;

  return (
    <div className="p-4 bg-red-50 border border-red-200 rounded-lg space-y-3">
      <div className="flex items-start gap-2.5 text-red-700 text-sm font-medium">
        <AlertCircle className="h-5 w-5 shrink-0 text-red-600 mt-0.5" />
        <span>
          Not enough available stock to cover the configured amounts for{" "}
          {shortfalls.length} month/person combination
          {shortfalls.length > 1 ? "s" : ""}. Nothing was generated — reduce the
          total amount, select fewer months, or pick different people, then try
          again.
        </span>
      </div>
      <div className="max-h-64 overflow-auto rounded border border-red-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-red-100 text-red-800 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Person</th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-left px-3 py-2">Month</th>
              <th className="text-right px-3 py-2">Required</th>
              <th className="text-right px-3 py-2">Available</th>
              <th className="text-right px-3 py-2">Short By</th>
            </tr>
          </thead>
          <tbody>
            {shortfalls.map((s, idx) => (
              <tr key={idx} className="border-t border-red-100">
                <td className="px-3 py-1.5">{s.personName}</td>
                <td className="px-3 py-1.5 text-slate-500">{s.category}</td>
                <td className="px-3 py-1.5">{s.monthLabel}</td>
                <td className="px-3 py-1.5 text-right">₹{formatAmount(s.requiredAmount)}</td>
                <td className="px-3 py-1.5 text-right">₹{formatAmount(s.allocatedAmount)}</td>
                <td className="px-3 py-1.5 text-right text-red-600 font-medium">
                  ₹{formatAmount(s.shortfallAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
