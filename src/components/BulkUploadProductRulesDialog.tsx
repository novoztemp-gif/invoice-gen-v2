"use client";

import React, { useState } from "react";
import * as XLSX from "xlsx";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import {
  Upload,
  Download,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
} from "lucide-react";

export interface ProductWithRule {
  id: string;
  product_name: string;
  hsn_code: string;
  unit_of_measure: string;
  rule?: {
    id: string;
    quantity_min: number;
    quantity_max: number;
    rate_min: number;
    rate_max: number;
  } | null;
}

interface BulkUploadProductRulesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  productsWithRules: ProductWithRule[];
}

export function downloadProductRulesTemplate(
  productsWithRules: ProductWithRule[],
) {
  const rows =
    productsWithRules.length > 0
      ? productsWithRules.slice(0, 5).map((p) => ({
          "Product Name": p.product_name,
          "Minimum Quantity": p.rule?.quantity_min ?? 10,
          "Maximum Quantity": p.rule?.quantity_max ?? 50,
          "Minimum Rate": p.rule?.rate_min ?? 350,
          "Maximum Rate": p.rule?.rate_max ?? 420,
        }))
      : [
          {
            "Product Name": "SARDINES",
            "Minimum Quantity": 10,
            "Maximum Quantity": 50,
            "Minimum Rate": 350,
            "Maximum Rate": 420,
          },
          {
            "Product Name": "POMFRET",
            "Minimum Quantity": 5,
            "Maximum Quantity": 20,
            "Minimum Rate": 500,
            "Maximum Rate": 650,
          },
          {
            "Product Name": "APPLE",
            "Minimum Quantity": 15,
            "Maximum Quantity": 80,
            "Minimum Rate": 90,
            "Maximum Rate": 140,
          },
        ];

  const worksheet = XLSX.utils.json_to_sheet(rows);

  worksheet["!cols"] = [
    { wch: 25 }, // Product Name
    { wch: 18 }, // Minimum Quantity
    { wch: 18 }, // Maximum Quantity
    { wch: 15 }, // Minimum Rate
    { wch: 15 }, // Maximum Rate
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Product Rules");

  XLSX.writeFile(workbook, "product_rules_template.xlsx");
}

export function BulkUploadProductRulesDialog({
  isOpen,
  onClose,
  productsWithRules,
}: BulkUploadProductRulesDialogProps) {
  const router = useRouter();
  const supabase = createClient();

  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [summary, setSummary] = useState<{
    totalRows: number;
    updatedCount: number;
    skippedList: string[];
    errorList: string[];
    validUpdates: {
      productId: string;
      productName: string;
      ruleId?: string;
      quantity_min: number;
      quantity_max: number;
      rate_min: number;
      rate_max: number;
    }[];
  } | null>(null);

  const resetState = () => {
    setFile(null);
    setIsProcessing(false);
    setIsSaving(false);
    setSummary(null);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      processExcelFile(selectedFile);
    }
  };

  const processExcelFile = (uploadedFile: File) => {
    setIsProcessing(true);
    setSummary(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });

        if (workbook.SheetNames.length === 0) {
          setSummary({
            totalRows: 0,
            updatedCount: 0,
            skippedList: [],
            errorList: ["Excel workbook contains no sheets."],
            validUpdates: [],
          });
          setIsProcessing(false);
          return;
        }

        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawRows: any[] = XLSX.utils.sheet_to_json(worksheet, {
          defval: "",
        });

        if (rawRows.length === 0) {
          setSummary({
            totalRows: 0,
            updatedCount: 0,
            skippedList: [],
            errorList: ["Uploaded Excel sheet is empty."],
            validUpdates: [],
          });
          setIsProcessing(false);
          return;
        }

        const skippedList: string[] = [];
        const errorList: string[] = [];
        const validUpdates: {
          productId: string;
          productName: string;
          ruleId?: string;
          quantity_min: number;
          quantity_max: number;
          rate_min: number;
          rate_max: number;
        }[] = [];

        const seenInExcel = new Set<string>();
        let totalRows = 0;

        rawRows.forEach((row, index) => {
          const rowNum = index + 2; // 1-indexed row in Excel

          const productNameKey = Object.keys(row).find((k) =>
            /product\s*name/i.test(k) || /^product$/i.test(k) || /^name$/i.test(k),
          );
          const minQtyKey = Object.keys(row).find((k) =>
            /min(imum)?\s*qty/i.test(k) || /min(imum)?\s*quantity/i.test(k),
          );
          const maxQtyKey = Object.keys(row).find((k) =>
            /max(imum)?\s*qty/i.test(k) || /max(imum)?\s*quantity/i.test(k),
          );
          const minRateKey = Object.keys(row).find((k) =>
            /min(imum)?\s*rate/i.test(k) || /min(imum)?\s*price/i.test(k),
          );
          const maxRateKey = Object.keys(row).find((k) =>
            /max(imum)?\s*rate/i.test(k) || /max(imum)?\s*price/i.test(k),
          );

          const rawProductName = productNameKey ? String(row[productNameKey]).trim() : "";
          const rawMinQty = minQtyKey ? String(row[minQtyKey]).trim() : "";
          const rawMaxQty = maxQtyKey ? String(row[maxQtyKey]).trim() : "";
          const rawMinRate = minRateKey ? String(row[minRateKey]).trim() : "";
          const rawMaxRate = maxRateKey ? String(row[maxRateKey]).trim() : "";

          // Skip completely empty rows
          if (!rawProductName && !rawMinQty && !rawMaxQty && !rawMinRate && !rawMaxRate) {
            return;
          }

          totalRows++;

          if (!rawProductName) {
            errorList.push(`Row ${rowNum}: Product Name is mandatory.`);
            return;
          }

          const normName = rawProductName.toLowerCase();

          // Rule: Detect duplicate Product Names in uploaded Excel
          if (seenInExcel.has(normName)) {
            skippedList.push(`- ${rawProductName} (Duplicate)`);
            return;
          }
          seenInExcel.add(normName);

          // Rule: Match products by Product Name in DB
          const matchedProduct = productsWithRules.find(
            (p) => p.product_name.trim().toLowerCase() === normName,
          );

          if (!matchedProduct) {
            skippedList.push(`- ${rawProductName} (Not Found)`);
            return;
          }

          // Rule: Numeric validation
          const minQty = parseFloat(rawMinQty);
          const maxQty = parseFloat(rawMaxQty);
          const minRate = parseFloat(rawMinRate);
          const maxRate = parseFloat(rawMaxRate);

          if (isNaN(minQty) || isNaN(maxQty) || isNaN(minRate) || isNaN(maxRate)) {
            errorList.push(
              `- ${rawProductName} → All quantity and rate fields must be numeric.`,
            );
            return;
          }

          if (minQty < 0 || maxQty < 0 || minRate < 0 || maxRate < 0) {
            errorList.push(
              `- ${rawProductName} → Quantity and rate values cannot be negative.`,
            );
            return;
          }

          // Rule: Minimum Quantity <= Maximum Quantity
          if (minQty > maxQty) {
            errorList.push(
              `- ${rawProductName} → Min Qty (${minQty}) greater than Max Qty (${maxQty})`,
            );
            return;
          }

          // Rule: Minimum Rate <= Maximum Rate
          if (minRate > maxRate) {
            errorList.push(
              `- ${rawProductName} → Min Rate (${minRate}) greater than Max Rate (${maxRate})`,
            );
            return;
          }

          // Valid rule update
          validUpdates.push({
            productId: matchedProduct.id,
            productName: matchedProduct.product_name,
            ruleId: matchedProduct.rule?.id || undefined,
            quantity_min: minQty,
            quantity_max: maxQty,
            rate_min: minRate,
            rate_max: maxRate,
          });
        });

        setSummary({
          totalRows,
          updatedCount: validUpdates.length,
          skippedList,
          errorList,
          validUpdates,
        });
      } catch (err: any) {
        setSummary({
          totalRows: 0,
          updatedCount: 0,
          skippedList: [],
          errorList: [
            `Failed to parse Excel file: ${err.message || "Invalid file format"}`,
          ],
          validUpdates: [],
        });
      } finally {
        setIsProcessing(false);
      }
    };

    reader.readAsArrayBuffer(uploadedFile);
  };

  const handleApplyImport = async () => {
    if (!summary || summary.validUpdates.length === 0) return;

    setIsSaving(true);
    try {
      for (const item of summary.validUpdates) {
        const payload = {
          product_id: item.productId,
          quantity_min: item.quantity_min,
          quantity_max: item.quantity_max,
          rate_min: item.rate_min,
          rate_max: item.rate_max,
          updated_at: new Date().toISOString(),
        };

        if (item.ruleId) {
          const { error } = await supabase
            .from("product_rules")
            .update(payload)
            .eq("id", item.ruleId);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from("product_rules")
            .insert(payload);
          if (error) throw error;
        }
      }

      router.refresh();
      handleClose();
    } catch (err: any) {
      console.error("Failed to save product rules:", err);
      alert(`Error saving rules: ${err.message || "Unknown error"}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-900">
            <FileSpreadsheet className="h-5 w-5 text-indigo-600" />
            Bulk Upload Product Rules
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-slate-500">
            Upload an Excel file to bulk configure Minimum/Maximum Quantity and Rate rules for your products.
          </p>

          {/* Download Template & File Upload Section */}
          <div className="flex flex-col sm:flex-row items-center gap-3 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadProductRulesTemplate(productsWithRules)}
              className="w-full sm:w-auto gap-2 text-xs bg-white hover:bg-slate-100 border-slate-300 text-slate-700"
            >
              <Download className="h-3.5 w-3.5 text-indigo-600" />
              Download Rules Template
            </Button>

            <div className="relative w-full sm:flex-1">
              <input
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={handleFileChange}
                className="hidden"
                id="product-rules-excel-file-input"
              />
              <label htmlFor="product-rules-excel-file-input">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  asChild
                  className="w-full gap-2 text-xs cursor-pointer"
                >
                  <span>
                    <Upload className="h-3.5 w-3.5" />
                    {file ? file.name : "Select Excel File"}
                  </span>
                </Button>
              </label>
            </div>
          </div>

          {isProcessing && (
            <div className="p-4 text-center text-xs text-slate-500 animate-pulse flex items-center justify-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
              Parsing Excel and validating product rules...
            </div>
          )}

          {/* Import Summary & Validation Report */}
          {summary && (
            <div className="space-y-3 pt-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Rules Imported Summary
              </h4>

              {/* Statistics Grid */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                  <span className="text-[10px] text-slate-400 font-medium block uppercase">
                    Total Rows
                  </span>
                  <span className="text-base font-bold text-slate-800 font-mono">
                    {summary.totalRows}
                  </span>
                </div>
                <div className="p-2.5 bg-emerald-50 rounded-lg border border-emerald-200">
                  <span className="text-[10px] text-emerald-600 font-medium block uppercase">
                    Updated
                  </span>
                  <span className="text-base font-bold text-emerald-800 font-mono">
                    {summary.updatedCount}
                  </span>
                </div>
                <div className="p-2.5 bg-amber-50 rounded-lg border border-amber-200">
                  <span className="text-[10px] text-amber-600 font-medium block uppercase">
                    Skipped
                  </span>
                  <span className="text-base font-bold text-amber-800 font-mono">
                    {summary.skippedList.length}
                  </span>
                </div>
              </div>

              {/* Skipped Products List */}
              {summary.skippedList.length > 0 && (
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                    <Info className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                    Skipped ({summary.skippedList.length})
                  </div>
                  <ul className="text-[11px] text-amber-700 font-mono space-y-1 list-none pl-1 max-h-28 overflow-y-auto">
                    {summary.skippedList.map((msg, idx) => (
                      <li key={idx}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Validation Errors List */}
              {summary.errorList.length > 0 && (
                <div className="p-3 bg-rose-50 rounded-lg border border-rose-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                    Errors ({summary.errorList.length})
                  </div>
                  <ul className="text-[11px] text-rose-700 font-mono space-y-1 list-none pl-1 max-h-32 overflow-y-auto">
                    {summary.errorList.map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleApplyImport}
            disabled={
              !summary ||
              summary.validUpdates.length === 0 ||
              isSaving
            }
            className="gap-2"
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving Rules...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" />
                Apply Import ({summary?.updatedCount || 0} Rules)
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
