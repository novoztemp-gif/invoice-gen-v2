"use client";

import { CheckCircle2, Loader2, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface ExpenseItemInput {
  expense_name: string;
  expense_category: string;
  amount: string;
}

const CATEGORIES = [
  "Logistics",
  "Packaging",
  "Payroll",
  "Utilities",
  "Marketing",
  "Maintenance",
  "Travel",
  "General",
];

export default function GenerateExpenseBatch() {
  const router = useRouter();

  // State definitions
  const [financialYearStart, setFinancialYearStart] = useState<number>(2026);
  const [financialYearEnd, setFinancialYearEnd] = useState<number>(2027);
  const [expenseDateFrom, setExpenseDateFrom] = useState<Date | undefined>(
    undefined,
  );
  const [expenseDateTo, setExpenseDateTo] = useState<Date | undefined>(
    undefined,
  );

  const [items, setItems] = useState<ExpenseItemInput[]>([
    { expense_name: "", expense_category: "General", amount: "" },
  ]);

  const [isSaving, setIsSaving] = useState(false);
  const [errorPopup, setErrorPopup] = useState<string | null>(null);

  // Dynamic calculations
  const totalExpenses = items.reduce((sum, item) => {
    const amt = parseFloat(item.amount) || 0;
    return sum + amt;
  }, 0);

  // Handlers
  const handleAddRow = () => {
    setItems([
      ...items,
      { expense_name: "", expense_category: "General", amount: "" },
    ]);
  };

  const handleRemoveRow = (idx: number) => {
    if (items.length === 1) {
      setErrorPopup("At least one expense row is required.");
      return;
    }
    setItems(items.filter((_, i) => i !== idx));
  };

  const handleItemChange = (
    idx: number,
    field: keyof ExpenseItemInput,
    val: string,
  ) => {
    const updated = [...items];
    updated[idx] = {
      ...updated[idx],
      [field]: val,
    };
    setItems(updated);
  };

  const handleSubmit = async () => {
    // 1. Basic Validations
    if (!expenseDateFrom || !expenseDateTo) {
      setErrorPopup("Please select the Date Range (From and To).");
      return;
    }

    if (expenseDateFrom > expenseDateTo) {
      setErrorPopup("Start date cannot be after end date.");
      return;
    }

    if (items.length === 0) {
      setErrorPopup("At least one expense row is required.");
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const row = items[i];
      if (!row.expense_name.trim()) {
        setErrorPopup(`Row ${i + 1} must have an Expense Name.`);
        return;
      }
      const amt = parseFloat(row.amount);
      if (isNaN(amt) || amt <= 0) {
        setErrorPopup(
          `Row ${i + 1} ('${row.expense_name}') must have an amount greater than zero.`,
        );
        return;
      }
    }

    // Format dates for storage YYYY-MM-DD
    const formatDate = (d: Date) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    };

    setIsSaving(true);
    try {
      const res = await fetch("/api/create-expense-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financialYear: `${financialYearStart}-${String(financialYearEnd).slice(2)}`,
          expenseDateFrom: formatDate(expenseDateFrom),
          expenseDateTo: formatDate(expenseDateTo),
          items: items,
        }),
      });

      const result = await res.json();
      setIsSaving(false);

      if (!res.ok) {
        setErrorPopup(result.message || "Failed to create Expense Batch.");
        return;
      }

      setErrorPopup("Expense Batch created successfully!");
      // Redirect on dismiss of popup or setTimeout
      setTimeout(() => {
        setErrorPopup(null);
        router.push("/expense-batches");
      }, 1500);
    } catch (err: any) {
      setIsSaving(false);
      console.error(err);
      setErrorPopup(`Error: ${err.message || "Failed to save batch"}`);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h1 className="text-3xl font-bold text-slate-900">
        Create Expense Batch
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left Side: Configuration Card */}
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Config Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="fy-start">Start Year *</Label>
                <Input
                  id="fy-start"
                  type="number"
                  value={financialYearStart}
                  onChange={(e) => {
                    const s = parseInt(e.target.value) || 2026;
                    setFinancialYearStart(s);
                    setFinancialYearEnd(s + 1);
                  }}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fy-end">End Year</Label>
                <Input
                  id="fy-end"
                  type="number"
                  value={financialYearEnd}
                  disabled
                  className="bg-slate-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Date From *</Label>
                <DatePicker
                  date={expenseDateFrom}
                  onDateChange={setExpenseDateFrom}
                />
              </div>
              <div className="space-y-2">
                <Label>Date To *</Label>
                <DatePicker
                  date={expenseDateTo}
                  onDateChange={setExpenseDateTo}
                />
              </div>
            </div>

            <div className="pt-2 flex justify-between items-center bg-slate-50 p-3 rounded-lg border border-slate-100">
              <span className="text-sm font-medium text-slate-500">
                Live Target Period:
              </span>
              <span className="text-sm font-bold text-slate-800">
                FY{financialYearStart}-{String(financialYearEnd).slice(2)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Right Side: Total Summary */}
        <Card className="shadow-sm border border-slate-200 bg-slate-50/50">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col justify-between h-[200px]">
            <div>
              <span className="text-xs text-slate-500 font-semibold block uppercase tracking-wider">
                Total Operating Expenses
              </span>
              <span className="text-3xl font-mono font-bold text-slate-900 block mt-2">
                ₹
                {totalExpenses.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </span>
            </div>

            <div className="pt-4 border-t">
              <Button
                onClick={handleSubmit}
                disabled={isSaving}
                className="w-full h-11"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving Batch...
                  </>
                ) : (
                  "Create Expense Batch"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dynamic Expense Rows Configuration */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b pb-4">
          <CardTitle>Expense Config Rows</CardTitle>
          <Button onClick={handleAddRow} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" /> Add Row
          </Button>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 uppercase">
                  <th className="px-4 py-3 w-12 text-center">#</th>
                  <th className="px-4 py-3">Expense Name</th>
                  <th className="px-4 py-3 w-48">Category</th>
                  <th className="px-4 py-3 w-48 text-right">Amount (₹)</th>
                  <th className="px-4 py-3 w-16 text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-semibold text-slate-400 text-center">
                      {idx + 1}
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="text"
                        placeholder="e.g. Salary, Electricity, Marketing..."
                        value={row.expense_name}
                        onChange={(e) =>
                          handleItemChange(idx, "expense_name", e.target.value)
                        }
                        required
                        className="h-9 bg-white"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={row.expense_category}
                        onChange={(e) =>
                          handleItemChange(
                            idx,
                            "expense_category",
                            e.target.value,
                          )
                        }
                        className="flex h-9 w-full rounded-md border border-input bg-white px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {CATEGORIES.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        placeholder="0.00"
                        value={row.amount}
                        onChange={(e) =>
                          handleItemChange(idx, "amount", e.target.value)
                        }
                        required
                        className="h-9 font-mono text-right bg-white"
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveRow(idx)}
                        className="text-red-500 hover:text-red-700 hover:bg-red-50 h-8 w-8"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Info Popup Dialog */}
      <Dialog
        open={!!errorPopup}
        onOpenChange={(open) => !open && setErrorPopup(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle
              className={cn(
                "flex items-center gap-2",
                errorPopup?.includes("successfully")
                  ? "text-green-600"
                  : "text-red-600",
              )}
            >
              {errorPopup?.includes("successfully") ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
              {errorPopup?.includes("successfully")
                ? "Success"
                : "Validation Error"}
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-slate-700">{errorPopup}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setErrorPopup(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
