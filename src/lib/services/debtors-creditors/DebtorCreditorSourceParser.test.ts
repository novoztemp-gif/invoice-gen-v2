import { describe, expect, it } from "vitest";
import { buildMonthlySplitUpWorkbook } from "@/lib/services/monthly-splitup/MonthlySplitUpWorkbookService";
import { MonthlySplitUpResult } from "@/lib/services/monthly-splitup/types";
import ExcelJS from "exceljs";
import {
  DebtorCreditorSourceParseError,
  parseDebtorCreditorSourceWorkbook,
} from "./DebtorCreditorSourceParser";

function makeFixtureResult(): MonthlySplitUpResult {
  // At least 12 products — parseUploadedDataSheet (existing, shipped code)
  // assumes the TOTAL row lands after all 12 month rows (row 15+), which
  // only holds when there are >= 12 product rows above it. Real uploads
  // always have far more products than months, so this matches real usage.
  const products = Array.from({ length: 14 }, (_, i) => ({
    hsnCode: `300000${i}`,
    description: `PRODUCT ${i}`,
    uqc: "KGS",
    totalQuantity: 1000 + i * 10,
    taxableValue: 100000 + i * 1000,
  }));
  const makeMatrix = (scale: number) =>
    products.map((p) =>
      Array.from({ length: 12 }, () => ({
        qty: p.totalQuantity / 12,
        amount: (p.taxableValue * scale) / 12,
      })),
    );
  const purchaseMatrix = makeMatrix(0.9);
  const salesMatrix = makeMatrix(1);

  // Months' totals must be internally consistent with the matrices (both
  // represent the same underlying numbers) — the parser cross-checks this,
  // same as it does for the products-vs-months taxable-value totals.
  const months = Array.from({ length: 12 }, (_, mIdx) => ({
    label: `M${mIdx + 1}`,
    monthIndex: mIdx,
    purchaseTotal: purchaseMatrix.reduce((s, row) => s + row[mIdx].amount, 0),
    salesTotal: salesMatrix.reduce((s, row) => s + row[mIdx].amount, 0),
  }));

  return {
    financialYear: "2024-25",
    products,
    months,
    purchaseMatrix,
    salesMatrix,
    purchaseTotalsWereSynthesized: false,
    purchaseMarginPercentUsed: 5,
  };
}

describe("parseDebtorCreditorSourceWorkbook", () => {
  it("round-trips a real Monthly Split-up download (products/months/matrices) exactly", async () => {
    const fixture = makeFixtureResult();
    const buffer = await buildMonthlySplitUpWorkbook(fixture);

    const parsed = await parseDebtorCreditorSourceWorkbook(buffer as any);

    expect(parsed.financialYear).toBe("2024-25");
    expect(parsed.products.map((p) => p.hsnCode)).toEqual(
      fixture.products.map((p) => p.hsnCode),
    );
    expect(parsed.months).toHaveLength(12);
    expect(parsed.months.every((m) => m.purchaseTotal !== null)).toBe(true);

    // Row sums match the annual totals.
    parsed.products.forEach((p, pIdx) => {
      const salesSum = parsed.salesMatrix[pIdx].reduce((s, c) => s + c.amount, 0);
      expect(salesSum).toBeCloseTo(p.taxableValue, 0);
    });
  });

  it("throws DebtorCreditorSourceParseError when a required sheet is missing", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Not The Right Sheet");
    const buffer = await workbook.xlsx.writeBuffer();

    await expect(
      parseDebtorCreditorSourceWorkbook(buffer as any),
    ).rejects.toThrow(DebtorCreditorSourceParseError);
  });

  it("throws when a Split-up sheet's row HSN doesn't match the Uploaded Data sheet's order", async () => {
    const fixture = makeFixtureResult();
    const buffer = await buildMonthlySplitUpWorkbook(fixture);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const salesSheet = workbook.getWorksheet("Sales Split-up")!;
    salesSheet.getCell(4, 1).value = "9999999"; // corrupt the first data row's HSN
    const corrupted = await workbook.xlsx.writeBuffer();

    await expect(
      parseDebtorCreditorSourceWorkbook(corrupted as any),
    ).rejects.toThrow(DebtorCreditorSourceParseError);
  });
});
