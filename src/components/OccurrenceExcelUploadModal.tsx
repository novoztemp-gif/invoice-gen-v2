"use client";

import React, { useState } from "react";
import * as XLSX from "xlsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Upload,
  Download,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Info,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectedProductForOccurrence {
  product: {
    id: string;
    product_name: string;
    hsn_code?: string;
    unit_of_measure?: string;
  };
  occurrencePercentage?: string;
}

interface OccurrenceExcelUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedProducts: SelectedProductForOccurrence[];
  onImportSuccess: (
    updates: { productId: string; occurrencePercentage: string }[],
  ) => void;
}

export function downloadOccurrenceTemplate(
  selectedProducts: SelectedProductForOccurrence[],
) {
  const rows =
    selectedProducts.length > 0
      ? selectedProducts.map((p) => ({
          "Product Name": p.product.product_name,
          "Occurrence Percentage": p.occurrencePercentage
            ? parseFloat(p.occurrencePercentage)
            : "",
        }))
      : [
          { "Product Name": "Sample Fish A", "Occurrence Percentage": 40 },
          { "Product Name": "Sample Fish B", "Occurrence Percentage": 60 },
        ];

  const worksheet = XLSX.utils.json_to_sheet(rows);

  // Auto-fit column widths
  worksheet["!cols"] = [
    { wch: 30 }, // Product Name
    { wch: 25 }, // Occurrence Percentage
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Occurrence Percentages");

  XLSX.writeFile(workbook, "purchase_occurrence_percentage_template.xlsx");
}

export function OccurrenceExcelUploadModal({
  isOpen,
  onClose,
  selectedProducts,
  onImportSuccess,
}: OccurrenceExcelUploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [summary, setSummary] = useState<{
    totalRows: number;
    updatedCount: number;
    skippedCount: number;
    validationErrors: string[];
    skippedDetails: string[];
    pendingUpdates: { productId: string; occurrencePercentage: string }[];
  } | null>(null);

  const resetState = () => {
    setFile(null);
    setIsProcessing(false);
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
            skippedCount: 0,
            validationErrors: ["Excel workbook contains no sheets."],
            skippedDetails: [],
            pendingUpdates: [],
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
            skippedCount: 0,
            validationErrors: ["Uploaded Excel sheet is empty."],
            skippedDetails: [],
            pendingUpdates: [],
          });
          setIsProcessing(false);
          return;
        }

        const validationErrors: string[] = [];
        const skippedDetails: string[] = [];
        const pendingUpdatesMap = new Map<string, string>();
        const seenProductNamesInExcel = new Set<string>();

        let totalRows = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        rawRows.forEach((row, index) => {
          const rowNum = index + 2; // 1-indexed header is row 1

          // Flexible key lookup for Product Name & Occurrence Percentage
          const productNameKey = Object.keys(row).find((k) =>
            /product\s*name/i.test(k) || /^product$/i.test(k),
          );
          const occurKey = Object.keys(row).find((k) =>
            /occurrence\s*percentage/i.test(k) ||
            /occurrence\s*%/i.test(k) ||
            /percentage/i.test(k) ||
            /occurrence/i.test(k),
          );

          const rawProductName = productNameKey ? String(row[productNameKey]).trim() : "";
          const rawOccurVal = occurKey ? String(row[occurKey]).trim() : "";

          // Skip completely empty rows
          if (!rawProductName && !rawOccurVal) {
            return;
          }

          totalRows++;

          if (!rawProductName) {
            validationErrors.push(`Row ${rowNum}: Product Name is missing.`);
            return;
          }

          const normProductName = rawProductName.toLowerCase();

          // Rule 6: Duplicate detection in Excel
          if (seenProductNamesInExcel.has(normProductName)) {
            validationErrors.push(
              `Row ${rowNum}: Duplicate product name "${rawProductName}" found in Excel.`,
            );
            return;
          }
          seenProductNamesInExcel.add(normProductName);

          // Rule 6: Percentage must be between 0 and 100
          if (rawOccurVal === "") {
            validationErrors.push(
              `Row ${rowNum} (${rawProductName}): Occurrence Percentage is required.`,
            );
            return;
          }

          const pctNum = parseFloat(rawOccurVal);
          if (isNaN(pctNum) || pctNum < 0 || pctNum > 100) {
            validationErrors.push(
              `Row ${rowNum} (${rawProductName}): Occurrence Percentage must be a valid number between 0 and 100 (got "${rawOccurVal}").`,
            );
            return;
          }

          // Rule 5: Match rows by Product Name with selected purchase batch products
          const matchedSelectedProduct = selectedProducts.find(
            (sp) => sp.product.product_name.trim().toLowerCase() === normProductName,
          );

          if (!matchedSelectedProduct) {
            // Rule 5: Ignore products not selected in the purchase batch / unknown products
            skippedCount++;
            skippedDetails.push(
              `Row ${rowNum}: Product "${rawProductName}" is not currently selected in the purchase batch (skipped).`,
            );
            return;
          }

          // Valid match found
          pendingUpdatesMap.set(matchedSelectedProduct.product.id, pctNum.toString());
          updatedCount++;
        });

        const pendingUpdates = Array.from(pendingUpdatesMap.entries()).map(
          ([productId, occurrencePercentage]) => ({
            productId,
            occurrencePercentage,
          }),
        );

        setSummary({
          totalRows,
          updatedCount,
          skippedCount,
          validationErrors,
          skippedDetails,
          pendingUpdates,
        });
      } catch (err: any) {
        setSummary({
          totalRows: 0,
          updatedCount: 0,
          skippedCount: 0,
          validationErrors: [
            `Failed to parse Excel file: ${err.message || "Invalid file format"}`,
          ],
          skippedDetails: [],
          pendingUpdates: [],
        });
      } finally {
        setIsProcessing(false);
      }
    };

    reader.readAsArrayBuffer(uploadedFile);
  };

  const handleApplyImport = () => {
    if (summary && summary.pendingUpdates.length > 0) {
      onImportSuccess(summary.pendingUpdates);
      handleClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-900">
            <FileSpreadsheet className="h-5 w-5 text-indigo-600" />
            Upload Occurrence Percentage Excel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-slate-500">
            Upload an Excel file to automatically populate occurrence percentages for products selected in this purchase batch.
          </p>

          {/* Download Template & File Upload Section */}
          <div className="flex flex-col sm:flex-row items-center gap-3 p-3.5 bg-slate-50 rounded-lg border border-slate-200">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadOccurrenceTemplate(selectedProducts)}
              className="w-full sm:w-auto gap-2 text-xs bg-white hover:bg-slate-100 border-slate-300 text-slate-700"
            >
              <Download className="h-3.5 w-3.5 text-indigo-600" />
              Download Excel Template
            </Button>

            <div className="relative w-full sm:flex-1">
              <input
                type="file"
                accept=".xlsx, .xls, .csv"
                onChange={handleFileChange}
                className="hidden"
                id="occurrence-excel-file-input"
              />
              <label htmlFor="occurrence-excel-file-input">
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
            <div className="p-4 text-center text-xs text-slate-500 animate-pulse">
              Parsing Excel and validating product occurrences...
            </div>
          )}

          {/* Import Summary & Validation Report */}
          {summary && (
            <div className="space-y-3 pt-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Import Summary
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
                    Products Updated
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
                    {summary.skippedCount}
                  </span>
                </div>
              </div>

              {/* Validation Errors List */}
              {summary.validationErrors.length > 0 && (
                <div className="p-3 bg-rose-50 rounded-lg border border-rose-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
                    <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
                    Validation Errors ({summary.validationErrors.length})
                  </div>
                  <ul className="text-[11px] text-rose-700 space-y-1 list-disc pl-4 max-h-32 overflow-y-auto">
                    {summary.validationErrors.map((err, idx) => (
                      <li key={idx}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Skipped Details Log */}
              {summary.skippedDetails.length > 0 && (
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                    <Info className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    Skipped Products Details ({summary.skippedDetails.length})
                  </div>
                  <ul className="text-[11px] text-slate-600 space-y-1 list-disc pl-4 max-h-24 overflow-y-auto">
                    {summary.skippedDetails.map((msg, idx) => (
                      <li key={idx}>{msg}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleApplyImport}
            disabled={
              !summary ||
              summary.validationErrors.length > 0 ||
              summary.pendingUpdates.length === 0
            }
            className="gap-2"
          >
            <CheckCircle2 className="h-4 w-4" />
            Apply Import ({summary?.updatedCount || 0} Products)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
