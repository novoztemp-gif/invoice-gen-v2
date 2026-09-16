"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DebtorCreditorPerson,
  StockAllocationLine,
} from "@/lib/services/debtors-creditors/types";

interface StockAllocationResultsTableProps {
  people: DebtorCreditorPerson[];
  lines: StockAllocationLine[];
}

export function StockAllocationResultsTable({
  people,
  lines,
}: StockAllocationResultsTableProps) {
  const personName = (id: string) =>
    people.find((p) => p.id === id)?.companyName ?? id;
  const personCategory = (id: string) =>
    people.find((p) => p.id === id)?.category ?? "";

  const sorted = [...lines].sort((a, b) => {
    const nameA = personName(a.personId);
    const nameB = personName(b.personId);
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    if (a.monthIndex !== b.monthIndex) return a.monthIndex - b.monthIndex;
    return a.description.localeCompare(b.description);
  });

  const grandQty = lines.reduce((s, l) => s + l.qty, 0);
  const grandAmount = lines.reduce((s, l) => s + l.amount, 0);

  return (
    <div className="overflow-auto border border-slate-200 rounded-lg max-h-[60vh]">
      <Table>
        <TableHeader className="sticky top-0 bg-slate-50 z-10">
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Month</TableHead>
            <TableHead>HSN</TableHead>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Amount (₹)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((line, idx) => (
            <TableRow key={`${line.personId}-${line.monthIndex}-${line.productIndex}-${idx}`}>
              <TableCell className="font-medium">{personName(line.personId)}</TableCell>
              <TableCell className="text-slate-500">{personCategory(line.personId)}</TableCell>
              <TableCell>{line.monthLabel}</TableCell>
              <TableCell className="font-mono text-xs">{line.hsnCode}</TableCell>
              <TableCell className="max-w-[260px] truncate" title={line.description}>
                {line.description}
              </TableCell>
              <TableCell className="text-right">
                {line.qty.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
              </TableCell>
              <TableCell className="text-right">
                {line.amount.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-6 px-4 py-2 bg-slate-800 text-white text-sm font-semibold">
        <span>
          Total Qty: {grandQty.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
        </span>
        <span>
          Total Amount: ₹
          {grandAmount.toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
      </div>
    </div>
  );
}
