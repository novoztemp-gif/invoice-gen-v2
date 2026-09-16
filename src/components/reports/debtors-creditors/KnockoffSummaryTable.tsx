"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { PersonKnockoffSummary } from "@/lib/services/debtors-creditors/types";

interface KnockoffSummaryTableProps {
  summary: PersonKnockoffSummary[];
  debtorFinancialYear: string;
  creditorFinancialYear: string;
}

function formatAmount(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function KnockoffSummaryTable({
  summary,
  debtorFinancialYear,
  creditorFinancialYear,
}: KnockoffSummaryTableProps) {
  const grandDebtor = summary.reduce((s, r) => s + r.debtorTotal, 0);
  const grandCreditor = summary.reduce((s, r) => s + r.creditorTotal, 0);
  const grandKnockoff = grandDebtor - grandCreditor;

  return (
    <div className="overflow-auto border border-slate-200 rounded-lg">
      <Table>
        <TableHeader className="bg-slate-50">
          <TableRow>
            <TableHead>Company</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Debtor Total (FY {debtorFinancialYear})</TableHead>
            <TableHead className="text-right">
              Creditor Total (FY {creditorFinancialYear})
            </TableHead>
            <TableHead className="text-right">Knockoff</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.map((row) => (
            <TableRow key={row.personId}>
              <TableCell className="font-medium">{row.companyName}</TableCell>
              <TableCell className="text-slate-500">{row.category}</TableCell>
              <TableCell className="text-right">₹{formatAmount(row.debtorTotal)}</TableCell>
              <TableCell className="text-right">₹{formatAmount(row.creditorTotal)}</TableCell>
              <TableCell
                className={cn(
                  "text-right font-semibold",
                  row.knockoff >= 0 ? "text-green-600" : "text-red-600",
                )}
              >
                ₹{formatAmount(row.knockoff)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-6 px-4 py-2.5 bg-slate-800 text-white text-sm font-semibold">
        <span>Debtor Total: ₹{formatAmount(grandDebtor)}</span>
        <span>Creditor Total: ₹{formatAmount(grandCreditor)}</span>
        <span className={grandKnockoff >= 0 ? "text-green-400" : "text-red-400"}>
          Overall Knockoff: ₹{formatAmount(grandKnockoff)}
        </span>
      </div>
    </div>
  );
}
