"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function PurchaseReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getPurchaseReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching purchase reports:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(selectedFY);
  }, [selectedFY]);

  const kpiCards: KPICardData[] = [
    {
      title: "Total Purchases Value",
      value: `₹${(reportData?.summary?.totalPurchaseValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Sum of all purchase vouchers",
    },
    {
      title: "Total Invoices",
      value: reportData?.summary?.totalPurchasesCount || 0,
      subtitle: "Purchase vouchers generated",
    },
    {
      title: "Avg Invoice Value",
      value: `₹${(reportData?.summary?.avgInvoiceValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Per purchase voucher",
    },
  ];

  const columns = [
    { key: "invoice_number", header: "Invoice Number", align: "left" as const },
    { key: "invoice_date", header: "Date", align: "left" as const },
    { key: "batch_number", header: "Purchase Batch", align: "left" as const },
    { key: "supplier_name", header: "Supplier Name", align: "left" as const },
    { key: "product_count", header: "Products", align: "center" as const },
    { key: "total_quantity", header: "Qty Purchased", align: "right" as const },
    {
      key: "total_amount",
      header: "Purchase Value (₹)",
      align: "right" as const,
      render: (r: any) =>
        `₹${Number(r.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    },
  ];

  return (
    <UniversalReportView
      title="Purchase Register & Reports"
      description="Read-only register of all purchase vouchers, batch statistics, and supplier purchasing histories."
      selectedFY={selectedFY}
      onFYChange={setSelectedFY}
      onRefresh={() => fetchReports(selectedFY)}
      isLoading={loading}
      kpiCards={kpiCards}
      columns={columns}
      data={reportData?.registerRows || []}
    />
  );
}
