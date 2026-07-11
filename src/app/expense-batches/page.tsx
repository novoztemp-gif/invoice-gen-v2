"use client";

import { format } from "date-fns";
import { ArrowRight, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import { createClient } from "@/lib/supabase/client";

interface ExpenseBatch {
  id: string;
  batch_name: string;
  financial_year: string;
  expense_date_from: string;
  expense_date_to: string;
  total_amount: number;
  status: string;
  created_at: string;
  items_count?: number;
}

export default function ExpenseBatches() {
  const router = useRouter();
  const [batches, setBatches] = useState<ExpenseBatch[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBatches = async () => {
    setLoading(true);
    try {
      const supabase = createClient();

      // Fetch expense batches
      const { data: batchesData, error: batchesError } = await supabase
        .from("expense_batch")
        .select("*")
        .order("created_at", { ascending: false });

      if (batchesError) {
        console.error("Error fetching expense batches:", batchesError);
        alert("Failed to load expense batches.");
        return;
      }

      // Fetch items count per batch
      const { data: itemsCountData, error: itemsError } = await supabase
        .from("expense_batch_items")
        .select("expense_batch_id");

      if (itemsError) {
        console.error("Error fetching items counts:", itemsError);
      }

      const countMap = new Map<string, number>();
      for (const row of itemsCountData || []) {
        countMap.set(
          row.expense_batch_id,
          (countMap.get(row.expense_batch_id) || 0) + 1,
        );
      }

      const formatted = (batchesData || []).map((b) => ({
        ...b,
        items_count: countMap.get(b.id) || 0,
      }));

      setBatches(formatted);
    } catch (error) {
      console.error("Error:", error);
      alert("An error occurred while loading batches.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBatches();
  }, []);

  const handleDeleteBatch = async (id: string) => {
    if (
      !window.confirm(
        "Are you sure you want to delete this expense batch? All associated items will be deleted permanently.",
      )
    )
      return;

    try {
      const supabase = createClient();

      // Cascade constraints handles items deletion automatically
      const { error } = await supabase
        .from("expense_batch")
        .delete()
        .eq("id", id);

      if (error) throw error;

      setBatches(batches.filter((b) => b.id !== id));
      alert("Expense batch deleted successfully.");
    } catch (error) {
      console.error("Error deleting batch:", error);
      alert("Failed to delete expense batch.");
    }
  };

  const getStatusBadge = (status: string) => {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-slate-900">Expense Batches</h1>
        <Button onClick={() => router.push("/generate-expense-batch")}>
          Create Expense Batch
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Expense Batches</CardTitle>
        </CardHeader>
        <CardContent>
          {batches.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg font-medium">No expense batches found.</p>
              <p className="text-slate-400 mt-1 max-w-sm mx-auto">
                Configure your operating expenses by creating a new expense
                batch.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch Name</TableHead>
                    <TableHead>Financial Year</TableHead>
                    <TableHead>Date Range</TableHead>
                    <TableHead className="text-center">Expense Items</TableHead>
                    <TableHead className="text-right">Total Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created Date</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.map((batch) => (
                    <TableRow
                      key={batch.id}
                      className="cursor-pointer hover:bg-slate-50 transition-colors"
                      onClick={() =>
                        router.push(`/expense-batches/${batch.id}`)
                      }
                    >
                      <TableCell className="font-semibold text-slate-800">
                        {batch.batch_name ||
                          `EB-${batch.id.substring(0, 8).toUpperCase()}`}
                      </TableCell>
                      <TableCell className="font-medium text-slate-600">
                        FY{batch.financial_year}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-slate-600">
                        {format(
                          new Date(batch.expense_date_from),
                          "dd/MM/yyyy",
                        )}{" "}
                        -{" "}
                        {format(new Date(batch.expense_date_to), "dd/MM/yyyy")}
                      </TableCell>
                      <TableCell className="text-center font-semibold text-slate-700">
                        {batch.items_count}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold text-slate-900">
                        ₹
                        {batch.total_amount.toLocaleString("en-IN", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell>{getStatusBadge(batch.status)}</TableCell>
                      <TableCell className="text-slate-500 text-xs">
                        {format(new Date(batch.created_at), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-right flex items-center justify-end gap-2">
                        <button
                          type="button"
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
