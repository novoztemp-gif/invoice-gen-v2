import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildCombinedDebtorCreditorExcel,
  buildCreditorExcel,
  buildDebtorExcel,
} from "./DebtorCreditorWorkbookService";
import {
  DebtorCreditorPerson,
  DebtorCreditorRoleResult,
  DebtorCreditorSourceData,
  ResolvedSplitUpProduct,
} from "./types";

const PEOPLE: DebtorCreditorPerson[] = [
  { id: "p1", companyName: "Sugumar", category: "Meat" },
  { id: "p2", companyName: "Raja", category: "Meat" },
];

function makeSource(financialYear: string): DebtorCreditorSourceData {
  const products: ResolvedSplitUpProduct[] = [
    { hsnCode: "1001", description: "SEER", uqc: "KGS", totalQuantity: 1000, taxableValue: 100000, category: "Meat", categorySource: "hsn-match" },
  ];
  const months = Array.from({ length: 12 }, (_, i) => ({
    label: `M${i + 1}`,
    monthIndex: i,
    purchaseTotal: 8000,
    salesTotal: 9000,
  }));
  const matrix = products.map(() =>
    months.map(() => ({ qty: 80, amount: 8000 })),
  );
  return { financialYear, products, months, purchaseMatrix: matrix, salesMatrix: matrix };
}

function makeRoleResult(financialYear: string, amount: number): DebtorCreditorRoleResult {
  return {
    source: makeSource(financialYear),
    selectedMonthIndices: [0, 1],
    totalAmount: amount,
    personAmounts: [{ personId: "p1", locked: false, amount }],
    allocation: {
      ok: true,
      lines: [
        { personId: "p1", monthIndex: 0, monthLabel: "M1", productIndex: 0, hsnCode: "1001", description: "SEER", qty: 10, amount: amount / 2 },
        { personId: "p1", monthIndex: 1, monthLabel: "M2", productIndex: 0, hsnCode: "1001", description: "SEER", qty: 10, amount: amount / 2 },
      ],
      shortfalls: [],
    },
  };
}

async function loadWorkbook(buffer: ExcelJS.Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}

describe("buildDebtorExcel", () => {
  it("has all 4 sheets, and the Debtors detail sheet's TOTAL row matches its own data rows", async () => {
    const role = makeRoleResult("2024-25", 1000);
    const buffer = await buildDebtorExcel(role, PEOPLE);
    const wb = await loadWorkbook(buffer);

    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Uploaded Data",
      "Purchase Split-up",
      "Sales Split-up",
      "Debtors",
    ]);

    const sheet = wb.getWorksheet("Debtors")!;
    expect(sheet.getCell(1, 1).value).toBe("Person");
    const totalRow = sheet.lastRow!.number;
    const dataSum = [2, 3].reduce((s, r) => s + (sheet.getCell(r, 7).value as number), 0);
    expect(sheet.getCell(totalRow, 7).value).toBeCloseTo(dataSum, 6);
  });
});

describe("buildCreditorExcel", () => {
  it("has all 4 sheets with a Creditors detail sheet", async () => {
    const role = makeRoleResult("2025-26", 1000);
    const buffer = await buildCreditorExcel(role, PEOPLE);
    const wb = await loadWorkbook(buffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Uploaded Data",
      "Purchase Split-up",
      "Sales Split-up",
      "Creditors",
    ]);
  });
});

describe("buildCombinedDebtorCreditorExcel", () => {
  it("Summary sheet's Knockoff column equals debtorTotal - creditorTotal per row and the grand total matches", async () => {
    const debtor = makeRoleResult("2024-25", 1000);
    const creditor = makeRoleResult("2025-26", 400);
    const buffer = await buildCombinedDebtorCreditorExcel(debtor, creditor, PEOPLE);
    const wb = await loadWorkbook(buffer);

    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Summary",
      "Debtor & Creditor Detail",
    ]);

    const summary = wb.getWorksheet("Summary")!;
    // Row 3 = p1 (Sugumar): debtor 1000, creditor 400, knockoff 600.
    expect(summary.getCell(3, 3).value).toBeCloseTo(1000, 6);
    expect(summary.getCell(3, 4).value).toBeCloseTo(400, 6);
    expect(summary.getCell(3, 5).value).toBeCloseTo(600, 6);

    const totalRow = summary.lastRow!.number;
    expect(summary.getCell(totalRow, 1).value).toBe("TOTAL");
    expect(summary.getCell(totalRow, 5).value).toBeCloseTo(600, 6); // only p1 has amounts
  });
});
