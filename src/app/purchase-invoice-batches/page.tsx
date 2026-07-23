"use client";

import { format } from "date-fns";
import { ArrowRight, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";

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
  batch_status: string;
  sheet_link: string | null;
  pdf_link: string | null;
  created_at: string;
  selected_customers?: string[] | null;
  major_customers?: Array<{
    customer_id: string;
    amount: number;
    invoice_count: number;
  }> | null;
  issuing_companies?: {
    company_name: string;
  };
  receiving_companies?: {
    company_name: string;
  };
};

export default function PurchaseInvoiceBatches() {
  const router = useRouter();
  const [batches, setBatches] = useState<InvoiceBatch[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchBatches = async () => {
      setLoading(true);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("invoice_batch")
          .select(
            `
            *,
            issuing_companies:issuing_company_id(company_name),
            receiving_companies:receiving_company_id(company_name),
            suppliers:supplier_id(company_name)
          `,
          )
          .eq("batch_type", "PURCHASE")
          .order("created_at", { ascending: false });

        if (error) {
          console.error("Error fetching batches:", error);
          alert("Failed to load purchase invoice batches.");
          return;
        }

        setBatches(data || []);
      } catch (error) {
        console.error("Error:", error);
        alert("An error occurred while loading purchase batches.");
      } finally {
        setLoading(false);
      }
    };

    fetchBatches();
  }, []);

  const handleDeleteBatch = async (id: string) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this purchase invoice batch? This action cannot be undone.",
      )
    )
      return;

    try {
      const supabase = createClient();

      // Delete associated invoices first
      await supabase.from("invoice").delete().eq("invoice_batch_id", id);

      // Delete the batch itself
      const { error } = await supabase
        .from("invoice_batch")
        .delete()
        .eq("id", id);

      if (error) throw error;

      // Update the UI
      setBatches(batches.filter((b) => b.id !== id));
      alert("Purchase invoice batch deleted successfully.");
    } catch (error) {
      console.error("Error deleting batch:", error);
      alert("Failed to delete purchase invoice batch.");
    }
  };

  const getStatusBadge = (status: string | null) => {
    if (!status) return <Badge variant="secondary">Unknown</Badge>;

    const statusColors: Record<
      string,
      "default" | "secondary" | "destructive" | "outline"
    > = {
      pending: "secondary",
      generated: "default",
      completed: "default",
    };

    return (
      <Badge variant={statusColors[status] || "outline"}>
        {status.toUpperCase()}
      </Badge>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-slate-900 mb-6">
        Purchase Invoice Batches
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>All Purchase Invoice Batches</CardTitle>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">No purchase invoice batches found.</p>
              <p className="text-slate-500 max-w-sm mx-auto">
                Create your first batch from the Purchase Invoice page.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice Type</TableHead>
                    <TableHead>Company Making Purchase</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Date Range</TableHead>
                    <TableHead className="text-right">Total Amount</TableHead>
                    <TableHead className="text-right">Invoice Range</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((batch: any) => (
                    <TableRow
                      key={batch.id}
                      className="cursor-pointer hover:bg-slate-50 transition-colors"
                      onClick={() =>
                        router.push(`/invoice-batches/${batch.id}`)
                      }
                    >
                      <TableCell className="font-medium uppercase">
                        {batch.batch_type || "—"}
                      </TableCell>
                      <TableCell className="font-medium">
                        {batch.issuing_companies?.company_name || "—"}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const selectedCount =
                            batch.selected_customers?.length || 0;
                          const majorCount = batch.major_customers?.length || 0;
                          const totalCount = selectedCount + majorCount;
                          if (totalCount > 1) {
                            return (
                              <Badge
                                variant="outline"
                                className="font-semibold text-slate-700 bg-slate-50 border-slate-200"
                              >
                                Multiple Suppliers ({totalCount})
                              </Badge>
                            );
                          }
                          return (
                            batch.suppliers?.company_name ||
                            batch.receiving_companies?.company_name ||
                            "—"
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        {format(
                          new Date(batch.invoice_date_from),
                          "dd/MM/yyyy",
                        )}{" "}
                        -{" "}
                        {format(new Date(batch.invoice_date_to), "dd/MM/yyyy")}
                      </TableCell>
                      <TableCell className="text-right">
                        ₹
                        {batch.total_amount.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        ₹
                        {batch.minimum_invoice_amount.toLocaleString("en-IN", {
                          minimumFractionDigits: 0,
                        })}
                        {" - "}₹
                        {batch.maximum_invoice_amount.toLocaleString("en-IN", {
                          minimumFractionDigits: 0,
                        })}
                      </TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>

                      <TableCell>
                        {format(new Date(batch.created_at), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right flex items-center justify-end gap-2">
                        <button
                          className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteBatch(batch.id);
                          }}
                          title="Delete Batch"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        <ArrowRight className="h-4 w-4 text-slate-400" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
