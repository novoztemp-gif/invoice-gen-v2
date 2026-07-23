"use client";

import React, { useEffect, useState } from "react";
import UniversalReportView, {
  KPICardData,
} from "@/components/reports/UniversalReportView";
import { ReportingEngine } from "@/lib/services/ReportingEngine";
import { createClient } from "@/lib/supabase/client";

export default function InventoryReportsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState("FY 2025-26");
  const [reportData, setReportData] = useState<any>(null);

  const fetchReports = async (fy: string) => {
    setLoading(true);
    try {
      const supabase = createClient();
      const res = await ReportingEngine.getInventoryReports(supabase, {
        financialYear: fy,
      });
      setReportData(res);
    } catch (err) {
      console.error("Error fetching inventory reports:", err);
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
      title: "Total Current Stock",
      value: `${(metrics?.totalCurrentStock || 0).toLocaleString()} KG`,
      subtitle: "Across active purchase inventory",
    },
    {
      title: "Inventory Value",
      value: `₹${(metrics?.totalStockValue || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`,
      subtitle: "Valued at average rate",
    },
    {
      title: "Carry Forward Stock",
      value: `${(metrics?.carryForwardStock || 0).toLocaleString()} KG`,
      subtitle: "Stock rolled over between months",
    },
    {
      title: "Out of Stock Products",
      value: metrics?.outOfStockProductsCount || 0,
      subtitle: "Depleted product inventory",
    },
  ];

  const columns = [
    { key: "product_name", header: "Product Name", align: "left" as const },
    { key: "unit", header: "Unit", align: "center" as const },
    {
      key: "opening_stock",
      header: "Opening Stock",
      align: "right" as const,
      render: (r: any) =>
        `${Number(r.opening_stock || 0).toLocaleString()} ${r.unit}`,
    },
    {
      key: "purchased_qty",
      header: "Purchased Qty",
      align: "right" as const,
      render: (r: any) =>
        `${Number(r.purchased_qty || 0).toLocaleString()} ${r.unit}`,
    },
    {
      key: "sold_qty",
      header: "Sold Qty",
      align: "right" as const,
      render: (r: any) =>
        `${Number(r.sold_qty || 0).toLocaleString()} ${r.unit}`,
    },
    {
      key: "closing_stock",
      header: "Closing Stock",
      align: "right" as const,
      render: (r: any) => (
        <span
          className={
            r.closing_stock <= 0
              ? "text-red-600 font-bold"
              : "text-emerald-700 font-bold"
          }
        >
          {Number(r.closing_stock || 0).toLocaleString()} {r.unit}
        </span>
      ),
    },
  ];

  return (
    <UniversalReportView
      title="Inventory Ledger & Stock Movement"
      description="Read-only tracking of opening stock, purchases, sales allocations, carry forward, and closing inventory."
      selectedFY={selectedFY}
      onFYChange={setSelectedFY}
      onRefresh={() => fetchReports(selectedFY)}
      isLoading={loading}
      kpiCards={kpiCards}
      columns={columns}
      data={reportData?.currentInventory || []}
    />
  );
}
