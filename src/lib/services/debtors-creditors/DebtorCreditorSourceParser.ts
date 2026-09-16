import ExcelJS from "exceljs";
import {
  parseUploadedDataSheet,
  readNumeric,
  readText,
} from "@/lib/services/monthly-splitup/MonthlySplitUpParser";
import {
  MonthlySplitUpMonth,
  MonthlySplitUpProduct,
  SplitUpMatrix,
} from "@/lib/services/monthly-splitup/types";

export class DebtorCreditorSourceParseError extends Error {}

const IDENTITY_COLS = 3; // HSN, Description, UQC
const HEADER_ROW_2 = 3;
const DATA_START_ROW = HEADER_ROW_2 + 1;

export interface DebtorCreditorRawSource {
  financialYear: string;
  products: MonthlySplitUpProduct[];
  months: MonthlySplitUpMonth[];
  purchaseMatrix: SplitUpMatrix;
  salesMatrix: SplitUpMatrix;
}

function getRequiredSheet(
  workbook: ExcelJS.Workbook,
  name: string,
): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) {
    throw new DebtorCreditorSourceParseError(
      `This file is missing the "${name}" sheet — did you upload the file downloaded from Monthly Split-up (not the original raw source file)?`,
    );
  }
  return sheet;
}

/** Reads back one of the "Purchase Split-up" / "Sales Split-up" sheets —
 * the exact inverse of MonthlySplitUpWorkbookService's `buildSplitUpSheet`.
 * Rows are in the same order as the Uploaded Data sheet's products (both
 * were written from the same array by the same writer), with a per-row HSN
 * sanity check as a cheap guard against a hand-edited/corrupted file. */
function parseSplitUpSheet(
  sheet: ExcelJS.Worksheet,
  sheetName: string,
  products: MonthlySplitUpProduct[],
  monthCount: number,
): SplitUpMatrix {
  const matrix: SplitUpMatrix = [];

  products.forEach((product, pIdx) => {
    const row = DATA_START_ROW + pIdx;
    const hsnOnRow = readText(sheet.getCell(row, 1));
    if (hsnOnRow !== product.hsnCode.trim()) {
      throw new DebtorCreditorSourceParseError(
        `"${sheetName}" row ${row}: expected HSN "${product.hsnCode}" (matching the Uploaded Data sheet's product order) but found "${hsnOnRow}". The file may be corrupted or hand-edited.`,
      );
    }

    const cells = [];
    for (let mIdx = 0; mIdx < monthCount; mIdx++) {
      const col = IDENTITY_COLS + 1 + mIdx * 2;
      const qty = readNumeric(sheet.getCell(row, col)) ?? 0;
      const amount = readNumeric(sheet.getCell(row, col + 1)) ?? 0;
      cells.push({ qty, amount });
    }
    matrix.push(cells);
  });

  return matrix;
}

/**
 * Parses a re-uploaded Monthly Split-up *download* (3 sheets: "Uploaded
 * Data", "Purchase Split-up", "Sales Split-up") — the input format for the
 * Debtors & Creditors feature. This is different from
 * `parseMonthlySplitUpWorkbook`, which parses the RAW source file Monthly
 * Split-up itself consumes.
 */
export async function parseDebtorCreditorSourceWorkbook(
  data: ArrayBuffer | Buffer,
): Promise<DebtorCreditorRawSource> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as any);

  const uploadedDataSheet = getRequiredSheet(workbook, "Uploaded Data");
  const purchaseSheet = getRequiredSheet(workbook, "Purchase Split-up");
  const salesSheet = getRequiredSheet(workbook, "Sales Split-up");

  const parsedUploadedData = parseUploadedDataSheet(uploadedDataSheet);
  const { financialYear, products } = parsedUploadedData;
  const monthCount = parsedUploadedData.months.length;

  // The source is Monthly Split-up's own output — purchase is always
  // resolved (real or margin-synthesized), never left null.
  const months: MonthlySplitUpMonth[] = parsedUploadedData.months.map((m) => ({
    ...m,
    purchaseTotal: m.purchaseTotal ?? 0,
  }));

  const purchaseMatrix = parseSplitUpSheet(
    purchaseSheet,
    "Purchase Split-up",
    products,
    monthCount,
  );
  const salesMatrix = parseSplitUpSheet(
    salesSheet,
    "Sales Split-up",
    products,
    monthCount,
  );

  // Cross-check: each product's Sales Split-up row should sum to its own
  // annual taxable value from the Uploaded Data sheet — confirms this
  // really is *that* file's own Sales Split-up, not a stray/mismatched one.
  const tolerance = Math.max(1, products.length);
  products.forEach((p, pIdx) => {
    const rowSum = salesMatrix[pIdx].reduce((s, c) => s + c.amount, 0);
    if (Math.abs(rowSum - p.taxableValue) > tolerance) {
      throw new DebtorCreditorSourceParseError(
        `"Sales Split-up" row for "${p.description}" sums to ₹${rowSum.toLocaleString(
          "en-IN",
        )}, but the Uploaded Data sheet's taxable value for it is ₹${p.taxableValue.toLocaleString(
          "en-IN",
        )}. The file may be corrupted or from a different upload.`,
      );
    }
  });

  return { financialYear, products, months, purchaseMatrix, salesMatrix };
}
