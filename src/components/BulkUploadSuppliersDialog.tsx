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
import { chunkArray } from "@/lib/utils/chunkArray";
import { BulkUploadProgressBar } from "@/components/BulkUploadProgressBar";

const CHUNK_SIZE = 200;

type SupplierCategory = "Meat" | "Fruits";

interface SupplierRow {
  company_name: string;
  address: string;
  gstin: string | null;
  pan: string | null;
  state: string;
  state_code: string | null;
  category: SupplierCategory;
}

/** Normalizes any real-world spelling ("meat", " MEAT ", "Meat ") to the
 * exact DB-required casing. Real, reported bug: the previous version did
 * an exact-string comparison against "Meat"/"Fruits" and silently fell
 * back to "Meat" for anything that didn't match byte-for-byte — so a
 * perfectly valid "meat" or "Fruits " in the source file got mislabeled
 * without any warning. */
function normalizeCategory(raw: unknown): SupplierCategory | null {
  const cleaned = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (cleaned === "meat") return "Meat";
  if (cleaned === "fruit" || cleaned === "fruits") return "Fruits";
  return null;
}

export function BulkUploadSuppliersDialog() {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
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

  const downloadSupplierTemplate = () => {
    const data = [
      {
        "Supplier Name": "ABC Chicken Farm",
        Address: "456 Industrial Estate",
        GSTIN: "33AAAAA0000A1Z5",
        PAN: "AAAAA0000A",
        State: "Tamil Nadu",
        "State Code": "33",
        Category: "Meat",
      },
      {
        "Supplier Name": "Green Valley Fruits Pvt Ltd",
        Address: "789 Orchard Road",
        GSTIN: "33BBBBB0000B1Z5",
        PAN: "BBBBB0000B",
        State: "Tamil Nadu",
        "State Code": "33",
        Category: "Fruits",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Suppliers");

    XLSX.writeFile(workbook, "supplier_bulk_upload_template.xlsx");
  };

  const handleUpload = async () => {
    if (!file) {
      setError("Please select a file to upload");
      return;
    }

    setUploading(true);
    setError(null);
    setResult(null);
    setProgress({ current: 0, total: 0 });

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
        const requiredHeaders = [
          "Supplier Name",
          "Address",
          "GSTIN",
          "PAN",
          "State",
          "State Code",
          "Category",
        ];

        const hasAllHeaders = requiredHeaders.every((req) =>
          headers.includes(req),
        );

        if (!hasAllHeaders) {
          setError(
            "Required columns missing. Required: Supplier Name, Address, GSTIN, PAN, State, State Code, Category",
          );
          setUploading(false);
          return;
        }

        const nameIdx = headers.indexOf("Supplier Name");
        const addressIdx = headers.indexOf("Address");
        const gstinIdx = headers.indexOf("GSTIN");
        const panIdx = headers.indexOf("PAN");
        const stateIdx = headers.indexOf("State");
        const stateCodeIdx = headers.indexOf("State Code");
        const categoryIdx = headers.indexOf("Category");

        // Build a deduplicated map of every valid row first (a later
        // duplicate row for the same name+state overwrites an earlier one),
        // so chunked bulk writes below don't need to grow the lookup map
        // between requests. A per-row invalid category now just fails that
        // ONE row (matching how a missing name/address already behaves)
        // instead of aborting the entire upload.
        const makeKey = (name: string, state: string) =>
          `${name.trim().toLowerCase()}::${state.trim().toLowerCase()}`;

        const rowsByKey = new Map<string, SupplierRow>();
        let preValidationFailed = 0;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;

          const isRowBlank = row.every(
            (val) =>
              val === undefined || val === null || String(val).trim() === "",
          );
          if (isRowBlank) continue;

          const company_name = row[nameIdx]?.toString()?.trim() || "";
          const address = row[addressIdx]?.toString()?.trim() || "";
          const state = row[stateIdx]?.toString()?.trim() || "";
          const category = normalizeCategory(row[categoryIdx]);

          if (!company_name || !address || !state || !category) {
            preValidationFailed++;
            continue;
          }

          const key = makeKey(company_name, state);
          rowsByKey.set(key, {
            company_name,
            address,
            gstin: row[gstinIdx]?.toString()?.trim() || null,
            pan: row[panIdx]?.toString()?.trim() || null,
            state,
            state_code: row[stateCodeIdx]?.toString()?.trim() || null,
            category,
          });
        }

        // One query to resolve which keys already exist.
        const { data: existingSuppliers, error: fetchError } = await supabase
          .from("suppliers")
          .select("id, company_name, state");

        if (fetchError) {
          throw new Error("Database lookup failed: " + fetchError.message);
        }

        const existingIdByKey = new Map<string, string>();
        for (const s of existingSuppliers ?? []) {
          if (s.company_name && s.state) {
            existingIdByKey.set(makeKey(s.company_name, s.state), s.id);
          }
        }

        const toInsert: SupplierRow[] = [];
        const toUpdate: (SupplierRow & { id: string })[] = [];
        for (const [key, row] of rowsByKey) {
          const existingId = existingIdByKey.get(key);
          if (existingId) {
            toUpdate.push({ ...row, id: existingId });
          } else {
            toInsert.push(row);
          }
        }

        const insertChunks = chunkArray(toInsert, CHUNK_SIZE);
        const updateChunks = chunkArray(toUpdate, CHUNK_SIZE);
        const totalChunks = insertChunks.length + updateChunks.length;
        setProgress({ current: 0, total: totalChunks });

        let inserted = 0;
        let updated = 0;
        let failed = preValidationFailed;
        let chunksDone = 0;

        for (const chunk of insertChunks) {
          const { data: insertedRows, error: insertError } = await supabase
            .from("suppliers")
            .insert(chunk)
            .select("id");

          if (insertError) {
            failed += chunk.length;
          } else {
            inserted += insertedRows?.length ?? chunk.length;
          }
          chunksDone++;
          setProgress({ current: chunksDone, total: totalChunks });
        }

        for (const chunk of updateChunks) {
          const { data: updatedRows, error: updateError } = await supabase
            .from("suppliers")
            .upsert(
              chunk.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
              { onConflict: "id" },
            )
            .select("id");

          if (updateError) {
            failed += chunk.length;
          } else {
            updated += updatedRows?.length ?? chunk.length;
          }
          chunksDone++;
          setProgress({ current: chunksDone, total: totalChunks });
        }

        setResult({ inserted, updated, failed });
        router.refresh();
      } catch (err: any) {
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
    setProgress({ current: 0, total: 0 });
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
          <DialogTitle>Bulk Upload Suppliers</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 pt-4">
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
              onClick={downloadSupplierTemplate}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Download Template
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="supplier-excel-file">
              Upload Excel File (.xlsx, .xls)
            </Label>
            <Input
              id="supplier-excel-file"
              type="file"
              accept=".xlsx, .xls"
              onChange={handleFileChange}
              ref={fileInputRef}
              disabled={uploading}
              className="cursor-pointer"
            />
          </div>

          {uploading && progress.total > 0 && (
            <BulkUploadProgressBar
              current={progress.current}
              total={progress.total}
              label="Uploading suppliers..."
            />
          )}

          {error && (
            <div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

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
