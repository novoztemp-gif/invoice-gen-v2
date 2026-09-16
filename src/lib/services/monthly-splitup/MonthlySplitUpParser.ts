import ExcelJS from "exceljs";
import {
  MonthlySplitUpAnnualTotals,
  MonthlySplitUpMonth,
  MonthlySplitUpParsedInput,
  MonthlySplitUpProduct,
} from "./types";

/** Reference layout (see GST9_SUMMARY_RANDOM_APRIL_MARCH.xlsx / the "_1"
 * no-purchase variant at the project root): one sheet, two tables sharing
 * the same row range.
 *  - A1: financial year label.
 *  - Row 2: headers (A:E product table, monthly-totals table starting at
 *    F — but F itself is never headered, it holds the month date in data
 *    rows). The monthly table's own columns are NOT at fixed positions:
 *    the "no purchase given" template drops the PURCHASE column (and
 *    GROSS PROFIT / PERCENTAGE with it) entirely rather than leaving it
 *    blank, which shifts SALES from H to G. Column identity is resolved
 *    by matching row 2's own header text ("PURCHASE" / "SALES"), not by
 *    a hardcoded column index.
 *  - Rows 3..N, cols A-E: one row per product, until column A is blank.
 *  - Rows 3-14 (fixed, 12 rows): month date in F, then whichever of
 *    purchase/sales/gross-profit/percentage columns are actually present.
 *  - A TOTAL row (literal "TOTAL" in column F) with annual sums. */
const PRODUCT_START_ROW = 3;
const MONTH_START_ROW = 3;
const MONTH_ROW_COUNT = 12;
const TOTAL_ROW_SEARCH_LIMIT = 200;
const HEADER_ROW = 2;
const MONTH_DATE_COL = 6;
const MONTHLY_HEADER_SEARCH_LAST_COL = 20;

const COL = {
  hsnCode: 1,
  description: 2,
  uqc: 3,
  totalQuantity: 4,
  taxableValue: 5,
  monthDate: MONTH_DATE_COL,
} as const;

interface MonthlyColumnLayout {
  purchaseCol: number | null;
  salesCol: number;
  grossProfitCol: number | null;
}

/** Scans row 2 from the month-date column rightward for "PURCHASE" /
 * "SALES" / "GROSS PROFIT" header text, so both the full template and the
 * no-purchase template (which physically removes columns rather than
 * leaving them blank) resolve correctly. */
function resolveMonthlyColumnLayout(sheet: ExcelJS.Worksheet): MonthlyColumnLayout {
  let purchaseCol: number | null = null;
  let salesCol: number | null = null;
  let grossProfitCol: number | null = null;

  for (
    let col = MONTH_DATE_COL + 1;
    col <= MONTHLY_HEADER_SEARCH_LAST_COL;
    col++
  ) {
    const text = readText(sheet.getCell(HEADER_ROW, col)).toUpperCase();
    if (!text) continue;
    if (text === "PURCHASE") purchaseCol = col;
    else if (text === "SALES") salesCol = col;
    else if (text.startsWith("GROSS PROFIT")) grossProfitCol = col;
  }

  if (salesCol === null) {
    throw new MonthlySplitUpParseError(
      'Could not find a "SALES" column header in row 2 (searched columns G onward).',
    );
  }

  return { purchaseCol, salesCol, grossProfitCol };
}

/** ExcelJS returns a plain value for a static cell, or `{formula, result}`
 * for a formula cell — ExcelJS.CellFormulaValue is not always what's
 * cached back, so unwrap defensively rather than assume a shape. */
export function readNumeric(cell: ExcelJS.Cell): number | null {
  const raw = cell.value as any;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "object" && "result" in raw) {
    const result = raw.result;
    return typeof result === "number" ? result : null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function readText(cell: ExcelJS.Cell): string {
  const raw = cell.value as any;
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object" && "richText" in raw) {
    return (raw.richText as { text: string }[])
      .map((r) => r.text)
      .join("")
      .trim();
  }
  return String(raw).trim();
}

function formatMonthLabel(cell: ExcelJS.Cell): string {
  const raw = cell.value as any;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return readText(cell);
  const month = date.toLocaleString("en-US", { month: "short" });
  const year = String(date.getFullYear()).slice(-2);
  return `${month}-${year}`;
}

export class MonthlySplitUpParseError extends Error {}

export async function parseMonthlySplitUpWorkbook(
  data: ArrayBuffer | Buffer,
): Promise<MonthlySplitUpParsedInput> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new MonthlySplitUpParseError("The uploaded file has no worksheet.");
  }
  return parseUploadedDataSheet(sheet);
}

/** Parses the "Uploaded Data" table layout (financial year + product table
 * + monthly totals table + TOTAL row) from a single worksheet. Factored out
 * of `parseMonthlySplitUpWorkbook` so the Debtors & Creditors feature can
 * reuse it directly on sheet 1 of a re-uploaded Monthly Split-up download,
 * without re-implementing this parsing logic. */
export function parseUploadedDataSheet(
  sheet: ExcelJS.Worksheet,
): MonthlySplitUpParsedInput {
  const financialYear = readText(sheet.getCell(1, 1));
  if (!financialYear) {
    throw new MonthlySplitUpParseError(
      "Cell A1 should contain the financial year (e.g. \"2024-25\") but is blank.",
    );
  }

  // Products: rows from PRODUCT_START_ROW until column A is blank.
  const products: MonthlySplitUpProduct[] = [];
  for (let row = PRODUCT_START_ROW; ; row++) {
    const hsnCell = sheet.getCell(row, COL.hsnCode);
    const hsnText = readText(hsnCell);
    if (!hsnText) break;

    const totalQuantity = readNumeric(sheet.getCell(row, COL.totalQuantity));
    const taxableValue = readNumeric(sheet.getCell(row, COL.taxableValue));
    if (totalQuantity === null || taxableValue === null) {
      throw new MonthlySplitUpParseError(
        `Row ${row}: "Total Quantity" and "Taxable Value" must both be numbers.`,
      );
    }

    products.push({
      hsnCode: hsnText,
      description: readText(sheet.getCell(row, COL.description)),
      uqc: readText(sheet.getCell(row, COL.uqc)),
      totalQuantity,
      taxableValue,
    });
  }

  if (products.length === 0) {
    throw new MonthlySplitUpParseError(
      "No product rows found starting at row 3, column A.",
    );
  }

  const layout = resolveMonthlyColumnLayout(sheet);

  // Months: fixed 12-row block, independent of where the product loop stopped.
  const months: MonthlySplitUpMonth[] = [];
  for (let i = 0; i < MONTH_ROW_COUNT; i++) {
    const row = MONTH_START_ROW + i;
    const label = formatMonthLabel(sheet.getCell(row, COL.monthDate));
    const salesTotal = readNumeric(sheet.getCell(row, layout.salesCol));
    if (salesTotal === null) {
      throw new MonthlySplitUpParseError(
        `Row ${row}: monthly SALES total is required for every month but is missing.`,
      );
    }
    months.push({
      label,
      monthIndex: i,
      purchaseTotal:
        layout.purchaseCol !== null
          ? readNumeric(sheet.getCell(row, layout.purchaseCol))
          : null,
      salesTotal,
    });
  }

  // TOTAL row: scan column F for the literal text "TOTAL".
  let totalRow: number | null = null;
  for (
    let row = MONTH_START_ROW + MONTH_ROW_COUNT;
    row <= TOTAL_ROW_SEARCH_LIMIT;
    row++
  ) {
    const text = readText(sheet.getCell(row, COL.monthDate)).toUpperCase();
    if (text === "TOTAL") {
      totalRow = row;
      break;
    }
  }
  if (totalRow === null) {
    throw new MonthlySplitUpParseError(
      'Could not find the "TOTAL" row (expected in column F, e.g. F31).',
    );
  }

  const totals: MonthlySplitUpAnnualTotals = {
    totalQuantity: readNumeric(sheet.getCell(totalRow, COL.totalQuantity)) ?? 0,
    taxableValue: readNumeric(sheet.getCell(totalRow, COL.taxableValue)) ?? 0,
    purchaseTotal:
      (layout.purchaseCol !== null
        ? readNumeric(sheet.getCell(totalRow, layout.purchaseCol))
        : null) ?? months.reduce((s, m) => s + (m.purchaseTotal ?? 0), 0),
    salesTotal: readNumeric(sheet.getCell(totalRow, layout.salesCol)) ?? 0,
    grossProfit:
      (layout.grossProfitCol !== null
        ? readNumeric(sheet.getCell(totalRow, layout.grossProfitCol))
        : null) ?? 0,
  };

  // Cross-check: the product table's sales total must agree with the
  // monthly table's sales total (both represent the same annual sales
  // figure, from two independent parts of the sheet) — a real mismatch
  // means the file doesn't match the expected layout, and silently
  // rescaling one side would just hide that.
  const productsTaxableSum = products.reduce((s, p) => s + p.taxableValue, 0);
  const monthsSalesSum = months.reduce((s, m) => s + m.salesTotal, 0);
  const tolerance = Math.max(1, products.length) * 1;
  if (Math.abs(productsTaxableSum - monthsSalesSum) > tolerance) {
    throw new MonthlySplitUpParseError(
      `The product table's total taxable value (₹${productsTaxableSum.toLocaleString(
        "en-IN",
      )}) doesn't match the monthly table's total sales (₹${monthsSalesSum.toLocaleString(
        "en-IN",
      )}). Please check the uploaded file.`,
    );
  }

  return { financialYear, products, months, totals };
}
