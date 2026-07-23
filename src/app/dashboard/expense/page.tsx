"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AnalyticsEngine,
  ExpenseMetrics,
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
import { PlusCircle, Loader2 } from "lucide-react";

export default function ExpenseDashboardPage() {
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

  const [metrics, setMetrics] = useState<ExpenseMetrics | null>(null);

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
        const data = await AnalyticsEngine.getExpenseMetrics(supabase, filter);
        setMetrics(data);
      } catch (err) {
        console.error("Error loading expense dashboard metrics:", err);
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
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Expenditure Dashboard
          </h1>
          <p className="text-slate-500 text-xs mt-0.5">
            Operational expense tracking, category distribution & cost analytics
          </p>
        </div>

        <Button
          onClick={() => router.push("/generate-expense-batch")}
          size="sm"
          className="h-8 text-xs bg-slate-800 hover:bg-slate-900"
        >
          <PlusCircle className="w-3.5 h-3.5 mr-1.5 stroke-[1.5]" />
          Expenditure Entry
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
        <div className="flex items-center justify-center min-h-[300px]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : metrics ? (
        <>
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Total Expenses
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.totalExpenses)}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Categories Count
                </span>
                <div className="text-lg font-bold text-slate-900">
                  {metrics.expenseCategoriesCount}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Latest Month Expense
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(
                    metrics.monthlyExpenses[metrics.monthlyExpenses.length - 1]
                      ?.amount || 0,
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardContent className="p-3.5 space-y-1">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                  Avg Expense / Batch
                </span>
                <div className="text-lg font-bold font-mono text-slate-900">
                  {formatCurrency(metrics.avgExpensePerBatch)}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <VisualBarChart
              title="Operational Expense Trend"
              subtitle="Monthly total operational expenses"
              data={metrics.expenseTrend.map((m) => ({
                label: m.month,
                value: m.amount,
                color: "bg-slate-700",
              }))}
            />

            <VisualBarChart
              title="Category Distribution"
              subtitle="Expenses broken down by category"
              data={metrics.categoryDistribution.map((c) => ({
                label: c.category,
                value: c.amount,
                color: "bg-slate-800",
              }))}
            />
          </div>

          {/* Tables Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Recent Expense Batches
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => router.push("/expense-batches")}
                  className="h-6 text-xs px-2"
                >
                  View All
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Batch ID
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Period
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Total Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.recentExpenses.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                          onClick={() => router.push("/expense-batches")}
                        >
                          <TableCell className="py-2 px-3 font-mono font-medium text-slate-900">
                            Batch ({b.id.slice(0, 8)})
                          </TableCell>
                          <TableCell className="py-2 px-3 text-slate-500">
                            {b.expense_date_from} to {b.expense_date_to}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                            {formatCurrency(Number(b.total_amount || 0))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
              <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                  Highest Value Expense Batches
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader className="bg-slate-50/70">
                      <TableRow className="border-b border-slate-200">
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Batch ID
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600">
                          Financial Year
                        </TableHead>
                        <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                          Total Amount
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {metrics.largestExpenses.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                          onClick={() => router.push("/expense-batches")}
                        >
                          <TableCell className="py-2 px-3 font-mono font-medium text-slate-900">
                            Batch ({b.id.slice(0, 8)})
                          </TableCell>
                          <TableCell className="py-2 px-3 text-slate-500">
                            {b.financial_year}
                          </TableCell>
                          <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
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
