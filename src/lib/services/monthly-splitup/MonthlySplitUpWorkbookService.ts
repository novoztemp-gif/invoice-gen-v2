import ExcelJS from "exceljs";
import {
  ALT_ROW_FILL,
  HEADER_BAND_FILL,
  HEADER_NAVY,
  THIN_BORDER,
  styleDataCell,
  styleHeaderCell,
  styleTotalCell,
} from "@/lib/services/SummaryWorkbookService";
import {
  MonthlySplitUpMonth,
  MonthlySplitUpProduct,
  MonthlySplitUpResult,
  SplitUpMatrix,
} from "./types";

/** The subset of `MonthlySplitUpResult` that `buildUploadedDataSheet` and
 * `buildSplitUpSheet` actually read — widened (and the two functions
 * exported) so the Debtors & Creditors feature can reuse them verbatim to
 * echo a re-uploaded source file's own sheets back into its own downloads,
 * without duplicating this sheet-building code. `MonthlySplitUpResult`
 * structurally satisfies this type, so existing callers are unaffected. */
export interface SplitUpWorkbookSource {
  financialYear: string;
  products: MonthlySplitUpProduct[];
  months: MonthlySplitUpMonth[];
}

const QUANTITY_FORMAT = "#,##0.00";
// Underlying amount values are always whole rupees (see the engine's
// precision=1 allocation) — this format just displays them the normal
// currency way (".00"), rather than hiding the decimal point entirely.
const CURRENCY_FORMAT = "₹#,##0.00";

function addTitleBanner(sheet: ExcelJS.Worksheet, title: string, colSpan: number) {
  sheet.mergeCells(1, 1, 1, colSpan);
  const cell = sheet.getCell(1, 1);
  cell.value = title;
  cell.font = { name: "Calibri", size: 16, bold: true, color: { argb: HEADER_NAVY } };
  cell.fill = HEADER_BAND_FILL as any;
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = THIN_BORDER as any;
  sheet.getRow(1).height = 32;
}

/** Sheet 1 — re-renders the parsed data back into the original two-table
 * layout. This mirrors the uploaded file's numbers exactly, but is a
 * re-rendering from the already-computed result, not a byte-faithful echo
 * of the original file (the original bytes aren't kept around, so the I/J
 * formula cells become static computed values here). */
export function buildUploadedDataSheet(
  workbook: ExcelJS.Workbook,
  result: SplitUpWorkbookSource,
) {
  const sheet = workbook.addWorksheet("Uploaded Data");

  sheet.getCell(1, 1).value = result.financialYear;
  sheet.getCell(1, 1).font = { name: "Calibri", size: 14, bold: true, color: { argb: HEADER_NAVY } };

  const headerRow = 2;
  const headers = [
    "HSN Code",
    "Description",
    "UQC",
    "Total Quantity",
    "Taxable Value (₹)",
    "",
    "PURCHASE",
    "SALES",
    "GROSS PROFIT",
    "PERCENTAGE",
  ];
  headers.forEach((h, i) => {
    if (!h) return;
    const cell = sheet.getCell(headerRow, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });

  result.products.forEach((p, idx) => {
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

  result.months.forEach((m, idx) => {
    const row = headerRow + 1 + idx;
    const isOdd = idx % 2 === 1;
    sheet.getCell(row, 6).value = m.label;
    sheet.getCell(row, 7).value = m.purchaseTotal ?? 0;
    sheet.getCell(row, 8).value = m.salesTotal;
    const grossProfit = m.salesTotal - (m.purchaseTotal ?? 0);
    sheet.getCell(row, 9).value = grossProfit;
    sheet.getCell(row, 10).value = m.salesTotal
      ? (grossProfit / m.salesTotal) * 100
      : 0;
    styleDataCell(sheet.getCell(row, 6), isOdd);
    [7, 8, 9].forEach((c) =>
      styleDataCell(sheet.getCell(row, c), isOdd, "right", CURRENCY_FORMAT),
    );
    styleDataCell(sheet.getCell(row, 10), isOdd, "right", "0.00");
  });

  const totalRow = headerRow + 1 + result.products.length;
  const totalQuantity = result.products.reduce((s, p) => s + p.totalQuantity, 0);
  const taxableValue = result.products.reduce((s, p) => s + p.taxableValue, 0);
  const purchaseTotal = result.months.reduce((s, m) => s + (m.purchaseTotal ?? 0), 0);
  const salesTotal = result.months.reduce((s, m) => s + m.salesTotal, 0);

  sheet.getCell(totalRow, 4).value = totalQuantity;
  sheet.getCell(totalRow, 5).value = taxableValue;
  sheet.getCell(totalRow, 6).value = "TOTAL";
  sheet.getCell(totalRow, 7).value = purchaseTotal;
  sheet.getCell(totalRow, 8).value = salesTotal;
  sheet.getCell(totalRow, 9).value = salesTotal - purchaseTotal;
  for (let c = 4; c <= 9; c++) {
    styleTotalCell(
      sheet.getCell(totalRow, c),
      c === 6 ? "left" : "right",
      c === 4 ? QUANTITY_FORMAT : c === 6 ? undefined : CURRENCY_FORMAT,
    );
  }

  // Set every column's width explicitly by number — `sheet.columns` is a
  // sparse array that only has real entries for columns already touched
  // via getColumn(), so a forEach over it silently skips any column that
  // was only ever written through getCell(row, col) (which every data
  // column here was), leaving those at Excel's ~8.43 default and showing
  // "#########" for anything wider than a couple of digits.
  const widths: Record<number, number> = { 1: 16, 2: 45, 3: 16, 4: 16, 5: 19, 6: 16, 7: 19, 8: 19, 9: 19, 10: 16 };
  for (const [col, width] of Object.entries(widths)) {
    sheet.getColumn(Number(col)).width = width;
  }
}

/** Sheets 2 & 3 — one row per product, a Qty+Amount column pair per month,
 * then Total Qty + Total Amount. */
export function buildSplitUpSheet(
  workbookRoot: ExcelJS.Workbook,
  sheetName: string,
  result: SplitUpWorkbookSource,
  matrix: SplitUpMatrix,
) {
  const sheet = workbookRoot.addWorksheet(sheetName);
  const monthCount = result.months.length;
  const identityCols = 3; // HSN, Description, UQC
  const monthCols = monthCount * 2;
  const totalCols = 2; // Total Qty, Total Amount
  const lastCol = identityCols + monthCols + totalCols;

  addTitleBanner(sheet, `${sheetName} — FY ${result.financialYear}`, lastCol);

  const headerRow1 = 2;
  const headerRow2 = 3;

  sheet.mergeCells(headerRow1, 1, headerRow2, 1);
  sheet.mergeCells(headerRow1, 2, headerRow2, 2);
  sheet.mergeCells(headerRow1, 3, headerRow2, 3);
  sheet.getCell(headerRow1, 1).value = "HSN Code";
  sheet.getCell(headerRow1, 2).value = "Description";
  sheet.getCell(headerRow1, 3).value = "UQC";

  result.months.forEach((m, idx) => {
    const startCol = identityCols + 1 + idx * 2;
    sheet.mergeCells(headerRow1, startCol, headerRow1, startCol + 1);
    sheet.getCell(headerRow1, startCol).value = m.label;
    sheet.getCell(headerRow2, startCol).value = "Qty";
    sheet.getCell(headerRow2, startCol + 1).value = "Amount (₹)";
  });

  const totalStartCol = identityCols + monthCols + 1;
  sheet.mergeCells(headerRow1, totalStartCol, headerRow2, totalStartCol);
  sheet.mergeCells(headerRow1, totalStartCol + 1, headerRow2, totalStartCol + 1);
  sheet.getCell(headerRow1, totalStartCol).value = "Total Qty";
  sheet.getCell(headerRow1, totalStartCol + 1).value = "Total Amount (₹)";

  for (let c = 1; c <= lastCol; c++) {
    styleHeaderCell(sheet.getCell(headerRow1, c));
    styleHeaderCell(sheet.getCell(headerRow2, c));
  }

  result.products.forEach((p, pIdx) => {
    const row = headerRow2 + 1 + pIdx;
    const isOdd = pIdx % 2 === 1;
    sheet.getCell(row, 1).value = p.hsnCode;
    sheet.getCell(row, 2).value = p.description;
    sheet.getCell(row, 3).value = p.uqc;
    styleDataCell(sheet.getCell(row, 1), isOdd);
    styleDataCell(sheet.getCell(row, 2), isOdd);
    styleDataCell(sheet.getCell(row, 3), isOdd);

    let totalQty = 0;
    let totalAmount = 0;
    matrix[pIdx].forEach((cell, mIdx) => {
      const col = identityCols + 1 + mIdx * 2;
      sheet.getCell(row, col).value = cell.qty;
      sheet.getCell(row, col + 1).value = cell.amount;
      styleDataCell(sheet.getCell(row, col), isOdd, "right", QUANTITY_FORMAT);
      styleDataCell(sheet.getCell(row, col + 1), isOdd, "right", CURRENCY_FORMAT);
      totalQty += cell.qty;
      totalAmount += cell.amount;
    });

    sheet.getCell(row, totalStartCol).value = totalQty;
    sheet.getCell(row, totalStartCol + 1).value = totalAmount;
    styleDataCell(sheet.getCell(row, totalStartCol), isOdd, "right", QUANTITY_FORMAT);
    styleDataCell(
      sheet.getCell(row, totalStartCol + 1),
      isOdd,
      "right",
      CURRENCY_FORMAT,
    );
  });

  const totalRow = headerRow2 + 1 + result.products.length;
  sheet.getCell(totalRow, 1).value = "TOTAL";
  styleTotalCell(sheet.getCell(totalRow, 1));
  styleTotalCell(sheet.getCell(totalRow, 2));
  styleTotalCell(sheet.getCell(totalRow, 3));

  for (let mIdx = 0; mIdx < monthCount; mIdx++) {
    const col = identityCols + 1 + mIdx * 2;
    const qtySum = matrix.reduce((s, row) => s + row[mIdx].qty, 0);
    const amountSum = matrix.reduce((s, row) => s + row[mIdx].amount, 0);
    sheet.getCell(totalRow, col).value = qtySum;
    sheet.getCell(totalRow, col + 1).value = amountSum;
    styleTotalCell(sheet.getCell(totalRow, col), "right", QUANTITY_FORMAT);
    styleTotalCell(sheet.getCell(totalRow, col + 1), "right", CURRENCY_FORMAT);
  }

  const grandQty = matrix.reduce(
    (s, row) => s + row.reduce((rs, c) => rs + c.qty, 0),
    0,
  );
  const grandAmount = matrix.reduce(
    (s, row) => s + row.reduce((rs, c) => rs + c.amount, 0),
    0,
  );
  sheet.getCell(totalRow, totalStartCol).value = grandQty;
  sheet.getCell(totalRow, totalStartCol + 1).value = grandAmount;
  styleTotalCell(sheet.getCell(totalRow, totalStartCol), "right", QUANTITY_FORMAT);
  styleTotalCell(
    sheet.getCell(totalRow, totalStartCol + 1),
    "right",
    CURRENCY_FORMAT,
  );

  sheet.getColumn(2).width = 40;
  sheet.getColumn(1).width = 14;
  sheet.getColumn(3).width = 8;
  // Qty columns (even offset from identityCols) are narrow; Amount columns
  // need real width or the currency format collapses to "#####" — and the
  // Total Amount column (grand sum across all months) needs the most of
  // all. A uniform width for every numeric column was too narrow for any
  // amount cell once real rupee figures were in play.
  for (let mIdx = 0; mIdx < monthCount; mIdx++) {
    const qtyCol = identityCols + 1 + mIdx * 2;
    sheet.getColumn(qtyCol).width = 11;
    sheet.getColumn(qtyCol + 1).width = 16;
  }
  sheet.getColumn(totalStartCol).width = 13;
  sheet.getColumn(totalStartCol + 1).width = 19;

  sheet.views = [{ state: "frozen", xSplit: 3, ySplit: headerRow2 }];
}

export async function buildMonthlySplitUpWorkbook(
  result: MonthlySplitUpResult,
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Invoice Gen";
  workbook.created = new Date();

  buildUploadedDataSheet(workbook, result);
  buildSplitUpSheet(workbook, "Purchase Split-up", result, result.purchaseMatrix);
  buildSplitUpSheet(workbook, "Sales Split-up", result, result.salesMatrix);

  return workbook.xlsx.writeBuffer();
}
