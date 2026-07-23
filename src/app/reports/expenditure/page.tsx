"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function ExpenditureReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getExpenditureReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching expenditure reports:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(selectedFY);
  }, [selectedFY]);

  const metrics = reportData?.metrics;

  const kpiCards: KPICardData[] = [
    {
      title: "Total Expenses",
      value: `₹${(metrics?.totalExpenseValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Sum of operational expenditures",
    },
    {
      title: "Expense Batches",
      value: metrics?.expenseBatchCount || 0,
      subtitle: "Recorded expense batches",
    },
    {
      title: "Active Categories",
      value: reportData?.categorySummary?.length || 0,
      subtitle: "Expense categories used",
    },
  ];

  const columns = [
    { key: "expense_date", header: "Expense Date", align: "left" as const },
    { key: "category_name", header: "Category", align: "left" as const },
    {
      key: "notes",
      header: "Particulars / Notes",
      align: "left" as const,
      render: (r: any) => r.notes || "—",
    },
    {
      key: "amount",
      header: "Amount (₹)",
      align: "right" as const,
      render: (r: any) =>
        `₹${Number(r.amount || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
    },
  ];

  return (
    <UniversalReportView
      title="Expenditure Register & Category Reports"
      description="Read-only analysis of company operational expenses, batch entries, and category distributions."
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
