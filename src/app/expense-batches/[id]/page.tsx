"use client";

import { format } from "date-fns";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  HelpCircle,
  Loader2,
  RefreshCw,
  Tag,
} from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  remarks: string | null;
  created_at: string;
}

interface ExpenseItem {
  id: string;
  expense_name: string;
  expense_category: string;
  amount: number;
  display_order: number;
}

interface ProposedRow {
  expense_item_id: string;
  expense_date: string;
  expense_category: string;
  expense_name: string;
  amount: number;
}

interface ExpenseDailyLedger {
  id: string;
  expense_date: string;
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
  const [ledgerRows, setLedgerRows] = useState<ExpenseDailyLedger[]>([]);
  const [loading, setLoading] = useState(true);

  // Split-up Generation Flow State
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [dialogStep, setDialogStep] = useState<1 | 2>(1);
  const [proposedLedger, setProposedLedger] = useState<ProposedRow[]>([]);
  const [selectedReviewItemId, setSelectedReviewItemId] = useState<string>("");
  const [savingSplit, setSavingSplit] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Ledger Filter State
  const [categoryFilter, setCategoryFilter] = useState<string>("All");

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

      // Fetch items sorted by display_order
      const { data: itemsData, error: itemsError } = await supabase
        .from("expense_batch_items")
        .select("*")
        .eq("expense_batch_id", batchId)
        .order("display_order", { ascending: true });

      if (itemsError) {
        console.error("Error fetching items:", itemsError);
      }

      setBatch(batchData);
      setItems(itemsData || []);

      // If batch status is generated, fetch the daily ledger split-ups
      if (batchData.status === "generated") {
        const { data: ledgerData, error: ledgerError } = await supabase
          .from("expense_daily_ledger")
          .select("*")
          .eq("expense_batch_id", batchId)
          .order("expense_date", { ascending: true })
          .order("expense_name", { ascending: true });

        if (ledgerError) {
          console.error("Error fetching daily ledger:", ledgerError);
        } else {
          setLedgerRows(ledgerData || []);
        }
      }
    } catch (error) {
      console.error("Error loading batch details:", error);
      alert("Failed to load details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
  }, [batchId, router]);

  // Date sequence helper
  const getDatesInRange = (
    startDateStr: string,
    endDateStr: string,
  ): string[] => {
    const dates = [];
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    const current = new Date(start);
    while (current <= end) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, "0");
      const d = String(current.getDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${d}`);
      current.setDate(current.getDate() + 1);
    }
    return dates;
  };

  // Equal/Random distribution triggers
  const handleGenerateProposals = (method: "equal" | "random") => {
    if (!batch) return;
    const dates = getDatesInRange(
      batch.expense_date_from,
      batch.expense_date_to,
    );
    const N = dates.length;
    if (N === 0) return;

    const proposedRows: ProposedRow[] = [];

    for (const item of items) {
      const total = Number(item.amount);
      let dailyAmounts: number[] = [];

      if (method === "equal") {
        const cents = Math.round(total * 100);
        const base = Math.floor(cents / N);
        const remainder = cents % N;
        const distribution = new Array(N).fill(base);
        for (let i = 0; i < remainder; i++) {
          distribution[i] += 1;
        }
        dailyAmounts = distribution.map((c) => c / 100);
      } else {
        const centsTotal = Math.round(total * 100);
        if (centsTotal <= 0) {
          dailyAmounts = new Array(N).fill(0);
        } else if (N === 1) {
          dailyAmounts = [total];
        } else {
          const cuts: number[] = [];
          for (let i = 0; i < N - 1; i++) {
            cuts.push(Math.floor(Math.random() * (centsTotal + 1)));
          }
          cuts.sort((a, b) => a - b);
          const distribution: number[] = [];
          let prev = 0;
          for (let i = 0; i < N - 1; i++) {
            distribution.push((cuts[i] - prev) / 100);
            prev = cuts[i];
          }
          distribution.push((centsTotal - prev) / 100);
          dailyAmounts = distribution;
        }
      }

      for (let d = 0; d < N; d++) {
        proposedRows.push({
          expense_item_id: item.id,
          expense_date: dates[d],
          expense_category: item.expense_category,
          expense_name: item.expense_name,
          amount: dailyAmounts[d],
        });
      }
    }

    setProposedLedger(proposedRows);
    if (items.length > 0) {
      setSelectedReviewItemId(items[0].id);
    }
    setDialogStep(2);
  };

  // Rebalancing algorithm
  const rebalanceExpenseItem = (
    days: number[],
    editIdx: number,
    newVal: number,
    originalTotal: number,
  ): number[] | null => {
    if (newVal < 0 || newVal > originalTotal) return null;

    const centsTotal = Math.round(originalTotal * 100);
    const centsNewVal = Math.round(newVal * 100);
    const remainingCents = centsTotal - centsNewVal;

    const otherIndices = [];
    for (let i = 0; i < days.length; i++) {
      if (i !== editIdx) {
        otherIndices.push(i);
      }
    }

    if (otherIndices.length === 0) {
      if (centsNewVal !== centsTotal) return null;
      return [newVal];
    }

    const otherCentsList = otherIndices.map((i) => Math.round(days[i] * 100));
    const currentOtherSum = otherCentsList.reduce((sum, c) => sum + c, 0);

    const newOtherCentsList = new Array(otherIndices.length).fill(0);

    if (currentOtherSum > 0) {
      let distributedSum = 0;
      for (let k = 0; k < otherIndices.length; k++) {
        const prop = otherCentsList[k] / currentOtherSum;
        const allocated = Math.floor(remainingCents * prop);
        newOtherCentsList[k] = allocated;
        distributedSum += allocated;
      }
      let remainder = remainingCents - distributedSum;
      const step = remainder > 0 ? 1 : -1;
      let idx = 0;
      while (remainder !== 0) {
        newOtherCentsList[idx % otherIndices.length] += step;
        remainder -= step;
        idx++;
      }
    } else {
      const base = Math.floor(remainingCents / otherIndices.length);
      const remainder = remainingCents % otherIndices.length;
      newOtherCentsList.fill(base);
      for (let i = 0; i < remainder; i++) {
        newOtherCentsList[i] += 1;
      }
    }

    const hasNegative = newOtherCentsList.some((c) => c < 0);
    if (hasNegative) {
      let deficit = 0;
      for (let k = 0; k < newOtherCentsList.length; k++) {
        if (newOtherCentsList[k] < 0) {
          deficit += newOtherCentsList[k];
          newOtherCentsList[k] = 0;
        }
      }

      let iterations = 0;
      while (deficit < 0 && iterations < 1000) {
        iterations++;
        const positiveIndices = [];
        for (let k = 0; k < newOtherCentsList.length; k++) {
          if (newOtherCentsList[k] > 0) {
            positiveIndices.push(k);
          }
        }
        if (positiveIndices.length === 0) {
          return null;
        }
        for (const posIdx of positiveIndices) {
          if (deficit < 0) {
            newOtherCentsList[posIdx] -= 1;
            deficit += 1;
          }
        }
      }
    }

    const result = [...days];
    result[editIdx] = newVal;
    for (let k = 0; k < otherIndices.length; k++) {
      result[otherIndices[k]] = newOtherCentsList[k] / 100;
    }

    return result;
  };

  const handleProposedAmountChange = (
    expenseItemId: string,
    date: string,
    newValStr: string,
  ) => {
    const newVal = parseFloat(newValStr) || 0;
    if (newVal < 0) return;

    const itemRows = proposedLedger.filter(
      (r) => r.expense_item_id === expenseItemId,
    );
    const editIdx = itemRows.findIndex((r) => r.expense_date === date);
    if (editIdx === -1) return;

    const originalItem = items.find((it) => it.id === expenseItemId);
    if (!originalItem) return;
    const originalTotal = Number(originalItem.amount);

    const dailyAmounts = itemRows.map((r) => r.amount);

    const balancedAmounts = rebalanceExpenseItem(
      dailyAmounts,
      editIdx,
      newVal,
      originalTotal,
    );

    if (!balancedAmounts) return;

    const updatedProposed = proposedLedger.map((row) => {
      if (row.expense_item_id === expenseItemId) {
        const idx = itemRows.findIndex(
          (r) => r.expense_date === row.expense_date,
        );
        return {
          ...row,
          amount: balancedAmounts[idx],
        };
      }
      return row;
    });

    setProposedLedger(updatedProposed);
  };

  const handleSaveSplits = async () => {
    setSavingSplit(true);
    setModalError(null);
    try {
      const res = await fetch("/api/save-expense-split-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: batchId,
          ledgerRows: proposedLedger,
        }),
      });

      const data = await res.json();
      setSavingSplit(false);

      if (!res.ok) {
        setModalError(data.message || "Failed to save daily split-up.");
        return;
      }

      setIsDialogOpen(false);
      await fetchDetails();
    } catch (err: any) {
      setSavingSplit(false);
      setModalError(err.message || "An unexpected error occurred.");
    }
  };

  const uniqueCategories = [
    "All",
    ...Array.from(new Set(ledgerRows.map((r) => r.expense_category))),
  ];

  const filteredLedgerRows = ledgerRows.filter(
    (row) =>
      categoryFilter === "All" || row.expense_category === categoryFilter,
  );

  const totalFilteredLedger = filteredLedgerRows.reduce(
    (sum, r) => sum + Number(r.amount),
    0,
  );

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

  const reviewItemRows = proposedLedger.filter(
    (r) => r.expense_item_id === selectedReviewItemId,
  );
  const reviewItemSum = reviewItemRows.reduce((sum, r) => sum + r.amount, 0);
  const selectedOriginalItem = items.find(
    (it) => it.id === selectedReviewItemId,
  );

  return (
    <div className="space-y-6">
      {/* Header and Back Button */}
      <div className="flex items-center justify-between">
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
              {batch.batch_name || "Expense Batch Details"}
            </h1>
            <p className="text-slate-500 font-mono text-xs mt-0.5">
              ID: {batch.id.substring(0, 8).toUpperCase()}
            </p>
          </div>
        </div>

        {/* Generate split-up triggers only when status is pending */}
        {batch.status === "pending" && (
          <Button
            onClick={() => {
              setDialogStep(1);
              setModalError(null);
              setIsDialogOpen(true);
            }}
            className="gap-2 shadow-sm font-semibold"
          >
            <RefreshCw className="h-4 w-4" /> Generate Split-up
          </Button>
        )}
      </div>

      {/* Remarks Section */}
      {batch.remarks && (
        <Card className="shadow-sm border-l-4 border-slate-900 bg-slate-50/50">
          <CardHeader className="py-2.5 pb-1">
            <CardTitle className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Remarks / Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-3 text-sm text-slate-700">
            {batch.remarks}
          </CardContent>
        </Card>
      )}

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
              <span className="font-semibold uppercase text-slate-700">
                {batch.status}
              </span>
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

      {/* Daily Split-up Section (Visible only when status is 'generated') */}
      {batch.status === "generated" && (
        <Card className="shadow-sm">
          <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b pb-4">
            <div>
              <CardTitle>Daily Split-up Ledger</CardTitle>
              <p className="text-xs text-slate-500 mt-1">
                Day-wise distribution of operating expenses across the period.
              </p>
            </div>
            {/* Category Filter Dropdown */}
            <div className="flex items-center gap-2">
              <Label
                htmlFor="category-filter"
                className="text-xs text-slate-500 font-medium whitespace-nowrap"
              >
                Filter Category:
              </Label>
              <select
                id="category-filter"
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="flex h-9 rounded-md border border-input bg-white px-3 py-1 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {uniqueCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {filteredLedgerRows.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-sm">
                No ledger records match the selected category.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="overflow-x-auto border rounded-lg">
                  <Table>
                    <TableHeader className="bg-slate-50">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Expense Category</TableHead>
                        <TableHead>Expense Name</TableHead>
                        <TableHead className="text-right">Amount (₹)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredLedgerRows.map((row) => (
                        <TableRow key={row.id} className="hover:bg-slate-50/50">
                          <TableCell className="font-medium text-slate-700">
                            {format(new Date(row.expense_date), "dd/MM/yyyy")}
                          </TableCell>
                          <TableCell>
                            <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700">
                              {row.expense_category}
                            </span>
                          </TableCell>
                          <TableCell className="font-semibold text-slate-800">
                            {row.expense_name}
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold text-slate-900">
                            ₹
                            {row.amount.toLocaleString("en-IN", {
                              minimumFractionDigits: 2,
                            })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {/* Total filter info */}
                <div className="flex justify-end pt-3 border-t text-sm font-semibold text-slate-700 gap-4">
                  <span>Filtered Expenses Sum:</span>
                  <span className="font-mono text-slate-900">
                    ₹
                    {totalFilteredLedger.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Generate Split-up Workflow Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Generate Expense Split-up</DialogTitle>
          </DialogHeader>

          {modalError && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-xs font-semibold">
              {modalError}
            </div>
          )}

          {/* STEP 1: Distribution Option selection */}
          {dialogStep === 1 && (
            <div className="py-6 space-y-6">
              <p className="text-sm text-slate-500">
                Choose a distribution method to allocate the expenses across the
                date period (
                {format(new Date(batch.expense_date_from), "dd/MM/yyyy")} to{" "}
                {format(new Date(batch.expense_date_to), "dd/MM/yyyy")}).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card
                  onClick={() => handleGenerateProposals("equal")}
                  className="hover:border-slate-400 hover:shadow-md cursor-pointer transition-all duration-200 group border"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-bold text-slate-800 flex items-center justify-between">
                      <span>Equal Distribution</span>
                      <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-slate-700 transition-colors" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-slate-500 leading-relaxed">
                    Distributes the total expense amounts equally across each
                    calendar day. Rounded fractions are accumulated and adjusted
                    on the final date.
                  </CardContent>
                </Card>

                <Card
                  onClick={() => handleGenerateProposals("random")}
                  className="hover:border-slate-400 hover:shadow-md cursor-pointer transition-all duration-200 group border"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-bold text-slate-800 flex items-center justify-between">
                      <span>Random Distribution</span>
                      <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-slate-700 transition-colors" />
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-slate-500 leading-relaxed">
                    Randomly distributes amounts per day, ensuring that the
                    total sum matches the expense config value exactly without
                    negative daily amounts.
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* STEP 2: Review and Auto-balancing interface */}
          {dialogStep === 2 && (
            <div className="space-y-4 py-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-slate-50 border rounded-lg">
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="review-item-select"
                    className="text-xs text-slate-500 font-semibold whitespace-nowrap"
                  >
                    Reviewing Expense:
                  </Label>
                  <select
                    id="review-item-select"
                    value={selectedReviewItemId}
                    onChange={(e) => setSelectedReviewItemId(e.target.value)}
                    className="flex h-9 rounded-md border border-input bg-white px-3 py-1 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring font-medium"
                  >
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.expense_name} (₹{it.amount.toLocaleString()})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex gap-4 text-xs font-semibold text-slate-700 sm:text-right">
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">
                      Configured Total
                    </span>
                    <span className="font-mono text-slate-800">
                      ₹
                      {selectedOriginalItem?.amount.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">
                      Proposed Sum
                    </span>
                    <span className="font-mono text-slate-800">
                      ₹
                      {reviewItemSum.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                </div>
              </div>

              {/* Review grid table */}
              <div className="overflow-x-auto border rounded-lg max-h-[300px] overflow-y-auto">
                <Table>
                  <TableHeader className="bg-slate-50 sticky top-0 z-10">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Expense Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right w-48">
                        Daily Amount (₹)
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reviewItemRows.map((row) => (
                      <TableRow key={row.expense_date}>
                        <TableCell className="font-medium text-slate-700 py-2">
                          {format(new Date(row.expense_date), "dd/MM/yyyy")}
                        </TableCell>
                        <TableCell className="py-2">
                          {row.expense_name}
                        </TableCell>
                        <TableCell className="py-2">
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700">
                            {row.expense_category}
                          </span>
                        </TableCell>
                        <TableCell className="py-2 text-right">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={row.amount}
                            onChange={(e) =>
                              handleProposedAmountChange(
                                row.expense_item_id,
                                row.expense_date,
                                e.target.value,
                              )
                            }
                            className="text-right font-mono font-semibold h-8 w-full"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex justify-between items-center text-xs text-slate-400 font-medium">
                <span className="flex items-center gap-1">
                  <HelpCircle className="h-3.5 w-3.5" /> Changing daily amount
                  will automatically rebalance remaining days.
                </span>
                <span className="text-green-600 font-semibold flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Sum totals are
                  mathematically locked
                </span>
              </div>
            </div>
          )}

          <DialogFooter className="border-t pt-4">
            {dialogStep === 2 && (
              <Button
                variant="outline"
                onClick={() => setDialogStep(1)}
                disabled={savingSplit}
              >
                Back to Methods
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => setIsDialogOpen(false)}
              disabled={savingSplit}
            >
              Cancel
            </Button>
            {dialogStep === 2 && (
              <Button onClick={handleSaveSplits} disabled={savingSplit}>
                {savingSplit ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                  </>
                ) : (
                  "Save Daily Split-ups"
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
