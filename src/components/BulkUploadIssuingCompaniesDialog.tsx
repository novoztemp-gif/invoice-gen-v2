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

export function BulkUploadIssuingCompaniesDialog() {
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

  const downloadIssuingCompanyTemplate = () => {
    const data = [
      {
        "Company Name": "ABC Industries Pvt Ltd",
        Phone: "9876543210",
        Address: "123 Industrial Area Chennai",
        GSTIN: "33ABCDE1234F1Z5",
        PAN: "ABCDE1234F",
        Branch: "Chennai Branch",
        "Bank Account Name": "ABC Industries Pvt Ltd",
        "Bank Name": "HDFC Bank",
        "Account Number": "123456789012",
        "IFSC Code": "HDFC0001234",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);

    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(workbook, worksheet, "Issuing Companies");

    XLSX.writeFile(workbook, "issuing_company_bulk_upload_template.xlsx");
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
        const requiredHeaders = [
          "Company Name",
          "Address",
          "GSTIN",
          "Phone",
          "PAN",
          "Bank Account Name",
          "Bank Name",
          "Account Number",
          "IFSC Code",
        ];

        // Check if required columns are present
        const hasAllHeaders = requiredHeaders.every((req) =>
          headers.includes(req),
        );

        if (!hasAllHeaders) {
          setError("Required columns missing");
          setUploading(false);
          return;
        }

        const nameIdx = headers.indexOf("Company Name");
        const addressIdx = headers.indexOf("Address");
        const gstinIdx = headers.indexOf("GSTIN");
        const phoneIdx = headers.indexOf("Phone");
        const panIdx = headers.indexOf("PAN");
        const branchIdx = headers.indexOf("Branch");
        const bankAccountNameIdx = headers.indexOf("Bank Account Name");
        const bankNameIdx = headers.indexOf("Bank Name");
        const accountNumberIdx = headers.indexOf("Account Number");
        const ifscCodeIdx = headers.indexOf("IFSC Code");

        // Fetch existing companies to perform lookups in-memory
        const { data: existingCompanies, error: fetchError } = await supabase
          .from("issuing_companies")
          .select("id, company_name, gstin");

        if (fetchError) {
          throw new Error("Database lookup failed: " + fetchError.message);
        }

        const makeKey = (name: string, gstin: string) =>
          `${name.trim().toLowerCase()}::${(gstin || "").trim().toLowerCase()}`;

        const companyMap = new Map<string, string>();
        if (existingCompanies) {
          for (const c of existingCompanies) {
            if (c.company_name) {
              companyMap.set(makeKey(c.company_name, c.gstin || ""), c.id);
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

          const company_name = row[nameIdx]?.toString()?.trim() || "";
          const address = row[addressIdx]?.toString()?.trim() || "";
          const gstin = row[gstinIdx]?.toString()?.trim() || null;
          const phone = row[phoneIdx]?.toString()?.trim() || "";
          const pan = row[panIdx]?.toString()?.trim() || "";
          const branch =
            branchIdx >= 0 ? row[branchIdx]?.toString()?.trim() || null : null;
          const bank_account_name =
            row[bankAccountNameIdx]?.toString()?.trim() || "";
          const bank_name = row[bankNameIdx]?.toString()?.trim() || "";
          const account_number =
            row[accountNumberIdx]?.toString()?.trim() || "";
          const ifsc_code = row[ifscCodeIdx]?.toString()?.trim() || "";

          if (
            !company_name ||
            !address ||
            !phone ||
            !pan ||
            !bank_account_name ||
            !bank_name ||
            !account_number ||
            !ifsc_code
          ) {
            failed++;
            continue;
          }

          const lookupKey = makeKey(company_name, gstin || "");

          try {
            if (companyMap.has(lookupKey)) {
              const matchedId = companyMap.get(lookupKey);
              const { error: updateError } = await supabase
                .from("issuing_companies")
                .update({
                  address,
                  phone,
                  pan,
                  branch,
                  bank_account_name,
                  bank_name,
                  account_number,
                  ifsc_code,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", matchedId);

              if (updateError) {
                console.error("Update error for:", company_name, updateError);
                failed++;
              } else {
                updated++;
              }
            } else {
              const { data: newCompany, error: insertError } = await supabase
                .from("issuing_companies")
                .insert({
                  company_name,
                  address,
                  gstin: gstin || null,
                  phone,
                  pan,
                  branch,
                  bank_account_name,
                  bank_name,
                  account_number,
                  ifsc_code,
                })
                .select("id")
                .single();

              if (insertError) {
                console.error("Insert error for:", company_name, insertError);
                failed++;
              } else {
                inserted++;
                if (newCompany?.id) {
                  companyMap.set(lookupKey, newCompany.id);
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
          <DialogTitle>Bulk Upload Issuing Companies</DialogTitle>
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
              onClick={downloadIssuingCompanyTemplate}
              className="gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              Download Template
            </Button>
          </div>

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
