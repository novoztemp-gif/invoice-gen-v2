"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
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
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowLeft, ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import fetchJobStats from "./actions";

type InvoiceBatch = {
  id: string;
  issuing_company_id: string;
  receiving_company_id: string;
  invoice_type: string;
  transport_mode: string;
  vehicle_number: string;
  date_of_supply: string;
  invoice_date_from: string;
  invoice_date_to: string;
  threshold_limit: number;
  total_amount: number;
  status: string | null;
  sheet_link: string | null;
  pdf_link: string | null;
  created_at: string;
  products?: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    unit_of_measure: string;
    perDayQtyMin: string;
    perDayQtyMax: string;
    perDayRateMin: string;
    perDayRateMax: string;
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

  const [batch, setBatch] = useState<InvoiceBatch | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>(
    {},
  );
  const [jobStats, setJobStats] = useState({
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  });
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false);
  const [sheetLink, setSheetLink] = useState("");
  const [sheetLinkError, setSheetLinkError] = useState("");
  const [validatingPermissions, setValidatingPermissions] = useState(false);

  const fetchBatchDetails = async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("invoice_batch")
        .select(
          `
          *,
          issuing_companies:issuing_company_id(company_name),
          receiving_companies:receiving_company_id(company_name)
        `,
        )
        .eq("id", batchId)
        .single();

      if (error) {
        console.error("Error fetching batch:", error);
        alert("Failed to load batch details.");
        return;
      }

      setBatch(data);
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvoices = async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("invoice")
        .select("*")
        .eq("invoice_batch_id", batchId)
        .order("invoice_date", { ascending: true });

      if (error) {
        console.error("Error fetching invoices:", error);
        return;
      }

      setInvoices(data || []);

      // Expand all dates by default
      if (data && data.length > 0) {
        const uniqueDates = [...new Set(data.map((inv) => inv.invoice_date))];
        const expanded: Record<string, boolean> = {};
        uniqueDates.forEach((date) => {
          expanded[date] = true;
        });
        setExpandedDates(expanded);
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  const updateJobStats = async () => {
    if (invoices.length > 0) {
      const invoiceIds = invoices.map((inv) => inv.id);
      const stats = await fetchJobStats(invoiceIds, batchId);
      setJobStats(stats);
    } else {
      setJobStats({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      });
    }
  };

  const handleGenerateSplitups = async () => {
    setGenerating(true);
    try {
      const response = await fetch("/api/generate-invoice-splitups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchId,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        alert(result.message || "Invoice splitups generated successfully!");

        await fetchInvoices();
        await fetchBatchDetails();
        await updateJobStats();
      } else {
        alert(result.message || "Failed to generate invoice splitups.");
      }
    } catch (error) {
      console.error("Error generating splitups:", error);
      alert("An error occurred while generating splitups.");
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateSheet = async () => {
    // Validate URL format
    const urlPattern =
      /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)\/edit$/;
    const match = sheetLink.match(urlPattern);

    if (!match) {
      setSheetLinkError(
        "Invalid Google Sheets URL format. Expected: https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit",
      );
      return;
    }

    const spreadsheetId = match[1];
    setSheetLinkError("");
    setValidatingPermissions(true);

    try {
      // Check permissions using the server-side API
      const permissionsResponse = await fetch("/api/check-permissions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheetId }),
      });

      const permissionsData = await permissionsResponse.json();

      if (!permissionsResponse.ok || !permissionsData.hasAccess) {
        setSheetLinkError(
          permissionsData.message ||
            "Failed to validate spreadsheet permissions.",
        );
        return;
      }

      const accessToken = permissionsData.accessToken;

      // If we get here, permissions are valid
      setSheetDialogOpen(false);
      setGeneratingSheet(true);

      const generateResponse = await fetch("/api/generate-sheets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchId,
          masterSheetLink: sheetLink,
        }),
      });

      const result = await generateResponse.json();

      if (generateResponse.ok) {
        alert(result.message || "Sheets generated successfully!");
        setSheetLink(""); // Reset the form
      } else {
        alert(result.message || "Failed to generate Sheets.");
      }
    } catch (error) {
      console.error("Error validating permissions:", error);
      setSheetLinkError(
        "Failed to validate spreadsheet permissions. Please try again.",
      );
    } finally {
      setValidatingPermissions(false);
      setGeneratingSheet(false);
    }
  };

  const getAccessToken = async (): Promise<string> => {
    // This is a simplified version - in a real app you'd get this from your auth system
    // For now, we'll make a request to get the token
    const response = await fetch("/api/get-access-token", {
      method: "GET",
    });

    if (!response.ok) {
      throw new Error("Failed to get access token");
    }

    const data = await response.json();
    return data.access_token;
  };

  useEffect(() => {
    fetchBatchDetails();
    fetchInvoices();
  }, []);

  useEffect(() => {
    if (invoices.length > 0) {
      updateJobStats();
      // Refresh job stats every 5 seconds
      const interval = setInterval(updateJobStats, 5000);
      return () => clearInterval(interval);
    }
  }, [invoices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

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
    (sum, inv) => sum + inv.total_amount,
    0,
  );

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

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => ({
      ...prev,
      [date]: !prev[date],
    }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div
            onClick={() => router.push("/invoice-batches")}
            className="cursor-pointer"
          >
            <ArrowLeft className="h-5 w-5 mr-2" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Batch Details</h1>
          {batch.status && (
            <Badge
              variant={
                batch.status === "generated" || batch.status === "completed"
                  ? "default"
                  : batch.status === "failed"
                    ? "destructive"
                    : "secondary"
              }
            >
              {batch.status.toUpperCase()}
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
            {/* Generate Sheets Button */}
            <Dialog open={sheetDialogOpen} onOpenChange={setSheetDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  disabled={
                    batch.status === "completed" ||
                    jobStats.pending > 0 ||
                    jobStats.processing > 0
                  }
                >
                  Generate Sheets
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>Generate Invoice Sheets</DialogTitle>
                  <DialogDescription>
                    Enter the Google Sheets URL where you want to generate the
                    invoice sheets. All invoices in this batch will be created
                    as separate tabs in this spreadsheet.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="sheet-link">Google Sheets URL</Label>
                    <Input
                      id="sheet-link"
                      placeholder="https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit"
                      value={sheetLink}
                      onChange={(e) => {
                        setSheetLink(e.target.value);
                        setSheetLinkError("");
                      }}
                      className={sheetLinkError ? "border-red-500" : ""}
                    />
                    {sheetLinkError && (
                      <p className="text-sm text-red-600">{sheetLinkError}</p>
                    )}
                    <p className="text-xs text-slate-500">
                      Make sure to share the spreadsheet with edit permissions
                      for the service account.
                    </p>
                    <div className="mt-2 p-2 bg-slate-50 rounded border">
                      <p className="text-xs text-slate-600 font-medium">
                        Service Account Email:
                      </p>
                      <p className="text-xs font-mono text-slate-800 select-all">
                        {process.env.NEXT_PUBLIC_GOOGLE_SERVICE_ACCOUNT_EMAIL ||
                          ""}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-3">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSheetDialogOpen(false);
                      setSheetLink("");
                      setSheetLinkError("");
                    }}
                    disabled={validatingPermissions}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleGenerateSheet}
                    disabled={validatingPermissions || !sheetLink.trim()}
                  >
                    {validatingPermissions ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Validating...
                      </>
                    ) : (
                      "Generate Sheets"
                    )}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
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
              <p className="font-medium capitalize">
                {batch.invoice_type || "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Issuing Company</p>
              <p className="font-medium">
                {batch.issuing_companies?.company_name || "—"}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Receiving Company</p>
              <p className="font-medium">
                {batch.receiving_companies?.company_name || "—"}
              </p>
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
                {format(new Date(batch.date_of_supply), "dd/MM/yyyy")}
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
              <p className="text-sm text-slate-500">Threshold Limit</p>
              <p className="font-medium">
                ₹
                {batch.threshold_limit.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
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
                                    {invoice.sheet_link && (
                                      <a
                                        href={invoice.sheet_link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-blue-600 hover:text-blue-800 underline mt-1 inline-block"
                                      >
                                        View Sheet
                                      </a>
                                    )}
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
                                          ₹{product.rate.toFixed(2)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          ₹
                                          {product.amount.toLocaleString(
                                            "en-IN",
                                            {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 2,
                                            },
                                          )}
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
    </div>
  );
}
