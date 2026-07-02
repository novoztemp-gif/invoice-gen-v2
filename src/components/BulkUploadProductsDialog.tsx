"use client";

import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Upload,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

export function BulkUploadProductsDialog() {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    inserted: number;
    updated: number;
    failed: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const supabase = createClient();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    setError(null);
    setResult(null);
    if (selectedFile) {
      const extension = selectedFile.name.split(".").pop()?.toLowerCase();
      if (extension !== "xlsx" && extension !== "xls") {
        setError("Please select a valid Excel file (.xlsx or .xls)");
        setFile(null);
        return;
      }
      setFile(selectedFile);
    }
  };

  const downloadProductTemplate = () => {
    const data = [
      {
        "Product Name": "Steel Rods (8mm)",
        "HSN Code": "72142000",
        "Unit of Measure": "MT",
      },
      {
        "Product Name": "Cement (OPC 53 Grade)",
        "HSN Code": "25232900",
        "Unit of Measure": "Bags",
      },
      {
        "Product Name": "Paint (Exterior)",
        "HSN Code": "32099090",
        "Unit of Measure": "Liters",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Products");

    XLSX.writeFile(workbook, "product_bulk_upload_template.xlsx");
  };

  const handleUpload = async () => {
    if (!file) {
      setError("Please select a file to upload");
      return;
    }

    setUploading(true);
    setError(null);
    setResult(null);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = e.target?.result;
        if (!data) throw new Error("Could not read file data");

        const workbook = XLSX.read(data, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) throw new Error("Excel file is empty");

        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
        }) as any[][];

        if (rows.length === 0) {
          throw new Error("No data rows found in the sheet");
        }

        const headers = rows[0]?.map((h) => String(h || "").trim()) || [];
        const requiredHeaders = ["Product Name", "HSN Code", "Unit of Measure"];

        // Check if required columns are present
        const hasAllHeaders = requiredHeaders.every((req) =>
          headers.includes(req),
        );

        if (!hasAllHeaders) {
          setError("Required columns missing");
          setUploading(false);
          return;
        }

        const nameIdx = headers.indexOf("Product Name");
        const hsnIdx = headers.indexOf("HSN Code");
        const uomIdx = headers.indexOf("Unit of Measure");

        // Fetch existing products to perform lookups in-memory
        const { data: existingProducts, error: fetchError } = await supabase
          .from("products")
          .select("id, product_name, hsn_code");

        if (fetchError) {
          throw new Error("Database lookup failed: " + fetchError.message);
        }

        const makeKey = (name: string, hsn: string) =>
          `${name.trim().toLowerCase()}::${(hsn || "").trim().toLowerCase()}`;

        const productMap = new Map<string, string>();
        if (existingProducts) {
          for (const p of existingProducts) {
            if (p.product_name) {
              productMap.set(makeKey(p.product_name, p.hsn_code || ""), p.id);
            }
          }
        }

        let inserted = 0;
        let updated = 0;
        let failed = 0;

        // Process data rows
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          // Skip if the row is entirely blank
          const isRowBlank = row.every(
            (val) =>
              val === undefined || val === null || String(val).trim() === "",
          );
          if (isRowBlank) continue;

          const product_name = row[nameIdx]?.toString()?.trim() || "";
          const hsn_code = row[hsnIdx]?.toString()?.trim() || "";
          const unit_of_measure = row[uomIdx]?.toString()?.trim() || "";

          if (!product_name || !hsn_code || !unit_of_measure) {
            failed++;
            continue;
          }

          const lookupKey = makeKey(product_name, hsn_code);

          try {
            if (productMap.has(lookupKey)) {
              const matchedId = productMap.get(lookupKey);
              const { error: updateError } = await supabase
                .from("products")
                .update({
                  unit_of_measure,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", matchedId);

              if (updateError) {
                console.error("Update error for:", product_name, updateError);
                failed++;
              } else {
                updated++;
              }
            } else {
              const { data: newProduct, error: insertError } = await supabase
                .from("products")
                .insert({
                  product_name,
                  hsn_code,
                  unit_of_measure,
                })
                .select("id")
                .single();

              if (insertError) {
                console.error("Insert error for:", product_name, insertError);
                failed++;
              } else {
                inserted++;
                if (newProduct?.id) {
                  productMap.set(lookupKey, newProduct.id);
                }
              }
            }
          } catch (e) {
            console.error("Row error:", e);
            failed++;
          }
        }

        setResult({ inserted, updated, failed });
        router.refresh();
      } catch (err: any) {
        console.error("Upload process error:", err);
        setError(err.message || "Failed to process the Excel file.");
      } finally {
        setUploading(false);
      }
    };

    reader.onerror = () => {
      setError("Failed to read file.");
      setUploading(false);
    };

    reader.readAsArrayBuffer(file);
  };

  const resetState = () => {
    setFile(null);
    setError(null);
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) resetState();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Upload className="h-4 w-4" />
          Bulk Upload
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk Upload Products</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-4">
          {/* Download Template Block */}
          <div className="flex items-center justify-between p-4 bg-slate-50 border border-slate-200 rounded-lg">
            <div>
              <p className="text-sm font-medium text-slate-900">
                Excel Template File
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Download the structure layout
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={downloadProductTemplate}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Download Template
            </Button>
          </div>

          {/* File Upload Selector */}
          <div className="space-y-2">
            <Label htmlFor="excel-file">Upload Excel File (.xlsx, .xls)</Label>
            <Input
              id="excel-file"
              type="file"
              accept=".xlsx, .xls"
              onChange={handleFileChange}
              ref={fileInputRef}
              disabled={uploading}
              className="cursor-pointer"
            />
          </div>

          {/* Error Message Block */}
          {error && (
            <div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Success Summary Result Block */}
          {result && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="flex items-center gap-2 text-slate-900 font-semibold">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <span>Bulk Upload Complete</span>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                <div className="p-2 bg-white rounded border border-slate-100">
                  <p className="text-xs text-slate-500 font-medium">Inserted</p>
                  <p className="text-lg font-bold text-slate-900">
                    {result.inserted}
                  </p>
                </div>
                <div className="p-2 bg-white rounded border border-slate-100">
                  <p className="text-xs text-slate-500 font-medium">Updated</p>
                  <p className="text-lg font-bold text-slate-900">
                    {result.updated}
                  </p>
                </div>
                <div className="p-2 bg-white rounded border border-slate-100">
                  <p className="text-xs text-slate-500 font-medium">Failed</p>
                  <p className="text-lg font-bold text-slate-900">
                    {result.failed}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Controls Footer */}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleUpload}
              disabled={uploading || !file}
              className="gap-2"
            >
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4" />
                  Upload
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
