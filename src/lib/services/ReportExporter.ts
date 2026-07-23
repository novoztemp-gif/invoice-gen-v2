import ExcelJS from "exceljs";

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
}

export class ReportExporter {
  /**
   * Helper to build clean, professional dynamic filename
   */
  public static generateFilename(
    reportName: string,
    financialYear?: string,
    context?: string,
    extension: "pdf" | "xlsx" | "csv" = "xlsx",
  ): string {
    const cleanStr = (s: string) =>
      s
        .replace(/[/\\:*?"<>|]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_");

    const parts: string[] = [cleanStr(reportName)];

    if (financialYear) {
      const fyClean = cleanStr(
        financialYear.startsWith("FY") ? financialYear : `FY_${financialYear}`,
      );
      parts.push(fyClean);
    }

    if (context) {
      parts.push(cleanStr(context));
    }

    const today = new Date().toISOString().split("T")[0];
    parts.push(today);

    return `${parts.join("_")}.${extension}`;
  }

  /**
   * Export array of objects to CSV
   */
  public static exportToCSV(
    data: any[],
    columns: ExportColumn[],
    filename: string,
  ) {
    const headers = columns
      .map((c) => `"${c.header.replace(/"/g, '""')}"`)
      .join(",");
    const rows = data.map((row) =>
      columns
        .map((c) => {
          const val = row[c.key] ?? "";
          const strVal =
            typeof val === "object" ? JSON.stringify(val) : String(val);
          return `"${strVal.replace(/"/g, '""')}"`;
        })
        .join(","),
    );

    const csvContent = [headers, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Export array of objects to Excel (.xlsx) using ExcelJS
   */
  public static async exportToExcel(
    title: string,
    data: any[],
    columns: ExportColumn[],
    filename: string,
    companyInfo?: { name?: string; fy?: string },
  ) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(title.substring(0, 31));

    // Header styling
    const titleRow = worksheet.addRow([companyInfo?.name || "ERP REPORT"]);
    titleRow.font = { bold: true, size: 14, color: { argb: "FF000080" } };

    const subtitleRow = worksheet.addRow([
      `${title} | ${companyInfo?.fy || "FY 2025-26"} | Date: ${new Date().toLocaleDateString("en-GB")}`,
    ]);
    subtitleRow.font = { italic: true, size: 10, color: { argb: "FF555555" } };
    worksheet.addRow([]); // Blank row

    // Table Headers
    const headerRow = worksheet.addRow(columns.map((c) => c.header));
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1E293B" }, // slate-800
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // Column widths
    columns.forEach((c, idx) => {
      worksheet.getColumn(idx + 1).width =
        c.width || Math.max(c.header.length + 5, 15);
    });

    // Data Rows
    data.forEach((row) => {
      const rowValues = columns.map((c) => row[c.key] ?? "");
      const r = worksheet.addRow(rowValues);
      r.eachCell((cell, colIndex) => {
        const val = cell.value;
        if (typeof val === "number") {
          cell.alignment = { horizontal: "right" };
          cell.numFmt = "#,##0.00";
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
