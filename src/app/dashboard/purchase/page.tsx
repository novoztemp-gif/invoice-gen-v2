"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AnalyticsEngine,
  PurchaseMetrics,
} from "@/lib/services/AnalyticsEngine";
import {
  GlobalFilterHeader,
  GlobalFilterState,
} from "@/components/analytics/GlobalFilterHeader";
import { VisualBarChart } from "@/components/analytics/VisualBarChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Package,
  FileText,
  TrendingDown,
  Loader2,
  DollarSign,
} from "lucide-react";

export default function PurchaseDashboardPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [filterOptions, setFilterOptions] = useState<any>({
    financialYears: [],
    purchaseBatches: [],
    salesBatches: [],
    products: [],
    customers: [],
  });

  const [filter, setFilter] = useState<GlobalFilterState>({
    financialYear: "All",
    startDate: "",
    endDate: "",
    purchaseBatchId: "All",
    salesBatchId: "All",
    productId: "All",
    customerId: "All",
  });

  const [metrics, setMetrics] = useState<PurchaseMetrics | null>(null);

  useEffect(() => {
    async function initOptions() {
      const opts = await AnalyticsEngine.getFilterOptions(supabase);
      setFilterOptions(opts);
    }
    initOptions();
  }, []);

  useEffect(() => {
    async function loadMetrics() {
      setLoading(true);
      try {
        const data = await AnalyticsEngine.getPurchaseMetrics(supabase, filter);
        setMetrics(data);
      } catch (err) {
        console.error("Error loading purchase dashboard metrics:", err);
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, [filter]);

  const handleResetFilter = () => {
    setFilter({
      financialYear: "All",
      startDate: "",
      endDate: "",
      purchaseBatchId: "All",
      salesBatchId: "All",
      productId: "All",
      customerId: "All",
    });
  };

  const formatCurrency = (val: number) => {
    return `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Title */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
            Purchase Dashboard
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Procurement analytics, batch statistics, product costs & supplier
            trends
          </p>
        </div>

        <Button
          onClick={() => router.push("/generate-purchase-invoice")}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Package className="w-4 h-4 mr-1.5" />
          Generate Purchase Invoice
        </Button>
      </div>

      {/* Global Filter Bar */}
      <GlobalFilterHeader
        filterOptions={filterOptions}
        filter={filter}
        onFilterChange={setFilter}
        onReset={handleResetFilter}
      />

      {loading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : metrics ? (
        <>
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Total Purchase Value */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Total Purchase Value
                </span>
                <div className="text-xl font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.totalPurchaseValue)}
                </div>
              </CardContent>
            </Card>

            {/* Purchase Batch Count */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Purchase Batches
                </span>
                <div className="text-xl font-bold text-slate-900">
                  {metrics.purchaseBatchCount}
                </div>
              </CardContent>
            </Card>

            {/* Total Purchased Qty */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Purchased Quantity
                </span>
                <div className="text-xl font-bold font-mono text-blue-700">
                  {metrics.totalProductsPurchasedQty.toLocaleString("en-IN")} KG
                </div>
              </CardContent>
            </Card>

            {/* Average Batch Value */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Avg Batch Value
                </span>
                <div className="text-xl font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.avgBatchValue)}
                </div>
              </CardContent>
            </Card>

            {/* Average Invoice Value */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Avg Invoice Value
                </span>
                <div className="text-xl font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.avgInvoiceValue)}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <VisualBarChart
              title="Monthly Procurement Expenditure"
              subtitle="Monthly purchase total amount"
              data={metrics.monthlyPurchases.map((m) => ({
                label: m.month,
                value: m.amount,
                color: "bg-blue-600",
              }))}
            />

            <VisualBarChart
              title="Product-wise Purchase Value"
              subtitle="Total purchase spending per product"
              data={metrics.productPurchases.map((p) => ({
                label: p.product_name,
                value: p.amount,
                color: "bg-indigo-600",
              }))}
            />
          </div>

          {/* Tables Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Purchase Batches */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-base font-semibold text-slate-800">
                  Recent Purchase Batches
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => router.push("/purchase-invoice-batches")}
                >
                  View All
                </Button>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50">
                      <TableRow>
                        <TableHead className="font-semibold text-slate-700">
                          Batch ID
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700">
                          Date Range
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700 text-right">
                          Batch Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.recentBatches.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() =>
                            router.push(`/invoice-batches/${b.id}`)
                          }
                        >
                          <TableCell className="font-mono font-medium text-slate-900">
                            Batch ({b.id.slice(0, 8)})
                          </TableCell>
                          <TableCell className="text-slate-500">
                            {b.invoice_date_from} to {b.invoice_date_to}
                          </TableCell>
                          <TableCell className="font-mono text-right font-bold text-slate-900">
                            {formatCurrency(Number(b.total_amount || 0))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Largest Purchase Batches */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-base font-semibold text-slate-800">
                  Highest Value Purchase Batches
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50">
                      <TableRow>
                        <TableHead className="font-semibold text-slate-700">
                          Batch ID
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700">
                          Financial Year
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700 text-right">
                          Batch Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.largestBatches.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50"
                          onClick={() =>
                            router.push(`/invoice-batches/${b.id}`)
                          }
                        >
                          <TableCell className="font-mono font-medium text-slate-900">
                            Batch ({b.id.slice(0, 8)})
                          </TableCell>
                          <TableCell className="text-slate-500">
                            {b.financial_year}
                          </TableCell>
                          <TableCell className="font-mono text-right font-bold text-blue-700">
                            {formatCurrency(Number(b.total_amount || 0))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
