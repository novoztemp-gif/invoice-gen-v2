import { AlertCircle, Check, CheckCircle2, DollarSign, HelpCircle, Package, Scale, Settings, SlidersHorizontal } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";

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
  onRowsChange?: (rows: StockReviewRow[]) => void;
}

export function DailyStockReviewModal({
  isOpen,
  onClose,
  initialRows,
  originalInvoices,
  onSave,
  isSaving,
  onRowsChange,
}: DailyStockReviewModalProps) {
  const [rows, setRows] = useState<StockReviewRow[]>([]);
  const [allocationMode, setAllocationMode] = useState<"NULL" | "AUTO_ALLOCATE">("NULL");
  const [isAutoConfigOpen, setIsAutoConfigOpen] = useState(false);
  const [targetClosingValueInput, setTargetClosingValueInput] = useState("19840");
  const [retainedProductIds, setRetainedProductIds] = useState<Set<string>>(new Set());

  // Initialize modal state ONCE when modal opens: allocationMode defaults to NULL
  useEffect(() => {
    if (isOpen) {
      setAllocationMode("NULL");
      const unallocated = JSON.parse(JSON.stringify(initialRows));
      setRows(unallocated);

      const allProductIds = new Set(initialRows.map((r) => r.product_id));
      setRetainedProductIds(allProductIds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── STEP 3: Average Purchase Price Calculation ──
  const productAvgPrices = useMemo(() => {
    const map = new Map<string, { avgPrice: number; totalQty: number; totalVal: number; name: string; unit: string }>();
    const productIds = [...new Set(initialRows.map((r) => r.product_id))];

    for (const pId of productIds) {
      const pRow = initialRows.find((r) => r.product_id === pId);
      const pName = pRow?.product_name || "Unknown Product";
      const pUnit = pRow?.unit || "kg";

      let totalVal = 0;
      let totalQty = 0;

      for (const inv of originalInvoices || []) {
        for (const item of inv.products || []) {
          if (item.product_id === pId || item.id === pId) {
            totalVal += Number(item.amount || 0);
            totalQty += Number(item.quantity || 0);
          }
        }
      }

      let avgPrice = 100;
      if (totalQty > 0) {
        avgPrice = Math.round((totalVal / totalQty) * 100) / 100;
      } else {
        const pRows = initialRows.filter((r) => r.product_id === pId);
        const avail = (Number(pRows[0]?.opening_stock) || 0) + pRows.reduce((s, r) => s + Number(r.purchased_quantity || 0), 0);
        totalQty = avail > 0 ? avail : 100;
        avgPrice = 100;
        totalVal = totalQty * avgPrice;
      }

      map.set(pId, { avgPrice, totalQty, totalVal, name: pName, unit: pUnit });
    }

    return map;
  }, [initialRows, originalInvoices]);

  // ── BOUNDED MULTI-STEP LOOKAHEAD RECONCILIATION ENGINE & STEP 4 PREVIEW ──
  const closingPreview = useMemo(() => {
    const targetValNum = parseFloat(targetClosingValueInput) || 0;
    const productIds = [...new Set(initialRows.map((r) => r.product_id))];

    const availableQuantities = new Map<string, number>();
    let totalRetainedMaxVal = 0;

    for (const pId of productIds) {
      const pRows = initialRows.filter((r) => r.product_id === pId);
      const initialOpening = Number(pRows[0]?.opening_stock || 0);
      const totalPurchased = pRows.reduce((s, r) => s + Number(r.purchased_quantity || 0), 0);
      const totalAvailable = initialOpening + totalPurchased;
      availableQuantities.set(pId, totalAvailable);

      if (retainedProductIds.has(pId)) {
        const price = productAvgPrices.get(pId)?.avgPrice || 100;
        totalRetainedMaxVal += totalAvailable * price;
      }
    }

    const previewMap = new Map<string, { closingQty: number; closingVal: number; maxQty: number; avgPrice: number; name: string; unit: string; isRetained: boolean }>();

    // Validation Check 1: Target > 0 and retained products exist and target <= max retained value
    if (targetValNum <= 0 || retainedProductIds.size === 0 || targetValNum > totalRetainedMaxVal + 0.01) {
      for (const pId of productIds) {
        const info = productAvgPrices.get(pId);
        previewMap.set(pId, {
          closingQty: 0,
          closingVal: 0,
          maxQty: availableQuantities.get(pId) || 0,
          avgPrice: info?.avgPrice || 100,
          name: info?.name || "Product",
          unit: info?.unit || "kg",
          isRetained: retainedProductIds.has(pId),
        });
      }
      return {
        previewMap,
        calculatedVal: 0,
        diff: targetValNum,
        totalRetainedMaxVal,
        totalClosingQty: 0,
        retainedCount: retainedProductIds.size,
        configuredPrecision: "0.25 kg",
        status: "TARGET_NOT_ACHIEVABLE" as const,
        statusMessage: targetValNum > totalRetainedMaxVal
          ? `Requested Target (₹${targetValNum.toLocaleString()}) exceeds total available retained stock value (₹${totalRetainedMaxVal.toLocaleString()}).`
          : retainedProductIds.size === 0
          ? "No products selected in Products To Retain."
          : "Please enter a valid Target Closing Stock Value greater than ₹0.",
      };
    }

    // 1. Initial Proportional Allocation
    const tempQuantities = new Map<string, number>();
    for (const pId of productIds) {
      if (!retainedProductIds.has(pId)) {
        tempQuantities.set(pId, 0);
      } else {
        const avail = availableQuantities.get(pId) || 0;
        const price = productAvgPrices.get(pId)?.avgPrice || 100;
        const maxValP = avail * price;
        const targetValP = targetValNum * (maxValP / (totalRetainedMaxVal || 1));
        let targetQty = roundToQuarterIncrement(targetValP / price);
        targetQty = Math.min(targetQty, avail);
        tempQuantities.set(pId, targetQty);
      }
    }

    const computeSum = () => {
      let sum = 0;
      for (const pId of retainedProductIds) {
        const qty = tempQuantities.get(pId) || 0;
        const price = productAvgPrices.get(pId)?.avgPrice || 100;
        sum += qty * price;
      }
      return Math.round(sum * 100) / 100;
    };

    // 2. Greedy 1-Step Optimization Loop
    let currentVal = computeSum();
    let currentDiff = targetValNum - currentVal;
    let maxIterations = 200;

    while (Math.abs(currentDiff) > 0.001 && maxIterations > 0) {
      maxIterations--;
      let bestPId: string | null = null;
      let bestError = Math.abs(currentDiff);

      if (currentDiff > 0) {
        for (const pId of retainedProductIds) {
          const curQty = tempQuantities.get(pId) || 0;
          const avail = availableQuantities.get(pId) || 0;
          if (curQty + 0.25 <= avail + 0.001) {
            const price = productAvgPrices.get(pId)?.avgPrice || 100;
            const testVal = currentVal + 0.25 * price;
            const testError = Math.abs(targetValNum - testVal);
            if (testError < bestError - 0.001) {
              bestError = testError;
              bestPId = pId;
            }
          }
        }
        if (bestPId) {
          const prev = tempQuantities.get(bestPId) || 0;
          tempQuantities.set(bestPId, roundToQuarterIncrement(prev + 0.25));
          currentVal = computeSum();
          currentDiff = targetValNum - currentVal;
        } else {
          break;
        }
      } else {
        for (const pId of retainedProductIds) {
          const curQty = tempQuantities.get(pId) || 0;
          if (curQty - 0.25 >= -0.001) {
            const price = productAvgPrices.get(pId)?.avgPrice || 100;
            const testVal = currentVal - 0.25 * price;
            const testError = Math.abs(targetValNum - testVal);
            if (testError < bestError - 0.001) {
              bestError = testError;
              bestPId = pId;
            }
          }
        }
        if (bestPId) {
          const prev = tempQuantities.get(bestPId) || 0;
          tempQuantities.set(bestPId, roundToQuarterIncrement(Math.max(0, prev - 0.25)));
          currentVal = computeSum();
          currentDiff = targetValNum - currentVal;
        } else {
          break;
        }
      }
    }

    // 3. Bounded Multi-Step Lookahead Search with Deterministic Tie-Breaking
    currentVal = computeSum();
    currentDiff = targetValNum - currentVal;

    if (Math.abs(currentDiff) > 0.001) {
      const retainedArr = Array.from(retainedProductIds);
      // Sort retained products descending by total monetary business impact (available stock * avg price)
      const sortedRetainedArr = [...retainedArr].sort((a, b) => {
        const priceA = productAvgPrices.get(a)?.avgPrice || 0;
        const availA = availableQuantities.get(a) || 0;
        const valA = priceA * availA;

        const priceB = productAvgPrices.get(b)?.avgPrice || 0;
        const availB = availableQuantities.get(b) || 0;
        const valB = priceB * availB;

        return valB - valA;
      });

      // Select top 4 candidate products with largest business impact for multi-step lookahead search
      const candidateProducts = sortedRetainedArr.length > 4 ? sortedRetainedArr.slice(0, 4) : sortedRetainedArr;
      const steps = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];

      let bestCombination: number[] | null = null;
      let minError = Math.abs(currentDiff);
      let evalCount = 0;
      const MAX_EVALUATIONS = 1000;

      const evaluateCombinations = (
        index: number,
        currentAdjustments: number[],
      ) => {
        if (evalCount >= MAX_EVALUATIONS) return;

        if (index === candidateProducts.length) {
          evalCount++;
          let testVal = 0;
          for (let i = 0; i < candidateProducts.length; i++) {
            const pId = candidateProducts[i];
            const curQty = tempQuantities.get(pId) || 0;
            const adj = currentAdjustments[i];
            const newQty = roundToQuarterIncrement(curQty + adj);
            const avail = availableQuantities.get(pId) || 0;
            if (newQty < 0 || newQty > avail) return;

            const price = productAvgPrices.get(pId)?.avgPrice || 100;
            testVal += newQty * price;
          }

          // Add unadjusted values for remaining products
          for (let i = candidateProducts.length; i < retainedArr.length; i++) {
            const pId = retainedArr[i];
            const curQty = tempQuantities.get(pId) || 0;
            const price = productAvgPrices.get(pId)?.avgPrice || 100;
            testVal += curQty * price;
          }

          testVal = Math.round(testVal * 100) / 100;
          const err = Math.abs(targetValNum - testVal);

          // Deterministic Tie-Breaking Hierarchy:
          // Priority 1 & 2: Exact Match / Smallest Difference
          // Priority 3: Fewest quantity adjustments
          // Priority 4: Smallest total quantity adjustment
          // Priority 5: Preserve original proportional allocation
          let isBetter = false;

          if (bestCombination === null) {
            isBetter = true;
          } else {
            const errDiff = err - minError;
            if (errDiff < -0.0001) {
              isBetter = true;
            } else if (Math.abs(errDiff) <= 0.0001) {
              const numAdjCur = currentAdjustments.filter((a) => Math.abs(a) > 0.001).length;
              const numAdjBest = bestCombination.filter((a) => Math.abs(a) > 0.001).length;

              if (numAdjCur < numAdjBest) {
                isBetter = true;
              } else if (numAdjCur === numAdjBest) {
                const totalQtyAdjCur = currentAdjustments.reduce((s, a) => s + Math.abs(a), 0);
                const totalQtyAdjBest = bestCombination.reduce((s, a) => s + Math.abs(a), 0);

                if (totalQtyAdjCur < totalQtyAdjBest - 0.001) {
                  isBetter = true;
                } else if (Math.abs(totalQtyAdjCur - totalQtyAdjBest) <= 0.001) {
                  const propDevCur = currentAdjustments.reduce((s, a) => s + a * a, 0);
                  const propDevBest = bestCombination.reduce((s, a) => s + a * a, 0);

                  if (propDevCur < propDevBest - 0.001) {
                    isBetter = true;
                  }
                }
              }
            }
          }

          if (isBetter) {
            minError = err;
            bestCombination = [...currentAdjustments];
          }
          return;
        }

        for (const step of steps) {
          currentAdjustments.push(step);
          evaluateCombinations(index + 1, currentAdjustments);
          currentAdjustments.pop();
          if (evalCount >= MAX_EVALUATIONS) break;
        }
      };

      evaluateCombinations(0, []);

      if (bestCombination) {
        for (let i = 0; i < candidateProducts.length; i++) {
          const pId = candidateProducts[i];
          const prev = tempQuantities.get(pId) || 0;
          const adj = (bestCombination as number[])[i];
          tempQuantities.set(pId, roundToQuarterIncrement(Math.max(0, prev + adj)));
        }
      }
    }

    const calculatedVal = computeSum();
    const diff = Math.abs(Math.round((targetValNum - calculatedVal) * 100) / 100);
    const status = diff === 0 ? ("EXACT_MATCH" as const) : ("CLOSEST_ACHIEVABLE" as const);

    let totalClosingQty = 0;
    for (const pId of productIds) {
      const info = productAvgPrices.get(pId);
      const isRetained = retainedProductIds.has(pId);
      const closingQty = isRetained ? tempQuantities.get(pId) || 0 : 0;
      const price = info?.avgPrice || 100;
      const closingVal = Math.round(closingQty * price * 100) / 100;

      totalClosingQty += closingQty;

      previewMap.set(pId, {
        closingQty,
        closingVal,
        maxQty: availableQuantities.get(pId) || 0,
        avgPrice: price,
        name: info?.name || "Product",
        unit: info?.unit || "kg",
        isRetained,
      });
    }

    return {
      previewMap,
      calculatedVal,
      diff,
      totalRetainedMaxVal,
      totalClosingQty,
      retainedCount: retainedProductIds.size,
      configuredPrecision: "0.25 kg",
      status,
      statusMessage: status === "EXACT_MATCH"
        ? "Target Closing Stock Value achieved exactly."
        : "Exact Target Value cannot be achieved using the configured quantity precision (0.25 kg). The closest achievable stock valuation has been generated.",
    };
  }, [initialRows, targetClosingValueInput, retainedProductIds, productAvgPrices]);

  // ── Intelligent Auto Allocation Algorithm (Gradual Consumption / Smooth Tapering) ──
  const performIntelligentAutoAllocation = () => {
    const updatedRows = JSON.parse(JSON.stringify(initialRows));
    const productIds = Array.from(
      new Set(updatedRows.map((r: any) => String(r.product_id))),
    ) as string[];

    for (const pId of productIds) {
      const pRows = updatedRows
        .filter((r: any) => r.product_id === pId)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));

      if (pRows.length === 0) continue;

      const targetClosingQty = closingPreview.previewMap.get(pId)?.closingQty || 0;
      const D = pRows.length;

      const initialOpening = Number(pRows[0].opening_stock) || 0;
      const totalPurchased = pRows.reduce(
        (sum: number, r: any) => sum + (Number(r.purchased_quantity) || 0),
        0,
      );
      const totalAvailable = initialOpening + totalPurchased;
      const totalToConsume = Math.max(0, totalAvailable - targetClosingQty);

      let runningCarry = initialOpening;

      pRows.forEach((row: any, idx: number) => {
        row.opening_stock = runningCarry;
        const available =
          Math.round(
            (row.opening_stock + Number(row.purchased_quantity)) * 100,
          ) / 100;

        if (idx === D - 1) {
          let proposed = Math.max(0, available - targetClosingQty);
          proposed = roundToQuarterIncrement(Math.min(proposed, available));
          row.proposed_sold = proposed;
          row.remaining_stock =
            Math.round((available - row.proposed_sold) * 100) / 100;
        } else {
          const remainingDaysFraction = (D - 1 - idx) / D;
          const targetRemForDay =
            targetClosingQty +
            roundToQuarterIncrement(totalToConsume * remainingDaysFraction);

          let proposed = Math.max(0, available - targetRemForDay);
          proposed = roundToQuarterIncrement(Math.min(proposed, available));

          row.proposed_sold = proposed;
          row.remaining_stock =
            Math.round((available - row.proposed_sold) * 100) / 100;
        }

        runningCarry = row.remaining_stock;
      });
    }

    setRows(updatedRows);
    setAllocationMode("AUTO_ALLOCATE");
    setIsAutoConfigOpen(false);
    onRowsChange?.(updatedRows);
  };

  const handleSetNullMode = () => {
    setAllocationMode("NULL");
    const unallocated = JSON.parse(JSON.stringify(initialRows));
    setRows(unallocated);
    onRowsChange?.(unallocated);
  };

  const handleQtyChange = (
    date: string,
    productId: string,
    newValue: string,
  ) => {
    const newQty = roundToQuarterIncrement(
      Math.max(0, parseFloat(newValue) || 0),
    );

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

    const editedRow = updatedRows[editedRowIndex];
    editedRow.proposed_sold = newQty;
    editedRow.remaining_stock =
      Math.round(
        (editedRow.opening_stock +
          editedRow.purchased_quantity -
          editedRow.proposed_sold) *
          100,
      ) / 100;

    for (let i = chronoIndex + 1; i < productRows.length; i++) {
      const currentIdx = productRows[i].idx;
      const prevIdx = productRows[i - 1].idx;
      const currentRow = updatedRows[currentIdx];

      currentRow.opening_stock = updatedRows[prevIdx].remaining_stock;
      const available =
        Math.round(
          (currentRow.opening_stock + currentRow.purchased_quantity) * 100,
        ) / 100;

      let proposedSold = Math.min(currentRow.proposed_sold, available);
      proposedSold = roundToQuarterIncrement(Math.max(0, proposedSold));

      currentRow.proposed_sold = proposedSold;
      currentRow.remaining_stock =
        Math.round((available - currentRow.proposed_sold) * 100) / 100;
    }

    setRows(updatedRows);
    onRowsChange?.(updatedRows);
  };

  const checkRowInvalid = (row: StockReviewRow) => {
    return row.remaining_stock < 0;
  };

  const isInvalid = rows.some((row) => checkRowInvalid(row));

  const finalProductSummaries = useMemo(() => {
    const productMap = new Map<
      string,
      { name: string; remaining: number; unit: string }
    >();

    const sortedDates = [...new Set(rows.map((r) => r.date))].sort();
    const lastDate = sortedDates[sortedDates.length - 1];

    if (lastDate) {
      const lastDayRows = rows.filter((r) => r.date === lastDate);
      for (const row of lastDayRows) {
        productMap.set(row.product_id, {
          name: row.product_name,
          remaining: row.remaining_stock,
          unit: row.unit,
        });
      }
    }

    return Array.from(productMap.values());
  }, [rows]);

  const toggleRetainedProduct = (pId: string) => {
    const next = new Set(retainedProductIds);
    if (next.has(pId)) {
      next.delete(pId);
    } else {
      next.add(pId);
    }
    setRetainedProductIds(next);
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[1100px] max-h-[90vh] flex flex-col p-6 bg-white rounded-xl">
          <DialogHeader className="pb-3 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
                <SlidersHorizontal className="h-5 w-5 text-indigo-600" />
                Daily Stock Ledger Review
              </DialogTitle>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Allocation Mode:
                </span>
                <span
                  className={`text-xs font-bold px-2.5 py-1 rounded-md border ${
                    allocationMode === "AUTO_ALLOCATE"
                      ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                      : "bg-slate-100 text-slate-700 border-slate-300"
                  }`}
                >
                  {allocationMode === "AUTO_ALLOCATE" ? "AUTO ALLOCATE" : "NULL (Default)"}
                </span>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Review and configure stock consumption. Initially mode is NULL. Select AUTO ALLOCATE to launch intelligent closing stock configuration.
            </p>
          </DialogHeader>

          {/* Allocation Mode Bar */}
          <div className="space-y-3 my-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* NULL Mode Toggle */}
              <div
                onClick={handleSetNullMode}
                className={`flex items-center justify-between border rounded-lg p-3 cursor-pointer transition-all ${
                  allocationMode === "NULL"
                    ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                    : "bg-slate-50 text-slate-900 border-slate-200 hover:bg-slate-100"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-4 w-4 rounded-full border flex items-center justify-center ${
                    allocationMode === "NULL" ? "border-white bg-white text-slate-900" : "border-slate-400"
                  }`}>
                    {allocationMode === "NULL" && <span className="h-2 w-2 rounded-full bg-slate-900" />}
                  </div>
                  <div>
                    <span className="text-sm font-bold block">Mode: NULL (Default)</span>
                    <span className={`text-xs ${allocationMode === "NULL" ? "text-slate-300" : "text-slate-500"}`}>
                      No automatic allocation. Preserves initial/manual values.
                    </span>
                  </div>
                </div>
              </div>

              {/* AUTO ALLOCATE Trigger */}
              <div
                onClick={() => setIsAutoConfigOpen(true)}
                className={`flex items-center justify-between border rounded-lg p-3 cursor-pointer transition-all ${
                  allocationMode === "AUTO_ALLOCATE"
                    ? "bg-indigo-900 text-white border-indigo-900 shadow-xs"
                    : "bg-indigo-50/60 text-slate-900 border-indigo-200 hover:bg-indigo-100/80"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-4 w-4 rounded-full border flex items-center justify-center ${
                    allocationMode === "AUTO_ALLOCATE" ? "border-white bg-white text-indigo-900" : "border-indigo-400"
                  }`}>
                    {allocationMode === "AUTO_ALLOCATE" && <span className="h-2 w-2 rounded-full bg-indigo-900" />}
                  </div>
                  <div>
                    <span className="text-sm font-bold block">Mode: AUTO ALLOCATE</span>
                    <span className={`text-xs ${allocationMode === "AUTO_ALLOCATE" ? "text-indigo-200" : "text-indigo-700"}`}>
                      Intelligent target closing stock value & gradual tapering.
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={allocationMode === "AUTO_ALLOCATE" ? "secondary" : "default"}
                  className="h-8 text-xs font-semibold"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsAutoConfigOpen(true);
                  }}
                >
                  <Settings className="w-3.5 h-3.5 mr-1" /> Configure
                </Button>
              </div>
            </div>

            {/* Live Remaining Stock Summary Panel */}
            <div className="bg-slate-900 text-white p-3.5 rounded-lg border border-slate-800 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Month-End Remaining Stock Summary (Final Day)
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  Updates Live
                </span>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {finalProductSummaries.map((p) => (
                  <div
                    key={p.name}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold border ${
                      p.remaining < 0
                        ? "bg-red-500/20 text-red-300 border-red-500/30"
                        : "bg-slate-800 text-slate-100 border-slate-700"
                    }`}
                  >
                    <span className="text-slate-300">{p.name}:</span>
                    <span
                      className={`font-mono text-sm ${
                        p.remaining < 0
                          ? "text-red-400 font-bold"
                          : "text-emerald-400 font-bold"
                      }`}
                    >
                      {p.remaining.toFixed(2)} {p.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {isInvalid && (
            <div className="my-2 bg-red-50 text-red-950 border border-red-200 rounded-lg p-3 flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />
              <p className="text-sm text-red-800">
                One or more items exceed available stock (Remaining Stock cannot be negative). Please reduce proposed sold quantities to continue.
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
                  <th className="px-4 py-3 text-right">Available</th>
                  <th className="px-4 py-3 text-center w-36">Proposed Sold</th>
                  <th className="px-4 py-3 text-right">Remaining Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono text-xs">
                {rows.map((row, idx) => {
                  const available =
                    Math.round(
                      (row.opening_stock + row.purchased_quantity) * 100,
                    ) / 100;
                  const rowInvalid = checkRowInvalid(row);

                  return (
                    <tr
                      key={`${row.date}-${row.product_id}-${idx}`}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        rowInvalid ? "bg-red-50/80" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 font-sans font-medium text-slate-900">
                        {row.date}
                      </td>
                      <td className="px-4 py-2.5 font-sans font-semibold text-slate-800">
                        {row.product_name}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">
                        {row.opening_stock.toFixed(2)} {row.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right text-slate-600">
                        {row.purchased_quantity.toFixed(2)} {row.unit}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-900">
                        {available.toFixed(2)} {row.unit}
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Input
                          type="number"
                          step="0.25"
                          min="0"
                          value={row.proposed_sold}
                          onChange={(e) =>
                            handleQtyChange(
                              row.date,
                              row.product_id,
                              e.target.value,
                            )
                          }
                          className="h-8 text-xs font-mono font-bold text-center w-28 mx-auto bg-white border-slate-300"
                        />
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-bold ${
                          rowInvalid ? "text-red-600" : "text-emerald-700"
                        }`}
                      >
                        {row.remaining_stock.toFixed(2)} {row.unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <DialogFooter className="pt-3 border-t border-slate-100 flex items-center justify-between">
            <div className="text-xs text-slate-500 font-medium">
              Mode: <span className="font-bold text-slate-900">{allocationMode}</span> | Rows: {rows.length}
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isSaving}
                className="h-9 px-4 text-xs"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => onSave(originalInvoices, rows)}
                disabled={isSaving || isInvalid}
                className="h-9 px-6 text-xs font-semibold"
              >
                {isSaving ? "Saving Batch..." : "Approve & Generate Invoices"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── AUTO ALLOCATE CONFIGURATION MODAL (STEPS 1-4 & RECONCILIATION SUMMARY) ── */}
      <Dialog open={isAutoConfigOpen} onOpenChange={setIsAutoConfigOpen}>
        <DialogContent className="sm:max-w-[850px] max-h-[88vh] flex flex-col p-6 bg-white rounded-xl">
          <DialogHeader className="pb-3 border-b border-slate-100">
            <DialogTitle className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Settings className="w-5 h-5 text-indigo-600" />
              AUTO ALLOCATE — Intelligent Stock Allocation & Reconciliation
            </DialogTitle>
            <p className="text-xs text-slate-500 mt-1">
              Configure Target Closing Stock Value and select Products To Retain. The Multi-Step Lookahead Reconciliation Engine optimizes stock values globally with deterministic tie-breaking.
            </p>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-5 py-3">
            {/* STEP 1: Target Closing Stock Value */}
            <div className="p-4 rounded-lg border border-indigo-200 bg-indigo-50/40 space-y-2">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-indigo-700" />
                <Label htmlFor="target-closing-val" className="font-bold text-sm text-indigo-950">
                  STEP 1: Target Closing Stock Value (End of Month) *
                </Label>
              </div>
              <p className="text-xs text-slate-600">
                Enter the <span className="font-bold text-indigo-900">TOTAL MONETARY VALUE (₹)</span> of stock that should remain after the final day of the month. (VALUE ONLY, not quantity).
              </p>
              <div className="flex items-center gap-2 w-64 pt-1">
                <span className="font-bold text-slate-700 text-sm">₹</span>
                <Input
                  id="target-closing-val"
                  type="number"
                  min="0"
                  step="100"
                  placeholder="e.g. 19840"
                  value={targetClosingValueInput}
                  onChange={(e) => setTargetClosingValueInput(e.target.value)}
                  className="h-9 bg-white font-mono font-bold text-slate-900 border-indigo-300"
                />
              </div>
            </div>

            {/* STEP 2: Products To Retain */}
            <div className="p-4 rounded-lg border border-slate-200 bg-white space-y-3">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-slate-700" />
                <span className="font-bold text-sm text-slate-900">
                  STEP 2: Products To Retain (Multi-Select)
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Check products allowed to remain in stock at month end. Unselected products naturally reduce to <span className="font-bold text-slate-900">0.00 kg</span> by month end.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {Array.from(productAvgPrices.entries()).map(([pId, info]) => {
                  const isChecked = retainedProductIds.has(pId);
                  return (
                    <div
                      key={pId}
                      onClick={() => toggleRetainedProduct(pId)}
                      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all ${
                        isChecked
                          ? "bg-emerald-50/80 border-emerald-300 text-emerald-950 font-semibold"
                          : "bg-slate-50 border-slate-200 text-slate-600 opacity-60"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                          isChecked ? "bg-emerald-600 border-emerald-600 text-white" : "border-slate-400 bg-white"
                        }`}>
                          {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                        <span className="text-xs font-semibold">{info.name}</span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">
                        ₹{info.avgPrice}/{info.unit}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* STEP 3: Average Purchase Price Table */}
            <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/60 space-y-2">
              <span className="font-bold text-xs uppercase tracking-wider text-slate-700 block">
                STEP 3: Average Purchase Price Table (Calculated from Purchase Invoices)
              </span>
              <div className="border rounded-md bg-white overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-100 text-slate-700 font-semibold border-b">
                    <tr>
                      <th className="p-2.5">Product</th>
                      <th className="p-2.5 text-right">Total Purchased Stock</th>
                      <th className="p-2.5 text-right">Total Purchase Value</th>
                      <th className="p-2.5 text-right font-bold text-slate-900">Average Purchase Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {Array.from(productAvgPrices.entries()).map(([pId, info]) => (
                      <tr key={pId}>
                        <td className="p-2.5 font-sans font-medium text-slate-900">{info.name}</td>
                        <td className="p-2.5 text-right">{info.totalQty.toFixed(2)} {info.unit}</td>
                        <td className="p-2.5 text-right">₹{info.totalVal.toLocaleString()}</td>
                        <td className="p-2.5 text-right font-bold text-indigo-700">₹{info.avgPrice}/{info.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* STEP 4: Estimated Closing Quantity Calculation & Preview */}
            <div className="p-4 rounded-lg border border-slate-200 bg-white space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-xs uppercase tracking-wider text-slate-900">
                  STEP 4: Estimated Closing Quantity Preview (Reconciled)
                </span>
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded border ${
                  closingPreview.status === "EXACT_MATCH"
                    ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                    : closingPreview.status === "CLOSEST_ACHIEVABLE"
                    ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                    : "bg-rose-50 text-rose-800 border-rose-200"
                }`}>
                  {closingPreview.status === "EXACT_MATCH" && "🟢 Exact Match"}
                  {closingPreview.status === "CLOSEST_ACHIEVABLE" && "🟢 Closest Achievable Value"}
                  {closingPreview.status === "TARGET_NOT_ACHIEVABLE" && "🔴 Target Not Achievable"}
                </span>
              </div>

              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-100 text-slate-700 font-semibold border-b">
                    <tr>
                      <th className="p-2.5">Product</th>
                      <th className="p-2.5">Status</th>
                      <th className="p-2.5 text-right">Avg Price</th>
                      <th className="p-2.5 text-right font-bold text-slate-900">Calculated Closing Qty</th>
                      <th className="p-2.5 text-right font-bold text-emerald-800">Calculated Closing Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {Array.from(closingPreview.previewMap.entries()).map(([pId, item]) => (
                      <tr key={pId} className={!item.isRetained ? "bg-slate-50/60 opacity-60" : ""}>
                        <td className="p-2.5 font-sans font-semibold text-slate-900">{item.name}</td>
                        <td className="p-2.5 font-sans">
                          {item.isRetained ? (
                            <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">Retained</span>
                          ) : (
                            <span className="text-[10px] font-bold bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded">0 kg Target</span>
                          )}
                        </td>
                        <td className="p-2.5 text-right">₹{item.avgPrice}/{item.unit}</td>
                        <td className="p-2.5 text-right font-bold text-slate-900">{item.closingQty.toFixed(2)} {item.unit}</td>
                        <td className="p-2.5 text-right font-bold text-emerald-700">₹{item.closingVal.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── LIVE RECONCILIATION SUMMARY CARD ── */}
              <div className="bg-slate-900 text-white rounded-xl p-4 space-y-3 border border-slate-800 shadow-md">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Scale className="w-4 h-4 text-emerald-400" />
                    <span className="font-bold text-xs uppercase tracking-wider text-slate-200">
                      Reconciliation Summary & Pre-Generation Validation
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-extrabold px-2.5 py-1 rounded-md border ${
                        closingPreview.status === "EXACT_MATCH"
                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                          : closingPreview.status === "CLOSEST_ACHIEVABLE"
                          ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                          : "bg-rose-500/20 text-rose-300 border-rose-500/40"
                      }`}
                    >
                      {closingPreview.status === "EXACT_MATCH" && "🟢 Exact Match"}
                      {closingPreview.status === "CLOSEST_ACHIEVABLE" && "🟢 Closest Achievable Value"}
                      {closingPreview.status === "TARGET_NOT_ACHIEVABLE" && "🔴 Target Not Achievable"}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2.5 text-xs font-mono">
                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Target Value</span>
                    <span className="text-sm font-bold text-white">₹{(parseFloat(targetClosingValueInput) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>

                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Calculated Value</span>
                    <span className="text-sm font-bold text-emerald-400">₹{closingPreview.calculatedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>

                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Difference</span>
                    <span className={`text-sm font-bold ${closingPreview.diff === 0 ? "text-emerald-400" : "text-amber-300"}`}>
                      ₹{closingPreview.diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>

                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Retained Products</span>
                    <span className="text-sm font-bold text-white">{closingPreview.retainedCount}</span>
                  </div>

                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Quantity Precision</span>
                    <span className="text-sm font-bold text-indigo-300">{closingPreview.configuredPrecision}</span>
                  </div>

                  <div className="bg-slate-800/80 p-2.5 rounded-lg border border-slate-700/60 col-span-2 sm:col-span-1">
                    <span className="text-[10px] font-sans font-semibold text-slate-400 block uppercase">Total Closing Qty</span>
                    <span className="text-sm font-bold text-indigo-300">{closingPreview.totalClosingQty.toFixed(2)} kg</span>
                  </div>
                </div>

                <div className="text-[11px] font-sans text-slate-300 flex items-start gap-1.5 pt-1">
                  <HelpCircle className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                  <p>{closingPreview.statusMessage}</p>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="pt-3 border-t border-slate-100 flex items-center justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsAutoConfigOpen(false)}
              className="h-9 px-4 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={performIntelligentAutoAllocation}
              disabled={closingPreview.status === "TARGET_NOT_ACHIEVABLE"}
              className="h-9 px-6 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700"
            >
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              Generate & Apply Auto Allocation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
