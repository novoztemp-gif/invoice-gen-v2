"use client";

import {
  AlertCircle,
  Calendar,
  DollarSign,
  FileText,
  Percent,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";

interface MappedInvoice {
  id: string;
  total_amount: number;
  invoice_date: string;
  batch_type: string;
  financial_year: string;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export default function FinanceDashboardPage() {
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [invoices, setInvoices] = useState<MappedInvoice[]>([]);
  const [availableYears, setAvailableYears] = useState<string[]>([]);

  // Filter States
  const [selectedYear, setSelectedYear] = useState<string>("All");
  const [selectedMonth, setSelectedMonth] = useState<string>("All");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        setLoading(true);
        setError(null);

        // 1. Fetch finalized batches
        const { data: batches, error: batchesError } = await supabase
          .from("invoice_batch")
          .select("id, batch_type, financial_year")
          .eq("batch_status", "FINALIZED");

        if (batchesError) throw batchesError;

        if (!batches || batches.length === 0) {
          setInvoices([]);
          setAvailableYears([]);
          setLoading(false);
          return;
        }

        // Extract distinct financial years
        const years = Array.from(new Set(batches.map((b) => b.financial_year)))
          .filter(Boolean)
          .sort();
        setAvailableYears(years);

        const batchIds = batches.map((b) => b.id);

        // 2. Fetch all invoices for these batches
        const { data: invoicesData, error: invoicesError } = await supabase
          .from("invoice")
          .select("id, invoice_batch_id, total_amount, invoice_date")
          .in("invoice_batch_id", batchIds);

        if (invoicesError) throw invoicesError;

        // 3. Map batches and invoices in-memory
        const mapped = (invoicesData || []).map((inv) => {
          const batch = batches.find((b) => b.id === inv.invoice_batch_id);
          return {
            id: inv.id,
            total_amount: Number(inv.total_amount) || 0,
            invoice_date: inv.invoice_date,
            batch_type: batch?.batch_type || "SALES",
            financial_year: batch?.financial_year || "Unknown",
          };
        });

        setInvoices(mapped);
      } catch (err: any) {
        console.error("Error loading dashboard data:", err);
        setError(err.message || "Failed to load dashboard data");
      } finally {
        setLoading(false);
      }
    }

    fetchDashboardData();
  }, []);

  // Filtered Invoices logic
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      // 1. Financial Year filter
      if (selectedYear !== "All" && inv.financial_year !== selectedYear) {
        return false;
      }

      // 2. Month filter
      if (selectedMonth !== "All") {
        const monthIndex = parseInt(inv.invoice_date.split("-")[1], 10) - 1;
        const monthName = MONTH_NAMES[monthIndex];
        if (monthName !== selectedMonth) {
          return false;
        }
      }

      // 3. Date range filter
      if (startDate && inv.invoice_date < startDate) {
        return false;
      }
      if (endDate && inv.invoice_date > endDate) {
        return false;
      }

      return true;
    });
  }, [invoices, selectedYear, selectedMonth, startDate, endDate]);

  // KPI Calculations
  const kpis = useMemo(() => {
    let salesTotal = 0;
    let purchaseTotal = 0;
    let salesCount = 0;
    let purchaseCount = 0;

    for (const inv of filteredInvoices) {
      if (inv.batch_type === "SALES") {
        salesTotal += inv.total_amount;
        salesCount++;
      } else if (inv.batch_type === "PURCHASE") {
        purchaseTotal += inv.total_amount;
        purchaseCount++;
      }
    }

    const grossProfit = salesTotal - purchaseTotal;
    const profitMargin = salesTotal > 0 ? (grossProfit / salesTotal) * 100 : 0;

    return {
      grossSales: salesTotal,
      grossPurchase: purchaseTotal,
      grossProfit,
      profitMargin,
      totalSalesInvoices: salesCount,
      totalPurchaseInvoices: purchaseCount,
    };
  }, [filteredInvoices]);

  // Monthly Grouping
  const monthlyData = useMemo(() => {
    const groups: {
      [key: string]: { monthLabel: string; sales: number; purchase: number };
    } = {};

    for (const inv of filteredInvoices) {
      const parts = inv.invoice_date.split("-");
      const year = parts[0];
      const monthIdx = parseInt(parts[1], 10) - 1;
      const key = `${year}-${parts[1]}`; // For sorting chronologically
      const monthLabel = `${MONTH_NAMES[monthIdx]} ${year}`;

      if (!groups[key]) {
        groups[key] = { monthLabel, sales: 0, purchase: 0 };
      }

      if (inv.batch_type === "SALES") {
        groups[key].sales += inv.total_amount;
      } else if (inv.batch_type === "PURCHASE") {
        groups[key].purchase += inv.total_amount;
      }
    }

    // Sort chronologically ascending
    return Object.keys(groups)
      .sort()
      .map((key) => {
        const item = groups[key];
        const grossProfit = item.sales - item.purchase;
        const profitMargin =
          item.sales > 0 ? (grossProfit / item.sales) * 100 : 0;
        return {
          month: item.monthLabel,
          sales: item.sales,
          purchase: item.purchase,
          grossProfit,
          profitMargin,
        };
      });
  }, [filteredInvoices]);

  // Yearly Grouping
  const yearlyData = useMemo(() => {
    const groups: { [key: string]: { sales: number; purchase: number } } = {};

    for (const inv of filteredInvoices) {
      const key = inv.financial_year;

      if (!groups[key]) {
        groups[key] = { sales: 0, purchase: 0 };
      }

      if (inv.batch_type === "SALES") {
        groups[key].sales += inv.total_amount;
      } else if (inv.batch_type === "PURCHASE") {
        groups[key].purchase += inv.total_amount;
      }
    }

    // Sort alphabetically/numerically
    return Object.keys(groups)
      .sort()
      .map((key) => {
        const item = groups[key];
        const grossProfit = item.sales - item.purchase;
        const profitMargin =
          item.sales > 0 ? (grossProfit / item.sales) * 100 : 0;
        return {
          financialYear: key,
          sales: item.sales,
          purchase: item.purchase,
          grossProfit,
          profitMargin,
        };
      });
  }, [filteredInvoices]);

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(val);
  };

  const handleResetFilters = () => {
    setSelectedYear("All");
    setSelectedMonth("All");
    setStartDate("");
    setEndDate("");
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <p className="text-slate-500 font-medium animate-pulse text-lg">
          Loading dashboard metrics...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 flex gap-3 items-center">
            <AlertCircle className="h-6 w-6 text-red-600" />
            <div>
              <h3 className="font-semibold text-red-950">
                Error Loading Metrics
              </h3>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Finance Dashboard
          </h1>
          <p className="text-slate-500 mt-1">
            Real-time financial analytics from finalized invoice batches.
          </p>
        </div>

        <Card className="border-slate-200">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="h-12 w-12 text-slate-400 mb-4" />
            <h3 className="text-lg font-semibold text-slate-800">
              No Finalized Data Found
            </h3>
            <p className="text-slate-500 max-w-sm mt-1">
              There are currently no finalized Sales or Purchase batches in the
              system. Please finalize at least one batch to generate dashboard
              analytics.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Title */}
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Finance Dashboard</h1>
        <p className="text-slate-500 mt-1">
          Real-time financial performance indicators and statements.
        </p>
      </div>

      {/* Filters section */}
      <Card className="border-slate-200">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div>
              <Label
                htmlFor="year-select"
                className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block"
              >
                Financial Year
              </Label>
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger id="year-select" className="w-full bg-white">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All Years</SelectItem>
                  {availableYears.map((yr) => (
                    <SelectItem key={yr} value={yr}>
                      {yr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label
                htmlFor="month-select"
                className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block"
              >
                Month
              </Label>
              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger id="month-select" className="w-full bg-white">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="All">All Months</SelectItem>
                  {MONTH_NAMES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label
                htmlFor="start-date"
                className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block"
              >
                Start Date
              </Label>
              <Input
                type="date"
                id="start-date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-white"
              />
            </div>

            <div>
              <Label
                htmlFor="end-date"
                className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block"
              >
                End Date
              </Label>
              <Input
                type="date"
                id="end-date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-white"
              />
            </div>
          </div>

          {(selectedYear !== "All" ||
            selectedMonth !== "All" ||
            startDate ||
            endDate) && (
            <div className="flex justify-end mt-4">
              <Button variant="outline" size="sm" onClick={handleResetFilters}>
                Reset Filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Gross Sales */}
        <Card className="border-slate-200">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Gross Sales
            </CardTitle>
            <div className="h-8 w-8 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center">
              <TrendingUp className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCurrency(kpis.grossSales)}
            </div>
            <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
              <FileText className="h-3.5 w-3.5 inline text-slate-400" />
              {kpis.totalSalesInvoices} Sales Invoices
            </p>
          </CardContent>
        </Card>

        {/* Gross Purchase */}
        <Card className="border-slate-200">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Gross Purchase
            </CardTitle>
            <div className="h-8 w-8 bg-red-50 text-red-600 rounded-full flex items-center justify-center">
              <TrendingDown className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-slate-900">
              {formatCurrency(kpis.grossPurchase)}
            </div>
            <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
              <FileText className="h-3.5 w-3.5 inline text-slate-400" />
              {kpis.totalPurchaseInvoices} Purchase Invoices
            </p>
          </CardContent>
        </Card>

        {/* Gross Profit */}
        <Card className="border-slate-200">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-slate-500">
              Gross Profit
            </CardTitle>
            <div className="h-8 w-8 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center">
              <DollarSign className="h-4 w-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${kpis.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
            >
              {formatCurrency(kpis.grossProfit)}
            </div>
            <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
              <Percent className="h-3.5 w-3.5 inline text-slate-400" />
              Margin:{" "}
              <span className="font-semibold text-slate-700">
                {kpis.profitMargin.toFixed(2)}%
              </span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Monthly Profit & Loss Statement */}
      <Card className="border-slate-200">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-slate-900">
            Monthly Profit & Loss
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="font-semibold text-slate-700">
                    Month
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Sales
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Purchase
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Gross Profit
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Profit Margin %
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthlyData.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-slate-500 text-sm"
                    >
                      No monthly statements match current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  monthlyData.map((item) => (
                    <TableRow key={item.month}>
                      <TableCell className="font-medium text-slate-900">
                        {item.month}
                      </TableCell>
                      <TableCell className="text-right text-emerald-700 font-medium">
                        {formatCurrency(item.sales)}
                      </TableCell>
                      <TableCell className="text-right text-red-700">
                        {formatCurrency(item.purchase)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold ${item.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
                      >
                        {formatCurrency(item.grossProfit)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-slate-700">
                        {item.profitMargin.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Yearly Profit & Loss Statement */}
      <Card className="border-slate-200">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-slate-900">
            Yearly Profit & Loss
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead className="font-semibold text-slate-700">
                    Financial Year
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Sales
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Purchase
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Gross Profit
                  </TableHead>
                  <TableHead className="text-right font-semibold text-slate-700">
                    Profit Margin %
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {yearlyData.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center py-8 text-slate-500 text-sm"
                    >
                      No yearly statements match current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  yearlyData.map((item) => (
                    <TableRow key={item.financialYear}>
                      <TableCell className="font-medium text-slate-900">
                        {item.financialYear}
                      </TableCell>
                      <TableCell className="text-right text-emerald-700 font-medium">
                        {formatCurrency(item.sales)}
                      </TableCell>
                      <TableCell className="text-right text-red-700">
                        {formatCurrency(item.purchase)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-semibold ${item.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
                      >
                        {formatCurrency(item.grossProfit)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-slate-700">
                        {item.profitMargin.toFixed(2)}%
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
