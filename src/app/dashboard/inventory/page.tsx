"use client";

import React, { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AnalyticsEngine,
  InventoryMetrics,
} from "@/lib/services/AnalyticsEngine";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2 } from "lucide-react";

export default function InventoryDashboardPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<InventoryMetrics | null>(null);

  useEffect(() => {
    async function loadMetrics() {
      setLoading(true);
      try {
        const data = await AnalyticsEngine.getInventoryMetrics(supabase);
        setMetrics(data);
      } catch (err) {
        console.error("Error loading inventory operational metrics:", err);
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, []);

  const formatCurrency = (val: number) => {
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-4 pb-10">
      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          Inventory Management
        </h1>
        <p className="text-slate-500 text-xs mt-0.5">
          Operational stock tracking, batch yields, carry forward ledger &
          movement log
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : metrics ? (
        <>
          {/* Numerical KPI Cards (6 Grid) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            {/* 1. Total Current Stock */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Total Current Stock
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {metrics.totalCurrentStock.toLocaleString("en-IN")} KG
                </div>
              </CardContent>
            </Card>

            {/* 2. Total Stock Value */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Total Stock Value
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.totalStockValue)}
                </div>
              </CardContent>
            </Card>

            {/* 3. Total Purchase Batches */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Active Batches
                </span>
                <div className="text-lg font-bold text-slate-900">
                  {metrics.activePurchaseBatchesCount}
                </div>
              </CardContent>
            </Card>

            {/* 4. Carry Forward Stock */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Carry Forward Stock
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {metrics.carryForwardStock.toLocaleString("en-IN")} KG
                </div>
              </CardContent>
            </Card>

            {/* 5. Products In Inventory */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Products In Inventory
                </span>
                <div className="text-lg font-bold text-slate-900">
                  {metrics.totalProductsCount}
                </div>
              </CardContent>
            </Card>

            {/* 6. Out of Stock Products */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Products Out of Stock
                </span>
                <div
                  className={`text-lg font-bold ${metrics.outOfStockProductsCount > 0 ? "text-red-700" : "text-slate-900"}`}
                >
                  {metrics.outOfStockProductsCount}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* TABLE 1: Purchase Batch Inventory */}
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Purchase Batch Inventory
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
                      <TableHead className="py-2 px-3 font-semibold text-slate-600">
                        Purchase Date
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                        Products
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Qty Purchased
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Qty Sold
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right font-bold">
                        Qty Remaining
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                        Status
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.purchaseBatchRows.map((row) => (
                      <TableRow
                        key={row.id}
                        className="border-b border-slate-100"
                      >
                        <TableCell className="py-2 px-3 font-mono font-bold text-slate-900">
                          {row.batch_number}
                        </TableCell>
                        <TableCell className="py-2 px-3 text-slate-500">
                          {row.purchase_date}
                        </TableCell>
                        <TableCell className="py-2 px-3 text-center font-medium text-slate-700">
                          {row.products_count}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-slate-800">
                          {row.qty_purchased.toLocaleString("en-IN")} KG
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-slate-800">
                          {row.qty_sold.toLocaleString("en-IN")} KG
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                          {row.qty_remaining.toLocaleString("en-IN")} KG
                        </TableCell>
                        <TableCell className="py-2 px-3 text-center">
                          {row.status === "Completed" ? (
                            <span className="px-2 py-0.5 rounded-xs bg-slate-100 text-slate-600 text-[10px] font-bold">
                              Completed
                            </span>
                          ) : row.status === "Active" ? (
                            <span className="px-2 py-0.5 rounded-xs bg-emerald-50 text-emerald-800 text-[10px] font-bold border border-emerald-200">
                              Active
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-xs bg-blue-50 text-blue-800 text-[10px] font-bold border border-blue-200">
                              New
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* TABLE 2 & 3: Carry Forward Stock & Product Inventory Ledger */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Carry Forward Inventory */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Carry Forward Inventory
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Month / Period
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Remaining Quantity
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                          Current Status
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.carryForwardRows.map((row, idx) => (
                        <TableRow
                          key={idx}
                          className="border-b border-slate-100"
                        >
                          <TableCell className="py-2 px-3 font-medium text-slate-900">
                            {row.month}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                            {row.remaining_qty.toLocaleString("en-IN")} KG
                          </TableCell>
                          <TableCell className="py-2 px-3 text-center">
                            <span className="px-2 py-0.5 rounded-xs bg-slate-100 text-slate-800 text-[10px] font-medium">
                              {row.status}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Product Inventory Ledger */}
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Product Inventory Ledger
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Product
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Opening
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Purchased
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Sold
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right font-bold">
                          Closing
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.productLedgerRows.map((row) => (
                        <TableRow
                          key={row.product_id}
                          className="border-b border-slate-100"
                        >
                          <TableCell className="py-2 px-3 font-medium text-slate-900">
                            {row.product_name}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right text-slate-600">
                            {row.opening_stock.toLocaleString("en-IN")}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right text-slate-600">
                            {row.purchased_qty.toLocaleString("en-IN")}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right text-slate-600">
                            {row.sold_qty.toLocaleString("en-IN")}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                            {row.closing_stock.toLocaleString("en-IN")}{" "}
                            {row.unit}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* TABLE 4: Inventory Movement Log */}
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Inventory Movement Log (Transaction History)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader className="bg-slate-50/70">
                    <TableRow className="border-b border-slate-200">
                      <TableHead className="py-2 px-3 font-semibold text-slate-600">
                        Date
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600">
                        Reference
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600">
                        Product
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Purchased (+)
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Sold (-)
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right font-bold">
                        Remaining Stock
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.movementLogs.map((log) => (
                      <TableRow
                        key={log.id}
                        className="border-b border-slate-100"
                      >
                        <TableCell className="py-2 px-3 text-slate-500 font-mono">
                          {log.date}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono font-medium text-slate-900">
                          {log.reference}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-medium text-slate-800">
                          {log.product_name}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-emerald-700 font-medium">
                          +{log.purchased_qty.toLocaleString("en-IN")}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                          -{log.sold_qty.toLocaleString("en-IN")}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                          {log.remaining_qty.toLocaleString("en-IN")} KG
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
