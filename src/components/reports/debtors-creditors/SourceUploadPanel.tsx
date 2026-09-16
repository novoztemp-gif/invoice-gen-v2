"use client";

import { AlertCircle, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DebtorCreditorSourceData } from "@/lib/services/debtors-creditors/types";

interface SourceUploadPanelProps {
  title: string;
  description: string;
  inputId: string;
  onGenerating: (label: string) => void;
  onGenerated: () => void;
  onUploaded: (data: DebtorCreditorSourceData) => void;
}

export function SourceUploadPanel({
  title,
  description,
  inputId,
  onGenerating,
  onGenerated,
  onUploaded,
}: SourceUploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const handleParse = async () => {
    if (!file) return;
    setError(null);
    onGenerating("Reading uploaded data");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/reports/debtors-creditors/parse-source", {
        method: "POST",
        body: formData,
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.message || "Failed to read the uploaded file.");
      }
      onUploaded(json as DebtorCreditorSourceData);
    } catch (err: any) {
      setError(err?.message || "Something went wrong reading the file.");
    } finally {
      onGenerated();
    }
  };

  return (
    <div className="border border-slate-200 rounded-xl p-6 space-y-4 bg-white">
      <div>
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="text-sm text-slate-500 mt-0.5">{description}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={inputId}>Upload Excel File (.xlsx)</Label>
        <Input
          id={inputId}
          type="file"
          accept=".xlsx"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:bg-slate-800 file:px-3 file:text-white file:font-medium hover:file:bg-slate-700"
        />
        {file && (
          <p className="text-xs text-slate-500">
            Selected: <span className="font-medium text-slate-700">{file.name}</span>
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
          <span>{error}</span>
        </div>
      )}

      <Button className="gap-2" disabled={!file} onClick={handleParse}>
        <Upload className="h-4 w-4" />
        Upload
      </Button>
    </div>
  );
}
