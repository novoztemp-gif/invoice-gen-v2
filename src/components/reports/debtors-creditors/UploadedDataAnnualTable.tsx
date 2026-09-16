"use client";

import { AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PartnerCategory, ResolvedSplitUpProduct } from "@/lib/services/debtors-creditors/types";

interface UploadedDataAnnualTableProps {
  products: ResolvedSplitUpProduct[];
  onCategoryChange: (productIndex: number, category: PartnerCategory) => void;
}

export function UploadedDataAnnualTable({
  products,
  onCategoryChange,
}: UploadedDataAnnualTableProps) {
  const unmatchedCount = products.filter((p) => p.category === null).length;

  return (
    <div className="space-y-3">
      {unmatchedCount > 0 && (
        <div className="flex items-start gap-2.5 p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <span>
            {unmatchedCount} product{unmatchedCount > 1 ? "s" : ""} couldn&apos;t be
            matched to the Products catalog — pick Meat or Fruits for each below
            before continuing.
          </span>
        </div>
      )}
      <div className="overflow-auto border border-slate-200 rounded-lg max-h-[50vh]">
        <Table>
          <TableHeader className="sticky top-0 bg-slate-50 z-10">
            <TableRow>
              <TableHead>HSN Code</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>UQC</TableHead>
              <TableHead className="text-right">Total Qty</TableHead>
              <TableHead className="text-right">Taxable Value (₹)</TableHead>
              <TableHead>Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p, idx) => (
              <TableRow key={`${p.hsnCode}-${idx}`}>
                <TableCell className="font-mono text-xs">{p.hsnCode}</TableCell>
                <TableCell className="max-w-[320px] truncate" title={p.description}>
                  {p.description}
                </TableCell>
                <TableCell>{p.uqc}</TableCell>
                <TableCell className="text-right">
                  {p.totalQuantity.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </TableCell>
                <TableCell className="text-right">
                  {p.taxableValue.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </TableCell>
                <TableCell>
                  {p.category === null ? (
                    <Select
                      value={undefined}
                      onValueChange={(v) => onCategoryChange(idx, v as PartnerCategory)}
                    >
                      <SelectTrigger className="h-8 w-[110px] border-amber-400">
                        <SelectValue placeholder="Choose..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Meat">Meat</SelectItem>
                        <SelectItem value="Fruits">Fruits</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-sm text-slate-600">
                      {p.category}
                      {p.categorySource === "manual" && (
                        <span className="text-xs text-slate-400"> (manual)</span>
                      )}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
