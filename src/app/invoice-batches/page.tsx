"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowRight, ExternalLink } from "lucide-react";
import { format } from "date-fns";

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
  issuing_companies?: {
    company_name: string;
  };
  receiving_companies?: {
    company_name: string;
  };
};

export default function InvoiceBatches() {
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
            receiving_companies:receiving_company_id(company_name)
          `,
          )
          .order("created_at", { ascending: false });

        if (error) {
          console.error("Error fetching batches:", error);
          alert("Failed to load invoice batches.");
          return;
        }

        setBatches(data || []);
      } catch (error) {
        console.error("Error:", error);
        alert("An error occurred while loading batches.");
      } finally {
        setLoading(false);
      }
    };

    fetchBatches();
  }, []);

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
        Invoice Batches
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>All Invoice Batches</CardTitle>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">No invoice batches found.</p>
              <p className="text-sm mt-2">
                Create your first batch from the Generate Invoice page.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice Type</TableHead>
                    <TableHead>Issuing Company</TableHead>
                    <TableHead>Receiving Company</TableHead>
                    <TableHead>Date Range</TableHead>
                    <TableHead className="text-right">Total Amount</TableHead>
                    <TableHead className="text-right">Threshold</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sheet Link</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((batch) => (
                    <TableRow
                      key={batch.id}
                      className="cursor-pointer hover:bg-slate-50 transition-colors"
                      onClick={() =>
                        router.push(`/invoice-batches/${batch.id}`)
                      }
                    >
                      <TableCell className="font-medium capitalize">
                        {batch.invoice_type || "—"}
                      </TableCell>
                      <TableCell className="font-medium">
                        {batch.issuing_companies?.company_name || "—"}
                      </TableCell>
                      <TableCell>
                        {batch.receiving_companies?.company_name || "—"}
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
                      <TableCell className="text-right">
                        ₹
                        {batch.threshold_limit.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell>
                        {batch.sheet_link ? (
                          <a
                            href={batch.sheet_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-4 w-4" />
                            <span>View</span>
                          </a>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {format(new Date(batch.created_at), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell>
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
