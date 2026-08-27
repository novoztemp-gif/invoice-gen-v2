"use client";

import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import {
  calendarMonthToFyIndex,
  formatFyLabel,
  fyIndexToCalendarMonth,
  InventorySummaryResult,
  InventorySummaryRow,
  InventorySummaryService,
} from "@/lib/services/InventorySummaryService";
import { ReportExporter } from "@/lib/services/ReportExporter";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Financial year runs April -> March, so the picker lists months in that
// order (fyIndex 1 = April .. 12 = March), not calendar Jan-Dec order.
// The calendar year doesn't matter for the label here (only the month
// name), so any placeholder FY start year works for this lookup.
const FY_MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => {
  const fyIndex = i + 1;
  const { month } = fyIndexToCalendarMonth(2000, fyIndex);
  return { fyIndex, label: MONTH_NAMES[month - 1] };
});

function currentFyStartYear(): number {
  const now = new Date();
  const month = now.getMonth() + 1;
  return month >= 4 ? now.getFullYear() : now.getFullYear() - 1;
}

export default function InventoryDashboardPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"year" | "month">("year");
  const [selectedFyStartYear, setSelectedFyStartYear] = useState<number>(
    currentFyStartYear(),
  );
  const [selectedFyMonthIndex, setSelectedFyMonthIndex] = useState<number>(
    calendarMonthToFyIndex(new Date().getMonth() + 1),
  );
  const [result, setResult] = useState<InventorySummaryResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await InventorySummaryService.compute(supabase, {
          fyStartYear: selectedFyStartYear,
          fyMonthIndex: viewMode === "month" ? selectedFyMonthIndex : undefined,
        });
        if (!cancelled) setResult(data);
      } catch (err) {
        console.error("Error loading inventory summary:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, selectedFyStartYear, selectedFyMonthIndex]);

  const formatQty = (val: number) =>
    val.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const formatMoney = (val: number) =>
    `₹${val.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const totals = result
    ? result.rows.reduce(
        (acc, r) => ({
          purchaseQty: acc.purchaseQty + r.purchaseQty,
          soldQty: acc.soldQty + r.soldQty,
          purchasePrice: acc.purchasePrice + r.purchasePrice,
          soldPrice: acc.soldPrice + r.soldPrice,
          grossProfit: acc.grossProfit + r.grossProfit,
        }),
        {
          purchaseQty: 0,
          soldQty: 0,
          purchasePrice: 0,
          soldPrice: 0,
          grossProfit: 0,
        },
      )
    : null;

  const availableFyYears = result?.availableFyYears?.length
    ? result.availableFyYears
    : [currentFyStartYear()];

  const handleDownload = async () => {
    if (!result) return;
    const rows = result.rows.map((r: InventorySummaryRow) => ({
      date: r.dateLabel,
      carryOnStock: r.carryOnStock,
      purchaseQty: r.purchaseQty,
      soldQty: r.soldQty,
      purchasePrice: r.purchasePrice,
      soldPrice: r.soldPrice,
      leftovers: r.leftovers,
      grossProfit: r.grossProfit,
    }));
    const filename = ReportExporter.generateFilename(
      "Inventory_Summary",
      undefined,
      result.periodLabel,
    );
    await ReportExporter.exportToExcel(
      `Inventory Summary — ${result.periodLabel}`,
      rows,
      [
        { header: "Date", key: "date", width: 20 },
        { header: "Carry-on Stock (KG)", key: "carryOnStock", width: 20 },
        { header: "Purchase Qty (KG)", key: "purchaseQty", width: 18 },
        { header: "Sold Qty (KG)", key: "soldQty", width: 18 },
        { header: "Purchase Price (₹)", key: "purchasePrice", width: 20 },
        { header: "Sold Price (₹)", key: "soldPrice", width: 20 },
        { header: "Leftovers (KG)", key: "leftovers", width: 18 },
        { header: "Gross Profit (₹)", key: "grossProfit", width: 20 },
      ],
      filename,
      { fy: result.periodLabel },
    );
  };

  return (
    <div className="space-y-4 pb-10">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          Inventory Management
        </h1>
        <p className="text-slate-500 text-xs mt-0.5">
          Month-wise and day-wise inventory summary by financial year (April
          – March) — stock, purchases, sales, and gross profit
        </p>
      </div>

      <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 flex-wrap">
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode("year")}
              className={`px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                viewMode === "year"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              Year View
            </button>
            <button
              type="button"
              onClick={() => setViewMode("month")}
              className={`px-3.5 py-1.5 text-xs font-semibold transition-colors border-l border-slate-200 ${
                viewMode === "month"
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              Month View
            </button>
          </div>

          <Select
            value={String(selectedFyStartYear)}
            onValueChange={(v) => setSelectedFyStartYear(parseInt(v, 10))}
          >
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableFyYears.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  FY {formatFyLabel(y)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {viewMode === "month" && (
            <Select
              value={String(selectedFyMonthIndex)}
              onValueChange={(v) => setSelectedFyMonthIndex(parseInt(v, 10))}
            >
              <SelectTrigger className="w-[140px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FY_MONTH_OPTIONS.map((m) => (
                  <SelectItem key={m.fyIndex} value={String(m.fyIndex)}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="flex-1" />

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={handleDownload}
            disabled={!result || loading}
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Download Excel
          </Button>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center min-h-[300px]">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : result ? (
        <Card className="border border-slate-200 shadow-2xs bg-white rounded-md">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader className="bg-slate-50/70">
                  <TableRow className="border-b border-slate-200">
                    <TableHead className="py-2 px-3 font-semibold text-slate-600">
                      Date
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Carry-on Stock
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Purchase Qty
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Sold Qty
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Purchase Price
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Sold Price
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Leftovers
                    </TableHead>
                    <TableHead className="py-2 px-3 font-semibold text-slate-600 text-right">
                      Gross Profit
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow
                      key={row.dateKey}
                      className="border-b border-slate-100"
                    >
                      <TableCell className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                        {row.dateLabel}
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                        {formatQty(row.carryOnStock)} KG
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                        {formatQty(row.purchaseQty)} KG
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                        {formatQty(row.soldQty)} KG
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                        {formatMoney(row.purchasePrice)}
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right text-slate-700">
                        {formatMoney(row.soldPrice)}
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                        {formatQty(row.leftovers)} KG
                      </TableCell>
                      <TableCell
                        className={`py-2 px-3 font-mono text-right font-bold ${
                          row.grossProfit >= 0
                            ? "text-emerald-700"
                            : "text-red-700"
                        }`}
                      >
                        {formatMoney(row.grossProfit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                {totals && (
                  <tfoot>
                    <TableRow className="bg-slate-50 border-t-2 border-slate-300">
                      <TableCell className="py-2 px-3 font-bold text-slate-900">
                        Total
                      </TableCell>
                      <TableCell className="py-2 px-3 text-right text-slate-400">
                        —
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                        {formatQty(totals.purchaseQty)} KG
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                        {formatQty(totals.soldQty)} KG
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                        {formatMoney(totals.purchasePrice)}
                      </TableCell>
                      <TableCell className="py-2 px-3 font-mono text-right font-bold text-slate-900">
                        {formatMoney(totals.soldPrice)}
                      </TableCell>
                      <TableCell className="py-2 px-3 text-right text-slate-400">
                        —
                      </TableCell>
                      <TableCell
                        className={`py-2 px-3 font-mono text-right font-bold ${
                          totals.grossProfit >= 0
                            ? "text-emerald-700"
                            : "text-red-700"
                        }`}
                      >
                        {formatMoney(totals.grossProfit)}
                      </TableCell>
                    </TableRow>
                  </tfoot>
                )}
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
