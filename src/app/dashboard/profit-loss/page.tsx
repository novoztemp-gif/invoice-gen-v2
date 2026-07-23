"use client";

import React, { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  AnalyticsEngine,
  ProfitLossMetrics,
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
import { Loader2 } from "lucide-react";

export default function ProfitLossDashboardPage() {
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

  const [metrics, setMetrics] = useState<ProfitLossMetrics | null>(null);

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
        const data = await AnalyticsEngine.getProfitLossMetrics(
          supabase,
          filter,
        );
        setMetrics(data);
      } catch (err) {
        console.error("Error loading Profit & Loss dashboard metrics:", err);
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
    <div className="space-y-4 pb-10">
      {/* Title */}
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          Profit & Loss Statement
        </h1>
        <p className="text-slate-500 text-xs mt-0.5">
          Financial P&L summary: Revenue - Purchase Cost - Operational Expenses
          = Net Profit
        </p>
      </div>

      {/* Global Filter Bar */}
      <GlobalFilterHeader
        filterOptions={filterOptions}
        filter={filter}
        onFilterChange={setFilter}
        onReset={handleResetFilter}
      />

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : metrics ? (
        <>
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Total Revenue
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.revenue)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Purchase Cost
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.purchaseCost)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Expenses
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.expenses)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Gross Profit
                </span>
                <div
                  className={`text-lg font-bold font-mono ${metrics.grossProfit >= 0 ? "text-slate-900" : "text-red-700"}`}
                >
                  {formatCurrency(metrics.grossProfit)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Net Profit
                </span>
                <div
                  className={`text-lg font-bold font-mono ${metrics.netProfit >= 0 ? "text-slate-900" : "text-red-700"}`}
                >
                  {formatCurrency(metrics.netProfit)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Net Profit Margin
                </span>
                <div
                  className={`text-lg font-bold ${metrics.profitMarginPct >= 0 ? "text-slate-900" : "text-red-700"}`}
                >
                  {metrics.profitMarginPct}%
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <VisualBarChart
              title="Revenue vs Expenses Comparison"
              subtitle="Monthly sales revenue vs operational & purchase expenses"
              data={metrics.revenueVsExpenses.map((m) => ({
                label: m.month,
                value: m.revenue,
                value2: m.expenses,
                color: "bg-slate-800",
                color2: "bg-slate-400",
              }))}
              legend1="Revenue"
              legend2="Expenses"
            />

            <VisualBarChart
              title="Gross Profit vs Net Profit"
              subtitle="Monthly Gross Profit and Net Profit after expenses"
              data={metrics.profitTrend.map((m) => ({
                label: m.month,
                value: m.grossProfit,
                value2: m.netProfit,
                color: "bg-slate-700",
                color2: "bg-slate-500",
              }))}
              legend1="Gross Profit"
              legend2="Net Profit"
            />

            <VisualBarChart
              title="Monthly Net Profit Trend"
              subtitle="Net Profit trajectory month by month"
              data={metrics.monthlyProfit.map((m) => ({
                label: m.month,
                value: m.netProfit,
                color: m.netProfit >= 0 ? "bg-slate-800" : "bg-red-700",
              }))}
            />
          </div>

          {/* Monthly P&L Summary Table */}
          <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
            <CardHeader className="p-3 pb-2 border-b border-slate-100">
              <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Monthly Profit & Loss Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader className="bg-slate-50/70">
                    <TableRow className="border-b border-slate-200">
                      <TableHead className="py-2 px-3 font-semibold text-slate-600">
                        Month
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Revenue (Sales)
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Purchase Cost
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Expenses
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Gross Profit
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Net Profit
                      </TableHead>
                      <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                        Profit Margin
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.monthlyPnLSummary.map((row, idx) => (
                      <TableRow key={idx} className="border-b border-slate-100">
                        <TableCell className="py-2 px-3 font-medium text-slate-900">
                          {row.month}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                          {formatCurrency(row.revenue)}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                          {formatCurrency(row.purchaseCost)}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                          {formatCurrency(row.expenses)}
                        </TableCell>
                        <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                          {formatCurrency(row.grossProfit)}
                        </TableCell>
                        <TableCell
                          className={`py-2 px-3 font-mono text-right font-bold ${row.netProfit >= 0 ? "text-slate-900" : "text-red-700"}`}
                        >
                          {formatCurrency(row.netProfit)}
                        </TableCell>
                        <TableCell
                          className={`py-2 px-3 font-mono text-right font-semibold ${row.marginPct >= 0 ? "text-slate-900" : "text-red-700"}`}
                        >
                          {row.marginPct}%
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
