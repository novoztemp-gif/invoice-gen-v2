"use client";

import { format } from "date-fns";
import { ArrowLeft, Calendar, FileText, Loader2, Tag } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
  financial_year: string;
  expense_date_from: string;
  expense_date_to: string;
  total_amount: number;
  status: string;
  created_at: string;
}

interface ExpenseItem {
  id: string;
  expense_name: string;
  expense_category: string;
  amount: number;
}

export default function ExpenseBatchDetails() {
  const params = useParams();
  const router = useRouter();
  const batchId = params.id as string;

  const [batch, setBatch] = useState<ExpenseBatch | null>(null);
  const [items, setItems] = useState<ExpenseItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDetails = async () => {
      if (!batchId) return;
      setLoading(true);
      try {
        const supabase = createClient();

        // Fetch Batch Metadata
        const { data: batchData, error: batchError } = await supabase
          .from("expense_batch")
          .select("*")
          .eq("id", batchId)
          .single();

        if (batchError || !batchData) {
          console.error("Error fetching expense batch:", batchError);
          alert("Expense batch not found.");
          router.push("/expense-batches");
          return;
        }

        // Fetch items
        const { data: itemsData, error: itemsError } = await supabase
          .from("expense_batch_items")
          .select("*")
          .eq("expense_batch_id", batchId)
          .order("amount", { ascending: false });

        if (itemsError) {
          console.error("Error fetching items:", itemsError);
        }

        setBatch(batchData);
        setItems(itemsData || []);
      } catch (error) {
        console.error("Error loading batch details:", error);
        alert("Failed to load details.");
      } finally {
        setLoading(false);
      }
    };

    fetchDetails();
  }, [batchId, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!batch) {
    return (
      <div className="text-center py-12 text-slate-500">
        <p className="text-lg">Batch not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header and Back Button */}
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="icon"
          onClick={() => router.push("/expense-batches")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            Expense Batch Details
          </h1>
          <p className="text-slate-500 font-mono text-sm mt-0.5">
            EB-{batch.id.substring(0, 8).toUpperCase()}
          </p>
        </div>
      </div>

      {/* Grid summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Date Range Card */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-500 flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-slate-400" /> Date Period
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-bold text-slate-800">
              {format(new Date(batch.expense_date_from), "dd MMM yyyy")} -{" "}
              {format(new Date(batch.expense_date_to), "dd MMM yyyy")}
            </p>
            <span className="text-xs text-slate-400 block mt-1">
              Financial Year: FY{batch.financial_year}
            </span>
          </CardContent>
        </Card>

        {/* Items Card */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-500 flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-slate-400" /> Total Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-slate-800">{items.length}</p>
            <span className="text-xs text-slate-400 block mt-1">
              Recorded in this batch
            </span>
          </CardContent>
        </Card>

        {/* Total Expenses Card */}
        <Card className="shadow-sm border-l-4 border-slate-900 bg-slate-50/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-slate-500 flex items-center gap-1.5">
              <Tag className="h-4 w-4 text-slate-400" /> Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-mono font-bold text-slate-900">
              ₹
              {batch.total_amount.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
            <span className="text-xs text-slate-400 block mt-1">
              Status:{" "}
              <span className="font-semibold uppercase">{batch.status}</span>
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Expense Items Breakdown */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Recorded Expenses</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12 text-center">#</TableHead>
                  <TableHead>Expense Category</TableHead>
                  <TableHead>Expense Name</TableHead>
                  <TableHead className="text-right">Amount (₹)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item, idx) => (
                  <TableRow key={item.id} className="hover:bg-slate-50/30">
                    <td className="text-center font-semibold text-slate-400 py-3">
                      {idx + 1}
                    </td>
                    <td className="py-3">
                      <span className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                        {item.expense_category}
                      </span>
                    </td>
                    <td className="py-3 font-medium text-slate-800">
                      {item.expense_name}
                    </td>
                    <td className="py-3 text-right font-mono font-semibold text-slate-900">
                      ₹
                      {item.amount.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
