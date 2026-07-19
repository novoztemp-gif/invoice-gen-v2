"use client";

import { format } from "date-fns";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Download,
  Edit3,
  Eye,
  Loader2,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import InvoiceEditor from "@/components/InvoiceEditor";
import InvoicePreview from "@/components/InvoicePreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useInvoiceBatchDetail } from "@/lib/hooks/useInvoiceBatchDetail";
import { triggerDownload } from "@/lib/utils";

type InvoiceBatch = {
  id: string;
  issuing_company_id: string;
  receiving_company_id: string;
  batch_type: string;
  transport_mode: string;
  vehicle_number: string;
  date_of_supply: string;
  invoice_date_from: string;
  invoice_date_to: string;
  minimum_invoice_amount: number;
  maximum_invoice_amount: number;
  total_amount: number;
  status: string | null;
  batch_status?: string;
  sheet_link: string | null;
  pdf_link: string | null;
  created_at: string;
  created_by?: string;
  financial_year?: string;
  finalized_at?: string;
  finalized_by?: string;
  reopened_at?: string;
  reopened_by?: string;
  selected_customers?: string[] | null;
  major_customers?: Array<{
    customer_id: string;
    amount: number;
    invoice_count: number;
  }> | null;
  products?: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    unit_of_measure: string;
    perDayQtyMin: string;
    perDayQtyMax: string;
    perDayRateMin: string;
    perDayRateMax: string;
    occurrencePercentage?: number | null;
  }>;
  issuing_companies?: {
    company_name: string;
  };
  receiving_companies?: {
    company_name: string;
  };
};

type Invoice = {
  id: string;
  invoice_batch_id: string;
  invoice_number: string;
  invoice_date: string;
  products: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    quantity: number;
    rate: number;
    amount: number;
    customer_id?: string;
  }>;
  total_amount: number;
  status: string | null;
  created_at: string;
  sheet_link: string | null;
};

export default function BatchDetail() {
  const params = useParams();
  const router = useRouter();
  const batchId = params.id as string;

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<
    "FINALIZE" | "REOPEN" | null
  >(null);

  const {
    batch,
    invoices,
    receivingCustomers,
    previewIndex,
    setPreviewIndex,
    isEditingMode,
    setIsEditingMode,
    loading,
    generating,
    expandedDates,
    jobStats,
    handleDownloadExcel,
    handleSaveInvoice,
    handleGenerateSplitups,
    handleBatchStatusChange,
    toggleDate,
  } = useInvoiceBatchDetail({ batchId });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  const backPath =
    batch?.batch_type === "PURCHASE"
      ? "/purchase-invoice-batches"
      : "/invoice-batches";

  if (!batch) {
    return (
      <div className="text-center py-12">
        <p className="text-lg text-slate-500">Batch not found.</p>
        <Button
          onClick={() => router.push("/invoice-batches")}
          className="mt-4"
        >
          Go Back
        </Button>
      </div>
    );
  }

  // Calculate statistics
  const totalInvoices = invoices.length;
  const totalInvoiceAmount = invoices.reduce(
    (sum, inv) => sum + Number(inv.total_amount || 0),
    0,
  );

  // If batch_type === "PURCHASE" and invoices are generated, calculate summary stats:
  let purchaseSummary = null;
  if (batch?.batch_type === "PURCHASE" && invoices.length > 0) {
    const productValueMap = new Map<string, number>();
    let totalQty = 0;
    const uniqueProducts = new Set<string>();

    for (const inv of invoices) {
      for (const p of inv.products) {
        uniqueProducts.add(p.product_id);
        const qty = Number(p.quantity || 0);
        const amt = Number(p.amount || 0);
        totalQty += qty;
        productValueMap.set(
          p.product_id,
          (productValueMap.get(p.product_id) || 0) + amt,
        );
      }
    }

    const productValues = Array.from(productValueMap.values());
    const highestProductVal =
      productValues.length > 0 ? Math.max(...productValues) : 0;
    const lowestProductVal =
      productValues.length > 0 ? Math.min(...productValues) : 0;
    const avgRate = totalQty > 0 ? totalInvoiceAmount / totalQty : 0;

    purchaseSummary = {
      totalValue: totalInvoiceAmount,
      totalProducts: uniqueProducts.size,
      totalQuantity: totalQty,
      avgRate: avgRate,
      highestVal: highestProductVal,
      lowestVal: lowestProductVal,
      invoicesCount: invoices.length,
    };
  }

  // Group invoices by date
  const invoicesByDate = invoices.reduce(
    (acc, invoice) => {
      const date = invoice.invoice_date;
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(invoice);
      return acc;
    },
    {} as Record<string, Invoice[]>,
  );

  const dateWiseSummary = Object.entries(invoicesByDate)
    .map(([date, invs]) => ({
      date,
      count: invs.length,
      total: invs.reduce((sum, inv) => sum + inv.total_amount, 0),
      invoices: invs,
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div onClick={() => router.push(backPath)} className="cursor-pointer">
            <ArrowLeft className="h-5 w-5 mr-2" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Batch Details</h1>
          {batch.batch_status && (
            <Badge
              variant={
                batch.batch_status === "FINALIZED"
                  ? "default"
                  : batch.batch_status === "REOPENED"
                    ? "destructive"
                    : "secondary"
              }
              className={
                batch.batch_status === "FINALIZED"
                  ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                  : batch.batch_status === "REOPENED"
                    ? "bg-orange-100 text-orange-800 hover:bg-orange-200"
                    : "bg-blue-100 text-blue-800 hover:bg-blue-200"
              }
            >
              {batch.batch_status}
            </Badge>
          )}
        </div>

        {/* Action Buttons */}
        {invoices.length > 0 && (
          <div className="flex items-center gap-4">
            {/* Job Stats */}
            {(jobStats.pending > 0 ||
              jobStats.processing > 0 ||
              jobStats.completed > 0 ||
              jobStats.failed > 0) && (
              <div className="flex items-center gap-3 text-sm">
                {jobStats.processing > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Processing:</span>
                    <Badge variant="secondary">{jobStats.processing}</Badge>
                  </div>
                )}
                {jobStats.pending > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Pending:</span>
                    <Badge variant="outline">{jobStats.pending}</Badge>
                  </div>
                )}
                {jobStats.completed > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Completed:</span>
                    <Badge variant="default">{jobStats.completed}</Badge>
                  </div>
                )}
                {jobStats.failed > 0 && (
                  <div className="flex items-center gap-1">
                    <span className="font-medium">Failed:</span>
                    <Badge variant="destructive">{jobStats.failed}</Badge>
                  </div>
                )}
              </div>
            )}
            {/* Download ZIP Button */}
            <Button
              onClick={() =>
                triggerDownload(
                  `/api/download-zip?batchId=${params.id}`,
                  `Invoice_Batch_${batch.financial_year || "Batch"}.zip`,
                )
              }
              className="gap-2"
              variant="outline"
            >
              <Download className="h-4 w-4" />
              Download ZIP
            </Button>

            {/* Download Summary Button (Visible only when Finalized) */}
            {batch.batch_status === "FINALIZED" && (
              <Button
                onClick={() =>
                  triggerDownload(
                    `/api/download-summary?id=${params.id}`,
                    `Summary_Batch_${batch.financial_year || "Batch"}.xlsx`,
                  )
                }
                className="gap-2 text-blue-600 border-blue-200 hover:bg-blue-50"
                variant="outline"
              >
                <Download className="h-4 w-4" />
                Download Summary
              </Button>
            )}

            {/* Finalize / Reopen Button */}
            {batch.batch_status === "FINALIZED" ? (
              <Button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmAction("REOPEN");
                  setShowConfirmModal(true);
                }}
                className="gap-2 bg-orange-600 hover:bg-orange-700 text-white"
              >
                Reopen Batch
              </Button>
            ) : (
              <Button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmAction("FINALIZE");
                  setShowConfirmModal(true);
                }}
                className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                Finalize Batch
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Batch Information */}
      <Card>
        <CardHeader>
          <CardTitle>Batch Information</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-slate-500">Invoice Type</p>
              <p className="font-medium uppercase">{batch.batch_type || "—"}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Issuing Company</p>
              <p className="font-medium">
                {batch.issuing_companies?.company_name || "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">
                {batch.batch_type === "PURCHASE"
                  ? "Supplier(s)"
                  : "Receiving Customer(s)"}
              </p>
              <div className="space-y-1 mt-0.5">
                {batch.selected_customers &&
                batch.selected_customers.length > 0 ? (
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 tracking-wide uppercase">
                      {batch.batch_type === "PURCHASE"
                        ? "Regular Supplier"
                        : "Regular"}
                    </span>
                    <p className="font-medium text-sm">
                      {batch.selected_customers
                        .map(
                          (id: string) =>
                            receivingCustomers[id]?.company_name || id,
                        )
                        .join(", ")}
                    </p>
                  </div>
                ) : null}
                {batch.major_customers && batch.major_customers.length > 0 ? (
                  <div>
                    <span className="text-[10px] font-bold text-slate-400 tracking-wide uppercase">
                      {batch.batch_type === "PURCHASE"
                        ? "Major Supplier"
                        : "Major"}
                    </span>
                    <ul className="list-disc list-inside text-sm font-medium">
                      {batch.major_customers.map((m, idx) => (
                        <li key={idx}>
                          {receivingCustomers[m.customer_id]?.company_name ||
                            m.customer_id}
                          : ₹{m.amount.toLocaleString("en-IN")} (
                          {m.invoice_count} invoice
                          {m.invoice_count > 1 ? "s" : ""})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {(!batch.selected_customers ||
                  batch.selected_customers.length === 0) &&
                (!batch.major_customers ||
                  batch.major_customers.length === 0) ? (
                  <p className="font-medium">
                    {batch.receiving_companies?.company_name || "—"}
                  </p>
                ) : null}
              </div>
            </div>
            <div>
              <p className="text-sm text-slate-500">Invoice Date Range</p>
              <p className="font-medium">
                {format(new Date(batch.invoice_date_from), "dd/MM/yyyy")} -{" "}
                {format(new Date(batch.invoice_date_to), "dd/MM/yyyy")}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Date of Supply</p>
              <p className="font-medium">
                {batch.date_of_supply
                  ? format(new Date(batch.date_of_supply), "dd/MM/yyyy")
                  : "As per Invoice Date"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Transport Mode</p>
              <p className="font-medium">{batch.transport_mode}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Vehicle Number</p>
              <p className="font-medium">{batch.vehicle_number}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Invoice Amount Range</p>
              <p className="font-medium">
                ₹
                {batch.minimum_invoice_amount?.toLocaleString("en-IN", {
                  minimumFractionDigits: 0,
                })}
                {" - "}₹
                {batch.maximum_invoice_amount?.toLocaleString("en-IN", {
                  minimumFractionDigits: 0,
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Total Amount</p>
              <p className="font-medium">
                ₹
                {batch.total_amount.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            </div>
          </div>

          {/* Audit Trail */}
          <div className="mt-8 pt-6 border-t border-slate-200">
            <h4 className="text-sm font-semibold text-slate-800 mb-4 uppercase tracking-wider">
              Audit Trail
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                  Created
                </p>
                <p className="font-medium mt-1">
                  {format(new Date(batch.created_at), "dd MMM yyyy, HH:mm")}
                </p>
                <p className="text-sm text-slate-600">
                  User{" "}
                  {batch.created_by ? batch.created_by.slice(0, 8) : "System"}
                </p>
              </div>

              {batch.finalized_at && (
                <div>
                  <p className="text-xs text-emerald-600 uppercase tracking-wider font-semibold">
                    Finalized
                  </p>
                  <p className="font-medium mt-1">
                    {format(new Date(batch.finalized_at), "dd MMM yyyy, HH:mm")}
                  </p>
                  <p className="text-sm text-slate-600">
                    User{" "}
                    {batch.finalized_by
                      ? batch.finalized_by.slice(0, 8)
                      : "Unknown"}
                  </p>
                </div>
              )}

              {batch.reopened_at && (
                <div>
                  <p className="text-xs text-orange-600 uppercase tracking-wider font-semibold">
                    Reopened
                  </p>
                  <p className="font-medium mt-1">
                    {format(new Date(batch.reopened_at), "dd MMM yyyy, HH:mm")}
                  </p>
                  <p className="text-sm text-slate-600">
                    User{" "}
                    {batch.reopened_by
                      ? batch.reopened_by.slice(0, 8)
                      : "Unknown"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Product Configuration */}
      {batch.products && batch.products.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Product Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product Name</TableHead>
                    <TableHead>HSN Code</TableHead>
                    <TableHead>Unit</TableHead>
                    <TableHead className="text-right font-medium">
                      Occurrence %
                    </TableHead>
                    <TableHead className="text-right">Qty Min</TableHead>
                    <TableHead className="text-right">Qty Max</TableHead>
                    <TableHead className="text-right">Rate Min</TableHead>
                    <TableHead className="text-right">Rate Max</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batch.products.map((product, idx) => (
                    <TableRow key={product.product_id || idx}>
                      <TableCell className="font-medium">
                        {product.product_name}
                      </TableCell>
                      <TableCell>{product.hsn_code}</TableCell>
                      <TableCell>{product.unit_of_measure}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {product.occurrencePercentage !== undefined &&
                        product.occurrencePercentage !== null
                          ? `${product.occurrencePercentage}%`
                          : "Default (50%)"}
                      </TableCell>
                      <TableCell className="text-right">
                        {parseFloat(product.perDayQtyMin).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        {parseFloat(product.perDayQtyMax).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        ₹{parseFloat(product.perDayRateMin).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        ₹{parseFloat(product.perDayRateMax).toFixed(2)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Purchase Planning Assistant - Summary Card */}
      {purchaseSummary && (
        <Card className="border border-indigo-200 bg-indigo-50/20 shadow-sm">
          <CardHeader className="pb-3 border-b border-indigo-100">
            <CardTitle className="text-base font-semibold text-indigo-900 flex items-center gap-2">
              Purchase Planning Assistant - Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 text-sm">
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Total Purchase Value
                </span>
                <span className="text-lg font-mono font-bold text-slate-900">
                  ₹
                  {purchaseSummary.totalValue.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Total Quantity Purchased
                </span>
                <span className="text-lg font-mono font-bold text-slate-900">
                  {purchaseSummary.totalQuantity.toLocaleString()} units
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Average Purchase Rate
                </span>
                <span className="text-lg font-mono font-bold text-slate-900">
                  ₹
                  {purchaseSummary.avgRate.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-slate-500 font-medium block">
                  Invoices Generated
                </span>
                <span className="text-lg font-bold text-slate-900">
                  {purchaseSummary.invoicesCount} Invoices
                </span>
              </div>
            </div>

            <hr className="border-indigo-100" />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-xs">
              <div>
                <span className="text-slate-400 block uppercase tracking-wider font-semibold">
                  Total Distinct Products
                </span>
                <span className="font-bold text-sm text-slate-700 mt-1 block">
                  {purchaseSummary.totalProducts} Products
                </span>
              </div>
              <div>
                <span className="text-slate-400 block uppercase tracking-wider font-semibold">
                  Highest Product Value Contribution
                </span>
                <span className="font-mono font-bold text-sm text-slate-700 mt-1 block">
                  ₹
                  {purchaseSummary.highestVal.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block uppercase tracking-wider font-semibold">
                  Lowest Product Value Contribution
                </span>
                <span className="font-mono font-bold text-sm text-slate-700 mt-1 block">
                  ₹
                  {purchaseSummary.lowestVal.toLocaleString("en-IN", {
                    minimumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Invoices Section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Invoice Splitups</CardTitle>
          {invoices.length === 0 && (
            <Button onClick={handleGenerateSplitups} disabled={generating}>
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                "Generate Invoice Splitups"
              )}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">No invoice splitups generated yet.</p>
              <p className="text-sm mt-2">
                Click the button above to generate invoice splitups.
              </p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Detailed Invoices by Date */}
              <div>
                <h3 className="text-lg font-semibold mb-4">
                  Detailed Invoices
                </h3>
                <div className="space-y-4">
                  {dateWiseSummary.map((summary) => {
                    const isExpanded = expandedDates[summary.date];
                    return (
                      <div
                        key={summary.date}
                        className="border rounded-lg overflow-hidden"
                      >
                        <div
                          className="flex items-center justify-between p-4 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors"
                          onClick={() => toggleDate(summary.date)}
                        >
                          <div className="flex items-center gap-3">
                            {isExpanded ? (
                              <ChevronUp className="h-5 w-5 text-slate-600" />
                            ) : (
                              <ChevronDown className="h-5 w-5 text-slate-600" />
                            )}
                            <div>
                              <h4 className="font-semibold text-lg text-slate-700">
                                {format(
                                  new Date(summary.date),
                                  "EEEE, dd MMMM yyyy",
                                )}
                              </h4>
                              <p className="text-sm text-slate-500">
                                {summary.count} invoice
                                {summary.count > 1 ? "s" : ""} • ₹
                                {summary.total.toLocaleString("en-IN", {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                              </p>
                            </div>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="p-4 space-y-4">
                            {summary.invoices.map((invoice) => (
                              <div
                                key={invoice.id}
                                className="border-l-4 border-slate-200 pl-4"
                              >
                                <div className="flex items-center justify-between mb-3">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <h5 className="font-semibold">
                                        {invoice.invoice_number}
                                      </h5>
                                      {invoice.status && (
                                        <Badge
                                          variant={
                                            invoice.status === "generated"
                                              ? "default"
                                              : invoice.status === "completed"
                                                ? "default"
                                                : invoice.status === "failed"
                                                  ? "destructive"
                                                  : "secondary"
                                          }
                                        >
                                          {invoice.status.toUpperCase()}
                                        </Badge>
                                      )}
                                    </div>
                                    {(() => {
                                      const custId =
                                        invoice.products?.[0]?.customer_id;
                                      const custName = custId
                                        ? receivingCustomers[custId]
                                            ?.company_name
                                        : batch.receiving_companies
                                            ?.company_name;
                                      return custName ? (
                                        <p className="text-xs text-slate-500 font-medium mt-0.5">
                                          {batch.batch_type === "PURCHASE"
                                            ? "Supplier: "
                                            : "Customer: "}
                                          {custName}
                                        </p>
                                      ) : null;
                                    })()}
                                  </div>
                                  <div className="text-right">
                                    <p className="text-sm text-slate-500">
                                      Invoice Total
                                    </p>
                                    <p className="text-lg font-bold">
                                      ₹
                                      {invoice.total_amount.toLocaleString(
                                        "en-IN",
                                        {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        },
                                      )}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-4 flex gap-2 w-full">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1 text-blue-600 hover:text-blue-700 hover:bg-blue-50 border-blue-200"
                                    onClick={() => {
                                      setPreviewIndex(
                                        invoices.findIndex(
                                          (inv) => inv.id === invoice.id,
                                        ),
                                      );
                                      setIsEditingMode(false);
                                    }}
                                  >
                                    <Eye className="h-4 w-4 mr-2" />
                                    Preview
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1 text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 border-indigo-200"
                                    onClick={() => {
                                      setPreviewIndex(
                                        invoices.findIndex(
                                          (inv) => inv.id === invoice.id,
                                        ),
                                      );
                                      setIsEditingMode(true);
                                    }}
                                  >
                                    <Edit3 className="h-4 w-4 mr-2" />
                                    Edit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1 text-slate-600 hover:text-slate-900"
                                    onClick={() => handleDownloadExcel(invoice)}
                                    disabled={
                                      !batch?.issuing_companies ||
                                      Object.keys(receivingCustomers).length ===
                                        0
                                    }
                                  >
                                    <Download className="h-4 w-4 mr-2" />
                                    {batch?.batch_type === "PURCHASE"
                                      ? "Download PDF"
                                      : "Download"}
                                  </Button>
                                </div>

                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Product</TableHead>
                                      <TableHead>HSN Code</TableHead>
                                      <TableHead className="text-right">
                                        Quantity
                                      </TableHead>
                                      <TableHead className="text-right">
                                        Rate
                                      </TableHead>
                                      <TableHead className="text-right">
                                        Amount
                                      </TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {invoice.products.map((product) => (
                                      <TableRow
                                        key={`${invoice.id}-${product.product_id}`}
                                      >
                                        <TableCell className="font-medium">
                                          {product.product_name}
                                        </TableCell>
                                        <TableCell>
                                          {product.hsn_code}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          {product.quantity}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          ₹
                                          {Number(product.rate || 0).toFixed(2)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          ₹
                                          {Number(
                                            product.amount || 0,
                                          ).toLocaleString("en-IN", {
                                            minimumFractionDigits: 2,
                                            maximumFractionDigits: 2,
                                          })}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Overall Statistics */}
              {/* {invoices.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-slate-500">
                        Total Invoices
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{totalInvoices}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-slate-500">
                        Total Generated Amount
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">
                        ₹
                        {totalInvoiceAmount.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-slate-500">
                        Batch Total
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">
                        ₹
                        {batch.total_amount.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-slate-500">
                        Difference
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p
                        className={`text-2xl font-bold ${Math.abs(batch.total_amount - totalInvoiceAmount) < 1 ? "text-green-600" : "text-orange-600"}`}
                      >
                        ₹
                        {Math.abs(
                          batch.total_amount - totalInvoiceAmount,
                        ).toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              )} */}
              {/* Date-wise Summary */}
              {/* <div>
                <h3 className="text-lg font-semibold mb-4">
                  Date-wise Summary
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">
                        Number of Invoices
                      </TableHead>
                      <TableHead className="text-right">Total Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dateWiseSummary.map((summary) => (
                      <TableRow key={summary.date}>
                        <TableCell className="font-medium">
                          {format(new Date(summary.date), "dd/MM/yyyy")}
                        </TableCell>
                        <TableCell className="text-right">
                          {summary.count}
                        </TableCell>
                        <TableCell className="text-right">
                          ₹
                          {summary.total.toLocaleString("en-IN", {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-slate-50 font-semibold">
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right">
                        {totalInvoices}
                      </TableCell>
                      <TableCell className="text-right">
                        ₹
                        {totalInvoiceAmount.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div> */}
            </div>
          )}
        </CardContent>
      </Card>
      <InvoicePreview
        isOpen={previewIndex !== null && !isEditingMode}
        onClose={() => setPreviewIndex(null)}
        invoice={
          previewIndex !== null && !isEditingMode
            ? invoices[previewIndex]
            : null
        }
        issuingCompany={batch?.issuing_companies}
        receivingCompany={
          previewIndex !== null && !isEditingMode
            ? invoices[previewIndex].products?.[0]?.customer_id
              ? receivingCustomers[
                  invoices[previewIndex].products[0].customer_id
                ]
              : batch?.receiving_companies
            : null
        }
        batch={batch}
        currentIndex={previewIndex ?? 0}
        totalInvoices={invoices.length}
        onNext={() =>
          setPreviewIndex((p) =>
            p !== null ? Math.min(invoices.length - 1, p + 1) : null,
          )
        }
        onPrev={() =>
          setPreviewIndex((p) => (p !== null ? Math.max(0, p - 1) : null))
        }
      />

      <InvoiceEditor
        isOpen={previewIndex !== null && isEditingMode}
        onClose={() => {
          setPreviewIndex(null);
          setIsEditingMode(false);
        }}
        invoice={
          previewIndex !== null && isEditingMode ? invoices[previewIndex] : null
        }
        batch={batch}
        onSave={handleSaveInvoice}
      />

      {/* Custom Confirmation Modal */}
      {showConfirmModal && confirmAction && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-6 max-w-md w-full shadow-xl border border-slate-200 animate-in fade-in zoom-in duration-200">
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              {confirmAction === "FINALIZE" ? "Finalize" : "Reopen"} Invoice
              Batch
            </h3>
            <p className="text-sm text-slate-600 mb-6 leading-relaxed">
              {confirmAction === "FINALIZE"
                ? "After finalization this batch becomes read-only. To edit again it must be reopened."
                : "Reopening will allow invoices to be edited again."}
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmAction(null);
                }}
                className="h-10 px-4"
              >
                Cancel
              </Button>
              <Button
                className={
                  confirmAction === "FINALIZE"
                    ? "h-10 px-4 bg-emerald-600 hover:bg-emerald-700 text-white"
                    : "h-10 px-4 bg-orange-600 hover:bg-orange-700 text-white"
                }
                onClick={async () => {
                  setShowConfirmModal(false);
                  const actionToRun = confirmAction;
                  setConfirmAction(null);
                  await handleBatchStatusChange(actionToRun);
                }}
              >
                Yes, {confirmAction === "FINALIZE" ? "Finalize" : "Reopen"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
