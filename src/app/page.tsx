"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  AnalyticsEngine,
  PurchaseMetrics,
  SalesMetrics,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Package, FileText, Loader2, PlusCircle } from "lucide-react";

export default function MainDashboardPage() {
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

  const [purchaseMetrics, setPurchaseMetrics] =
    useState<PurchaseMetrics | null>(null);
  const [salesMetrics, setSalesMetrics] = useState<SalesMetrics | null>(null);

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
        const [pData, sData] = await Promise.all([
          AnalyticsEngine.getPurchaseMetrics(supabase, filter),
          AnalyticsEngine.getSalesMetrics(supabase, filter),
        ]);
        setPurchaseMetrics(pData);
        setSalesMetrics(sData);
      } catch (err) {
        console.error("Error loading Main Dashboard analytics:", err);
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
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Main Dashboard
          </h1>
          <p className="text-slate-500 text-xs mt-0.5">
            Central ERP analytics hub for Purchase & Sales performance
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() => router.push("/generate-purchase-invoice")}
            size="sm"
            variant="outline"
            className="h-8 text-xs border-slate-200"
          >
            <PlusCircle className="w-3.5 h-3.5 mr-1.5 stroke-[1.5]" />
            Purchase Invoice
          </Button>
          <Button
            onClick={() => router.push("/generate-invoice")}
            size="sm"
            className="h-8 text-xs bg-slate-800 hover:bg-slate-900"
          >
            <FileText className="w-3.5 h-3.5 mr-1.5 stroke-[1.5]" />
            Sales Invoice
          </Button>
        </div>
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
      ) : (
        <Tabs defaultValue="purchase" className="space-y-4">
          <TabsList className="bg-slate-100 border border-slate-200 p-1 rounded-md grid grid-cols-2 max-w-xs h-9">
            <TabsTrigger
              value="purchase"
              className="gap-1.5 font-medium text-xs rounded-xs"
            >
              <Package className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
              Purchase Analytics
            </TabsTrigger>
            <TabsTrigger
              value="sales"
              className="gap-1.5 font-medium text-xs rounded-xs"
            >
              <FileText className="w-3.5 h-3.5 text-slate-600 stroke-[1.5]" />
              Sales Analytics
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: PURCHASE ANALYTICS */}
          <TabsContent value="purchase" className="space-y-4">
            {purchaseMetrics && (
              <>
                {/* Purchase KPI Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Total Purchase Value
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {formatCurrency(purchaseMetrics.totalPurchaseValue)}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Purchase Batches
                      </span>
                      <div className="text-lg font-bold text-slate-900">
                        {purchaseMetrics.purchaseBatchCount}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Purchased Quantity
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {purchaseMetrics.totalProductsPurchasedQty.toLocaleString(
                          "en-IN",
                        )}{" "}
                        KG
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Avg Batch Value
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {formatCurrency(purchaseMetrics.avgBatchValue)}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Avg Invoice Value
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {formatCurrency(purchaseMetrics.avgInvoiceValue)}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Purchase Charts */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <VisualBarChart
                    title="Monthly Procurement Expenditure"
                    subtitle="Monthly purchase total amount"
                    data={purchaseMetrics.monthlyPurchases.map((m) => ({
                      label: m.month,
                      value: m.amount,
                      color: "bg-slate-700",
                    }))}
                  />

                  <VisualBarChart
                    title="Product-wise Purchase Value"
                    subtitle="Total purchase spending per product"
                    data={purchaseMetrics.productPurchases.map((p) => ({
                      label: p.product_name,
                      value: p.amount,
                      color: "bg-slate-800",
                    }))}
                  />
                </div>

                {/* Purchase Tables */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
                      <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                        Recent Purchase Batches
                      </CardTitle>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => router.push("/purchase-invoice-batches")}
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
                                Date Range
                              </TableHead>
                              <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                                Batch Amount
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {purchaseMetrics.recentBatches.map((b) => (
                              <TableRow
                                key={b.id}
                                className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                                onClick={() =>
                                  router.push(`/invoice-batches/${b.id}`)
                                }
                              >
                                <TableCell className="py-2 px-3 font-mono font-medium text-slate-900">
                                  Batch ({b.id.slice(0, 8)})
                                </TableCell>
                                <TableCell className="py-2 px-3 text-slate-500">
                                  {b.invoice_date_from} to {b.invoice_date_to}
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
                        Highest Value Purchase Batches
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
                                Batch Amount
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {purchaseMetrics.largestBatches.map((b) => (
                              <TableRow
                                key={b.id}
                                className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                                onClick={() =>
                                  router.push(`/invoice-batches/${b.id}`)
                                }
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
            )}
          </TabsContent>

          {/* TAB 2: SALES ANALYTICS */}
          <TabsContent value="sales" className="space-y-4">
            {salesMetrics && (
              <>
                {/* Sales KPI Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Total Revenue
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {formatCurrency(salesMetrics.totalSalesValue)}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Sales Batches
                      </span>
                      <div className="text-lg font-bold text-slate-900">
                        {salesMetrics.salesBatchCount}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Total Invoices
                      </span>
                      <div className="text-lg font-bold text-slate-900">
                        {salesMetrics.totalInvoicesCount}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Avg Invoice Value
                      </span>
                      <div className="text-lg font-bold font-mono text-slate-900">
                        {formatCurrency(salesMetrics.avgInvoiceValue)}
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardContent className="p-3.5 space-y-1">
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider block">
                        Customers Served
                      </span>
                      <div className="text-lg font-bold text-slate-900">
                        {salesMetrics.customersServedCount}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* Sales Charts */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <VisualBarChart
                    title="Monthly Sales Revenue Trend"
                    subtitle="Monthly total revenue generated"
                    data={salesMetrics.monthlySales.map((m) => ({
                      label: m.month,
                      value: m.amount,
                      color: "bg-slate-800",
                    }))}
                  />

                  <VisualBarChart
                    title="Customer-wise Sales Breakdown"
                    subtitle="Revenue generated per customer"
                    data={salesMetrics.customerSales.map((c) => ({
                      label: c.customer_name,
                      value: c.amount,
                      color: "bg-slate-700",
                    }))}
                  />

                  <VisualBarChart
                    title="Product-wise Sales Revenue"
                    subtitle="Sales amount by product"
                    data={salesMetrics.productSales.map((p) => ({
                      label: p.product_name,
                      value: p.amount,
                      color: "bg-slate-800",
                    }))}
                  />

                  <VisualBarChart
                    title="Product-wise Sales Volume (KG)"
                    subtitle="Quantity sold by product"
                    valuePrefix=""
                    valueSuffix=" KG"
                    data={salesMetrics.productSales.map((p) => ({
                      label: p.product_name,
                      value: p.qty,
                      color: "bg-slate-600",
                    }))}
                  />
                </div>

                {/* Sales Tables */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
                    <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
                      <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                        Recent Sales Batches
                      </CardTitle>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => router.push("/invoice-batches")}
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
                                Financial Year
                              </TableHead>
                              <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                                Batch Amount
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {salesMetrics.recentSalesBatches.map((b) => (
                              <TableRow
                                key={b.id}
                                className="cursor-pointer hover:bg-slate-50/80 border-b border-slate-100"
                                onClick={() =>
                                  router.push(`/invoice-batches/${b.id}`)
                                }
                              >
                                <TableCell className="py-2 px-3 font-mono font-medium text-slate-900">
                                  Batch ({b.id.slice(0, 8)})
                                </TableCell>
                                <TableCell className="py-2 px-3 text-slate-500">
                                  {b.financial_year || "FY 2025-26"}
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
                        Highest Value Customers
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="overflow-x-auto">
                        <Table className="text-xs">
                          <TableHeader className="bg-slate-50/70">
                            <TableRow className="border-b border-slate-200">
                              <TableHead className="py-2 px-3 font-semibold text-slate-600">
                                Customer Name
                              </TableHead>
                              <TableHead className="py-2 px-3 font-semibold text-slate-600 text-center">
                                Invoices
                              </TableHead>
                              <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                                Total Revenue
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {salesMetrics.highestValueCustomers.map(
                              (c, idx) => (
                                <TableRow
                                  key={idx}
                                  className="border-b border-slate-100"
                                >
                                  <TableCell className="py-2 px-3 font-medium text-slate-900">
                                    {c.customer_name}
                                  </TableCell>
                                  <TableCell className="py-2 px-3 text-center font-semibold text-slate-700">
                                    {c.invoices_count}
                                  </TableCell>
                                  <TableCell className="py-2 px-3 font-mono text-right font-semibold text-slate-900">
                                    {formatCurrency(c.amount)}
                                  </TableCell>
                                </TableRow>
                              ),
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
