"use client";

import React, { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FileText,
  Download,
  Printer,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  FileSpreadsheet,
} from "lucide-react";
import { ReportExporter, ExportColumn } from "@/lib/services/ReportExporter";

export interface KPICardData {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: string;
}

export interface UniversalReportProps {
  title: string;
  description: string;
  companyInfo?: {
    name: string;
    address: string;
    gstin?: string;
    pan?: string;
  };
  kpiCards?: KPICardData[];
  columns: {
    key: string;
    header: string;
    align?: "left" | "center" | "right";
    render?: (row: any) => React.ReactNode;
  }[];
  data: any[];
  financialYears?: string[];
  selectedFY?: string;
  onFYChange?: (fy: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export default function UniversalReportView({
  title,
  description,
  companyInfo = {
    name: "NOVOZ INFINITY ERP",
    address: "Chennai, Tamil Nadu, India",
    gstin: "33AAAAA0000A1Z5",
    pan: "AAAAA0000A",
  },
  kpiCards = [],
  columns,
  data,
  financialYears = ["FY 2025-26", "FY 2024-25"],
  selectedFY = "FY 2025-26",
  onFYChange,
  onRefresh,
  isLoading = false,
}: UniversalReportProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Filter & Search
  const filteredData = useMemo(() => {
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const val = row[col.key];
        return (
          val !== null &&
          val !== undefined &&
          String(val).toLowerCase().includes(q)
        );
      }),
    );
  }, [data, search, columns]);

  // Sort
  const sortedData = useMemo(() => {
    if (!sortKey) return filteredData;
    return [...filteredData].sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (valA === valB) return 0;
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if (typeof valA === "number" && typeof valB === "number") {
        return sortAsc ? valA - valB : valB - valA;
      }
      return sortAsc
        ? String(valA).localeCompare(String(valB))
        : String(valB).localeCompare(String(valA));
    });
  }, [filteredData, sortKey, sortAsc]);

  // Pagination
  const totalPages = Math.ceil(sortedData.length / pageSize) || 1;
  const paginatedData = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, page, pageSize]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  // Export handlers with strict naming convention
  const exportColumns: ExportColumn[] = columns.map((c) => ({
    header: c.header,
    key: c.key,
  }));

  const handleExportCSV = () => {
    const filename = ReportExporter.generateFilename(
      title,
      selectedFY,
      "",
      "csv",
    );
    ReportExporter.exportToCSV(sortedData, exportColumns, filename);
  };

  const handleExportExcel = () => {
    const filename = ReportExporter.generateFilename(
      title,
      selectedFY,
      "",
      "xlsx",
    );
    ReportExporter.exportToExcel(title, sortedData, exportColumns, filename, {
      name: companyInfo.name,
      fy: selectedFY,
    });
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-6 p-6 max-w-[1600px] mx-auto bg-slate-50 min-h-screen text-slate-900 print:bg-white print:p-0">
      {/* Printable Header */}
      <div className="bg-white p-6 rounded-xl shadow-xs border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {title}
            </h1>
            <span className="bg-blue-50 text-blue-700 text-xs px-2.5 py-0.5 rounded-full font-semibold border border-blue-200">
              {selectedFY}
            </span>
          </div>
          <p className="text-sm text-slate-500 mt-1">{description}</p>
        </div>

        <div className="hidden print:block text-right text-xs text-slate-500 space-y-0.5 border-l border-slate-200 pl-4">
          <p className="font-bold text-slate-900">{companyInfo.name}</p>
          <p>{companyInfo.address}</p>
          <p>
            GSTIN: <span className="font-medium">{companyInfo.gstin}</span> |
            PAN: <span className="font-medium">{companyInfo.pan}</span>
          </p>
          <p className="text-[11px] text-slate-400">
            Generated on: {new Date().toLocaleString("en-GB")}
          </p>
        </div>
      </div>

      {/* Filter & Action Control Bar */}
      <div className="bg-white p-4 rounded-xl shadow-xs border border-slate-200 flex flex-wrap justify-between items-center gap-3 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-600">
              Financial Year:
            </span>
            <select
              className="text-xs border border-slate-300 rounded-md px-2.5 py-1.5 bg-white font-medium focus:outline-hidden focus:ring-2 focus:ring-blue-500"
              value={selectedFY}
              onChange={(e) => onFYChange && onFYChange(e.target.value)}
            >
              {financialYears.map((fy) => (
                <option key={fy} value={fy}>
                  {fy}
                </option>
              ))}
            </select>
          </div>

          <div className="relative w-64">
            <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-slate-400" />
            <Input
              placeholder="Search report..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-8 h-8 text-xs bg-slate-50 border-slate-200"
            />
          </div>

          {onRefresh && (
            <Button
              onClick={onRefresh}
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`}
              />
              Reset Filters
            </Button>
          )}
        </div>

        {/* Export Buttons */}
        <div className="flex items-center gap-2">
          <Button
            onClick={handlePrint}
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 text-slate-700 border-slate-300"
          >
            <Printer className="w-3.5 h-3.5" /> Print / PDF
          </Button>
          <Button
            onClick={handleExportCSV}
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100"
          >
            <FileText className="w-3.5 h-3.5" /> CSV
          </Button>
          <Button
            onClick={handleExportExcel}
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5 text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      {kpiCards.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {kpiCards.map((kpi, idx) => (
            <Card key={idx} className="bg-white border-slate-200 shadow-2xs">
              <CardHeader className="p-4 pb-1">
                <CardTitle className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  {kpi.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <div className="text-xl font-extrabold text-slate-900">
                  {kpi.value}
                </div>
                {kpi.subtitle && (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {kpi.subtitle}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Detailed Report Table */}
      <Card className="bg-white border-slate-200 shadow-2xs overflow-hidden">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-slate-100">
              <TableRow>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`cursor-pointer select-none text-xs font-bold text-slate-700 py-3 ${
                      col.align === "right"
                        ? "text-right"
                        : col.align === "center"
                          ? "text-center"
                          : "text-left"
                    }`}
                  >
                    <div
                      className={`flex items-center gap-1.5 ${
                        col.align === "right"
                          ? "justify-end"
                          : col.align === "center"
                            ? "justify-center"
                            : "justify-start"
                      }`}
                    >
                      {col.header}
                      <ArrowUpDown className="w-3 h-3 text-slate-400" />
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedData.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="text-center py-12 text-sm text-slate-500"
                  >
                    No records found for this report filter.
                  </TableCell>
                </TableRow>
              ) : (
                paginatedData.map((row, idx) => (
                  <TableRow
                    key={row.id || idx}
                    className="hover:bg-slate-50/80 transition-colors"
                  >
                    {columns.map((col) => (
                      <TableCell
                        key={col.key}
                        className={`text-xs py-2.5 ${
                          col.align === "right"
                            ? "text-right font-medium"
                            : col.align === "center"
                              ? "text-center"
                              : "text-left"
                        }`}
                      >
                        {col.render ? col.render(row) : (row[col.key] ?? "—")}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          {/* Table Pagination Footer */}
          <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs text-slate-600 print:hidden">
            <div>
              Showing {sortedData.length > 0 ? (page - 1) * pageSize + 1 : 0} to{" "}
              {Math.min(page * pageSize, sortedData.length)} of{" "}
              {sortedData.length} entries
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="h-7 px-2 text-xs"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </Button>
              <span className="font-semibold text-slate-800">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="h-7 px-2 text-xs"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
