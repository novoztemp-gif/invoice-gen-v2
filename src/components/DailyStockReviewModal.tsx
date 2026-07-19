import { AlertCircle } from "lucide-react";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface StockReviewRow {
  date: string;
  product_id: string;
  product_name: string;
  opening_stock: number;
  purchased_quantity: number;
  proposed_sold: number;
  remaining_stock: number;
  unit: string;
}

interface DailyStockReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialRows: StockReviewRow[];
  originalInvoices: any[];
  onSave: (adjustedInvoices: any[], finalReviewRows: StockReviewRow[]) => void;
  isSaving: boolean;
}

export function DailyStockReviewModal({
  isOpen,
  onClose,
  initialRows,
  originalInvoices,
  onSave,
  isSaving,
}: DailyStockReviewModalProps) {
  const [rows, setRows] = useState<StockReviewRow[]>([]);

  useEffect(() => {
    if (isOpen) {
      setRows(JSON.parse(JSON.stringify(initialRows)));
    }
  }, [isOpen, initialRows]);

  const handleQtyChange = (
    date: string,
    productId: string,
    newValue: string,
  ) => {
    const newQty = Math.max(0, parseFloat(newValue) || 0);

    const updatedRows = [...rows];
    const editedRowIndex = updatedRows.findIndex(
      (r) => r.date === date && r.product_id === productId,
    );
    if (editedRowIndex === -1) return;

    const productRows = updatedRows
      .map((r, idx) => ({ r, idx }))
      .filter((x) => x.r.product_id === productId)
      .sort((a, b) => a.r.date.localeCompare(b.r.date));

    const chronoIndex = productRows.findIndex((x) => x.idx === editedRowIndex);

    updatedRows[editedRowIndex].proposed_sold = newQty;

    for (let i = chronoIndex; i < productRows.length; i++) {
      const currentIdx = productRows[i].idx;
      const currentRow = updatedRows[currentIdx];

      if (i > chronoIndex) {
        const prevIdx = productRows[i - 1].idx;
        currentRow.opening_stock = updatedRows[prevIdx].remaining_stock;
      }

      currentRow.remaining_stock =
        Math.round(
          (currentRow.opening_stock +
            currentRow.purchased_quantity -
            currentRow.proposed_sold) *
            100,
        ) / 100;
    }

    setRows(updatedRows);
  };

  const checkRowInvalid = (row: StockReviewRow) => {
    return row.remaining_stock < 0 || row.remaining_stock > 15;
  };

  const isInvalid = rows.some((row) => checkRowInvalid(row));

  const handleSaveClick = () => {
    if (isInvalid) return;

    const targetMap = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.date}_${r.product_id}`;
      targetMap.set(key, r.proposed_sold);
    }

    const origSums = new Map<string, number>();
    for (const inv of originalInvoices) {
      for (const p of inv.products) {
        const key = `${inv.invoice_date}_${p.product_id}`;
        origSums.set(key, (origSums.get(key) || 0) + p.quantity);
      }
    }

    const adjustedInvoices = originalInvoices
      .map((inv) => {
        const updatedProducts = inv.products
          .map((p: any) => {
            const key = `${inv.invoice_date}_${p.product_id}`;
            const targetQty = targetMap.get(key);
            if (targetQty === undefined) return p;

            const origSum = origSums.get(key) || 0;
            if (origSum === 0) {
              return { ...p, quantity: 0, amount: 0 };
            }

            const newQty =
              Math.round(p.quantity * (targetQty / origSum) * 100) / 100;
            const newAmt = Math.round(newQty * p.rate * 100) / 100;
            return {
              ...p,
              quantity: newQty,
              amount: newAmt,
            };
          })
          .filter((p: any) => p.quantity > 0);

        const totalAmount =
          Math.round(
            updatedProducts.reduce((sum: number, p: any) => sum + p.amount, 0) *
              100,
          ) / 100;

        return {
          ...inv,
          products: updatedProducts,
          total_amount: totalAmount,
        };
      })
      .filter((inv) => inv.products.length > 0);

    onSave(adjustedInvoices, rows);
  };

  const sortedDates = [...new Set(rows.map((r) => r.date))].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[85vw] max-w-[85vw] sm:max-w-[85vw] h-[85vh] max-h-[85vh] sm:max-h-[85vh] flex flex-col p-6">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-slate-900">
            Daily Stock Review
          </DialogTitle>
          <p className="text-sm text-slate-500">
            Review and adjust proposed sales quantities. Changes will propagate
            downstream.
          </p>
        </DialogHeader>

        {isInvalid && (
          <div className="my-2 bg-red-50 text-red-950 border border-red-200 rounded-lg p-3 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
            <p className="text-sm text-red-800">
              One or more days have invalid remaining stock. Remaining Stock
              must be between 0 and 15 units (inclusive). Please correct them to
              continue.
            </p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto border rounded-lg border-slate-200 my-4">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-slate-50 text-slate-700 font-semibold uppercase text-xs sticky top-0 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3 text-right">Opening Stock</th>
                <th className="px-4 py-3 text-right">Purchased</th>
                <th className="px-4 py-3 text-center w-36">Proposed Sold</th>
                <th className="px-4 py-3 text-right">Remaining Stock</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {sortedDates.map((date) => {
                const dateRows = rows.filter((r) => r.date === date);
                return dateRows.map((row, idx) => {
                  const isRowInvalid = checkRowInvalid(row);
                  return (
                    <tr
                      key={`${row.date}_${row.product_id}`}
                      className={`hover:bg-slate-50 transition-colors ${
                        isRowInvalid ? "bg-red-50/70" : ""
                      }`}
                    >
                      {idx === 0 && (
                        <td
                          className="px-4 py-3 font-medium text-slate-900 align-top border-r border-slate-100"
                          rowSpan={dateRows.length}
                        >
                          {row.date}
                        </td>
                      )}
                      <td className="px-4 py-3 font-medium text-slate-700">
                        {row.product_name}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-600">
                        {row.opening_stock.toFixed(2)} {row.unit}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-slate-600">
                        {row.purchased_quantity.toFixed(2)} {row.unit}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            className={`w-28 text-center h-8 font-mono ${
                              isRowInvalid
                                ? "border-red-500 focus-visible:ring-red-500 bg-red-50"
                                : ""
                            }`}
                            value={row.proposed_sold}
                            onChange={(e) =>
                              handleQtyChange(
                                row.date,
                                row.product_id,
                                e.target.value,
                              )
                            }
                          />
                          <span className="text-xs text-slate-400 font-medium">
                            {row.unit}
                          </span>
                        </div>
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono font-bold ${
                          row.remaining_stock < 0
                            ? "text-red-600"
                            : "text-slate-900"
                        }`}
                      >
                        {row.remaining_stock.toFixed(2)} {row.unit}
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="flex items-center justify-end gap-2 pt-2 border-t">
          <Button variant="ghost" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveClick}
            disabled={isInvalid || isSaving}
            className="px-6"
          >
            {isSaving ? "Saving Batch..." : "Save & Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
