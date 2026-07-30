"use client";

import { CheckCircle2, FileText, Scale, X } from "lucide-react";
import React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ImpactSummary {
  editedInvoice: {
    id: string;
    invoice_number: string;
    supplier?: string;
    original_total: number;
    updated_total: number;
    original_quantity: number;
    updated_quantity: number;
  };
  rebalancedInvoices: Array<{
    id: string;
    invoice_number: string;
    supplier?: string;
    previous_total: number;
    updated_total: number;
    amount_difference: number;
  }>;
  productQuantityChanges: Array<{
    invoice_id: string;
    invoice_number: string;
    product_id: string;
    product_name: string;
    previous_quantity: number;
    updated_quantity: number;
    difference: number;
  }>;
  batchSummary: {
    invoices_rebalanced_count: number;
    total_quantity_adjusted: number;
    total_amount_adjusted: number;
  };
}

interface PurchaseAutoBalanceSummaryModalProps {
  summary: ImpactSummary | null;
  onClose: () => void;
  supplierNameMap?: Record<string, string>;
}

export function PurchaseAutoBalanceSummaryModal({
  summary,
  onClose,
  supplierNameMap = {},
}: PurchaseAutoBalanceSummaryModalProps) {
  if (!summary) return null;

  const { editedInvoice, rebalancedInvoices, productQuantityChanges, batchSummary } = summary;

  const resolveSupplier = (invNumber: string, fallback?: string) => {
    if (fallback && fallback.trim()) return fallback;
    return supplierNameMap[invNumber] || "Supplier";
  };

  return (
    <Dialog open={!!summary} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto bg-slate-50 p-6 flex flex-col gap-6">
        {/* Header */}
        <DialogHeader className="pb-4 border-b border-slate-200">
          <DialogTitle className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Scale className="h-6 w-6 text-indigo-600" />
            Purchase Auto Balance Summary
          </DialogTitle>
          <p className="text-xs text-slate-500 mt-1">
            Automatic batch rebalancing completed successfully. Summary of all changes below.
          </p>
        </DialogHeader>

        {/* SECTION 1: Edited Invoice */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <FileText className="h-4 w-4 text-indigo-500" />
              SECTION 1: Edited Invoice
            </h3>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 text-xs">
              Directly Edited
            </Badge>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 pt-2 text-xs">
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Invoice Number
              </span>
              <span className="font-bold text-slate-800 text-sm mt-0.5 block">
                {editedInvoice.invoice_number}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Supplier
              </span>
              <span className="font-semibold text-slate-700 text-xs mt-0.5 block truncate">
                {resolveSupplier(editedInvoice.invoice_number, editedInvoice.supplier)}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Original Total
              </span>
              <span className="font-mono text-slate-600 mt-0.5 block">
                ₹{editedInvoice.original_total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Updated Total
              </span>
              <span className="font-mono font-bold text-slate-900 mt-0.5 block">
                ₹{editedInvoice.updated_total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Original Quantity
              </span>
              <span className="font-mono text-slate-600 mt-0.5 block">
                {editedInvoice.original_quantity.toLocaleString()} units
              </span>
            </div>
            <div>
              <span className="text-slate-400 block font-medium uppercase tracking-wider text-[10px]">
                Updated Quantity
              </span>
              <span className="font-mono font-bold text-slate-900 mt-0.5 block">
                {editedInvoice.updated_quantity.toLocaleString()} units
              </span>
            </div>
          </div>
        </div>

        {/* SECTION 2: Automatically Rebalanced Invoices */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs space-y-3">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            SECTION 2: Automatically Rebalanced Invoices
          </h3>

          {rebalancedInvoices.length === 0 ? (
            <div className="py-6 text-center text-slate-500 bg-slate-50/70 rounded-lg border border-dashed border-slate-200 text-xs font-medium">
              No additional invoices required auto balancing.
            </div>
          ) : (
            <div className="overflow-x-auto border rounded-lg border-slate-200">
              <table className="w-full text-xs text-left text-slate-600 border-collapse">
                <thead className="bg-slate-50 font-medium text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="px-3.5 py-2.5">Invoice Number</th>
                    <th className="px-3.5 py-2.5">Supplier</th>
                    <th className="px-3.5 py-2.5 text-right">Previous Total</th>
                    <th className="px-3.5 py-2.5 text-right">Updated Total</th>
                    <th className="px-3.5 py-2.5 text-right">Amount Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rebalancedInvoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50/80">
                      <td className="px-3.5 py-2.5 font-semibold text-slate-800">
                        {inv.invoice_number}
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-600">
                        {resolveSupplier(inv.invoice_number, inv.supplier)}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono">
                        ₹{inv.previous_total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono font-semibold text-slate-900">
                        ₹{inv.updated_total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </td>
                      <td className={`px-3.5 py-2.5 text-right font-mono font-semibold ${
                        inv.amount_difference > 0
                          ? "text-emerald-600"
                          : inv.amount_difference < 0
                          ? "text-rose-600"
                          : "text-slate-500"
                      }`}>
                        {inv.amount_difference > 0 ? "+" : ""}
                        ₹{inv.amount_difference.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* SECTION 3: Product Quantity Changes */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs space-y-3">
          <h3 className="text-sm font-semibold text-slate-800">
            SECTION 3: Product Quantity Changes
          </h3>

          {productQuantityChanges.length === 0 ? (
            <div className="py-4 text-center text-slate-400 text-xs">
              No product quantity changes occurred.
            </div>
          ) : (
            <div className="overflow-x-auto border rounded-lg border-slate-200 max-h-48 overflow-y-auto">
              <table className="w-full text-xs text-left text-slate-600 border-collapse">
                <thead className="bg-slate-50 font-medium text-slate-500 border-b border-slate-200 sticky top-0">
                  <tr>
                    <th className="px-3.5 py-2.5">Invoice Number</th>
                    <th className="px-3.5 py-2.5">Product Name</th>
                    <th className="px-3.5 py-2.5 text-right">Previous Quantity</th>
                    <th className="px-3.5 py-2.5 text-right">Updated Quantity</th>
                    <th className="px-3.5 py-2.5 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {productQuantityChanges.map((change, idx) => (
                    <tr key={`${change.invoice_id}-${change.product_id}-${idx}`} className="hover:bg-slate-50/80">
                      <td className="px-3.5 py-2.5 font-medium text-slate-800">
                        {change.invoice_number}
                      </td>
                      <td className="px-3.5 py-2.5 text-slate-700 font-medium">
                        {change.product_name}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono">
                        {change.previous_quantity.toLocaleString()}
                      </td>
                      <td className="px-3.5 py-2.5 text-right font-mono font-semibold text-slate-900">
                        {change.updated_quantity.toLocaleString()}
                      </td>
                      <td className={`px-3.5 py-2.5 text-right font-mono font-semibold ${
                        change.difference > 0
                          ? "text-emerald-600"
                          : change.difference < 0
                          ? "text-rose-600"
                          : "text-slate-500"
                      }`}>
                        {change.difference > 0 ? "+" : ""}
                        {change.difference.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* SECTION 4: Batch Summary */}
        <div className="bg-indigo-900 text-white rounded-xl p-5 shadow-sm space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-200">
            SECTION 4: Batch Summary
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div className="bg-indigo-950/60 p-3 rounded-lg border border-indigo-800/50">
              <span className="text-indigo-300 block text-[11px]">Invoices Rebalanced</span>
              <span className="text-lg font-bold mt-0.5 block">
                {batchSummary.invoices_rebalanced_count} Invoices
              </span>
            </div>
            <div className="bg-indigo-950/60 p-3 rounded-lg border border-indigo-800/50">
              <span className="text-indigo-300 block text-[11px]">Total Quantity Adjusted</span>
              <span className="text-lg font-bold font-mono mt-0.5 block">
                {batchSummary.total_quantity_adjusted.toLocaleString()} units
              </span>
            </div>
            <div className="bg-indigo-950/60 p-3 rounded-lg border border-indigo-800/50">
              <span className="text-indigo-300 block text-[11px]">Total Amount Adjusted</span>
              <span className="text-lg font-bold font-mono mt-0.5 block">
                ₹{batchSummary.total_amount_adjusted.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="pt-2 border-t border-slate-200">
          <Button onClick={onClose} size="default" className="px-6 font-medium text-xs">
            Close Summary
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
