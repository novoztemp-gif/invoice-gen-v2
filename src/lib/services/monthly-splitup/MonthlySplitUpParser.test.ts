import ExcelJS from "exceljs";
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  MonthlySplitUpParseError,
  parseMonthlySplitUpWorkbook,
} from "./MonthlySplitUpParser";

/** Builds a minimal fixture matching the reference layout: A1 FY label,
 * row 2 headers, product rows from row 3, and a fixed 12-row F-J monthly
 * block also starting at row 3, followed by a TOTAL row. */
async function buildFixtureWorkbook(options: {
  financialYear?: string;
  products?: { hsn: string; desc: string; uqc: string; qty: number; value: number }[];
  monthlySales: number[]; // length 12
  monthlyPurchase?: (number | null)[]; // length 12, null = blank
  omitA1?: boolean;
}): Promise<ExcelJS.Buffer> {
  const {
    financialYear = "2024-25",
    products = [
      { hsn: "1001", desc: "PRODUCT A", uqc: "KGS", qty: 600, value: 60000 },
      { hsn: "1002", desc: "PRODUCT B", uqc: "KGS", qty: 400, value: 40000 },
    ],
    monthlySales,
    monthlyPurchase = monthlySales.map((s) => s * 0.95),
    omitA1 = false,
  } = options;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");

  if (!omitA1) sheet.getCell(1, 1).value = financialYear;

  sheet.getCell(2, 1).value = "HSN Code";
  sheet.getCell(2, 2).value = "Description";
  sheet.getCell(2, 3).value = "UQC";
  sheet.getCell(2, 4).value = "Total Quantity";
  sheet.getCell(2, 5).value = "Taxable Value (₹)";
  sheet.getCell(2, 7).value = "PURCHASE";
  sheet.getCell(2, 8).value = "SALES";
  sheet.getCell(2, 9).value = "GROSS PROFIT";
  sheet.getCell(2, 10).value = "PERCENTAGE";

  products.forEach((p, idx) => {
    const row = 3 + idx;
    sheet.getCell(row, 1).value = p.hsn;
    sheet.getCell(row, 2).value = p.desc;
    sheet.getCell(row, 3).value = p.uqc;
    sheet.getCell(row, 4).value = p.qty;
    sheet.getCell(row, 5).value = p.value;
  });

  for (let i = 0; i < 12; i++) {
    const row = 3 + i;
    sheet.getCell(row, 6).value = new Date(2024, 3 + i, 1); // Apr..Mar
    const purchase = monthlyPurchase[i];
    if (purchase !== null && purchase !== undefined) {
      sheet.getCell(row, 7).value = purchase;
    }
    sheet.getCell(row, 8).value = monthlySales[i];
    sheet.getCell(row, 9).value = {
      formula: `H${row}-G${row}`,
      result: monthlySales[i] - (purchase ?? 0),
    } as any;
    sheet.getCell(row, 10).value = {
      formula: `I${row}/H${row}*100`,
      result: monthlySales[i]
        ? ((monthlySales[i] - (purchase ?? 0)) / monthlySales[i]) * 100
        : 0,
    } as any;
  }

  const totalRow = 3 + Math.max(products.length, 12) + 2;
  const totalQty = products.reduce((s, p) => s + p.qty, 0);
  const totalValue = products.reduce((s, p) => s + p.value, 0);
  const totalPurchase = monthlyPurchase.reduce(
    (s: number, p) => s + (p ?? 0),
    0,
  );
  const totalSales = monthlySales.reduce((s, v) => s + v, 0);
  sheet.getCell(totalRow, 4).value = totalQty;
  sheet.getCell(totalRow, 5).value = totalValue;
  sheet.getCell(totalRow, 6).value = "TOTAL";
  sheet.getCell(totalRow, 7).value = totalPurchase;
  sheet.getCell(totalRow, 8).value = totalSales;
  sheet.getCell(totalRow, 9).value = totalSales - totalPurchase;

  return workbook.xlsx.writeBuffer();
}

describe("parseMonthlySplitUpWorkbook", () => {
  it("parses a normal file with purchase given for every month", async () => {
    // Default fixture products total ₹1,00,000 — monthly sales must sum to
    // the same, since the parser cross-checks the two tables.
    const monthlySales = new Array(12).fill(100000 / 12);
    const buf = await buildFixtureWorkbook({ monthlySales });

    const result = await parseMonthlySplitUpWorkbook(buf as any);

    expect(result.financialYear).toBe("2024-25");
    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      hsnCode: "1001",
      description: "PRODUCT A",
      uqc: "KGS",
      totalQuantity: 600,
      taxableValue: 60000,
    });
    expect(result.months).toHaveLength(12);
    expect(result.months[0].label).toBe("Apr-24");
    expect(result.months[0].purchaseTotal).toBeCloseTo(monthlySales[0] * 0.95, 5);
    expect(result.months[11].label).toBe("Mar-25");
  });

  it("treats a blank monthly purchase column as null (not zero)", async () => {
    const monthlySales = new Array(12).fill(100000);
    const buf = await buildFixtureWorkbook({
      monthlySales,
      monthlyPurchase: new Array(12).fill(null),
      products: [
        { hsn: "1001", desc: "PRODUCT A", uqc: "KGS", qty: 600, value: 700000 },
        { hsn: "1002", desc: "PRODUCT B", uqc: "KGS", qty: 400, value: 500000 },
      ],
    });

    const result = await parseMonthlySplitUpWorkbook(buf as any);

    expect(result.months.every((m) => m.purchaseTotal === null)).toBe(true);
    expect(result.months.every((m) => m.salesTotal === 100000)).toBe(true);
  });

  it("reads cached formula results for gross profit / percentage without throwing", async () => {
    const monthlySales = new Array(12).fill(50000);
    const buf = await buildFixtureWorkbook({
      monthlySales,
      products: [
        { hsn: "1001", desc: "PRODUCT A", uqc: "KGS", qty: 600, value: 600000 },
      ],
    });
    await expect(parseMonthlySplitUpWorkbook(buf as any)).resolves.toBeDefined();
  });

  it("throws a descriptive error when A1 (financial year) is blank", async () => {
    const monthlySales = new Array(12).fill(10000);
    const buf = await buildFixtureWorkbook({ monthlySales, omitA1: true });

    await expect(parseMonthlySplitUpWorkbook(buf as any)).rejects.toThrow(
      MonthlySplitUpParseError,
    );
  });

  it("throws when the product table's taxable value doesn't match the monthly sales total", async () => {
    const monthlySales = new Array(12).fill(10000); // sums to 120000
    const buf = await buildFixtureWorkbook({
      monthlySales,
      products: [
        { hsn: "1001", desc: "PRODUCT A", uqc: "KGS", qty: 600, value: 999999 },
      ],
    });

    await expect(parseMonthlySplitUpWorkbook(buf as any)).rejects.toThrow(
      MonthlySplitUpParseError,
    );
  });

  it("loads the real reference file at the project root end-to-end", async () => {
    const filePath = path.join(
      process.cwd(),
      "templates",
      "monthly-splitup-with-purchase.xlsx",
    );
    const buffer = readFileSync(filePath);

    const result = await parseMonthlySplitUpWorkbook(buffer);

    expect(result.financialYear).toBe("2024-25");
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.months).toHaveLength(12);
    expect(result.months.every((m) => m.purchaseTotal !== null)).toBe(true);

    const totalTaxable = result.products.reduce((s, p) => s + p.taxableValue, 0);
    expect(totalTaxable).toBeCloseTo(result.totals.taxableValue, 0);
  });

  it("loads the real no-purchase reference file (SALES shifted to column G, no PURCHASE/GROSS PROFIT/PERCENTAGE columns at all)", async () => {
    const filePath = path.join(
      process.cwd(),
      "templates",
      "monthly-splitup-no-purchase.xlsx",
    );
    const buffer = readFileSync(filePath);

    const result = await parseMonthlySplitUpWorkbook(buffer);

    expect(result.financialYear).toBe("2024-25");
    expect(result.months).toHaveLength(12);
    expect(result.months.every((m) => m.purchaseTotal === null)).toBe(true);
    expect(result.months.every((m) => m.salesTotal > 0)).toBe(true);

    const totalTaxable = result.products.reduce((s, p) => s + p.taxableValue, 0);
    expect(totalTaxable).toBeCloseTo(result.totals.taxableValue, 0);
  });

  it("resolves PURCHASE/SALES columns by header text, not fixed position (a hand-built no-purchase fixture with SALES in G)", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell(1, 1).value = "2099-00";
    sheet.getCell(2, 1).value = "HSN Code";
    sheet.getCell(2, 2).value = "Description";
    sheet.getCell(2, 3).value = "UQC";
    sheet.getCell(2, 4).value = "Total Quantity";
    sheet.getCell(2, 5).value = "Taxable Value (₹)";
    sheet.getCell(2, 7).value = "SALES"; // column G, no PURCHASE column at all

    sheet.getCell(3, 1).value = "1001";
    sheet.getCell(3, 2).value = "PRODUCT A";
    sheet.getCell(3, 3).value = "KGS";
    sheet.getCell(3, 4).value = 100;
    sheet.getCell(3, 5).value = 120000;

    for (let i = 0; i < 12; i++) {
      const row = 3 + i;
      sheet.getCell(row, 6).value = new Date(2099, i, 1);
      sheet.getCell(row, 7).value = 10000;
    }
    sheet.getCell(17, 4).value = 100;
    sheet.getCell(17, 5).value = 120000;
    sheet.getCell(17, 6).value = "TOTAL";
    sheet.getCell(17, 7).value = 120000;

    const buf = await workbook.xlsx.writeBuffer();
    const result = await parseMonthlySplitUpWorkbook(buf as any);

    expect(result.months.every((m) => m.purchaseTotal === null)).toBe(true);
    expect(result.months.every((m) => m.salesTotal === 10000)).toBe(true);
  });
});
