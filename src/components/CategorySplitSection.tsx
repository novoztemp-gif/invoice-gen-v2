"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tag, CheckCircle2, AlertCircle } from "lucide-react";
import { useEffect } from "react";

export interface CategorySplitItem {
  category_name: "Meat" | "Fruits";
  percentage: number;
  amount: number;
}

interface CategorySplitSectionProps {
  totalAmount: string | number;
  value: CategorySplitItem[];
  onChange: (splits: CategorySplitItem[]) => void;
}

export function CategorySplitSection({
  totalAmount,
  value,
  onChange,
}: CategorySplitSectionProps) {
  const numericTotal =
    typeof totalAmount === "number"
      ? totalAmount
      : parseFloat(totalAmount) || 0;

  // Initialize or ensure fixed Meat and Fruits splits
  const meatSplit = value.find((v) => v.category_name === "Meat") || {
    category_name: "Meat" as const,
    percentage: 70,
    amount: Math.round(numericTotal * 0.7 * 100) / 100,
  };

  const fruitSplit = value.find((v) => v.category_name === "Fruits") || {
    category_name: "Fruits" as const,
    percentage: 30,
    amount: Math.round(numericTotal * 0.3 * 100) / 100,
  };

  useEffect(() => {
    if (value.length !== 2 || !value.some((v) => v.category_name === "Meat")) {
      const meatPct = 70;
      const fruitPct = 30;
      onChange([
        {
          category_name: "Meat",
          percentage: meatPct,
          amount: Math.round(numericTotal * (meatPct / 100) * 100) / 100,
        },
        {
          category_name: "Fruits",
          percentage: fruitPct,
          amount: Math.round(numericTotal * (fruitPct / 100) * 100) / 100,
        },
      ]);
    }
  }, [numericTotal]);

  const handleMeatChange = (newMeatPct: number) => {
    const meatPct = Math.max(0, Math.min(100, newMeatPct || 0));
    const fruitPct = 100 - meatPct;

    const meatAmt = Math.round(numericTotal * (meatPct / 100) * 100) / 100;
    const fruitAmt = Math.round((numericTotal - meatAmt) * 100) / 100;

    onChange([
      { category_name: "Meat", percentage: meatPct, amount: meatAmt },
      { category_name: "Fruits", percentage: fruitPct, amount: fruitAmt },
    ]);
  };

  const handleFruitChange = (newFruitPct: number) => {
    const fruitPct = Math.max(0, Math.min(100, newFruitPct || 0));
    const meatPct = 100 - fruitPct;

    const fruitAmt = Math.round(numericTotal * (fruitPct / 100) * 100) / 100;
    const meatAmt = Math.round((numericTotal - fruitAmt) * 100) / 100;

    onChange([
      { category_name: "Meat", percentage: meatPct, amount: meatAmt },
      { category_name: "Fruits", percentage: fruitPct, amount: fruitAmt },
    ]);
  };

  const totalPercentage = meatSplit.percentage + fruitSplit.percentage;
  const is100Percent = Math.abs(totalPercentage - 100) < 0.01;

  return (
    <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
      <CardHeader className="p-3 pb-2 border-b border-slate-100 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-slate-600" />
          <CardTitle className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
            Category Split (Meat & Fruits Allocation)
          </CardTitle>
        </div>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {is100Percent ? (
            <span className="flex items-center gap-1 text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5" /> Total Split: 100% (₹
              {numericTotal.toLocaleString()})
            </span>
          ) : (
            <span className="flex items-center gap-1 text-amber-600 font-semibold bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
              <AlertCircle className="w-3.5 h-3.5" /> Total Split:{" "}
              {totalPercentage}% (Must sum to 100%)
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-3.5">
        <p className="text-xs text-slate-500 mb-3">
          Distribute total billing amount between Meat and Fruits categories.
          Invoices generated for Meat and Fruits remain completely independent.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Meat Split */}
          <div className="p-3.5 rounded-lg border border-rose-200 bg-rose-50/50 flex items-center justify-between gap-3">
            <div>
              <span className="font-bold text-rose-900 text-xs block">
                Meat Allocation
              </span>
              <span className="text-[11px] text-rose-700 font-mono block mt-0.5 font-semibold">
                Monetary: ₹{meatSplit.amount.toLocaleString()}
              </span>
            </div>

            <div className="flex items-center gap-1.5 w-28">
              <Label htmlFor="meat-pct" className="sr-only">
                Meat %
              </Label>
              <Input
                id="meat-pct"
                type="number"
                min="0"
                max="100"
                step="1"
                value={meatSplit.percentage}
                onChange={(e) =>
                  handleMeatChange(parseFloat(e.target.value) || 0)
                }
                className="h-8 text-xs bg-white text-right font-bold text-rose-900 border-rose-300"
              />
              <span className="font-bold text-rose-900">%</span>
            </div>
          </div>

          {/* Fruits Split */}
          <div className="p-3.5 rounded-lg border border-amber-200 bg-amber-50/50 flex items-center justify-between gap-3">
            <div>
              <span className="font-bold text-amber-900 text-xs block">
                Fruits Allocation
              </span>
              <span className="text-[11px] text-amber-700 font-mono block mt-0.5 font-semibold">
                Monetary: ₹{fruitSplit.amount.toLocaleString()}
              </span>
            </div>

            <div className="flex items-center gap-1.5 w-28">
              <Label htmlFor="fruit-pct" className="sr-only">
                Fruits %
              </Label>
              <Input
                id="fruit-pct"
                type="number"
                min="0"
                max="100"
                step="1"
                value={fruitSplit.percentage}
                onChange={(e) =>
                  handleFruitChange(parseFloat(e.target.value) || 0)
                }
                className="h-8 text-xs bg-white text-right font-bold text-amber-900 border-amber-300"
              />
              <span className="font-bold text-amber-900">%</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
