"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AnalyticsEngine, SalesMetrics } from "@/lib/services/AnalyticsEngine";
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
import { FileText, TrendingUp, Users, Loader2 } from "lucide-react";

export default function SalesDashboardPage() {
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

  const [metrics, setMetrics] = useState<SalesMetrics | null>(null);

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
        const data = await AnalyticsEngine.getSalesMetrics(supabase, filter);
        setMetrics(data);
      } catch (err) {
        console.error("Error loading sales dashboard metrics:", err);
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
            Sales Dashboard
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Revenue performance, customer distribution, product sales & invoice
            analytics
          </p>
        </div>

        <Button
          onClick={() => router.push("/generate-invoice")}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <FileText className="w-4 h-4 mr-1.5" />
          Generate Sales Invoice
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
            {/* Total Sales Value */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Total Revenue
                </span>
                <div className="text-xl font-bold font-mono text-emerald-700">
                  {formatCurrency(metrics.totalSalesValue)}
                </div>
              </CardContent>
            </Card>

            {/* Sales Batch Count */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Sales Batches
                </span>
                <div className="text-xl font-bold text-slate-900">
                  {metrics.salesBatchCount}
                </div>
              </CardContent>
            </Card>

            {/* Total Invoices */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Total Invoices
                </span>
                <div className="text-xl font-bold text-slate-900">
                  {metrics.totalInvoicesCount}
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

            {/* Customers Served */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardContent className="pt-5 space-y-1">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Customers Served
                </span>
                <div className="text-xl font-bold text-blue-700">
                  {metrics.customersServedCount}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <VisualBarChart
              title="Monthly Sales Trend"
              subtitle="Monthly total revenue generated"
              data={metrics.monthlySales.map((m) => ({
                label: m.month,
                value: m.amount,
                color: "bg-emerald-600",
              }))}
            />

            <VisualBarChart
              title="Customer-wise Sales Breakdown"
              subtitle="Revenue generated per customer"
              data={metrics.customerSales.map((c) => ({
                label: c.customer_name,
                value: c.amount,
                color: "bg-blue-600",
              }))}
            />

            <VisualBarChart
              title="Product-wise Sales Revenue"
              subtitle="Sales amount by product"
              data={metrics.productSales.map((p) => ({
                label: p.product_name,
                value: p.amount,
                color: "bg-indigo-600",
              }))}
            />

            <VisualBarChart
              title="Product-wise Sales Volume (KG)"
              subtitle="Quantity sold by product"
              valuePrefix=""
              valueSuffix=" KG"
              data={metrics.productSales.map((p) => ({
                label: p.product_name,
                value: p.qty,
                color: "bg-teal-600",
              }))}
            />
          </div>

          {/* Tables Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Sales Batches */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-base font-semibold text-slate-800">
                  Recent Sales Batches
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => router.push("/invoice-batches")}
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
                          Financial Year
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700 text-right">
                          Batch Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.recentSalesBatches.map((b) => (
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
                            {b.financial_year || "FY 2025-26"}
                          </TableCell>
                          <TableCell className="font-mono text-right font-bold text-emerald-700">
                            {formatCurrency(Number(b.total_amount || 0))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Highest Value Customers */}
            <Card className="border border-slate-200 shadow-xs bg-white">
              <CardHeader className="pb-3 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-base font-semibold text-slate-800">
                  Highest Value Customers
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50">
                      <TableRow>
                        <TableHead className="font-semibold text-slate-700">
                          Customer Name
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700 text-center">
                          Invoices
                        </TableHead>
                        <TableHead className="font-semibold text-slate-700 text-right">
                          Total Revenue
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.highestValueCustomers.map((c, idx) => (
                        <TableRow key={idx}>
                          <TableCell className="font-medium text-slate-900">
                            {c.customer_name}
                          </TableCell>
                          <TableCell className="text-center font-semibold text-slate-700">
                            {c.invoices_count}
                          </TableCell>
                          <TableCell className="font-mono text-right font-bold text-emerald-700">
                            {formatCurrency(c.amount)}
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
