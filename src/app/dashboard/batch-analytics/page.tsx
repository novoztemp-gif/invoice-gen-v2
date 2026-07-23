"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { fetchAllQueryRows } from "@/lib/supabase/fetchAll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Package, FileText, Loader2 } from "lucide-react";

export default function BatchAnalyticsPage() {
  const router = useRouter();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [purchaseAnalytics, setPurchaseAnalytics] = useState<any[]>([]);
  const [salesAnalytics, setSalesAnalytics] = useState<any[]>([]);

  useEffect(() => {
    async function loadBatchAnalytics() {
      setLoading(true);
      try {
        const [{ data: batches }, invoices, ledgerRows] = await Promise.all([
          supabase.from("invoice_batch").select("*"),
          fetchAllQueryRows((from, to) =>
            supabase.from("invoice").select("*").range(from, to),
          ),
          fetchAllQueryRows((from, to) =>
            supabase.from("daily_stock_ledger").select("*").range(from, to),
          ),
        ]);

        const allBatches = batches || [];
        const allInvoices = invoices || [];
        const allLedger = ledgerRows || [];

        const purchaseBatches = allBatches.filter(
          (b) => b.batch_type === "PURCHASE",
        );
        const salesBatches = allBatches.filter(
          (b) => b.batch_type === "SALES" || !b.batch_type,
        );

        // Map Purchase Batch Analytics
        const pAnalytics = purchaseBatches.map((pBatch) => {
          const batchId = pBatch.id;
          const pValue = Number(pBatch.total_amount || 0);
          const productsCount = (pBatch.products || []).length;

          // Ledger totals for this purchase batch
          const batchLedger = allLedger.filter(
            (l) => l.purchase_batch_id === batchId,
          );
          let totalPurchasedQty = 0;
          let totalSoldQty = 0;

          for (const l of batchLedger) {
            totalPurchasedQty += Number(l.purchased_quantity || 0);
            totalSoldQty += Number(l.sold_quantity || 0);
          }

          const remainingQty = Math.max(0, totalPurchasedQty - totalSoldQty);
          const utilizationPct =
            totalPurchasedQty > 0
              ? Math.min(
                  100,
                  Math.round((totalSoldQty / totalPurchasedQty) * 10000) / 100,
                )
              : 0;

          const linkedSalesBatches = salesBatches.filter(
            (s) => s.stock_source_batch_id === batchId,
          );

          return {
            id: batchId,
            batch_number: `PB-${batchId.slice(0, 8)}`,
            purchase_value: pValue,
            products_count: productsCount,
            total_purchased_qty: totalPurchasedQty,
            inventory_remaining: remainingQty,
            utilization_pct: utilizationPct,
            linked_sales_count: linkedSalesBatches.length,
            created_at: pBatch.created_at,
          };
        });

        // Map Sales Batch Analytics
        const sAnalytics = salesBatches.map((sBatch) => {
          const batchId = sBatch.id;
          const sInvoices = allInvoices.filter(
            (inv) => inv.invoice_batch_id === batchId,
          );
          const sValue = sInvoices.reduce(
            (sum, inv) => sum + Number(inv.total_amount || 0),
            0,
          );

          let qtySold = 0;
          const customerIds = new Set<string>();

          for (const inv of sInvoices) {
            for (const p of inv.products || []) {
              qtySold += Number(p.quantity || 0);
              if (p.customer_id) customerIds.add(p.customer_id);
            }
          }

          const parentPurchaseBatch = purchaseBatches.find(
            (p) => p.id === sBatch.stock_source_batch_id,
          );

          // Est Profit: Sales Value - (Percentage of Purchase Value allocated)
          let estProfit = 0;
          if (parentPurchaseBatch) {
            const pValue = Number(parentPurchaseBatch.total_amount || 0);
            const parentLedger = allLedger.filter(
              (l) => l.purchase_batch_id === parentPurchaseBatch.id,
            );
            let pTotalQty = 0;
            for (const l of parentLedger)
              pTotalQty += Number(l.purchased_quantity || 0);

            const costRatio = pTotalQty > 0 ? qtySold / pTotalQty : 0;
            const approxCost = pValue * costRatio;
            estProfit = sValue - approxCost;
          }

          return {
            id: batchId,
            batch_number: `SB-${batchId.slice(0, 8)}`,
            sales_value: sValue,
            qty_sold: qtySold,
            customers_count: customerIds.size,
            parent_purchase_batch_name: parentPurchaseBatch
              ? `PB-${parentPurchaseBatch.id.slice(0, 8)}`
              : "Direct Stock",
            estimated_profit: Math.round(estProfit * 100) / 100,
            created_at: sBatch.created_at,
          };
        });

        setPurchaseAnalytics(pAnalytics);
        setSalesAnalytics(sAnalytics);
      } catch (err) {
        console.error("Error loading batch analytics:", err);
      } finally {
        setLoading(false);
      }
    }

    loadBatchAnalytics();
  }, []);

  const formatCurrency = (val: number) => {
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-4 pb-10">
      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          Batch Lifecycle Analytics
        </h1>
        <p className="text-slate-500 text-xs mt-0.5">
          Audit complete batch lifespan from Purchase Procurement $\rightarrow$
          Stock Ledger $\rightarrow$ Sales Invoices
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : (
        <Tabs defaultValue="purchase" className="space-y-4">
          <TabsList className="bg-slate-100 border border-slate-200 p-1 rounded-md grid grid-cols-2 max-w-xs h-9">
            <TabsTrigger
              value="purchase"
              className="gap-1.5 font-medium text-xs rounded-xs"
            >
              <Package className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
              Purchase Batches
            </TabsTrigger>
            <TabsTrigger
              value="sales"
              className="gap-1.5 font-medium text-xs rounded-xs"
            >
              <FileText className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
              Sales Batches
            </TabsTrigger>
          </TabsList>

          {/* Purchase Batch Analytics */}
          <TabsContent value="purchase" className="space-y-4">
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Purchase Batch Inventory Yield & Sales Linkage
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Purchase Batch
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Purchase Value
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Products
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Total Purchased Qty
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Remaining Inventory
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Utilization Rate
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Linked Sales Batches
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {purchaseAnalytics.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                          onClick={() =>
                            router.push(`/invoice-batches/${b.id}`)
                          }
                        >
                          <TableCell className="py-2 px-3 font-mono font-bold text-slate-900">
                            {b.batch_number}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                            {formatCurrency(b.purchase_value)}
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center font-medium text-slate-700">
                            {b.products_count}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right text-slate-800">
                            {b.total_purchased_qty.toLocaleString("en-IN")} KG
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                            {b.inventory_remaining.toLocaleString("en-IN")} KG
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center">
                            <span className="px-2 py-0.5 rounded-sm bg-slate-100 text-slate-800 font-bold text-[10px]">
                              {b.utilization_pct}%
                            </span>
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center font-medium text-slate-800">
                            {b.linked_sales_count > 0 ? (
                              <span className="text-slate-900 font-semibold">
                                {b.linked_sales_count} Linked Batches
                              </span>
                            ) : (
                              <span className="text-slate-400">0 Batches</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Sales Batch Analytics */}
          <TabsContent value="sales" className="space-y-4">
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Sales Batch Performance & Yield Tracing
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Sales Batch
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Sales Revenue
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Quantity Sold
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Customers Served
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Purchase Batch Used
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Estimated Yield / Profit
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {salesAnalytics.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                          onClick={() =>
                            router.push(`/invoice-batches/${b.id}`)
                          }
                        >
                          <TableCell className="py-2 px-3 font-mono font-bold text-slate-900">
                            {b.batch_number}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                            {formatCurrency(b.sales_value)}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right text-slate-800">
                            {b.qty_sold.toLocaleString("en-IN")} KG
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center font-semibold text-slate-700">
                            {b.customers_count}
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center font-mono font-medium text-slate-700">
                            {b.parent_purchase_batch_name}
                          </TableCell>
                          <TableCell
                            className={`py-2 px-3 font-mono text-right font-bold ${b.estimated_profit >= 0 ? "text-slate-900" : "text-red-700"}`}
                          >
                            {formatCurrency(b.estimated_profit)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
