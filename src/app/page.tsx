"use client";

import {
  ArrowRight,
  Building2,
  FileText,
  IndianRupee,
  Loader2,
  Package,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";

type DashboardStats = {
  totalBatches: number;
  pendingBatches: number;
  generatedBatches: number;
  totalInvoices: number;
  totalInvoiceAmount: number;
  avgInvoiceAmount: number;
  batchTotalAmount: number;
  issuingCompanies: number;
  receivingCompanies: number;
  totalProducts: number;
  recentBatches: Array<{
    id: string;
    status: string;
    total_amount: number;
    created_at: string;
    batch_type: string;
  }>;
};

type InvoiceTypeStats = {
  totalBatches: number;
  pendingBatches: number;
  generatedBatches: number;
  totalInvoices: number;
  totalInvoiceAmount: number;
  avgInvoiceAmount: number;
  batchTotalAmount: number;
  recentBatches: Array<{
    id: string;
    status: string;
    total_amount: number;
    created_at: string;
    batch_type: string;
  }>;
};

export default function Home() {
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [salesStats, setSalesStats] = useState<InvoiceTypeStats | null>(null);
  const [purchaseStats, setPurchaseStats] = useState<InvoiceTypeStats | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardStats();
  }, []);

  const fetchDashboardStats = async () => {
    try {
      const supabase = createClient();

      // Fetch batches with batch_type
      const { data: batches } = await supabase
        .from("invoice_batch")
        .select("id, status, total_amount, created_at, batch_type")
        .order("created_at", { ascending: false });

      // Fetch invoices
      const { data: invoices } = await supabase
        .from("invoice")
        .select("id, total_amount");

      // Fetch companies
      const { data: issuingCompanies } = await supabase
        .from("issuing_companies")
        .select("id");

      const { data: receivingCompanies } = await supabase
        .from("receiving_companies")
        .select("id");

      // Fetch products
      const { data: products } = await supabase.from("products").select("id");

      // Calculate overall stats
      const totalBatches = batches?.length || 0;
      const pendingBatches =
        batches?.filter((b) => b.status === "pending").length || 0;
      const generatedBatches =
        batches?.filter((b) => b.status === "generated").length || 0;
      const totalInvoices = invoices?.length || 0;
      const totalInvoiceAmount =
        invoices?.reduce((sum, inv) => sum + inv.total_amount, 0) || 0;
      const avgInvoiceAmount =
        totalInvoices > 0 ? totalInvoiceAmount / totalInvoices : 0;
      const batchTotalAmount =
        batches?.reduce((sum, b) => sum + b.total_amount, 0) || 0;
      const totalProducts = products?.length || 0;
      const recentBatches = batches?.slice(0, 5) || [];

      setStats({
        totalBatches,
        pendingBatches,
        generatedBatches,
        totalInvoices,
        totalInvoiceAmount,
        avgInvoiceAmount,
        batchTotalAmount,
        issuingCompanies: issuingCompanies?.length || 0,
        receivingCompanies: receivingCompanies?.length || 0,
        totalProducts,
        recentBatches,
      });

      // Calculate sales stats
      const salesBatches =
        batches?.filter((b) => b.batch_type === "SALES" || !b.batch_type) || [];
      const salesTotalBatches = salesBatches.length;
      const salesPendingBatches = salesBatches.filter(
        (b) => b.status === "pending",
      ).length;
      const salesGeneratedBatches = salesBatches.filter(
        (b) => b.status === "generated",
      ).length;
      const salesBatchTotalAmount = salesBatches.reduce(
        (sum, b) => sum + b.total_amount,
        0,
      );
      const salesRecentBatches = salesBatches.slice(0, 5);

      setSalesStats({
        totalBatches: salesTotalBatches,
        pendingBatches: salesPendingBatches,
        generatedBatches: salesGeneratedBatches,
        totalInvoices: 0, // Will be calculated per-batch in real scenario
        totalInvoiceAmount: 0,
        avgInvoiceAmount: 0,
        batchTotalAmount: salesBatchTotalAmount,
        recentBatches: salesRecentBatches,
      });

      // Calculate purchase stats
      const purchaseBatches =
        batches?.filter((b) => b.batch_type === "PURCHASE") || [];
      const purchaseTotalBatches = purchaseBatches.length;
      const purchasePendingBatches = purchaseBatches.filter(
        (b) => b.status === "pending",
      ).length;
      const purchaseGeneratedBatches = purchaseBatches.filter(
        (b) => b.status === "generated",
      ).length;
      const purchaseBatchTotalAmount = purchaseBatches.reduce(
        (sum, b) => sum + b.total_amount,
        0,
      );
      const purchaseRecentBatches = purchaseBatches.slice(0, 5);

      setPurchaseStats({
        totalBatches: purchaseTotalBatches,
        pendingBatches: purchasePendingBatches,
        generatedBatches: purchaseGeneratedBatches,
        totalInvoices: 0,
        totalInvoiceAmount: 0,
        avgInvoiceAmount: 0,
        batchTotalAmount: purchaseBatchTotalAmount,
        recentBatches: purchaseRecentBatches,
      });
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-600 mt-1">
            Invoice generation system overview
          </p>
        </div>
        <Button
          onClick={() => router.push("/generate-invoice")}
          variant="default"
        >
          <FileText className="mr-2 h-4 w-4" />
          New Batch
        </Button>
      </div>

      {/* Overall Statistics */}
      <Card className="bg-gradient-to-br from-slate-50 to-slate-100 border-slate-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-600 uppercase tracking-wide">
            Overall Statistics
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-slate-600 font-medium">
                Total Batches
              </p>
              <p className="text-2xl font-bold text-slate-900">
                {stats?.totalBatches || 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">Total Amount</p>
              <p className="text-2xl font-bold text-slate-900">
                ₹
                {(stats?.batchTotalAmount || 0).toLocaleString("en-IN", {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                })}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">
                Generated Batches
              </p>
              <p className="text-2xl font-bold text-green-600">
                {stats?.generatedBatches || 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">
                Pending Batches
              </p>
              <p className="text-2xl font-bold text-amber-600">
                {stats?.pendingBatches || 0}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Sales and Purchase */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : (
        <Tabs defaultValue="sales" className="space-y-4">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="sales" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Sales Invoices
            </TabsTrigger>
            <TabsTrigger value="purchase" className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Purchase Invoices
            </TabsTrigger>
          </TabsList>

          {/* Sales Tab */}
          <TabsContent value="sales" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Batches
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <p className="text-3xl font-semibold text-slate-900">
                      {salesStats?.totalBatches || 0}
                    </p>
                    <div className="flex gap-3 text-xs text-slate-600">
                      <span>{salesStats?.generatedBatches || 0} generated</span>
                      <span>•</span>
                      <span>{salesStats?.pendingBatches || 0} pending</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Total Amount
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <p className="text-3xl font-semibold text-slate-900">
                      ₹
                      {(salesStats?.batchTotalAmount || 0).toLocaleString(
                        "en-IN",
                        {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        },
                      )}
                    </p>
                    <p className="text-xs text-slate-600">
                      Combined batch amounts
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Status Distribution
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-8 bg-green-500 rounded"></div>
                      <span className="text-xs text-slate-600">
                        {Math.round(
                          ((salesStats?.generatedBatches || 0) /
                            (salesStats?.totalBatches || 1)) *
                            100,
                        )}
                        % Generated
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-8 bg-amber-500 rounded"></div>
                      <span className="text-xs text-slate-600">
                        {Math.round(
                          ((salesStats?.pendingBatches || 0) /
                            (salesStats?.totalBatches || 1)) *
                            100,
                        )}
                        % Pending
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Recent Sales Batches
                </CardTitle>
              </CardHeader>
              <CardContent>
                {salesStats?.recentBatches &&
                salesStats.recentBatches.length > 0 ? (
                  <div className="space-y-3">
                    {salesStats.recentBatches.map((batch) => (
                      <div
                        key={batch.id}
                        className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                        onClick={() =>
                          router.push(`/invoice-batches/${batch.id}`)
                        }
                      >
                        <div className="flex items-center gap-3">
                          <FileText className="h-4 w-4 text-slate-400" />
                          <div>
                            <p className="text-sm font-medium text-slate-900">
                              {new Date(batch.created_at).toLocaleDateString(
                                "en-IN",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                },
                              )}
                            </p>
                            <p className="text-xs text-slate-500 capitalize">
                              {batch.status}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-slate-900">
                            ₹{batch.total_amount.toLocaleString("en-IN")}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div className="pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => router.push("/invoice-batches")}
                      >
                        View All Batches
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 text-center py-8">
                    No sales batches created yet
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Purchase Tab */}
          <TabsContent value="purchase" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Batches
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <p className="text-3xl font-semibold text-slate-900">
                      {purchaseStats?.totalBatches || 0}
                    </p>
                    <div className="flex gap-3 text-xs text-slate-600">
                      <span>
                        {purchaseStats?.generatedBatches || 0} generated
                      </span>
                      <span>•</span>
                      <span>{purchaseStats?.pendingBatches || 0} pending</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Total Amount
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <p className="text-3xl font-semibold text-slate-900">
                      ₹
                      {(purchaseStats?.batchTotalAmount || 0).toLocaleString(
                        "en-IN",
                        {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        },
                      )}
                    </p>
                    <p className="text-xs text-slate-600">
                      Combined batch amounts
                    </p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-slate-600 uppercase tracking-wide">
                    Status Distribution
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-8 bg-green-500 rounded"></div>
                      <span className="text-xs text-slate-600">
                        {Math.round(
                          ((purchaseStats?.generatedBatches || 0) /
                            (purchaseStats?.totalBatches || 1)) *
                            100,
                        )}
                        % Generated
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-8 bg-amber-500 rounded"></div>
                      <span className="text-xs text-slate-600">
                        {Math.round(
                          ((purchaseStats?.pendingBatches || 0) /
                            (purchaseStats?.totalBatches || 1)) *
                            100,
                        )}
                        % Pending
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Recent Purchase Batches
                </CardTitle>
              </CardHeader>
              <CardContent>
                {purchaseStats?.recentBatches &&
                purchaseStats.recentBatches.length > 0 ? (
                  <div className="space-y-3">
                    {purchaseStats.recentBatches.map((batch) => (
                      <div
                        key={batch.id}
                        className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 -mx-2 px-2 rounded"
                        onClick={() =>
                          router.push(`/invoice-batches/${batch.id}`)
                        }
                      >
                        <div className="flex items-center gap-3">
                          <FileText className="h-4 w-4 text-slate-400" />
                          <div>
                            <p className="text-sm font-medium text-slate-900">
                              {new Date(batch.created_at).toLocaleDateString(
                                "en-IN",
                                {
                                  day: "2-digit",
                                  month: "short",
                                  year: "numeric",
                                },
                              )}
                            </p>
                            <p className="text-xs text-slate-500 capitalize">
                              {batch.status}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-medium text-slate-900">
                            ₹{batch.total_amount.toLocaleString("en-IN")}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div className="pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => router.push("/invoice-batches")}
                      >
                        View All Batches
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 text-center py-8">
                    No purchase batches created yet
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Master Data (Always Visible) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-900">
            Master Data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-slate-400" />
                <span className="text-sm text-slate-700">
                  Issuing Companies
                </span>
              </div>
              <span className="text-sm font-medium text-slate-900">
                {stats?.issuingCompanies || 0}
              </span>
            </div>
            <div className="flex items-center justify-between py-2 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-slate-400" />
                <span className="text-sm text-slate-700">
                  Receiving Customers
                </span>
              </div>
              <span className="text-sm font-medium text-slate-900">
                {stats?.receivingCompanies || 0}
              </span>
            </div>
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-slate-400" />
                <span className="text-sm text-slate-700">Products</span>
              </div>
              <span className="text-sm font-medium text-slate-900">
                {stats?.totalProducts || 0}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
