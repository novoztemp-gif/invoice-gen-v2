import ExcelJS from "exceljs";
import { readFile } from "fs/promises";
import path from "path";
import {
  HEADER_BAND_FILL,
  HEADER_NAVY,
  THIN_BORDER,
  styleDataCell,
  styleHeaderCell,
} from "@/lib/services/SummaryWorkbookService";
import { parseMonthlySplitUpWorkbook } from "./MonthlySplitUpParser";

export type TemplateKind = "with-purchase" | "no-purchase";

const QUANTITY_FORMAT = "#,##0.00";
const CURRENCY_FORMAT = "₹#,##0.00";

const SOURCE_FILES: Record<TemplateKind, string> = {
  "with-purchase": "monthly-splitup-with-purchase.xlsx",
  "no-purchase": "monthly-splitup-no-purchase.xlsx",
};

/**
 * Builds a clean template workbook for the given kind, sourced from the
 * real reference files in templates/ (so the numbers are realistic, not
 * placeholder zeros) but stripped down to exactly what's actually
 * required: no GROSS PROFIT / PERCENTAGE columns, and — for the
 * no-purchase kind — no PURCHASE column at all (matching how a real
 * "we don't have purchase data" upload is shaped: the column is absent,
 * not just blank).
 */
export async function buildMonthlySplitUpTemplate(
  kind: TemplateKind,
): Promise<ExcelJS.Buffer> {
  const filePath = path.join(process.cwd(), "templates", SOURCE_FILES[kind]);
  const sourceBuffer = await readFile(filePath);
  const parsed = await parseMonthlySplitUpWorkbook(sourceBuffer);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  sheet.getCell(1, 1).value = parsed.financialYear;
  sheet.getCell(1, 1).font = {
    name: "Calibri",
    size: 14,
    bold: true,
    color: { argb: HEADER_NAVY },
  };

  const includePurchase = kind === "with-purchase";
  const headerRow = 2;
  const headers = ["HSN Code", "Description", "UQC", "Total Quantity", "Taxable Value (₹)"];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(headerRow, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });
  const monthlyHeaderCol = 7; // G
  if (includePurchase) {
    const purchaseCell = sheet.getCell(headerRow, monthlyHeaderCol);
    purchaseCell.value = "PURCHASE";
    styleHeaderCell(purchaseCell);
    const salesCell = sheet.getCell(headerRow, monthlyHeaderCol + 1);
    salesCell.value = "SALES";
    styleHeaderCell(salesCell);
  } else {
    const salesCell = sheet.getCell(headerRow, monthlyHeaderCol);
    salesCell.value = "SALES";
    styleHeaderCell(salesCell);
  }

  parsed.products.forEach((p, idx) => {
    const row = headerRow + 1 + idx;
    const isOdd = idx % 2 === 1;
    sheet.getCell(row, 1).value = p.hsnCode;
    sheet.getCell(row, 2).value = p.description;
    sheet.getCell(row, 3).value = p.uqc;
    sheet.getCell(row, 4).value = p.totalQuantity;
    sheet.getCell(row, 5).value = p.taxableValue;
    [1, 2, 3].forEach((c) => styleDataCell(sheet.getCell(row, c), isOdd));
    styleDataCell(sheet.getCell(row, 4), isOdd, "right", QUANTITY_FORMAT);
    styleDataCell(sheet.getCell(row, 5), isOdd, "right", CURRENCY_FORMAT);
  });

  parsed.months.forEach((m, idx) => {
    const row = headerRow + 1 + idx;
    const isOdd = idx % 2 === 1;
    sheet.getCell(row, 6).value = m.label;
    styleDataCell(sheet.getCell(row, 6), isOdd);
    if (includePurchase) {
      sheet.getCell(row, 7).value = m.purchaseTotal ?? 0;
      sheet.getCell(row, 8).value = m.salesTotal;
      styleDataCell(sheet.getCell(row, 7), isOdd, "right", CURRENCY_FORMAT);
      styleDataCell(sheet.getCell(row, 8), isOdd, "right", CURRENCY_FORMAT);
    } else {
      sheet.getCell(row, 7).value = m.salesTotal;
      styleDataCell(sheet.getCell(row, 7), isOdd, "right", CURRENCY_FORMAT);
    }
  });

  const totalRow = headerRow + 1 + parsed.products.length;
  const totalQuantity = parsed.products.reduce((s, p) => s + p.totalQuantity, 0);
  const taxableValue = parsed.products.reduce((s, p) => s + p.taxableValue, 0);
  sheet.getCell(totalRow, 4).value = totalQuantity;
  sheet.getCell(totalRow, 5).value = taxableValue;
  sheet.getCell(totalRow, 6).value = "TOTAL";
  styleDataCell(sheet.getCell(totalRow, 4), false, "right", QUANTITY_FORMAT);
  styleDataCell(sheet.getCell(totalRow, 5), false, "right", CURRENCY_FORMAT);
  sheet.getCell(totalRow, 4).font = { bold: true };
  sheet.getCell(totalRow, 5).font = { bold: true };
  sheet.getCell(totalRow, 6).font = { bold: true };
  sheet.getCell(totalRow, 6).border = THIN_BORDER as any;

  if (includePurchase) {
    const purchaseTotal = parsed.months.reduce((s, m) => s + (m.purchaseTotal ?? 0), 0);
    const salesTotal = parsed.months.reduce((s, m) => s + m.salesTotal, 0);
    sheet.getCell(totalRow, 7).value = purchaseTotal;
    sheet.getCell(totalRow, 8).value = salesTotal;
    styleDataCell(sheet.getCell(totalRow, 7), false, "right", CURRENCY_FORMAT);
    styleDataCell(sheet.getCell(totalRow, 8), false, "right", CURRENCY_FORMAT);
    sheet.getCell(totalRow, 7).font = { bold: true };
    sheet.getCell(totalRow, 8).font = { bold: true };
  } else {
    const salesTotal = parsed.months.reduce((s, m) => s + m.salesTotal, 0);
    sheet.getCell(totalRow, 7).value = salesTotal;
    styleDataCell(sheet.getCell(totalRow, 7), false, "right", CURRENCY_FORMAT);
    sheet.getCell(totalRow, 7).font = { bold: true };
  }

  sheet.getColumn(2).width = 45;
  const widths: Record<number, number> = includePurchase
    ? { 1: 16, 2: 45, 3: 10, 4: 16, 5: 19, 6: 12, 7: 16, 8: 16 }
    : { 1: 16, 2: 45, 3: 10, 4: 16, 5: 19, 6: 12, 7: 16 };
  for (const [col, width] of Object.entries(widths)) {
    sheet.getColumn(Number(col)).width = width;
  }
  sheet.getRow(1).height = 22;

  return workbook.xlsx.writeBuffer();
}
