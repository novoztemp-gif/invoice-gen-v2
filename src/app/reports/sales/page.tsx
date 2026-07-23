"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function SalesReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getSalesReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching sales reports:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(selectedFY);
  }, [selectedFY]);

  const kpiCards: KPICardData[] = [
    {
      title: "Total Revenue Value",
      value: `₹${(reportData?.summary?.totalSalesValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Sum of all sales invoices",
    },
    {
      title: "Total Sales Invoices",
      value: reportData?.summary?.totalSalesCount || 0,
      subtitle: "Generated sales invoices",
    },
    {
      title: "Avg Invoice Value",
      value: `₹${(reportData?.summary?.avgInvoiceValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Per sales invoice",
    },
  ];

  const columns = [
    { key: "invoice_number", header: "Invoice Number", align: "left" as const },
    {
      key: "sales_batch_number",
      header: "Sales Batch",
      align: "left" as const,
    },
    { key: "customer_name", header: "Customer", align: "left" as const },
    { key: "invoice_date", header: "Date", align: "left" as const },
    { key: "product_count", header: "Products", align: "center" as const },
    {
      key: "total_amount",
      header: "Invoice Value (₹)",
      align: "right" as const,
      render: (r: any) =>
        `₹${Number(r.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    },
  ];

  return (
    <UniversalReportView
      title="Sales Register & Reports"
      description="Read-only register of generated sales invoices, monthly/quarterly trends, and customer sales histories."
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
