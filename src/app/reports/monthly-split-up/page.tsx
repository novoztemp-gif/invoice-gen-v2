"use client";

import {
  AlertCircle,
  CalendarRange,
  Download,
  FileDown,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GeneratingModal } from "@/components/GeneratingModal";
import { MonthlySplitUpTable } from "@/components/reports/MonthlySplitUpTable";
import { MonthlySplitUpResult } from "@/lib/services/monthly-splitup/types";
import { DEFAULT_PURCHASE_MARGIN_PERCENT } from "@/lib/services/monthly-splitup/MonthlySplitUpEngine";
import { triggerDownload } from "@/lib/utils";

type Phase = "upload" | "generating" | "results";
type Mode = "purchase" | "sales";

export default function MonthlySplitUpPage() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [mode, setMode] = useState<Mode>("purchase");
  const [result, setResult] = useState<MonthlySplitUpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marginPercent, setMarginPercent] = useState(
    String(DEFAULT_PURCHASE_MARGIN_PERCENT),
  );
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (extension !== "xlsx") {
      setError("Please select a valid Excel file (.xlsx).");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setError(null);
    setFile(selected);
  };

  const handleGenerate = async () => {
    if (!file) return;

    setError(null);
    setPhase("generating");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("marginPercent", marginPercent || "0");

      const response = await fetch("/api/reports/monthly-split-up/generate", {
        method: "POST",
        body: formData,
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.message || "Failed to generate the split-up.");
      }

      setResult(json as MonthlySplitUpResult);
      setMode("purchase");
      setPhase("results");
    } catch (err: any) {
      setError(err?.message || "Something went wrong generating the split-up.");
      setPhase("upload");
    }
  };

  const handleDownload = async () => {
    if (!result) return;
    setDownloading(true);
    try {
      await triggerDownload(
        "/api/reports/monthly-split-up/download",
        `Monthly_SplitUp_${result.financialYear}.xlsx`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        },
      );
    } finally {
      setDownloading(false);
    }
  };

  const handleDownloadTemplate = (kind: "with-purchase" | "no-purchase") => {
    triggerDownload(
      `/api/reports/monthly-split-up/template?type=${kind}`,
      kind === "with-purchase"
        ? "Monthly_SplitUp_Template_With_Purchase.xlsx"
        : "Monthly_SplitUp_Template_No_Purchase.xlsx",
    );
  };

  const handleReset = () => {
    setResult(null);
    setError(null);
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setPhase("upload");
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <GeneratingModal
        open={phase === "generating"}
        label="Computing monthly split-up"
      />

      {phase !== "results" && (
        <div className="max-w-lg mx-auto mt-16">
          <div className="text-center mb-8">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center">
              <CalendarRange className="h-6 w-6 text-slate-600" />
            </div>
            <h1 className="text-xl font-semibold text-slate-900">
              Monthly Split-up
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Upload a financial year's stock &amp; monthly totals Excel file
              to generate a per-product, per-month Purchase and Sales
              split-up.
            </p>
          </div>

          <div className="border border-slate-200 rounded-xl p-6 space-y-5 bg-white">
            <div className="space-y-2">
              <Label htmlFor="splitup-file">Upload Excel File (.xlsx)</Label>
              <Input
                id="splitup-file"
                type="file"
                accept=".xlsx"
                ref={fileInputRef}
                onChange={handleFileChange}
                disabled={phase === "generating"}
                className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:bg-slate-800 file:px-3 file:text-white file:font-medium hover:file:bg-slate-700"
              />
              {file && (
                <p className="text-xs text-slate-500">
                  Selected: <span className="font-medium text-slate-700">{file.name}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="margin-percent">
                Assumed purchase margin %
              </Label>
              <Input
                id="margin-percent"
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={marginPercent}
                onChange={(e) => setMarginPercent(e.target.value)}
                disabled={phase === "generating"}
                className="max-w-[140px]"
              />
              <p className="text-xs text-slate-400">
                Used only for months where the uploaded file has no purchase
                figures — purchase is estimated as sales minus this margin.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
                <span>{error}</span>
              </div>
            )}

            <Button
              className="w-full gap-2"
              disabled={phase === "generating" || !file}
              onClick={handleGenerate}
            >
              <Upload className="h-4 w-4" />
              Generate
            </Button>
          </div>

          <div className="mt-5 border border-slate-200 rounded-xl p-4 bg-white">
            <p className="text-sm font-medium text-slate-700 mb-2.5">
              Need the file layout? Download a template
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 flex-1"
                onClick={() => handleDownloadTemplate("with-purchase")}
              >
                <FileDown className="h-4 w-4" />
                With Purchase Data
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 flex-1"
                onClick={() => handleDownloadTemplate("no-purchase")}
              >
                <FileDown className="h-4 w-4" />
                Without Purchase Data
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === "results" && result && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-slate-900">
                Monthly Split-up
              </h1>
              <Badge variant="secondary">FY {result.financialYear}</Badge>
              {result.purchaseTotalsWereSynthesized && (
                <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                  Purchase estimated ({result.purchaseMarginPercentUsed}% margin)
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "purchase" ? "default" : "ghost"}
                  className="rounded-md"
                  onClick={() => setMode("purchase")}
                >
                  Purchase
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "sales" ? "default" : "ghost"}
                  className="rounded-md"
                  onClick={() => setMode("sales")}
                >
                  Sales
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={handleDownload}
                disabled={downloading}
              >
                <Download className="h-4 w-4" />
                {downloading ? "Preparing..." : "Download Excel"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleReset}
                title="Start over"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <MonthlySplitUpTable
            products={result.products}
            months={result.months}
            matrix={mode === "purchase" ? result.purchaseMatrix : result.salesMatrix}
          />
        </div>
      )}
    </div>
  );
}
