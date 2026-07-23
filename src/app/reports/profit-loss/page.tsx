"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function ProfitLossReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getProfitLossReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching P&L reports:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(selectedFY);
  }, [selectedFY]);

  const rev = reportData?.revenue || 0;
  const pur = reportData?.purchaseCost || 0;
  const exp = reportData?.expenses || 0;
  const gross = reportData?.grossProfit || 0;
  const net = reportData?.netProfit || 0;
  const netPct = reportData?.profitPercentage || 0;

  const kpiCards: KPICardData[] = [
    {
      title: "Total Revenue",
      value: `₹${rev.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Gross Sales Turnover",
    },
    {
      title: "Cost of Goods (Purchases)",
      value: `₹${pur.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Direct Raw Material Cost",
    },
    {
      title: "Net Profit",
      value: `₹${net.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: `${netPct}% Net Margin`,
    },
    {
      title: "Total Operating Expenses",
      value: `₹${exp.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Overheads & Expenses",
    },
  ];

  const statementRows = [
    {
      metric: "1. Total Revenue / Sales Turnover",
      amount: rev,
      percentage: "100.00%",
    },
    {
      metric: "2. Cost of Goods Sold (Purchase Value)",
      amount: pur,
      percentage: rev > 0 ? `${((pur / rev) * 100).toFixed(2)}%` : "0%",
    },
    {
      metric: "Gross Profit (Revenue - Purchases)",
      amount: gross,
      percentage: rev > 0 ? `${((gross / rev) * 100).toFixed(2)}%` : "0%",
    },
    {
      metric: "3. Operational Expenditures",
      amount: exp,
      percentage: rev > 0 ? `${((exp / rev) * 100).toFixed(2)}%` : "0%",
    },
    {
      metric: "Net Profit (Gross Profit - Expenses)",
      amount: net,
      percentage: `${netPct}%`,
    },
  ];

  const columns = [
    {
      key: "metric",
      header: "Particulars / Line Item",
      align: "left" as const,
    },
    {
      key: "amount",
      header: "Amount (₹)",
      align: "right" as const,
      render: (r: any) => (
        <span
          className={
            r.amount < 0 ? "text-red-600 font-bold" : "font-bold text-slate-900"
          }
        >
          ₹
          {Number(r.amount).toLocaleString("en-IN", {
            minimumFractionDigits: 2,
          })}
        </span>
      ),
    },
    { key: "percentage", header: "% of Turnover", align: "right" as const },
  ];

  return (
    <UniversalReportView
      title="Profit & Loss Financial Statement"
      description="Read-only summary of gross revenue, purchase costs, overhead expenses, and net profit performance."
      selectedFY={selectedFY}
      onFYChange={setSelectedFY}
      onRefresh={() => fetchReports(selectedFY)}
      isLoading={loading}
      kpiCards={kpiCards}
      columns={columns}
      data={statementRows}
    />
  );
}
