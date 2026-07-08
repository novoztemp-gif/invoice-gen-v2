"use client";

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";

interface MappedInvoice {
  id: string;
  total_amount: number;
  invoice_date: string;
  batch_type: string;
  financial_year: string;
  customer_id: string;
  products: any[];
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
  const [companies, setCompanies] = useState<any[]>([]);

  // Filter States
  const [selectedYear, setSelectedYear] = useState<string>("All");
  const [selectedMonth, setSelectedMonth] = useState<string>("All");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");

  // Product Sort States
  const [productSortField, setProductSortField] = useState<
    "salesAmount" | "grossProfit" | "name"
  >("salesAmount");
  const [productSortOrder, setProductSortOrder] = useState<"asc" | "desc">(
    "desc",
  );

  useEffect(() => {
    async function fetchDashboardData() {
      try {
        setLoading(true);
        setError(null);

        // 1. Fetch receiving companies (for name mapping)
        const { data: companiesData, error: companiesError } = await supabase
          .from("receiving_companies")
          .select("id, company_name");

        if (companiesError) throw companiesError;
        setCompanies(companiesData || []);

        // 2. Fetch finalized batches
        const { data: batches, error: batchesError } = await supabase
          .from("invoice_batch")
          .select(
            "id, batch_type, financial_year, receiving_company_id, issuing_company_id",
          )
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

        // 3. Fetch all invoices for these batches
        const { data: invoicesData, error: invoicesError } = await supabase
          .from("invoice")
          .select("id, invoice_batch_id, total_amount, invoice_date, products");

        if (invoicesError) throw invoicesError;

        // 4. Map batches and invoices in-memory
        const mapped = (invoicesData || []).map((inv) => {
          const batch = batches.find((b) => b.id === inv.invoice_batch_id);
          const productsList = Array.isArray(inv.products) ? inv.products : [];
          // Resolve customer_id/supplier_id
          const customerId =
            productsList[0]?.customer_id ||
            batch?.receiving_company_id ||
            "Unknown";
          return {
            id: inv.id,
            total_amount: Number(inv.total_amount) || 0,
            invoice_date: inv.invoice_date,
            batch_type: batch?.batch_type || "SALES",
            financial_year: batch?.financial_year || "Unknown",
            customer_id: customerId,
            products: productsList,
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

  const companiesMap = useMemo(() => {
    return new Map<string, string>(
      companies.map((c) => [c.id, c.company_name]),
    );
  }, [companies]);

  // Filtered Invoices logic
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      if (selectedYear !== "All" && inv.financial_year !== selectedYear) {
        return false;
      }

      if (selectedMonth !== "All") {
        const monthIndex = parseInt(inv.invoice_date.split("-")[1], 10) - 1;
        const monthName = MONTH_NAMES[monthIndex];
        if (monthName !== selectedMonth) {
          return false;
        }
      }

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
      const key = `${year}-${parts[1]}`;
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

  // 1. Product Analytics Grouping
  const productAnalytics = useMemo(() => {
    const prodMap: {
      [name: string]: {
        name: string;
        salesAmount: number;
        purchaseAmount: number;
        qtySold: number;
        qtyPurchased: number;
      };
    } = {};

    for (const inv of filteredInvoices) {
      for (const p of inv.products) {
        const name = p.product_name || "Unknown Product";
        const qty = Number(p.quantity) || 0;
        const amt = Number(p.amount) || 0;

        if (!prodMap[name]) {
          prodMap[name] = {
            name,
            salesAmount: 0,
            purchaseAmount: 0,
            qtySold: 0,
            qtyPurchased: 0,
          };
        }

        if (inv.batch_type === "SALES") {
          prodMap[name].salesAmount += amt;
          prodMap[name].qtySold += qty;
        } else if (inv.batch_type === "PURCHASE") {
          prodMap[name].purchaseAmount += amt;
          prodMap[name].qtyPurchased += qty;
        }
      }
    }

    const list = Object.values(prodMap).map((item) => {
      const grossProfit = item.salesAmount - item.purchaseAmount;
      return {
        ...item,
        grossProfit,
      };
    });

    // Handle sorting
    return list.sort((a, b) => {
      const aVal = a[productSortField];
      const bVal = b[productSortField];
      if (typeof aVal === "string") {
        return productSortOrder === "asc"
          ? aVal.localeCompare(bVal as string)
          : (bVal as string).localeCompare(aVal);
      }
      const aNum = Number(aVal) || 0;
      const bNum = Number(bVal) || 0;
      return productSortOrder === "asc" ? aNum - bNum : bNum - aNum;
    });
  }, [filteredInvoices, productSortField, productSortOrder]);

  // 2. Customer Analytics Grouping
  const customerAnalytics = useMemo(() => {
    const custMap: {
      [id: string]: {
        id: string;
        name: string;
        invoicesCount: number;
        totalSales: number;
        highest: number;
        lowest: number;
      };
    } = {};

    for (const inv of filteredInvoices) {
      if (inv.batch_type !== "SALES") continue;

      const id = inv.customer_id;
      const amt = inv.total_amount;
      const name = companiesMap.get(id) || `Customer (${id.slice(0, 8)})`;

      if (!custMap[id]) {
        custMap[id] = {
          id,
          name,
          invoicesCount: 0,
          totalSales: 0,
          highest: amt,
          lowest: amt,
        };
      }

      custMap[id].invoicesCount++;
      custMap[id].totalSales += amt;
      if (amt > custMap[id].highest) custMap[id].highest = amt;
      if (amt < custMap[id].lowest) custMap[id].lowest = amt;
    }

    return Object.values(custMap)
      .map((item) => ({
        ...item,
        average:
          item.invoicesCount > 0 ? item.totalSales / item.invoicesCount : 0,
      }))
      .sort((a, b) => b.totalSales - a.totalSales);
  }, [filteredInvoices, companiesMap]);

  // 3. Supplier Analytics Grouping
  const supplierAnalytics = useMemo(() => {
    const suppMap: {
      [id: string]: {
        id: string;
        name: string;
        invoicesCount: number;
        totalPurchase: number;
        highest: number;
        lowest: number;
      };
    } = {};

    for (const inv of filteredInvoices) {
      if (inv.batch_type !== "PURCHASE") continue;

      const id = inv.customer_id;
      const amt = inv.total_amount;
      const name = companiesMap.get(id) || `Supplier (${id.slice(0, 8)})`;

      if (!suppMap[id]) {
        suppMap[id] = {
          id,
          name,
          invoicesCount: 0,
          totalPurchase: 0,
          highest: amt,
          lowest: amt,
        };
      }

      suppMap[id].invoicesCount++;
      suppMap[id].totalPurchase += amt;
      if (amt > suppMap[id].highest) suppMap[id].highest = amt;
      if (amt < suppMap[id].lowest) suppMap[id].lowest = amt;
    }

    return Object.values(suppMap)
      .map((item) => ({
        ...item,
        average:
          item.invoicesCount > 0 ? item.totalPurchase / item.invoicesCount : 0,
      }))
      .sort((a, b) => b.totalPurchase - a.totalPurchase);
  }, [filteredInvoices, companiesMap]);

  // Top lists memo
  const topLists = useMemo(() => {
    const topCustomers = [...customerAnalytics].slice(0, 10);
    const topSuppliers = [...supplierAnalytics].slice(0, 10);

    // Sort products by sales
    const productsBySales = [...productAnalytics]
      .sort((a, b) => b.salesAmount - a.salesAmount)
      .slice(0, 10);

    // Sort products by profit
    const productsByProfit = [...productAnalytics]
      .sort((a, b) => b.grossProfit - a.grossProfit)
      .slice(0, 10);

    return {
      topCustomers,
      topSuppliers,
      productsBySales,
      productsByProfit,
    };
  }, [customerAnalytics, supplierAnalytics, productAnalytics]);

  // Chart helpers & scaling
  const chartSalesPurchaseMax = useMemo(() => {
    if (monthlyData.length === 0) return 1;
    return Math.max(
      ...monthlyData.map((d) => Math.max(d.sales, d.purchase)),
      1,
    );
  }, [monthlyData]);

  const chartProfitMax = useMemo(() => {
    if (monthlyData.length === 0) return 1;
    return Math.max(...monthlyData.map((d) => Math.abs(d.grossProfit)), 1);
  }, [monthlyData]);

  const topProductSalesMax = useMemo(() => {
    if (topLists.productsBySales.length === 0) return 1;
    return Math.max(...topLists.productsBySales.map((p) => p.salesAmount), 1);
  }, [topLists]);

  const topCustomerSalesMax = useMemo(() => {
    if (topLists.topCustomers.length === 0) return 1;
    return Math.max(...topLists.topCustomers.map((c) => c.totalSales), 1);
  }, [topLists]);

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(val);
  };

  const handleResetFilters = () => {
    setSelectedYear("All");
    setSelectedMonth("All");
    setStartDate("");
    setEndDate("");
  };

  const handleProductSort = (field: "salesAmount" | "grossProfit" | "name") => {
    if (productSortField === field) {
      setProductSortOrder(productSortOrder === "asc" ? "desc" : "asc");
    } else {
      setProductSortField(field);
      setProductSortOrder("desc");
    }
  };

  const getSortIcon = (field: "salesAmount" | "grossProfit" | "name") => {
    if (productSortField !== field) {
      return <ArrowUpDown className="ml-1 h-3 w-3 inline" />;
    }
    return productSortOrder === "asc" ? (
      <ArrowUp className="ml-1 h-3 w-3 inline" />
    ) : (
      <ArrowDown className="ml-1 h-3 w-3 inline" />
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <p className="text-slate-500 font-medium animate-pulse text-lg">
          Loading metrics and statements...
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
          Real-time financial analytics, statements, and visual trend charts.
        </p>
      </div>

      {/* Filters section */}
      <Card className="border-slate-200 shadow-sm bg-white">
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
                <SelectTrigger
                  id="year-select"
                  className="w-full bg-white border-slate-200"
                >
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
                <SelectTrigger
                  id="month-select"
                  className="w-full bg-white border-slate-200"
                >
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
                className="bg-white border-slate-200"
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
                className="bg-white border-slate-200"
              />
            </div>
          </div>

          {(selectedYear !== "All" ||
            selectedMonth !== "All" ||
            startDate ||
            endDate) && (
            <div className="flex justify-end mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                className="border-slate-200"
              >
                Reset Filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPI cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Gross Sales */}
        <Card className="border-slate-200 shadow-sm bg-white">
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
        <Card className="border-slate-200 shadow-sm bg-white">
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
        <Card className="border-slate-200 shadow-sm bg-white">
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

      {/* Main Tabs Hub */}
      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="bg-slate-100 border p-1 rounded-lg">
          <TabsTrigger value="overview">Overview & Statements</TabsTrigger>
          <TabsTrigger value="products">Product Analytics</TabsTrigger>
          <TabsTrigger value="partners">
            Partner Analytics (Customers/Suppliers)
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: OVERVIEW & TRENDS */}
        <TabsContent value="overview" className="space-y-6">
          {/* Charts Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Sales vs Purchase Bar Chart */}
            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  Monthly Sales vs Purchase
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {monthlyData.length === 0 ? (
                  <p className="text-center py-12 text-slate-400 text-sm">
                    No data available
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="h-48 flex items-end gap-3 border-b border-l border-slate-150 pb-2 pl-2">
                      {monthlyData.map((d) => {
                        const salesHeight =
                          (d.sales / chartSalesPurchaseMax) * 100;
                        const purchaseHeight =
                          (d.purchase / chartSalesPurchaseMax) * 100;
                        return (
                          <div
                            key={d.month}
                            className="flex-1 flex flex-col items-center group relative h-full justify-end"
                          >
                            <div className="w-full flex items-end justify-center gap-1 h-full">
                              <div
                                style={{ height: `${salesHeight}%` }}
                                className="w-2.5 bg-emerald-500 rounded-t-sm hover:bg-emerald-600 transition-all duration-200 relative group cursor-pointer"
                              >
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-slate-900 text-white text-[10px] px-2 py-0.5 rounded shadow-lg z-20 whitespace-nowrap">
                                  Sales: {formatCurrency(d.sales)}
                                </div>
                              </div>
                              <div
                                style={{ height: `${purchaseHeight}%` }}
                                className="w-2.5 bg-red-500 rounded-t-sm hover:bg-red-600 transition-all duration-200 relative group cursor-pointer"
                              >
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-slate-900 text-white text-[10px] px-2 py-0.5 rounded shadow-lg z-20 whitespace-nowrap">
                                  Purchase: {formatCurrency(d.purchase)}
                                </div>
                              </div>
                            </div>
                            <span className="text-[8px] text-slate-500 mt-1.5 rotate-45 origin-left whitespace-nowrap w-2 truncate">
                              {d.month.split(" ")[0].slice(0, 3)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex gap-4 justify-center text-xs pt-4 border-t">
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 bg-emerald-500 rounded-sm" />{" "}
                        Sales
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-3 h-3 bg-red-500 rounded-sm" />{" "}
                        Purchase
                      </span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Gross Profit Line Chart */}
            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  Gross Profit Trend
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {monthlyData.length === 0 ? (
                  <p className="text-center py-12 text-slate-400 text-sm">
                    No data available
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="h-48 border-b border-l border-slate-150 pb-2 pl-2 relative">
                      <svg
                        className="w-full h-full"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                      >
                        {/* Render Line */}
                        <polyline
                          fill="none"
                          stroke="rgb(99, 102, 241)"
                          strokeWidth="2.5"
                          points={monthlyData
                            .map((d, i) => {
                              const x =
                                (i / Math.max(monthlyData.length - 1, 1)) * 100;
                              // Scale so center is 0 if there are negative profits
                              const y =
                                100 -
                                ((d.grossProfit + chartProfitMax) /
                                  (chartProfitMax * 2)) *
                                  100;
                              return `${x},${y}`;
                            })
                            .join(" ")}
                        />
                        {/* Nodes */}
                        {monthlyData.map((d, i) => {
                          const x =
                            (i / Math.max(monthlyData.length - 1, 1)) * 100;
                          const y =
                            100 -
                            ((d.grossProfit + chartProfitMax) /
                              (chartProfitMax * 2)) *
                              100;
                          return (
                            <circle
                              key={d.month}
                              cx={x}
                              cy={y}
                              r="3.5"
                              className="fill-indigo-600 stroke-white stroke-2 cursor-pointer hover:r-5 transition-all"
                            />
                          );
                        })}
                      </svg>
                      {/* X Axis Labels */}
                      <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 pt-1 translate-y-full">
                        {monthlyData.map((d, i) => (
                          <span
                            key={d.month}
                            className="text-[8px] text-slate-400"
                          >
                            {d.month.split(" ")[0].slice(0, 3)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p className="text-[10px] text-center text-slate-500 pt-4 border-t">
                      Interactive lines depict gross monthly profit variance.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Profit Margin % Bar Chart */}
            <Card className="border-slate-200 shadow-sm bg-white">
              <CardHeader className="pb-3 border-b">
                <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                  Monthly Profit Margin %
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {monthlyData.length === 0 ? (
                  <p className="text-center py-12 text-slate-400 text-sm">
                    No data available
                  </p>
                ) : (
                  <div className="space-y-4">
                    <div className="h-48 flex items-end gap-3 border-b border-l border-slate-150 pb-2 pl-2">
                      {monthlyData.map((d) => {
                        const h = Math.min(Math.max(d.profitMargin, 0), 100);
                        return (
                          <div
                            key={d.month}
                            className="flex-1 flex flex-col items-center group relative h-full justify-end"
                          >
                            <div
                              style={{ height: `${h}%` }}
                              className="w-5 bg-indigo-500 rounded-t-sm hover:bg-indigo-600 transition-all duration-200 relative group cursor-pointer"
                            >
                              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-slate-900 text-white text-[10px] px-2 py-0.5 rounded shadow-lg z-20 whitespace-nowrap">
                                Margin: {d.profitMargin.toFixed(2)}%
                              </div>
                            </div>
                            <span className="text-[8px] text-slate-500 mt-1.5">
                              {d.month.split(" ")[0].slice(0, 3)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-center text-slate-500 pt-4 border-t">
                      Profit margin distribution bounded between 0% and 100%.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Monthly P&L Table */}
          <Card className="border-slate-200 shadow-sm bg-white">
            <CardHeader className="border-b">
              <CardTitle className="text-lg font-bold text-slate-900">
                Monthly Profit & Loss
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="rounded-md border border-slate-150 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50 hover:bg-slate-50">
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
                          className="text-center py-8 text-slate-400 text-sm"
                        >
                          No monthly statements match current filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      monthlyData.map((item) => (
                        <TableRow
                          key={item.month}
                          className="hover:bg-slate-50/50"
                        >
                          <TableCell className="font-medium text-slate-900">
                            {item.month}
                          </TableCell>
                          <TableCell className="text-right text-emerald-700 font-semibold">
                            {formatCurrency(item.sales)}
                          </TableCell>
                          <TableCell className="text-right text-red-600">
                            {formatCurrency(item.purchase)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-bold ${item.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
                          >
                            {formatCurrency(item.grossProfit)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-slate-600">
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

          {/* Yearly P&L Table */}
          <Card className="border-slate-200 shadow-sm bg-white">
            <CardHeader className="border-b">
              <CardTitle className="text-lg font-bold text-slate-900">
                Yearly Profit & Loss
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="rounded-md border border-slate-150 overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50 hover:bg-slate-50">
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
                          className="text-center py-8 text-slate-400 text-sm"
                        >
                          No yearly statements match current filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      yearlyData.map((item) => (
                        <TableRow
                          key={item.financialYear}
                          className="hover:bg-slate-50/50"
                        >
                          <TableCell className="font-semibold text-slate-900">
                            {item.financialYear}
                          </TableCell>
                          <TableCell className="text-right text-emerald-700 font-semibold">
                            {formatCurrency(item.sales)}
                          </TableCell>
                          <TableCell className="text-right text-red-600">
                            {formatCurrency(item.purchase)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-bold ${item.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
                          >
                            {formatCurrency(item.grossProfit)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-slate-600">
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
        </TabsContent>

        {/* TAB 2: PRODUCT ANALYTICS */}
        <TabsContent value="products" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Table block */}
            <div className="lg:col-span-2 space-y-6">
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="border-b">
                  <CardTitle className="text-lg font-bold text-slate-900">
                    Product Analytics
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <div className="rounded-md border border-slate-150 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableHead
                            onClick={() => handleProductSort("name")}
                            className="font-semibold text-slate-700 cursor-pointer select-none"
                          >
                            Product Name {getSortIcon("name")}
                          </TableHead>
                          <TableHead
                            onClick={() => handleProductSort("salesAmount")}
                            className="text-right font-semibold text-slate-700 cursor-pointer select-none"
                          >
                            Sales Amt {getSortIcon("salesAmount")}
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Purchase Amt
                          </TableHead>
                          <TableHead
                            onClick={() => handleProductSort("grossProfit")}
                            className="text-right font-semibold text-slate-700 cursor-pointer select-none"
                          >
                            Gross Profit {getSortIcon("grossProfit")}
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Qty Sold
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Qty Purchased
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {productAnalytics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center py-8 text-slate-400 text-sm"
                            >
                              No product statistics available under current
                              filters.
                            </TableCell>
                          </TableRow>
                        ) : (
                          productAnalytics.map((item) => (
                            <TableRow
                              key={item.name}
                              className="hover:bg-slate-50/50"
                            >
                              <TableCell className="font-medium text-slate-900">
                                {item.name}
                              </TableCell>
                              <TableCell className="text-right text-emerald-700 font-semibold">
                                {formatCurrency(item.salesAmount)}
                              </TableCell>
                              <TableCell className="text-right text-slate-600">
                                {formatCurrency(item.purchaseAmount)}
                              </TableCell>
                              <TableCell
                                className={`text-right font-bold ${item.grossProfit >= 0 ? "text-indigo-900" : "text-red-700"}`}
                              >
                                {formatCurrency(item.grossProfit)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {item.qtySold}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {item.qtyPurchased}
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

            {/* Sidebar Charts/Lists block */}
            <div className="space-y-6">
              {/* Chart: Top 10 Products by Sales */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Top 10 Products by Sales
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  {topLists.productsBySales.length === 0 ? (
                    <p className="text-center py-8 text-slate-400 text-xs">
                      No data available
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {topLists.productsBySales.map((p, i) => {
                        const pct = (p.salesAmount / topProductSalesMax) * 100;
                        return (
                          <div key={p.name} className="space-y-1">
                            <div className="flex justify-between text-xs font-semibold text-slate-700">
                              <span className="truncate w-40">
                                {i + 1}. {p.name}
                              </span>
                              <span className="text-emerald-700">
                                {formatCurrency(p.salesAmount)}
                              </span>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${pct}%` }}
                                className="bg-emerald-500 h-full rounded-full"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Top 10 Products by Profit List */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Top 10 Products by Profit
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  {topLists.productsByProfit.length === 0 ? (
                    <p className="text-center py-8 text-slate-400 text-xs">
                      No data available
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {topLists.productsByProfit.map((p, i) => (
                        <div
                          key={p.name}
                          className="flex justify-between text-xs items-center py-1.5 border-b last:border-0 border-slate-100"
                        >
                          <span className="truncate w-44 text-slate-600 font-medium">
                            {i + 1}. {p.name}
                          </span>
                          <span
                            className={`font-bold ${p.grossProfit >= 0 ? "text-indigo-600" : "text-red-600"}`}
                          >
                            {formatCurrency(p.grossProfit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* TAB 3: PARTNER ANALYTICS */}
        <TabsContent value="partners" className="space-y-6">
          {/* Top customer charts / lists */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {/* Customer Analytics Table */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="border-b">
                  <CardTitle className="text-lg font-bold text-slate-900">
                    Customer Analytics (Sales Inbound)
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <div className="rounded-md border border-slate-150 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableHead className="font-semibold text-slate-700">
                            Customer Name
                          </TableHead>
                          <TableHead className="text-center font-semibold text-slate-700">
                            Invoices
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Total Sales Amt
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Avg Invoice
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Highest Invoice
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Lowest Invoice
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {customerAnalytics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center py-8 text-slate-400 text-sm"
                            >
                              No customer data available under current filters.
                            </TableCell>
                          </TableRow>
                        ) : (
                          customerAnalytics.map((item) => (
                            <TableRow
                              key={item.id}
                              className="hover:bg-slate-50/50"
                            >
                              <TableCell className="font-medium text-slate-900">
                                {item.name}
                              </TableCell>
                              <TableCell className="text-center font-mono text-xs">
                                {item.invoicesCount}
                              </TableCell>
                              <TableCell className="text-right text-emerald-700 font-semibold">
                                {formatCurrency(item.totalSales)}
                              </TableCell>
                              <TableCell className="text-right text-slate-600 font-medium">
                                {formatCurrency(item.average)}
                              </TableCell>
                              <TableCell className="text-right text-indigo-700">
                                {formatCurrency(item.highest)}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {formatCurrency(item.lowest)}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              {/* Supplier Analytics Table */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="border-b">
                  <CardTitle className="text-lg font-bold text-slate-900">
                    Supplier Analytics (Purchase Outbound)
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <div className="rounded-md border border-slate-150 overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-slate-50 hover:bg-slate-50">
                          <TableHead className="font-semibold text-slate-700">
                            Supplier Name
                          </TableHead>
                          <TableHead className="text-center font-semibold text-slate-700">
                            Invoices
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Total Purchase Amt
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Avg Invoice
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Highest Invoice
                          </TableHead>
                          <TableHead className="text-right font-semibold text-slate-700">
                            Lowest Invoice
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {supplierAnalytics.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              className="text-center py-8 text-slate-400 text-sm"
                            >
                              No supplier data available under current filters.
                            </TableCell>
                          </TableRow>
                        ) : (
                          supplierAnalytics.map((item) => (
                            <TableRow
                              key={item.id}
                              className="hover:bg-slate-50/50"
                            >
                              <TableCell className="font-medium text-slate-900">
                                {item.name}
                              </TableCell>
                              <TableCell className="text-center font-mono text-xs">
                                {item.invoicesCount}
                              </TableCell>
                              <TableCell className="text-right text-red-600 font-semibold">
                                {formatCurrency(item.totalPurchase)}
                              </TableCell>
                              <TableCell className="text-right text-slate-600 font-medium">
                                {formatCurrency(item.average)}
                              </TableCell>
                              <TableCell className="text-right text-indigo-700">
                                {formatCurrency(item.highest)}
                              </TableCell>
                              <TableCell className="text-right text-slate-500">
                                {formatCurrency(item.lowest)}
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

            {/* Sidebar top lists / charts */}
            <div className="space-y-6">
              {/* Chart: Top 10 Customers by Sales */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Top 10 Customers by Sales
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  {topLists.topCustomers.length === 0 ? (
                    <p className="text-center py-8 text-slate-400 text-xs">
                      No data available
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {topLists.topCustomers.map((c, i) => {
                        const pct = (c.totalSales / topCustomerSalesMax) * 100;
                        return (
                          <div key={c.id} className="space-y-1">
                            <div className="flex justify-between text-xs font-semibold text-slate-700">
                              <span className="truncate w-40">
                                {i + 1}. {c.name}
                              </span>
                              <span className="text-emerald-700">
                                {formatCurrency(c.totalSales)}
                              </span>
                            </div>
                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                              <div
                                style={{ width: `${pct}%` }}
                                className="bg-indigo-500 h-full rounded-full"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Top 10 Suppliers List */}
              <Card className="border-slate-200 shadow-sm bg-white">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Top 10 Suppliers
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  {topLists.topSuppliers.length === 0 ? (
                    <p className="text-center py-8 text-slate-400 text-xs">
                      No data available
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {topLists.topSuppliers.map((s, i) => (
                        <div
                          key={s.id}
                          className="flex justify-between text-xs items-center py-1.5 border-b last:border-0 border-slate-100"
                        >
                          <span className="truncate w-44 text-slate-600 font-medium">
                            {i + 1}. {s.name}
                          </span>
                          <span className="font-bold text-red-600">
                            {formatCurrency(s.totalPurchase)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
