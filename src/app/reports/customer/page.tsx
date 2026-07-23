"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function CustomerReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getCustomerReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching customer reports:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(selectedFY);
  }, [selectedFY]);

  const kpiCards: KPICardData[] = [
    {
      title: "Total Customers",
      value: reportData?.totalCustomers || 0,
      subtitle: "Registered receiving companies",
    },
    {
      title: "Active Customers",
      value: reportData?.activeCustomers || 0,
      subtitle: "With invoices in this period",
    },
  ];

  const columns = [
    { key: "company_name", header: "Customer Name", align: "left" as const },
    { key: "gstin", header: "GSTIN", align: "left" as const },
    { key: "city", header: "Location / State", align: "left" as const },
    {
      key: "invoiceCount",
      header: "Invoices Issued",
      align: "center" as const,
    },
    {
      key: "lastTransactionDate",
      header: "Last Activity",
      align: "center" as const,
    },
    {
      key: "totalSalesValue",
      header: "Total Value (₹)",
      align: "right" as const,
      render: (r: any) =>
        `₹${Number(r.totalSalesValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    },
  ];

  return (
    <UniversalReportView
      title="Customer Ledger & Sales History"
      description="Read-only analysis of customer purchasing performance, invoice counts, and total revenue contribution."
      selectedFY={selectedFY}
      onFYChange={setSelectedFY}
      onRefresh={() => fetchReports(selectedFY)}
      isLoading={loading}
      kpiCards={kpiCards}
      columns={columns}
      data={reportData?.customers || []}
    />
  );
}
