import ExcelJS from "exceljs";
import {
  HEADER_NAVY,
  THIN_BORDER,
  styleDataCell,
  styleHeaderCell,
  styleTotalCell,
} from "@/lib/services/SummaryWorkbookService";
import {
  buildSplitUpSheet,
  buildUploadedDataSheet,
} from "@/lib/services/monthly-splitup/MonthlySplitUpWorkbookService";
import {
  DebtorCreditorPerson,
  DebtorCreditorRoleResult,
  StockAllocationLine,
} from "./types";
import { summarizeKnockoff } from "./StockAllocationEngine";

const CURRENCY_FORMAT = "₹#,##0.00";
const QUANTITY_FORMAT = "#,##0.00";

function personName(people: DebtorCreditorPerson[], personId: string): string {
  return people.find((p) => p.id === personId)?.companyName ?? personId;
}

function personCategory(people: DebtorCreditorPerson[], personId: string): string {
  return people.find((p) => p.id === personId)?.category ?? "";
}

/** One flat "Person | Category | Month | HSN | Description | Qty | Amount"
 * sheet, sorted person -> month -> product, with a grand TOTAL row. */
function buildDetailSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  people: DebtorCreditorPerson[],
  lines: StockAllocationLine[],
) {
  const sheet = workbook.addWorksheet(sheetName);
  const headers = ["Person", "Category", "Month", "HSN Code", "Description", "Qty", "Amount (₹)"];
  headers.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });

  const sorted = [...lines].sort((a, b) => {
    const nameA = personName(people, a.personId);
    const nameB = personName(people, b.personId);
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    if (a.monthIndex !== b.monthIndex) return a.monthIndex - b.monthIndex;
    return a.description.localeCompare(b.description);
  });

  let grandQty = 0;
  let grandAmount = 0;
  sorted.forEach((line, idx) => {
    const row = idx + 2;
    const isOdd = idx % 2 === 1;
    sheet.getCell(row, 1).value = personName(people, line.personId);
    sheet.getCell(row, 2).value = personCategory(people, line.personId);
    sheet.getCell(row, 3).value = line.monthLabel;
    sheet.getCell(row, 4).value = line.hsnCode;
    sheet.getCell(row, 5).value = line.description;
    sheet.getCell(row, 6).value = line.qty;
    sheet.getCell(row, 7).value = line.amount;
    [1, 2, 3, 4, 5].forEach((c) => styleDataCell(sheet.getCell(row, c), isOdd));
    styleDataCell(sheet.getCell(row, 6), isOdd, "right", QUANTITY_FORMAT);
    styleDataCell(sheet.getCell(row, 7), isOdd, "right", CURRENCY_FORMAT);
    grandQty += line.qty;
    grandAmount += line.amount;
  });

  const totalRow = sorted.length + 2;
  sheet.getCell(totalRow, 1).value = "TOTAL";
  for (let c = 1; c <= 5; c++) styleTotalCell(sheet.getCell(totalRow, c));
  sheet.getCell(totalRow, 6).value = grandQty;
  sheet.getCell(totalRow, 7).value = grandAmount;
  styleTotalCell(sheet.getCell(totalRow, 6), "right", QUANTITY_FORMAT);
  styleTotalCell(sheet.getCell(totalRow, 7), "right", CURRENCY_FORMAT);

  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 12;
  sheet.getColumn(3).width = 10;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 40;
  sheet.getColumn(6).width = 12;
  sheet.getColumn(7).width = 16;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function buildDebtorExcel(
  role: DebtorCreditorRoleResult,
  people: DebtorCreditorPerson[],
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildUploadedDataSheet(workbook, role.source);
  buildSplitUpSheet(workbook, "Purchase Split-up", role.source, role.source.purchaseMatrix);
  buildSplitUpSheet(workbook, "Sales Split-up", role.source, role.source.salesMatrix);
  buildDetailSheet(workbook, "Debtors", people, role.allocation.lines);
  return workbook.xlsx.writeBuffer();
}

export async function buildCreditorExcel(
  role: DebtorCreditorRoleResult,
  people: DebtorCreditorPerson[],
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  buildUploadedDataSheet(workbook, role.source);
  buildSplitUpSheet(workbook, "Purchase Split-up", role.source, role.source.purchaseMatrix);
  buildSplitUpSheet(workbook, "Sales Split-up", role.source, role.source.salesMatrix);
  buildDetailSheet(workbook, "Creditors", people, role.allocation.lines);
  return workbook.xlsx.writeBuffer();
}

export async function buildCombinedDebtorCreditorExcel(
  debtor: DebtorCreditorRoleResult,
  creditor: DebtorCreditorRoleResult,
  people: DebtorCreditorPerson[],
): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = summarizeKnockoff(people, debtor.allocation.lines, creditor.allocation.lines);

  const summarySheet = workbook.addWorksheet("Summary");
  summarySheet.mergeCells(1, 1, 1, 7);
  const titleCell = summarySheet.getCell(1, 1);
  titleCell.value = `Debtors & Creditors — Debtor FY ${debtor.source.financialYear} / Creditor FY ${creditor.source.financialYear}`;
  titleCell.font = { name: "Calibri", size: 14, bold: true, color: { argb: HEADER_NAVY } };
  summarySheet.getRow(1).height = 26;

  const headerRow = 2;
  const headers = [
    "Company",
    "Category",
    `Debtor Total (FY ${debtor.source.financialYear})`,
    `Creditor Total (FY ${creditor.source.financialYear})`,
    "Knockoff (Debtor - Creditor)",
  ];
  headers.forEach((h, i) => {
    const cell = summarySheet.getCell(headerRow, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });

  let grandDebtor = 0;
  let grandCreditor = 0;
  summary.forEach((row, idx) => {
    const r = headerRow + 1 + idx;
    const isOdd = idx % 2 === 1;
    summarySheet.getCell(r, 1).value = row.companyName;
    summarySheet.getCell(r, 2).value = row.category;
    summarySheet.getCell(r, 3).value = row.debtorTotal;
    summarySheet.getCell(r, 4).value = row.creditorTotal;
    summarySheet.getCell(r, 5).value = row.knockoff;
    styleDataCell(summarySheet.getCell(r, 1), isOdd);
    styleDataCell(summarySheet.getCell(r, 2), isOdd);
    styleDataCell(summarySheet.getCell(r, 3), isOdd, "right", CURRENCY_FORMAT);
    styleDataCell(summarySheet.getCell(r, 4), isOdd, "right", CURRENCY_FORMAT);
    const knockoffCell = summarySheet.getCell(r, 5);
    styleDataCell(knockoffCell, isOdd, "right", CURRENCY_FORMAT);
    knockoffCell.font = {
      name: "Calibri",
      size: 11,
      bold: true,
      color: { argb: row.knockoff >= 0 ? "FF1B7A3D" : "FFB3261E" },
    };
    grandDebtor += row.debtorTotal;
    grandCreditor += row.creditorTotal;
  });

  const totalRow = headerRow + 1 + summary.length;
  summarySheet.getCell(totalRow, 1).value = "TOTAL";
  styleTotalCell(summarySheet.getCell(totalRow, 1));
  styleTotalCell(summarySheet.getCell(totalRow, 2));
  summarySheet.getCell(totalRow, 3).value = grandDebtor;
  summarySheet.getCell(totalRow, 4).value = grandCreditor;
  summarySheet.getCell(totalRow, 5).value = grandDebtor - grandCreditor;
  styleTotalCell(summarySheet.getCell(totalRow, 3), "right", CURRENCY_FORMAT);
  styleTotalCell(summarySheet.getCell(totalRow, 4), "right", CURRENCY_FORMAT);
  styleTotalCell(summarySheet.getCell(totalRow, 5), "right", CURRENCY_FORMAT);

  summarySheet.getColumn(1).width = 26;
  summarySheet.getColumn(2).width = 12;
  summarySheet.getColumn(3).width = 20;
  summarySheet.getColumn(4).width = 20;
  summarySheet.getColumn(5).width = 22;
  summarySheet.views = [{ state: "frozen", ySplit: headerRow }];

  // Detail sheet: debtor lines and creditor lines side by side, grouped
  // per person, each block with its own subtotal row.
  const detailSheet = workbook.addWorksheet("Debtor & Creditor Detail");
  const detailHeaders = [
    "Person",
    `Debtor Month (FY ${debtor.source.financialYear})`,
    "Debtor HSN",
    "Debtor Product",
    "Debtor Qty",
    "Debtor Amount (₹)",
    `Creditor Month (FY ${creditor.source.financialYear})`,
    "Creditor HSN",
    "Creditor Product",
    "Creditor Qty",
    "Creditor Amount (₹)",
  ];
  detailHeaders.forEach((h, i) => {
    const cell = detailSheet.getCell(1, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });

  let row = 2;
  people.forEach((person) => {
    const debtorLines = debtor.allocation.lines
      .filter((l) => l.personId === person.id)
      .sort((a, b) => a.monthIndex - b.monthIndex);
    const creditorLines = creditor.allocation.lines
      .filter((l) => l.personId === person.id)
      .sort((a, b) => a.monthIndex - b.monthIndex);
    if (debtorLines.length === 0 && creditorLines.length === 0) return;

    const blockRows = Math.max(debtorLines.length, creditorLines.length);
    for (let i = 0; i < blockRows; i++) {
      const isOdd = i % 2 === 1;
      const d = debtorLines[i];
      const c = creditorLines[i];
      if (i === 0) detailSheet.getCell(row, 1).value = person.companyName;
      styleDataCell(detailSheet.getCell(row, 1), isOdd);

      if (d) {
        detailSheet.getCell(row, 2).value = d.monthLabel;
        detailSheet.getCell(row, 3).value = d.hsnCode;
        detailSheet.getCell(row, 4).value = d.description;
        detailSheet.getCell(row, 5).value = d.qty;
        detailSheet.getCell(row, 6).value = d.amount;
      }
      [2, 3, 4].forEach((col) => styleDataCell(detailSheet.getCell(row, col), isOdd));
      styleDataCell(detailSheet.getCell(row, 5), isOdd, "right", QUANTITY_FORMAT);
      styleDataCell(detailSheet.getCell(row, 6), isOdd, "right", CURRENCY_FORMAT);

      if (c) {
        detailSheet.getCell(row, 7).value = c.monthLabel;
        detailSheet.getCell(row, 8).value = c.hsnCode;
        detailSheet.getCell(row, 9).value = c.description;
        detailSheet.getCell(row, 10).value = c.qty;
        detailSheet.getCell(row, 11).value = c.amount;
      }
      [7, 8, 9].forEach((col) => styleDataCell(detailSheet.getCell(row, col), isOdd));
      styleDataCell(detailSheet.getCell(row, 10), isOdd, "right", QUANTITY_FORMAT);
      styleDataCell(detailSheet.getCell(row, 11), isOdd, "right", CURRENCY_FORMAT);

      row++;
    }

    const subtotalRow = row;
    const debtorSubtotal = debtorLines.reduce((s, l) => s + l.amount, 0);
    const creditorSubtotal = creditorLines.reduce((s, l) => s + l.amount, 0);
    detailSheet.getCell(subtotalRow, 1).value = `${person.companyName} — Subtotal`;
    detailSheet.getCell(subtotalRow, 6).value = debtorSubtotal;
    detailSheet.getCell(subtotalRow, 11).value = creditorSubtotal;
    for (let c = 1; c <= 11; c++) styleTotalCell(detailSheet.getCell(subtotalRow, c));
    styleTotalCell(detailSheet.getCell(subtotalRow, 6), "right", CURRENCY_FORMAT);
    styleTotalCell(detailSheet.getCell(subtotalRow, 11), "right", CURRENCY_FORMAT);
    row = subtotalRow + 2; // blank spacer row between people
  });

  detailSheet.getColumn(1).width = 24;
  [2, 7].forEach((c) => (detailSheet.getColumn(c).width = 12));
  [3, 8].forEach((c) => (detailSheet.getColumn(c).width = 14));
  [4, 9].forEach((c) => (detailSheet.getColumn(c).width = 35));
  [5, 10].forEach((c) => (detailSheet.getColumn(c).width = 11));
  [6, 11].forEach((c) => (detailSheet.getColumn(c).width = 16));
  detailSheet.views = [{ state: "frozen", ySplit: 1 }];

  return workbook.xlsx.writeBuffer();
}
