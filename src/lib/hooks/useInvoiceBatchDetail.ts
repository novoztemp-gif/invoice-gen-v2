"use client";

import { useEffect, useState } from "react";
import fetchJobStats from "@/app/invoice-batches/[id]/actions";
import { createClient } from "@/lib/supabase/client";
import { fetchAllInvoicesForBatch } from "@/lib/supabase/fetchAll";
import { triggerDownload } from "@/lib/utils";

export type InvoiceBatch = {
  id: string;
  issuing_company_id: string;
  receiving_company_id: string;
  batch_type: string;
  transport_mode: string;
  vehicle_number: string;
  date_of_supply: string;
  invoice_date_from: string;
  invoice_date_to: string;
  minimum_invoice_amount: number;
  maximum_invoice_amount: number;
  total_amount: number;
  status: string | null;
  batch_status?: string;
  sheet_link: string | null;
  pdf_link: string | null;
  created_at: string;
  created_by?: string;
  financial_year?: string;
  finalized_at?: string;
  finalized_by?: string;
  reopened_at?: string;
  reopened_by?: string;
  selected_customers?: string[] | null;
  major_customers?: Array<{
    customer_id: string;
    amount: number;
    invoice_count: number;
  }> | null;
  products?: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    unit_of_measure: string;
    perDayQtyMin: string;
    perDayQtyMax: string;
    perDayRateMin: string;
    perDayRateMax: string;
    occurrencePercentage?: number | null;
  }>;
  issuing_companies?: {
    company_name: string;
  };
  receiving_companies?: {
    company_name: string;
  };
};

export type Invoice = {
  id: string;
  invoice_batch_id: string;
  invoice_number: string;
  invoice_date: string;
  products: Array<{
    product_id: string;
    product_name: string;
    hsn_code: string;
    quantity: number;
    rate: number;
    amount: number;
    customer_id?: string;
  }>;
  total_amount: number;
  status: string | null;
  created_at: string;
  sheet_link: string | null;
};

export interface UseInvoiceBatchDetailProps {
  batchId: string;
}

export function useInvoiceBatchDetail({ batchId }: UseInvoiceBatchDetailProps) {
  const [batch, setBatch] = useState<InvoiceBatch | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [receivingCustomers, setReceivingCustomers] = useState<
    Record<string, any>
  >({});
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [isEditingMode, setIsEditingMode] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>(
    {},
  );
  const [jobStats, setJobStats] = useState({
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  });

  const fetchReceivingCustomers = async () => {
    try {
      const supabase = createClient();
      const { data } = await supabase.from("receiving_companies").select("*");
      if (data) {
        const map: Record<string, any> = {};
        data.forEach((c) => {
          map[c.id] = c;
        });
        setReceivingCustomers(map);
      }
    } catch (e) {
      console.error("Error fetching receiving customers map:", e);
    }
  };

  const fetchBatchDetails = async () => {
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("invoice_batch")
        .select(
          `
          *,
          issuing_companies:issuing_company_id(
            id, company_name, address, gstin, phone, bank_account_name, bank_name, account_number, ifsc_code, pan, branch
          ),
          receiving_companies:receiving_company_id(company_name),
          suppliers:supplier_id(company_name)
        `,
        )
        .eq("id", batchId)
        .single();

      if (error) {
        console.error("Error fetching batch:", error);
        alert("Failed to load batch details.");
        return;
      }

      setBatch(data);
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvoices = async () => {
    try {
      const supabase = createClient();
      const data = await fetchAllInvoicesForBatch(supabase, batchId);

      setInvoices(data || []);

      if (data && data.length > 0) {
        const uniqueDates = [...new Set(data.map((inv) => inv.invoice_date))];
        const expanded: Record<string, boolean> = {};
        uniqueDates.forEach((date) => {
          expanded[date] = true;
        });
        setExpandedDates(expanded);
      }
    } catch (error) {
      console.error("Error fetching invoices:", error);
    }
  };

  const updateJobStats = async () => {
    if (invoices.length > 0) {
      const invoiceIds = invoices.map((inv) => inv.id);
      const stats = await fetchJobStats(invoiceIds, batchId);
      setJobStats(stats);
    } else {
      setJobStats({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
      });
    }
  };

  const handleDownloadExcel = (invoice: Invoice) => {
    triggerDownload(
      `/api/download-invoice?invoiceId=${invoice.id}`,
      `${invoice.invoice_number || invoice.id}.xlsx`,
    );
  };

  const handleSaveInvoice = async (
    invoiceId: string,
    updates: any,
    setStatus?: (status: string) => void,
  ) => {
    try {
      const supabase = createClient();

      const { data: originalInvoice } = await supabase
        .from("invoice")
        .select("total_amount")
        .eq("id", invoiceId)
        .single();

      const originalTotal = Number(originalInvoice?.total_amount || 0);
      const newTotal = Number(updates.total_amount || 0);

      if (setStatus) setStatus("Updating Invoice...");

      const { error } = await supabase
        .from("invoice")
        .update({
          ...updates,
          is_edited: true,
          edited_at: new Date().toISOString(),
        })
        .eq("id", invoiceId);

      if (error) {
        throw error;
      }

      setInvoices((prev) =>
        prev.map((inv) =>
          inv.id === invoiceId ? { ...inv, ...updates, is_edited: true } : inv,
        ),
      );

      if (originalTotal !== newTotal) {
        if (setStatus) setStatus("Rebalancing Batch...");

        const balanceRes = await fetch("/api/auto-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            batchId,
            editedInvoiceId: invoiceId,
            originalTotal,
            newTotal,
          }),
        });

        const balanceData = await balanceRes.json();

        if (!balanceRes.ok) {
          throw new Error(balanceData.message || "Auto-balancing failed");
        }

        if (setStatus) setStatus("Batch Successfully Balanced");

        await fetchInvoices();

        await new Promise((resolve) => setTimeout(resolve, 1500));

        alert(
          `Invoice Updated.\nRemaining Invoices Adjusted: ${balanceData.modifiedInvoicesCount}\nNet Difference Applied: ₹${Math.abs(originalTotal - newTotal).toLocaleString("en-IN")}\n\nFinal Batch Total Verified!`,
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err: any) {
      console.error("Save error:", err);
      throw err;
    }
  };

  const handleGenerateSplitups = async () => {
    setGenerating(true);
    try {
      const response = await fetch("/api/generate-invoice-splitups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchId,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        alert(result.message || "Invoice splitups generated successfully!");

        await fetchInvoices();
        await fetchBatchDetails();
        await updateJobStats();
      } else {
        alert(result.message || "Failed to generate invoice splitups.");
      }
    } catch (error) {
      console.error("Error generating splitups:", error);
      alert("An error occurred while generating splitups.");
    } finally {
      setGenerating(false);
    }
  };

  const handleBatchStatusChange = async (action: "FINALIZE" | "REOPEN") => {
    try {
      const response = await fetch("/api/batch-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId, action }),
      });

      const data = await response.json();

      if (response.ok) {
        alert(data.message);
        await fetchBatchDetails();
      } else {
        alert(data.message || `Failed to ${action.toLowerCase()} batch.`);
      }
    } catch (error) {
      console.error(`Error changing batch status:`, error);
      alert("An unexpected error occurred.");
    }
  };

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => ({
      ...prev,
      [date]: !prev[date],
    }));
  };

  useEffect(() => {
    fetchReceivingCustomers();
    fetchBatchDetails();
    fetchInvoices();
  }, []);

  useEffect(() => {
    if (invoices.length > 0) {
      updateJobStats();
      const interval = setInterval(updateJobStats, 5000);
      return () => clearInterval(interval);
    }
  }, [invoices]);

  return {
    batch,
    invoices,
    receivingCustomers,
    previewIndex,
    setPreviewIndex,
    isEditingMode,
    setIsEditingMode,
    loading,
    generating,
    expandedDates,
    jobStats,
    handleDownloadExcel,
    handleSaveInvoice,
    handleGenerateSplitups,
    handleBatchStatusChange,
    toggleDate,
  };
}
