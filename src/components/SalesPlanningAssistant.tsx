"use client";

import React, { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StockReviewRow } from "@/components/DailyStockReviewModal";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  TrendingUp,
  Package,
  ShieldCheck,
} from "lucide-react";

export interface SalesPlanningAssistantProps {
  selectedPurchaseBatch: any | null;
  purchaseBatchDetails: any | null;
  stockSummary: any[];
  formData: {
    totalAmount: string;
    minimumInvoiceAmount: string;
    maximumInvoiceAmount: string;
    invoiceDateFrom?: Date;
    invoiceDateTo?: Date;
    stockSourceBatchId?: string;
  };
  selectedCustomers: string[];
  majorCustomers: any[];
  selectedProducts: any[];
  reviewRows: StockReviewRow[];
  isLoadingSummary?: boolean;
}

export function SalesPlanningAssistant({
  selectedPurchaseBatch,
  purchaseBatchDetails,
  stockSummary,
  formData,
  selectedCustomers,
  majorCustomers,
  selectedProducts,
  reviewRows,
  isLoadingSummary,
}: SalesPlanningAssistantProps) {
  // 1. Purchase Batch Metrics
  const batchValue =
    purchaseBatchDetails?.total_amount ||
    selectedPurchaseBatch?.total_amount ||
    0;
  const batchDateFrom =
    purchaseBatchDetails?.invoice_date_from ||
    selectedPurchaseBatch?.invoice_date_from ||
    "";
  const batchDateTo =
    purchaseBatchDetails?.invoice_date_to ||
    selectedPurchaseBatch?.invoice_date_to ||
    "";

  const totalPurchasedQty = useMemo(() => {
    return stockSummary.reduce(
      (sum, item) =>
        sum + (Number(item.purchased || item.total_available) || 0),
      0,
    );
  }, [stockSummary]);

  const totalProductsInBatch =
    purchaseBatchDetails?.products_count ||
    stockSummary.length ||
    selectedPurchaseBatch?.products?.length ||
    0;

  // 2. Sales Summary Metrics
  const targetSalesAmount = parseFloat(formData.totalAmount) || 0;
  const minInvoiceAmt = parseFloat(formData.minimumInvoiceAmount) || 0;
  const maxInvoiceAmt = parseFloat(formData.maximumInvoiceAmount) || 0;

  const estimatedSalesInvoiceCount = useMemo(() => {
    if (!targetSalesAmount || targetSalesAmount <= 0) return 0;
    if (minInvoiceAmt > 0 && maxInvoiceAmt > 0) {
      const avg = (minInvoiceAmt + maxInvoiceAmt) / 2;
      return Math.round(targetSalesAmount / avg);
    }
    return 1;
  }, [targetSalesAmount, minInvoiceAmt, maxInvoiceAmt]);

  const selectedCustomersCount =
    (selectedCustomers?.length || 0) + (majorCustomers?.length || 0);
  const selectedProductsCount = selectedProducts?.length || 0;

  // 3. Inventory Coverage & Health (Realtime Synced with reviewRows)
  const allocatedToSales = useMemo(() => {
    if (reviewRows && reviewRows.length > 0) {
      return reviewRows.reduce(
        (sum, row) => sum + (Number(row.proposed_sold) || 0),
        0,
      );
    }
    return 0;
  }, [reviewRows]);

  const remainingAfterSales = Math.max(
    0,
    Math.round((totalPurchasedQty - allocatedToSales) * 100) / 100,
  );

  const inventoryUtilizationPct = useMemo(() => {
    if (totalPurchasedQty <= 0) return 0;
    const raw = (allocatedToSales / totalPurchasedQty) * 100;
    return Math.min(100, Math.round(raw * 100) / 100);
  }, [allocatedToSales, totalPurchasedQty]);

  const estimatedClosingStock = remainingAfterSales;
  const carryForwardStock = remainingAfterSales;

  // Product Consumption breakdown
  const { fullyConsumedCount, carryingForwardCount } = useMemo(() => {
    if (!reviewRows || reviewRows.length === 0) {
      return {
        fullyConsumedCount: 0,
        carryingForwardCount: stockSummary.length,
      };
    }

    const productRemainingMap = new Map<string, number>();
    for (const r of reviewRows) {
      productRemainingMap.set(r.product_id, r.remaining_stock);
    }

    let fullyConsumed = 0;
    let carryingForward = 0;

    for (const [, remaining] of productRemainingMap.entries()) {
      if (remaining <= 15) {
        fullyConsumed++;
      } else {
        carryingForward++;
      }
    }

    return {
      fullyConsumedCount: fullyConsumed,
      carryingForwardCount: carryingForward,
    };
  }, [reviewRows, stockSummary.length]);

  // 4. Sales Value Validation
  const { minAchievableSales, maxAchievableSales } = useMemo(() => {
    let minSales = 0;
    let maxSales = 0;

    for (const prod of selectedProducts) {
      const pId = prod.product_id || prod.product?.id;
      const summaryItem = stockSummary.find((s) => s.product_id === pId);
      const availQty =
        Number(summaryItem?.total_available || summaryItem?.purchased) || 0;

      const minRate = parseFloat(prod.perDayRateMin) || 0;
      const maxRate = parseFloat(prod.perDayRateMax) || 0;

      minSales += availQty * minRate;
      maxSales += availQty * maxRate;
    }

    return {
      minAchievableSales: Math.round(minSales * 100) / 100,
      maxAchievableSales: Math.round(maxSales * 100) / 100,
    };
  }, [selectedProducts, stockSummary]);

  const isTargetAchievable = useMemo(() => {
    if (!targetSalesAmount || targetSalesAmount <= 0) return true;
    if (maxAchievableSales > 0 && targetSalesAmount > maxAchievableSales) {
      return false;
    }
    return true;
  }, [targetSalesAmount, maxAchievableSales]);

  // 5. Validation Badge Determination
  const overallBadge = useMemo(() => {
    if (!formData.stockSourceBatchId) {
      return {
        label: "Select Purchase Batch",
        color: "bg-slate-100 text-slate-700 border-slate-300",
        icon: Info,
      };
    }

    if (!isTargetAchievable) {
      return {
        label: "Target Sales Amount Not Achievable",
        color: "bg-red-50 text-red-800 border-red-200",
        icon: XCircle,
      };
    }

    if (allocatedToSales > totalPurchasedQty && totalPurchasedQty > 0) {
      return {
        label: "Insufficient Inventory",
        color: "bg-red-50 text-red-800 border-red-200",
        icon: XCircle,
      };
    }

    if (
      inventoryUtilizationPct > 95 ||
      (totalPurchasedQty > 0 && remainingAfterSales < totalPurchasedQty * 0.05)
    ) {
      return {
        label: "Low Remaining Stock",
        color: "bg-amber-50 text-amber-800 border-amber-200",
        icon: AlertTriangle,
      };
    }

    return {
      label: "Ready to Generate",
      color: "bg-emerald-50 text-emerald-800 border-emerald-200",
      icon: CheckCircle2,
    };
  }, [
    formData.stockSourceBatchId,
    isTargetAchievable,
    allocatedToSales,
    totalPurchasedQty,
    inventoryUtilizationPct,
    remainingAfterSales,
  ]);

  const BadgeIcon = overallBadge.icon;

  const formatDateStr = (dateStr: string) => {
    if (!dateStr) return "N/A";
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-3 my-4">
      <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
        <CardHeader className="p-3.5 pb-2.5 border-b border-slate-100 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-slate-600 stroke-[1.5]" />
              Sales Planning Assistant
            </CardTitle>
          </div>

          <div
            className={cn(
              "px-2.5 py-1 rounded-md border text-xs font-medium flex items-center gap-1.5",
              overallBadge.color,
            )}
          >
            <BadgeIcon className="w-3.5 h-3.5 stroke-[1.5]" />
            <span>{overallBadge.label}</span>
          </div>
        </CardHeader>

        <CardContent className="p-3.5 space-y-4">
          {/* Main Metrics Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            {/* Sales Summary */}
            <div className="p-3 bg-slate-50/70 rounded-md border border-slate-200/80 space-y-1.5">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                Sales Summary
              </span>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Target Amount:</span>
                  <span className="font-mono font-bold text-slate-900">
                    ₹
                    {targetSalesAmount.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Est. Invoices:</span>
                  <span className="font-medium text-slate-800">
                    {estimatedSalesInvoiceCount}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Customers:</span>
                  <span className="font-medium text-slate-800">
                    {selectedCustomersCount}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Products:</span>
                  <span className="font-medium text-slate-800">
                    {selectedProductsCount}
                  </span>
                </div>
              </div>
            </div>

            {/* Purchase Batch Summary */}
            <div className="p-3 bg-slate-50/70 rounded-md border border-slate-200/80 space-y-1.5">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                Purchase Batch
              </span>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Batch Value:</span>
                  <span className="font-mono font-bold text-slate-900">
                    ₹
                    {batchValue.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Date Range:</span>
                  <span className="font-medium text-slate-800 text-[11px]">
                    {batchDateFrom
                      ? `${formatDateStr(batchDateFrom)} - ${formatDateStr(batchDateTo)}`
                      : "Not Selected"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Purchased Qty:</span>
                  <span className="font-mono font-semibold text-slate-800">
                    {totalPurchasedQty.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Total Products:</span>
                  <span className="font-medium text-slate-800">
                    {totalProductsInBatch}
                  </span>
                </div>
              </div>
            </div>

            {/* Inventory Coverage */}
            <div className="p-3 bg-slate-50/70 rounded-md border border-slate-200/80 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Inventory Coverage
                </span>
                <span className="text-[10px] font-bold text-slate-700 bg-slate-200 px-1.5 py-0.5 rounded-sm">
                  {inventoryUtilizationPct}%
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Purchased Qty:</span>
                  <span className="font-mono font-medium text-slate-800">
                    {totalPurchasedQty.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Allocated Sales:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {allocatedToSales.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Remaining Stock:</span>
                  <span className="font-mono font-semibold text-slate-900">
                    {remainingAfterSales.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="w-full bg-slate-200 rounded-xs h-1 mt-1 overflow-hidden">
                  <div
                    className={cn(
                      "h-full transition-all duration-300",
                      inventoryUtilizationPct > 95
                        ? "bg-amber-600"
                        : "bg-slate-700",
                    )}
                    style={{
                      width: `${Math.min(100, inventoryUtilizationPct)}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Inventory Health */}
            <div className="p-3 bg-slate-50/70 rounded-md border border-slate-200/80 space-y-1.5">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                Inventory Health
              </span>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Est. Closing Stock:</span>
                  <span className="font-mono font-medium text-slate-800">
                    {estimatedClosingStock.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Carry Forward:</span>
                  <span className="font-mono font-medium text-slate-800">
                    {carryForwardStock.toLocaleString("en-IN")} KG
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Fully Consumed:</span>
                  <span className="font-medium text-slate-800">
                    {fullyConsumedCount} Products
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Carrying Forward:</span>
                  <span className="font-medium text-slate-800">
                    {carryingForwardCount} Products
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Target Validation Section */}
          <div className="p-3 bg-slate-100/70 rounded-md border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <div>
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Target Sales Amount
                </span>
                <span className="font-mono font-bold text-sm text-slate-900">
                  ₹
                  {targetSalesAmount.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <span className="text-slate-300">|</span>
              <div>
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Est. Achievable Range
                </span>
                <span className="font-mono text-slate-700 font-semibold">
                  ₹{minAchievableSales.toLocaleString("en-IN")} ↓ ₹
                  {maxAchievableSales.toLocaleString("en-IN")}
                </span>
              </div>
            </div>

            <div>
              {isTargetAchievable ? (
                <span className="px-2.5 py-1 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-md font-semibold text-xs inline-block">
                  ✓ VALID TARGET
                </span>
              ) : (
                <span className="px-2.5 py-1 bg-red-50 text-red-800 border border-red-200 rounded-md font-semibold text-xs inline-block">
                  ❌ Target Sales Amount exceeds estimated inventory capacity.
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
