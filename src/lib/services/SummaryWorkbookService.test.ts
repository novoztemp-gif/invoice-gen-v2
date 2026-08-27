import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { numberToWords } from "@/lib/numberToWords";
import { stripInvoicePrefixForDisplay } from "./WorkbookSyncEngine";
import {
  FilingWorkbookInput,
  invoiceFooterRows,
  INV_PRODUCT_DATA_ROW,
  INV_PRODUCT_HEADER_ROW,
  MIN_PRODUCT_ROWS,
  safeSheetName,
  SummaryWorkbookService,
} from "./SummaryWorkbookService";

function product(overrides: Partial<any> = {}) {
  return {
    product_id: "p1",
    product_name: "Chicken",
    hsn_code: "0207",
    quantity: 10,
    rate: 100,
    amount: 1000,
    category: "Meat",
    ...overrides,
  };
}

/** Finds the first row in `sheet` whose column-1 value strictly equals `label`. */
function findRowByFirstCell(sheet: any, label: string, maxRow = 40): number {
  for (let r = 1; r <= maxRow; r++) {
    if (sheet.getRow(r).getCell(1).value === label) return r;
  }
  return -1;
}

function invoice(overrides: Partial<any> = {}) {
  return {
    id: "inv-1",
    invoice_number: "2026-27-P-0000001",
    invoice_date: "2026-08-01",
    date_of_supply: "2026-08-01",
    total_amount: 1000,
    transport_mode: "In Hand Delivery",
    vehicle_number: "TN01AB1234",
    customer_id: "party-1",
    products: [product()],
    ...overrides,
  };
}

function makeInput(overrides: Partial<FilingWorkbookInput> = {}): FilingWorkbookInput {
  const partnerMap = new Map<string, any>([
    ["party-1", { company_name: "Acme Traders", gstin: "29AAAAA0000A1Z5" }],
  ]);
  return {
    batch: {
      id: "batch-1",
      batch_type: "PURCHASE",
      financial_year: "2026-27",
      transport_mode: "In Hand Delivery",
      vehicle_number: "TN01AB1234",
      supplier_id: null,
      receiving_company_id: null,
    },
    invoices: [invoice()],
    partnerMap,
    issuingCompany: {
      company_name: "AT Technology",
      address: "123 Main St",
      gstin: "29BBBBB0000B1Z5",
      phone: "9999999999",
    },
    ...overrides,
  };
}

describe("safeSheetName", () => {
  it("strips invalid Excel sheet-name characters", () => {
    const used = new Set<string>();
    const name = safeSheetName("AT/2026-27\\P:0001[x]?*", used);
    expect(name).not.toMatch(/[\\/?*[\]:]/);
  });

  it("truncates to 31 characters", () => {
    const used = new Set<string>();
    const longName = "A".repeat(50);
    const name = safeSheetName(longName, used);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it("de-duplicates colliding names, keeping each unique and within 31 chars", () => {
    const used = new Set<string>();
    const first = safeSheetName("2026-27-P-0000001", used);
    const second = safeSheetName("2026-27-P-0000001", used);
    const third = safeSheetName("2026-27-P-0000001", used);
    expect(new Set([first, second, third]).size).toBe(3);
    for (const n of [first, second, third]) {
      expect(n.length).toBeLessThanOrEqual(31);
    }
  });

  it("de-duplicates safely even for names already at the 31-char limit", () => {
    const used = new Set<string>();
    const longName = "B".repeat(31);
    const first = safeSheetName(longName, used);
    const second = safeSheetName(longName, used);
    expect(first).not.toBe(second);
    expect(second.length).toBeLessThanOrEqual(31);
  });

  it("never produces a blank name", () => {
    const used = new Set<string>();
    const name = safeSheetName("////", used);
    expect(name.trim().length).toBeGreaterThan(0);
  });
});

describe("SummaryWorkbookService.build — Purchase", () => {
  it("produces Batch Overview, Purchase Summary, Product Summary, Supplier Summary, then one sheet per invoice, in that order (Prompt 9, section 2)", async () => {
    const input = makeInput({
      invoices: [
        invoice({ id: "inv-1", invoice_number: "2026-27-P-0000001" }),
        invoice({ id: "inv-2", invoice_number: "2026-27-P-0000002" }),
      ],
    });
    const workbook = await SummaryWorkbookService.build(input);
    const names = workbook.worksheets.map((s) => s.name);

    expect(names[0]).toBe("Batch Overview");
    expect(names[1]).toBe("Purchase Summary");
    expect(names[2]).toBe("Product Summary");
    expect(names[3]).toBe("Supplier Summary");
    // Batch Overview + 3 summaries + 2 invoices + the trailing
    // _hidden_invoice_data sheet (Prompt 4B) — appended last so this
    // "4 summaries first" contract and the slice(4, 4+N) invoice-sheet
    // contract both still hold exactly.
    expect(names.length).toBe(7);
    expect(names.slice(4, 6)).toEqual([
      "2026-27-P-0000001",
      "2026-27-P-0000002",
    ]);
    expect(names[6]).toBe("_hidden_invoice_data");
  });

  it("every finalized invoice gets exactly one sheet — none combined, none skipped", async () => {
    const invoices = Array.from({ length: 7 }, (_, i) =>
      invoice({ id: `inv-${i}`, invoice_number: `2026-27-P-000000${i}` }),
    );
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    // slice(4, 4+7) — invoice sheets only, after the 4 summary sheets and
    // excluding the trailing hidden data sheet that follows them.
    const invoiceSheets = workbook.worksheets.slice(4, 4 + 7);
    expect(invoiceSheets.length).toBe(7);
    expect(invoiceSheets.every((s) => s.name !== "_hidden_invoice_data")).toBe(true);
  });
});

describe("SummaryWorkbookService.build — Sales", () => {
  it("produces Batch Overview, Sales Summary, Product Summary, Customer Summary, then invoice sheets (Prompt 9, section 2)", async () => {
    const input = makeInput({
      batch: {
        batch_type: "SALES",
        financial_year: "2026-27",
        transport_mode: "In Hand Delivery",
        vehicle_number: "TN01AB1234",
      },
      invoices: [invoice({ invoice_number: "AT-2026-27-S-0000001" })],
    });
    const workbook = await SummaryWorkbookService.build(input);
    const names = workbook.worksheets.map((s) => s.name);

    expect(names[0]).toBe("Batch Overview");
    expect(names[1]).toBe("Sales Summary");
    expect(names[2]).toBe("Product Summary");
    expect(names[3]).toBe("Customer Summary");
    expect(names[4]).toBe("AT-2026-27-S-0000001");
  });

  it("uses Sales terminology (Customer) not Purchase terminology (Supplier)", async () => {
    const input = makeInput({
      batch: { batch_type: "SALES", financial_year: "2026-27" },
    });
    const workbook = await SummaryWorkbookService.build(input);
    const summarySheet = workbook.getWorksheet("Sales Summary")!;
    const headerRow = summarySheet.getRow(3);
    const headerValues = headerRow.values as any[];
    expect(headerValues).toContain("Customer");
    expect(headerValues).not.toContain("Supplier");
  });

  it("Purchase uses Supplier terminology, not Customer", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const summarySheet = workbook.getWorksheet("Purchase Summary")!;
    const headerRow = summarySheet.getRow(3);
    const headerValues = headerRow.values as any[];
    expect(headerValues).toContain("Supplier");
    expect(headerValues).not.toContain("Customer");
  });
});

describe("Invoice sheet — vertical product table (Prompt 15, matching the reference invoice exactly)", () => {
  it("the product table header matches the reference invoice's exact 6-column set (Sl.No/Name/HSN/Qty/Rate/Total), not the old per-product 4-column block", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect(sheet.getRow(14).getCell(1).value).toBe("Sl.\nNo.");
    expect(sheet.getRow(14).getCell(2).value).toBe("Name of the Product / Service");
    expect(sheet.getRow(14).getCell(4).value).toBe("HSN/ ACS");
    expect(sheet.getRow(14).getCell(5).value).toBe("Qty in KG");
    expect(sheet.getRow(14).getCell(6).value).toBe("Rate Per KG");
    expect(sheet.getRow(15).getCell(6).value).toBe("Rs.");
    expect(sheet.getRow(14).getCell(8).value).toBe("Total Amount");
  });

  it("every invoice sheet reserves at least MIN_PRODUCT_ROWS blank editable product rows, regardless of how many real products it has", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    const lastRow = INV_PRODUCT_DATA_ROW + MIN_PRODUCT_ROWS - 1;
    // Row 16 has the real product; every row after it up to the padded
    // minimum is blank but still live (formula already in place).
    expect(sheet.getRow(INV_PRODUCT_DATA_ROW).getCell(2).value).toBe("Chicken");
    const blankRow = sheet.getRow(INV_PRODUCT_DATA_ROW + 1);
    expect(blankRow.getCell(2).value).toBe("");
    expect((blankRow.getCell(8).value as any).formula).toContain("IF(AND(");
    // The "Total" row sits immediately after the padded block, at
    // MIN_PRODUCT_ROWS rows down from the first data row — never earlier,
    // even though this invoice only has 1 real product.
    expect(sheet.getRow(lastRow + 1).getCell(1).value).toBe("Total");
  });

  it("products stack in successive rows, never side-by-side columns — never a comma-joined text cell", async () => {
    const products = [
      product({ product_id: "p1", product_name: "Chicken", hsn_code: "0207" }),
      product({ product_id: "p2", product_name: "Mutton", hsn_code: "0204" }),
    ];
    const inv = invoice({ invoice_number: "2026-27-P-0000002", products });
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices: [inv] }),
    );
    const sheet = workbook.getWorksheet("2026-27-P-0000002")!;
    expect(String(sheet.getRow(16).getCell(2).value)).toBe("Chicken");
    expect(String(sheet.getRow(17).getCell(2).value)).toBe("Mutton");
    expect(sheet.getRow(16).getCell(4).value).toBe("0207");
    expect(sheet.getRow(17).getCell(4).value).toBe("0204");
  });

  it("an invoice with more than MIN_PRODUCT_ROWS products grows the table instead of truncating, and the Total row follows it down", async () => {
    const products = Array.from({ length: 20 }, (_, i) =>
      product({ product_id: `p${i}`, product_name: `Product ${i}` }),
    );
    const inv = invoice({ invoice_number: "2026-27-P-0000020", products });
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices: [inv] }),
    );
    const sheet = workbook.getWorksheet("2026-27-P-0000020")!;
    expect(sheet.getRow(INV_PRODUCT_DATA_ROW + 19).getCell(2).value).toBe("Product 19");
    const footer = invoiceFooterRows(20);
    expect(sheet.getRow(footer.totalRow).getCell(1).value).toBe("Total");
  });

  it("represents the actual finalized quantity, rate for each product exactly, with Total Amount computed live (qty * rate)", async () => {
    const inv = invoice({
      invoice_number: "2026-27-P-0000009",
      products: [product({ quantity: 12.5, rate: 350, amount: 4375 })],
    });
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices: [inv] }),
    );
    const sheet = workbook.getWorksheet("2026-27-P-0000009")!;
    const dataRow = sheet.getRow(INV_PRODUCT_DATA_ROW);
    expect(dataRow.getCell(5).value).toBe(12.5);
    expect(dataRow.getCell(6).value).toBe(350);
    expect((dataRow.getCell(8).value as any).formula).toBe(
      `IF(AND(E${INV_PRODUCT_DATA_ROW}<>"",F${INV_PRODUCT_DATA_ROW}<>""),E${INV_PRODUCT_DATA_ROW}*F${INV_PRODUCT_DATA_ROW},"")`,
    );
  });

  it("Purchase invoice sheet matches the reference exactly, never the old Cash Voucher structure or the old horizontal block layout", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    const allValues: string[] = [];
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        allValues.push(String(cell.value));
      });
    });
    expect(allValues).not.toContain("CASH VOUCHER");
    // Prompt 6, section 6: the doc title is now plain "INVOICE" for
    // Purchase (matching the reversed supplier-as-seller structure), not
    // "PURCHASE INVOICE".
    expect(allValues).not.toContain("PURCHASE INVOICE");
    expect(allValues).toContain("INVOICE");
    expect(allValues).not.toContain("Product & HSN"); // old horizontal-block header, gone
    expect(allValues).toContain("Name of the Product / Service");
  });

  it("Sales invoice sheet uses the same vertical layout", async () => {
    const input = makeInput({
      batch: { batch_type: "SALES", financial_year: "2026-27" },
      invoices: [invoice({ invoice_number: "AT-2026-27-S-0000001" })],
    });
    const workbook = await SummaryWorkbookService.build(input);
    const sheet = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const allValues: string[] = [];
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        allValues.push(String(cell.value));
      });
    });
    // Matches the real reference invoice exactly — plain "INVOICE" for
    // both directions, not "SALES INVOICE".
    expect(allValues).toContain("INVOICE");
    expect(allValues).toContain("Name of the Product / Service");
  });

  it("invoice sheet names are safe and unique even when invoice numbers collide or contain unsafe characters", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT/2026-27\\P:0001" }),
      invoice({ id: "b", invoice_number: "AT/2026-27\\P:0001" }), // duplicate on purpose
    ];
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices }),
    );
    const invoiceSheetNames = workbook.worksheets.slice(4, 6).map((s) => s.name);
    expect(new Set(invoiceSheetNames).size).toBe(2);
    for (const name of invoiceSheetNames) {
      expect(name).not.toMatch(/[\\/?*[\]:]/);
    }
  });
});

describe("Summary sheets — data correctness", () => {
  it("Product Summary aggregates quantity and amount across invoices for the same product", async () => {
    const invoices = [
      invoice({
        id: "a",
        invoice_number: "AT-1",
        products: [product({ product_id: "p1", quantity: 10, amount: 1000 })],
      }),
      invoice({
        id: "b",
        invoice_number: "AT-2",
        products: [product({ product_id: "p1", quantity: 5, amount: 500 })],
      }),
    ];
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices }),
    );
    const sheet = workbook.getWorksheet("Product Summary")!;
    const dataRow = sheet.getRow(4);
    // Prompt 3: totals are now SUMIF formulas against the sheet's own
    // hidden line-item table, not hardcoded values — assert both the
    // formula exists and the cached result is still numerically correct.
    const qtyCell = dataRow.getCell(3).value as any;
    const amtCell = dataRow.getCell(4).value as any;
    expect(qtyCell.formula).toContain("SUMIF");
    expect(qtyCell.result).toBe(15); // total quantity
    expect(amtCell.formula).toContain("SUMIF");
    expect(amtCell.result).toBe(1500); // total amount
  });

  it("Supplier Summary aggregates invoice count and total amount per partner", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", customer_id: "party-1", total_amount: 1000 }),
      invoice({ id: "b", invoice_number: "AT-2", customer_id: "party-1", total_amount: 2000 }),
    ];
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices }),
    );
    const sheet = workbook.getWorksheet("Supplier Summary")!;
    const dataRow = sheet.getRow(4);
    expect(dataRow.getCell(1).value).toBe("Acme Traders");
    // Prompt 3: invoice count/total amount are now COUNTIF/SUMIF formulas
    // against the Purchase Summary sheet's hidden Partner ID column.
    const countCell = dataRow.getCell(2).value as any;
    const amountCell = dataRow.getCell(3).value as any;
    expect(countCell.formula).toContain("COUNTIF");
    expect(countCell.result).toBe(2);
    expect(amountCell.formula).toContain("SUMIF");
    expect(amountCell.result).toBe(3000);
  });

  it("Purchase Summary row reflects the actual finalized invoice number, date, partner, and amount", async () => {
    const inv = invoice({
      invoice_number: "2026-27-P-0000042",
      invoice_date: "2026-08-15",
      total_amount: 4375,
    });
    const workbook = await SummaryWorkbookService.build(
      makeInput({ invoices: [inv] }),
    );
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    const dataRow = sheet.getRow(4);
    // Prompt 6 (latest revision): Purchase Summary's own Invoice Number
    // column is now ALSO the prefix-stripped display number.
    expect(dataRow.getCell(1).value).toBe("2026-27-P-0000042");
    expect(dataRow.getCell(2).value).toBe("2026-08-15");
    expect(dataRow.getCell(4).value).toBe("Acme Traders");
    // Prompt 11, section 4/7: Invoice Amount now sits right after the
    // last product block — 1 product -> block occupies columns 5-8,
    // Invoice Amount at column 9 — not a fixed column 5 any more.
    const amountCell = dataRow.getCell(9).value as any;
    expect(amountCell.formula).toContain("SUMIF");
    expect(amountCell.formula).toContain("Total Price");
    expect(amountCell.formula).not.toContain("2026-27-P-0000042");
    expect(amountCell.result).toBe(4375);
  });
});

describe("Prompt 3 — stable identifiers and formula-based data model", () => {
  it("every invoice's stable IDs (real, not invented) are on the central hidden sheet, keyed by Sheet Name (Prompt 4B)", async () => {
    const inv = invoice({ id: "real-invoice-uuid-1", invoice_number: "2026-27-P-0000010" });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const hidden = workbook.getWorksheet("_hidden_invoice_data")!;
    expect(hidden.state).toBe("veryHidden");
    const row = hidden.getRow(2);
    expect(row.getCell(1).value).toBe("batch-1"); // BatchID
    expect(row.getCell(2).value).toBe("real-invoice-uuid-1"); // InvoiceID
    expect(row.getCell(3).value).toBe("2026-27-P-0000010"); // InvoiceNumber
    expect(row.getCell(13).value).toBe("2026-27-P-0000010"); // SheetName
  });

  it("every product line carries a stable Product ID + BlockIndex on the central hidden sheet (Prompt 4B)", async () => {
    const products = [
      product({ product_id: "prod-uuid-1", product_name: "Chicken", hsn_code: "0207", category: "Meat" }),
      product({ product_id: "prod-uuid-2", product_name: "Mango", hsn_code: "0804", category: "Fruits" }),
    ];
    const inv = invoice({ invoice_number: "2026-27-P-0000011", products });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const hidden = workbook.getWorksheet("_hidden_invoice_data")!;
    const line1 = hidden.getRow(2);
    const line2 = hidden.getRow(3);
    expect(line1.getCell(4).value).toBe("prod-uuid-1"); // ProductID
    expect(line1.getCell(6).value).toBe("0207"); // HSN
    expect(line1.getCell(7).value).toBe("Meat"); // Category
    expect(line1.getCell(14).value).toBe(0); // BlockIndex
    expect(line2.getCell(4).value).toBe("prod-uuid-2");
    expect(line2.getCell(6).value).toBe("0804");
    expect(line2.getCell(7).value).toBe("Fruits");
    expect(line2.getCell(14).value).toBe(1); // BlockIndex
  });

  it("Supplier/Customer Summary has a stable, hidden Partner ID column", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Supplier Summary")!;
    expect(sheet.getRow(3).getCell(4).value).toBe("Partner ID");
    expect(sheet.getRow(4).getCell(4).value).toBe("party-1");
    expect(sheet.getColumn(4).hidden).toBe(true);
  });

  it("Product Summary has a stable, hidden Product ID column", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Product Summary")!;
    expect(sheet.getRow(3).getCell(5).value).toBe("Product ID");
    expect(sheet.getRow(4).getCell(5).value).toBe("p1");
    expect(sheet.getColumn(5).hidden).toBe(true);
  });

  it("Total Amount (per product row) and the grand Total row are both formula-based (Prompt 15)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    const lineCell = sheet.getRow(INV_PRODUCT_DATA_ROW).getCell(8).value as any;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const totalCell = sheet.getRow(footer.totalRow).getCell(8).value as any;
    // Prompt 10: the formula string must NOT carry its own leading "=" —
    // ExcelJS writes it verbatim into the <f> XML tag, and OOXML's own
    // implicit "=" on top of that produced a literal "==SUMIF(...)" in
    // real Excel (the exact bug this prompt reported and this asserts
    // against a regression of).
    expect(lineCell.formula).toContain("IF(AND(");
    expect(lineCell.formula.startsWith("=")).toBe(false);
    expect(totalCell.formula).toContain("SUM(");
    expect(totalCell.formula.startsWith("=")).toBe(false);
  });

  it("Supplier/Customer Summary totals are COUNTIF/SUMIF formulas, not hardcoded", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", customer_id: "party-1", total_amount: 1000 }),
      invoice({ id: "b", invoice_number: "AT-2", customer_id: "party-1", total_amount: 2000 }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const sheet = workbook.getWorksheet("Supplier Summary")!;
    const row = sheet.getRow(4);
    expect((row.getCell(2).value as any).formula).toContain("COUNTIF");
    expect((row.getCell(3).value as any).formula).toContain("SUMIF");
  });

  it("Product Summary quantity totals are formula-based, not hardcoded", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", products: [product({ product_id: "p1", quantity: 10 })] }),
      invoice({ id: "b", invoice_number: "AT-2", products: [product({ product_id: "p1", quantity: 5 })] }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const sheet = workbook.getWorksheet("Product Summary")!;
    const cell = sheet.getRow(4).getCell(3).value as any;
    expect(cell.formula).toContain("SUMIF");
    expect(cell.result).toBe(15);
  });

  it("Product Summary amount totals are formula-based, not hardcoded", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", products: [product({ product_id: "p1", amount: 1000 })] }),
      invoice({ id: "b", invoice_number: "AT-2", products: [product({ product_id: "p1", amount: 500 })] }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const sheet = workbook.getWorksheet("Product Summary")!;
    const cell = sheet.getRow(4).getCell(4).value as any;
    expect(cell.formula).toContain("SUMIF");
    expect(cell.result).toBe(1500);
  });

  it("Purchase/Sales Summary's invoice amount formula is a same-row SUMIF over that invoice's own product-block cells, not a cross-sheet lookup (Prompt 9, section 7)", async () => {
    const inv = invoice({ invoice_number: "2026-27-P-0000099", total_amount: 777 });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const summarySheet = workbook.getWorksheet("Purchase Summary")!;
    // 1 product -> block occupies columns 5-8, Invoice Amount at column 9
    // (Prompt 11, section 4: right after the last product block).
    const cell = summarySheet.getRow(4).getCell(9).value as any;
    expect(cell.formula).toBe('SUMIF(3:3,"Total Price",4:4)');
    expect(cell.result).toBe(777);
  });

  it("Purchase/Sales Summary's invoice amount formula remains correct after a product's rate/quantity changes, since it sums live product cells rather than a stored total", async () => {
    const inv = invoice({
      invoice_number: "2026-27-P-0000100",
      products: [product({ product_id: "p1", quantity: 10, rate: 50, amount: 500 })],
      total_amount: 500,
    });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const summarySheet = workbook.getWorksheet("Purchase Summary")!;
    const row = summarySheet.getRow(4);
    // Product block at columns 5-8 — Total Price is column 8 (Prompt 18: a
    // live Qty*Rate formula, not a stored value); Invoice Amount is
    // column 9, right after it.
    expect((row.getCell(8).value as any).formula).toBe("F4*G4");
    expect((row.getCell(9).value as any).formula).toBe('SUMIF(3:3,"Total Price",4:4)');
  });

  it("Purchase workbook structure remains correct (Batch Overview + 3 summaries + invoice sheets + trailing hidden sheet, in order)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const names = workbook.worksheets.map((s) => s.name);
    expect(names).toEqual([
      "Batch Overview", "Purchase Summary", "Product Summary", "Supplier Summary",
      "2026-27-P-0000001", "_hidden_invoice_data",
    ]);
  });

  it("Sales workbook structure remains correct (Batch Overview + 3 summaries + invoice sheets + trailing hidden sheet, in order)", async () => {
    const input = makeInput({
      batch: { batch_type: "SALES", financial_year: "2026-27" },
      invoices: [invoice({ invoice_number: "AT-2026-27-S-0000001" })],
    });
    const workbook = await SummaryWorkbookService.build(input);
    const names = workbook.worksheets.map((s) => s.name);
    // Prompt 9, section 2: Batch Overview now leads the workbook for both
    // batch types — no longer appended after the invoice sheets.
    expect(names).toEqual([
      "Batch Overview", "Sales Summary", "Product Summary", "Customer Summary",
      "AT-2026-27-S-0000001", "_hidden_invoice_data",
    ]);
  });

  it("sheet ordering is unaffected by the new hidden helper data", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    expect(workbook.worksheets[0].name).toBe("Batch Overview");
    expect(workbook.worksheets[1].name).toBe("Purchase Summary");
    expect(workbook.worksheets[2].name).toBe("Product Summary");
    expect(workbook.worksheets[3].name).toBe("Supplier Summary");
  });

  it("the central _hidden_invoice_data sheet has one row per invoice product line with real IDs (Prompt 4B)", async () => {
    const products = [
      product({ product_id: "p1", product_name: "Chicken", quantity: 10, rate: 100, amount: 1000, category: "Meat" }),
      product({ product_id: "p2", product_name: "Mutton", quantity: 5, rate: 200, amount: 1000, category: "Meat" }),
    ];
    const inv = invoice({ id: "inv-77", invoice_number: "2026-27-P-0000077", products });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const hidden = workbook.getWorksheet("_hidden_invoice_data")!;
    expect(hidden.getRow(1).getCell(1).value).toBe("BatchID"); // header row
    const line1 = hidden.getRow(2);
    const line2 = hidden.getRow(3);
    expect(line1.getCell(2).value).toBe("inv-77"); // InvoiceID
    expect(line1.getCell(4).value).toBe("p1"); // ProductID
    expect(line1.getCell(8).value).toBe(10); // Qty
    expect(line1.getCell(10).value).toBe(1000); // Amount
    expect(line1.getCell(13).value).toBe("2026-27-P-0000077"); // SheetName
    expect(line2.getCell(4).value).toBe("p2");
  });

  it("does not disturb the visible product table (header starts at row 14, data visible and unhidden)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect(sheet.getRow(INV_PRODUCT_HEADER_ROW).getCell(1).value).toBe("Sl.\nNo.");
    expect(sheet.getRow(INV_PRODUCT_HEADER_ROW).hidden).toBeFalsy();
    expect(sheet.getRow(INV_PRODUCT_DATA_ROW).hidden).toBeFalsy();
  });

  it("Purchase/Sales Summary has a visible ADD NEW INVOICE trigger cell, and a delete instruction (deletion is native row/sheet deletion, not a trigger)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    expect(sheet.getRow(2).getCell(1).value).toBe("+ ADD NEW INVOICE");
    expect(sheet.getRow(2).getCell(4).value).toContain("delete");
  });
});

// ---------------------------------------------------------------------------
// Prompt 6 — Sales Batch Overview, Amount in Words, Purchase restructuring
// ---------------------------------------------------------------------------

const fullIssuingCompany = {
  company_name: "AT Technology",
  address: "123 Main St, Chennai",
  gstin: "29BBBBB0000B1Z5",
  phone: "9999999999",
  pan: "ABCDE1234F",
  state: "Tamil Nadu",
  state_code: "33",
  bank_account_name: "AT Technology Pvt Ltd",
  bank_name: "HDFC Bank",
  branch: "T Nagar",
  account_number: "123456789012",
  ifsc_code: "HDFC0001234",
};

function makeSalesInput(overrides: Partial<FilingWorkbookInput> = {}): FilingWorkbookInput {
  return makeInput({
    batch: {
      id: "batch-1",
      batch_type: "SALES",
      financial_year: "2026-27",
      transport_mode: "In Hand Delivery",
      vehicle_number: "TN01AB1234",
    },
    invoices: [invoice({ invoice_number: "AT-2026-27-S-0000001" })],
    issuingCompany: fullIssuingCompany,
    ...overrides,
  });
}

describe("Prompt 6, section A/B — Sales Batch Overview and bank-detail propagation", () => {
  it("Batch Overview exists (Sales only) with the exact bank-detail fields, populated from issuing-company data", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    const overview = workbook.getWorksheet("Batch Overview")!;
    expect(overview).toBeDefined();
    expect(findRowByFirstCell(overview, "Name of Account")).toBeGreaterThan(0);
    // Prompt 13: value column moved to 3 (label|colon|value geometry).
    const nameRow = findRowByFirstCell(overview, "Name of Account");
    expect(overview.getRow(nameRow).getCell(3).value).toBe("AT Technology Pvt Ltd");
    expect(overview.getRow(findRowByFirstCell(overview, "Name of Bank")).getCell(3).value).toBe("HDFC Bank");
    expect(overview.getRow(findRowByFirstCell(overview, "Branch Name")).getCell(3).value).toBe("T Nagar");
    expect(overview.getRow(findRowByFirstCell(overview, "Account No.")).getCell(3).value).toBe("123456789012");
    expect(overview.getRow(findRowByFirstCell(overview, "IFSC Code")).getCell(3).value).toBe("HDFC0001234");
    expect(overview.getRow(findRowByFirstCell(overview, "PAN")).getCell(3).value).toBe("ABCDE1234F");
  });

  it("Purchase workbooks also have a Batch Overview sheet, with hero stat cards and batch statistics — never the Sales-only editable bank-detail section (Prompt 16)", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", customer_id: "party-1", total_amount: 1000, invoice_date: "2026-08-01" }),
      invoice({ id: "b", invoice_number: "AT-2", customer_id: "party-1", total_amount: 2000, invoice_date: "2026-08-05" }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices })); // default batch_type PURCHASE
    const overview = workbook.getWorksheet("Batch Overview")!;
    expect(overview).toBeDefined();

    expect(findRowByFirstCell(overview, "Name of Account")).toBe(-1); // no Sales-only editable bank section
    expect(findRowByFirstCell(overview, "Batch Information")).toBeGreaterThan(0);

    // Prompt 16: Grand Total/Invoice Count/Average Invoice are hero cards
    // at the fixed BATCH_OVERVIEW_HERO_ROW (3/4), not detail-section rows.
    expect(overview.getRow(3).getCell(1).value).toBe("GRAND TOTAL");
    expect(overview.getRow(4).getCell(1).value).toBe(3000);
    expect(overview.getRow(3).getCell(4).value).toBe("INVOICE COUNT");
    expect(overview.getRow(4).getCell(4).value).toBe(2);

    const supplierCountRow = findRowByFirstCell(overview, "Supplier Count");
    expect(overview.getRow(supplierCountRow).getCell(3).value).toBe(1);
    const dateRangeRow = findRowByFirstCell(overview, "Date Range");
    expect(overview.getRow(dateRangeRow).getCell(3).value).toBe("2026-08-01 to 2026-08-05");
  });

  it("Sales Batch Overview now ALSO shows the same hero cards and batch-statistics sections Purchase has, on top of its own bank-detail fields (Prompt 16 — reverses Prompt 9's earlier 'no invented fields' scope)", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    const overview = workbook.getWorksheet("Batch Overview")!;
    expect(overview.getRow(3).getCell(1).value).toBe("GRAND TOTAL");
    expect(overview.getRow(3).getCell(4).value).toBe("INVOICE COUNT");
    expect(findRowByFirstCell(overview, "Batch Information")).toBeGreaterThan(0);
    expect(findRowByFirstCell(overview, "Name of Account")).toBeGreaterThan(0);
  });

  it("every Sales invoice sheet's bank-detail values are FORMULAS pointing back at Batch Overview (propagation is formula-driven, not copied)", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    const sheet = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const nameOfAccountCell = sheet.getRow(footer.bankAccountRow).getCell(3).value as any;
    expect(nameOfAccountCell.formula).toBe("'Batch Overview'!C7");
    const ifscCell = sheet.getRow(footer.bankIfscRow).getCell(3).value as any;
    expect(ifscCell.formula).toBe("'Batch Overview'!C11");
  });

  it("multiple Sales invoices in the same batch all reference the SAME Batch Overview cells (one shared source, not per-invoice copies)", async () => {
    const workbook = await SummaryWorkbookService.build(
      makeSalesInput({
        invoices: [
          invoice({ id: "a", invoice_number: "AT-2026-27-S-0000001" }),
          invoice({ id: "b", invoice_number: "AT-2026-27-S-0000002" }),
        ],
      }),
    );
    const s1 = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const s2 = workbook.getWorksheet("AT-2026-27-S-0000002")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect((s1.getRow(footer.bankAccountRow).getCell(3).value as any).formula).toBe(
      (s2.getRow(footer.bankAccountRow).getCell(3).value as any).formula,
    );
  });
});

describe("Prompt 6, section C — Amount in Words derived from Invoice Amount", () => {
  it("uses the app's own existing numberToWords utility, never a hard-coded/invented string", async () => {
    const inv = invoice({ total_amount: 55000, products: [product({ amount: 55000 })] });
    const workbook = await SummaryWorkbookService.build(makeSalesInput({ invoices: [inv] }));
    const sheet = workbook.getWorksheet(inv.invoice_number)!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const cell = sheet.getRow(footer.wordsRow).getCell(1).value;
    // numberToWords() already embeds "Rupees" itself (right before "Only")
    // — used directly, matching the real reference's own wording exactly
    // ("Rupees in words: Twenty Two Thousand Five Hundred Only", no
    // doubled "Rupees").
    expect(cell).toBe(`Rupees in words: ${numberToWords(55000)}`);
  });

  it("works for Purchase invoices too (section 14)", async () => {
    const inv = invoice({ total_amount: 4375, products: [product({ amount: 4375 })] });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] })); // default PURCHASE
    const sheet = workbook.getWorksheet(inv.invoice_number)!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const cell = sheet.getRow(footer.wordsRow).getCell(1).value;
    expect(cell).toBe(`Rupees in words: ${numberToWords(4375)}`);
  });

  it("reflects that specific invoice's own amount, not the batch total or another invoice's amount", async () => {
    const workbook = await SummaryWorkbookService.build(
      makeSalesInput({
        invoices: [
          invoice({ id: "a", invoice_number: "AT-2026-27-S-0000001", total_amount: 1000, products: [product({ amount: 1000 })] }),
          invoice({ id: "b", invoice_number: "AT-2026-27-S-0000002", total_amount: 9000, products: [product({ amount: 9000 })] }),
        ],
      }),
    );
    const s1 = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const s2 = workbook.getWorksheet("AT-2026-27-S-0000002")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect(s1.getRow(footer.wordsRow).getCell(1).value).toBe(`Rupees in words: ${numberToWords(1000)}`);
    expect(s2.getRow(footer.wordsRow).getCell(1).value).toBe(`Rupees in words: ${numberToWords(9000)}`);
  });
});

describe("Prompt 6, sections D/E/F/G/H/I/J — Purchase invoice restructuring", () => {
  function purchaseInput(overrides: Partial<FilingWorkbookInput> = {}): FilingWorkbookInput {
    const partnerMap = new Map<string, any>([
      ["party-1", {
        company_name: "Om Traders",
        gstin: "29CCCCC0000C1Z5",
        address: "45 Supplier Street, Madurai",
      }],
    ]);
    return makeInput({
      invoices: [invoice({ invoice_number: "AT-2021-22-P-00000001", customer_id: "party-1" })],
      partnerMap,
      issuingCompany: fullIssuingCompany,
      ...overrides,
    });
  }

  it("D: the top section uses the SUPPLIER, not our own company", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Om Traders");
    expect(sheet.getRow(1).getCell(1).value).not.toBe(fullIssuingCompany.company_name);
  });

  it("section headers match the reference exactly (merged A:C / D:H, Prompt 13)", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    expect(sheet.getRow(4).getCell(1).value).toBe("Delivery Details");
    expect(sheet.getRow(4).getCell(4).value).toBe("Seller Details");
    expect(sheet.getRow(8).getCell(1).value).toBe("Details of Receiver / Billed to :");
    expect(sheet.getRow(8).getCell(4).value).toBe("Original for Recipient");
    // Real merges now, matching the reference's own A4:C4/D4:H4.
    expect(sheet.getCell("A4").isMerged).toBe(true);
    expect(sheet.getCell("D4").isMerged).toBe(true);
  });

  it("E: Seller Details (paired with Delivery Details/Vehicle Number, rows 5-7) use the supplier's GSTIN and Phone — left blank when phone is unavailable, never substituted", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    // Prompt 15: rows 5-7's right side is a single concatenated "Label :
    // value" cell (columns 4-8 merged), matching the reference exactly —
    // not a separate label|colon|value triple like rows 9-13. GSTIN is
    // paired with Transport Mode (row 5); Phone is paired with Date of
    // Supply (row 7) — Vehicle Number's row (6) has no right-side content.
    expect(sheet.getRow(5).getCell(4).value).toBe("GSTIN : 29CCCCC0000C1Z5");
    expect(sheet.getRow(7).getCell(4).value).toBe(""); // not available on FilingPartner, left blank
  });

  it("F: Receiver/Billed To uses OUR issuing company (name, GSTIN, address, PAN, state, state code)", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    // Prompt 13: left-side values now at column 3; State Code (right side)
    // label at column 4, value at column 7.
    expect(sheet.getRow(9).getCell(1).value).toBe("Name");
    expect(sheet.getRow(9).getCell(3).value).toBe(fullIssuingCompany.company_name);
    expect(sheet.getRow(10).getCell(1).value).toBe("Address");
    expect(sheet.getRow(10).getCell(3).value).toBe(fullIssuingCompany.address);
    expect(sheet.getRow(11).getCell(1).value).toBe("GSTIN");
    expect(sheet.getRow(11).getCell(3).value).toBe(fullIssuingCompany.gstin);
    expect(sheet.getRow(12).getCell(1).value).toBe("PAN");
    expect(sheet.getRow(12).getCell(3).value).toBe(fullIssuingCompany.pan);
    expect(sheet.getRow(13).getCell(1).value).toBe("State");
    expect(sheet.getRow(13).getCell(3).value).toBe(fullIssuingCompany.state);
    // Prompt 15: State Code is a single concatenated "Label : value" cell
    // at column 4 (merged 4-8), matching the reference exactly.
    expect(sheet.getRow(13).getCell(4).value).toBe(`State Code : ${fullIssuingCompany.state_code}`);
  });

  it("G: the Purchase invoice sheet displays the invoice number (paired with Name, under Original for Recipient) with only the app prefix stripped", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    // Prompt 13: right-side label at column 4, value at column 7.
    expect(sheet.getRow(9).getCell(4).value).toBe("Invoice No");
    const displayed = sheet.getRow(9).getCell(7).value;
    expect(displayed).toBe(stripInvoicePrefixForDisplay("AT-2021-22-P-00000001"));
    expect(displayed).toBe("2021-22-P-00000001");
  });

  it("G (continued): Purchase Summary's own Invoice Number column now ALSO shows the stripped display number (explicit requirement)", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const summary = workbook.getWorksheet("Purchase Summary")!;
    expect(summary.getRow(4).getCell(1).value).toBe("2021-22-P-00000001");
  });

  it("H: the hidden normalized data keeps the full, unstripped invoice number regardless — the stable identity is never destroyed by the display transform", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const hidden = workbook.getWorksheet("_hidden_invoice_data")!;
    expect(hidden.getRow(2).getCell(3).value).toBe("AT-2021-22-P-00000001"); // InvoiceNumber column
  });

  it("I: Purchase bank-detail rows are blank boxes — no labels, no header text, just the bordered grid (Prompt 17)", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect(sheet.getRow(footer.bankHeaderRow).getCell(1).value).toBeNull();
    expect(sheet.getRow(footer.bankAccountRow).getCell(1).value).toBeNull();
    expect(sheet.getRow(footer.bankAccountRow).getCell(3).value).toBeFalsy();
    expect(sheet.getRow(footer.bankAccountRow).getCell(3).border).toBeDefined(); // box/border structure preserved
    expect(sheet.getRow(footer.bankIfscRow).getCell(1).value).toBeNull();
    expect(sheet.getRow(footer.bankIfscRow).getCell(3).value).toBeFalsy();
  });

  it("J: certification uses the supplier's name, never a hard-coded company", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const certText = String(sheet.getRow(footer.termsCertRow).getCell(5).value);
    expect(certText).toContain("For Om Traders");
    expect(certText).toContain("Certified that the particulars given above are true and correct");
  });

  it("Goods Dispatched wording is preserved verbatim (section 11)", async () => {
    const workbook = await SummaryWorkbookService.build(purchaseInput());
    const sheet = workbook.getWorksheet("2021-22-P-00000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect(sheet.getRow(footer.goodsDispatchedRow).getCell(1).value).toBe("✅ GOODS DISPATCHED");
  });

  it("Sales certification uses our own issuing company (unchanged behavior)", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    const sheet = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    const certText = String(sheet.getRow(footer.termsCertRow).getCell(5).value);
    expect(certText).toContain(`For ${fullIssuingCompany.company_name}`);
  });

  it("K: Purchase product rows stack vertically — a 5-product invoice fills 5 successive rows starting at INV_PRODUCT_DATA_ROW", async () => {
    const products = Array.from({ length: 5 }, (_, i) =>
      product({ product_id: `p${i}`, product_name: `Product ${i}` }),
    );
    const workbook = await SummaryWorkbookService.build(
      purchaseInput({ invoices: [invoice({ invoice_number: "AT-2021-22-P-00000005", products })] }),
    );
    const sheet = workbook.getWorksheet("2021-22-P-00000005")!;
    for (let i = 0; i < 5; i++) {
      expect(sheet.getRow(INV_PRODUCT_DATA_ROW + i).getCell(2).value).toBe(`Product ${i}`);
    }
    // Still padded to MIN_PRODUCT_ROWS total, so the Total row doesn't
    // move up just because there were only 5 real products.
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect(sheet.getRow(footer.totalRow).getCell(1).value).toBe("Total");
  });
});

// ---------------------------------------------------------------------------
// Prompt 9 — Invoice Summary product blocks, robust ranges, print scaling
// ---------------------------------------------------------------------------

describe("Prompt 9, sections 5/6/7 — Invoice Summary horizontal product blocks", () => {
  it("gives every invoice row a 4-column block per product, immediately after Supplier/Customer, never a comma-joined cell (Prompt 11, section 4)", async () => {
    const invoices = [
      invoice({
        id: "a",
        invoice_number: "AT-1",
        products: [
          product({ product_id: "p1", product_name: "Chicken", hsn_code: "0207", quantity: 10, rate: 100, amount: 1000 }),
          product({ product_id: "p2", product_name: "Mutton", hsn_code: "0204", quantity: 5, rate: 200, amount: 1000 }),
        ],
      }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    const headerRow = sheet.getRow(3);
    // Column 4 is Supplier; column 5 (E) is the first block's "Product &
    // HSN" label — immediately after, per section 4's non-negotiable order.
    expect(headerRow.getCell(4).value).toBe("Supplier");
    expect(headerRow.getCell(5).value).toBe("Product & HSN");
    expect(headerRow.getCell(6).value).toBe("Qty");
    expect(headerRow.getCell(7).value).toBe("Price per KG");
    expect(headerRow.getCell(8).value).toBe("Total Price");
    // Second block starts at column 9 (I).
    expect(headerRow.getCell(9).value).toBe("Product & HSN");

    const dataRow = sheet.getRow(4);
    expect(String(dataRow.getCell(5).value)).toContain("Chicken");
    expect(String(dataRow.getCell(5).value)).not.toContain("Mutton");
    expect(String(dataRow.getCell(5).value)).not.toContain(",");
    expect(dataRow.getCell(6).value).toBe(10);
    expect(dataRow.getCell(7).value).toBe(100);
    expect((dataRow.getCell(8).value as any).formula).toBe("F4*G4"); // Prompt 18: live formula
    expect(String(dataRow.getCell(9).value)).toContain("Mutton");
  });

  it("allocates blocks for the batch's WIDEST invoice, leaving the trailing blocks of shorter invoices blank — not padded, not a separate row", async () => {
    const invoices = [
      invoice({
        id: "wide",
        invoice_number: "AT-1",
        products: [
          product({ product_id: "p1", product_name: "A" }),
          product({ product_id: "p2", product_name: "B" }),
          product({ product_id: "p3", product_name: "C" }),
        ],
      }),
      invoice({
        id: "narrow",
        invoice_number: "AT-2",
        products: [product({ product_id: "p1", product_name: "A" })],
      }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    // 3 blocks reserved (widest invoice), starting at column 5 -> block 3
    // starts at column 13.
    expect(sheet.getRow(3).getCell(13).value).toBe("Product & HSN");
    // The narrower invoice's row 5 has nothing in blocks 2/3.
    const narrowRow = sheet.getRow(5);
    expect(narrowRow.getCell(5).value).toBeTruthy(); // block 1 filled
    expect(narrowRow.getCell(9).value).toBeFalsy(); // block 2 blank
    expect(narrowRow.getCell(13).value).toBeFalsy(); // block 3 blank
  });

  it("a zero-product invoice still gets a correct Invoice Amount (static fallback, matching the individual invoice sheet's own convention)", async () => {
    const inv = invoice({ invoice_number: "AT-1", products: [], total_amount: 500 });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    expect(sheet.getRow(4).getCell(5).value).toBe(500);
  });
});

describe("Prompt 9, section 8 — Supplier/Customer Summary uses a robust (whole-column) range", () => {
  it("COUNTIF/SUMIF reference whole columns, not a range bounded to today's invoice count", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Supplier Summary")!;
    const row = sheet.getRow(4);
    const countFormula = (row.getCell(2).value as any).formula;
    const amountFormula = (row.getCell(3).value as any).formula;
    // The old bug: a range like $I$4:$I$524 frozen at generation time,
    // which silently stops covering any invoice added after it. A
    // whole-column reference has no "last row" to fall behind. Prompt 11:
    // the referenced column is no longer a fixed I/E — 1 product -> block
    // at 5-8, Invoice Amount at 9 (I), Partner ID at 13 (M).
    expect(countFormula).toContain("$M:$M");
    expect(countFormula).not.toMatch(/\$[A-Z]+\$\d+:\$[A-Z]+\$\d+/);
    expect(amountFormula).toContain("$I:$I");
    expect(amountFormula).not.toMatch(/\$[A-Z]+\$\d+:\$[A-Z]+\$\d+/);
  });
});

describe("Prompt 15 — invoice sheet page setup is always the reference invoice's own portrait layout, regardless of product count", () => {
  it("a 1-product invoice is portrait, fits on exactly one page width, and fits to one page tall", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect(sheet.pageSetup.orientation).toBe("portrait");
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.fitToHeight).toBe(1);
  });

  it("products now stack vertically, not horizontally, so even a many-product invoice stays the same 8-column portrait width", async () => {
    const products = Array.from({ length: 12 }, (_, i) =>
      product({ product_id: `p${i}`, product_name: `Product ${i}` }),
    );
    const inv = invoice({ invoice_number: "2026-27-P-0000123", products });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const sheet = workbook.getWorksheet("2026-27-P-0000123")!;
    expect(sheet.pageSetup.orientation).toBe("portrait");
    expect(sheet.pageSetup.fitToWidth).toBe(1);
  });

  it("uses the reference invoice's own page margins (0.7/0.7/0.75/0.75/0.3/0.3)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect(sheet.pageSetup.margins).toEqual({
      left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3,
    });
  });
});

describe("Prompt 17 — the invoice sheet carries no yellow 'editable' highlighting anywhere, matching the reference invoice exactly", () => {
  it("Transport Mode/Vehicle Number and the product table are plain, unhighlighted cells", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect((sheet.getCell(5, 3).fill as any)?.fgColor?.argb).not.toBe("FFFFF2CC");
    expect((sheet.getCell(6, 3).fill as any)?.fgColor?.argb).not.toBe("FFFFF2CC");
    expect((sheet.getCell(INV_PRODUCT_DATA_ROW, 2).fill as any)?.fgColor?.argb).not.toBe("FFFFF2CC");
  });

  it("Purchase bank-detail boxes and Sales bank-detail formula cells are both plain, unhighlighted cells", async () => {
    const purchaseWb = await SummaryWorkbookService.build(makeInput());
    const purchaseSheet = purchaseWb.getWorksheet("2026-27-P-0000001")!;
    const salesWb = await SummaryWorkbookService.build(makeSalesInput());
    const salesSheet = salesWb.getWorksheet("AT-2026-27-S-0000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect((purchaseSheet.getRow(footer.bankAccountRow).getCell(3).fill as any)?.fgColor?.argb).not.toBe("FFFFF2CC");
    expect((salesSheet.getRow(footer.bankAccountRow).getCell(3).fill as any)?.fgColor?.argb).not.toBe("FFFFF2CC");
  });

  it("no worksheet or cell protection is ever applied — nothing should block normal Excel editing", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    for (const sheet of workbook.worksheets) {
      expect((sheet as any).sheetProtection).toBeFalsy();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt 10 — no double-equals formulas, VBA column compatibility, phone field
// ---------------------------------------------------------------------------

describe("Prompt 10, section 6 — no formula anywhere starts with its own '='", () => {
  /** Walks every sheet/cell in the workbook and returns any formula string
   * that itself begins with "=" — ExcelJS writes formula strings verbatim
   * into the XML <f> tag, and OOXML's own implicit "=" on top of a formula
   * that already has one is exactly how real Excel produced "==SUMIF(...)". */
  function findLeadingEqualsFormulas(workbook: any): string[] {
    const offenders: string[] = [];
    workbook.worksheets.forEach((sheet: any) => {
      sheet.eachRow({ includeEmpty: false }, (row: any) => {
        row.eachCell({ includeEmpty: false }, (cell: any) => {
          const v = cell.value;
          if (v && typeof v === "object" && "formula" in v && typeof v.formula === "string") {
            if (v.formula.startsWith("=")) {
              offenders.push(`${sheet.name}!${cell.address}: ${v.formula}`);
            }
          }
        });
      });
    });
    return offenders;
  }

  it("Purchase workbook: zero formulas with a leading '='", async () => {
    const invoices = [
      invoice({ id: "a", invoice_number: "AT-1", products: [product({ product_id: "p1" }), product({ product_id: "p2" })] }),
      invoice({ id: "b", invoice_number: "AT-2", products: [product({ product_id: "p1" })] }),
    ];
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    expect(findLeadingEqualsFormulas(workbook)).toEqual([]);
  });

  it("Sales workbook (including Batch Overview bank-detail cross-sheet formulas): zero formulas with a leading '='", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    expect(findLeadingEqualsFormulas(workbook)).toEqual([]);
  });

  it("the raw generated XML never contains a doubled '==' inside an <f> tag", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    const zip = await JSZip.loadAsync(buffer);
    const worksheetFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith("xl/worksheets/") && f.endsWith(".xml") && !zip.files[f].dir,
    );
    expect(worksheetFiles.length).toBeGreaterThan(0);
    for (const f of worksheetFiles) {
      const xml = await zip.file(f)!.async("string");
      expect(xml).not.toMatch(/<f>==/);
    }
  });
});

describe("Prompt 11, section 8 — Purchase/Sales Summary's only fixed columns are 1-4; everything else is header-text-discoverable", () => {
  it("columns 1-4 are always Invoice Number/Invoice Date/Date of Supply/Supplier, regardless of product count", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    const headerRow = sheet.getRow(3);
    expect(headerRow.getCell(1).value).toBe("Invoice Number");
    expect(headerRow.getCell(2).value).toBe("Invoice Date");
    expect(headerRow.getCell(3).value).toBe("Date of Supply");
    expect(headerRow.getCell(4).value).toBe("Supplier");
  });

  it("Date of Supply falls back to Invoice Date when unset, matching the invoice sheet's own fallback — was previously left blank", async () => {
    const workbook = await SummaryWorkbookService.build(
      makeInput({
        invoices: [invoice({ invoice_date: "2026-08-05", date_of_supply: undefined })],
      }),
    );
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    expect(sheet.getRow(4).getCell(3).value).toBe("2026-08-05");
  });

  it("Invoice Amount/Transport Mode/Vehicle Number/Invoice ID/Supplier ID are each discoverable by header text, and their column moves with the batch's product count (matching VBA's new FindColumnByHeader)", async () => {
    function findCol(row: any, label: string): number {
      for (let c = 1; c <= 50; c++) {
        if (row.getCell(c).value === label) return c;
      }
      return -1;
    }
    // 1 product -> tail columns start right after column 8.
    const oneProduct = await SummaryWorkbookService.build(makeInput());
    const s1 = oneProduct.getWorksheet("Purchase Summary")!.getRow(3);
    expect(findCol(s1, "Invoice Amount")).toBe(9);
    expect(findCol(s1, "Transport Mode")).toBe(10);
    expect(findCol(s1, "Vehicle Number")).toBe(11);
    expect(findCol(s1, "Invoice ID")).toBe(12);
    expect(findCol(s1, "Supplier ID")).toBe(13);

    // 3 products -> everything shifts right by 2 blocks (8 columns).
    const threeProducts = await SummaryWorkbookService.build(
      makeInput({
        invoices: [
          invoice({
            products: [product({ product_id: "p1" }), product({ product_id: "p2" }), product({ product_id: "p3" })],
          }),
        ],
      }),
    );
    const s3 = threeProducts.getWorksheet("Purchase Summary")!.getRow(3);
    expect(findCol(s3, "Invoice Amount")).toBe(17);
    expect(findCol(s3, "Transport Mode")).toBe(18);
    expect(findCol(s3, "Vehicle Number")).toBe(19);
    expect(findCol(s3, "Invoice ID")).toBe(20);
    expect(findCol(s3, "Supplier ID")).toBe(21);
  });

  it("no visible Invoice ID / Partner ID column sits between Supplier and the first product block (section 4's explicit prohibition)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    const headerRow = sheet.getRow(3);
    // Column 5, immediately after Supplier (4), must be the product block
    // — never "Invoice ID" or "Supplier ID".
    expect(headerRow.getCell(5).value).toBe("Product & HSN");
  });

  it("Supplier/Customer Summary: Name stays at column 1, Partner ID at column 4 (PT_COL_* in SyncEngine.bas)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Supplier Summary")!;
    expect(sheet.getRow(3).getCell(1).value).toBe("Supplier Name");
    expect(sheet.getRow(3).getCell(4).value).toBe("Partner ID");
  });

  it("Product Summary: Name/HSN/Qty/Amount/ProductID stay at columns 1-5 (PR_COL_* in SyncEngine.bas)", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("Product Summary")!;
    expect(sheet.getRow(3).getCell(1).value).toBe("Product");
    expect(sheet.getRow(3).getCell(2).value).toBe("HSN");
    expect(sheet.getRow(3).getCell(3).value).toBe("Total Quantity");
    expect(sheet.getRow(3).getCell(4).value).toBe("Total Amount");
    expect(sheet.getRow(3).getCell(5).value).toBe("Product ID");
  });

  it("individual invoice sheet: the fixed VBA anchor rows (9, 14-15, 16, then invoiceFooterRows off the product table) are all present at the expected positions", async () => {
    const workbook = await SummaryWorkbookService.build(makeSalesInput());
    const sheet = workbook.getWorksheet("AT-2026-27-S-0000001")!;
    const footer = invoiceFooterRows(MIN_PRODUCT_ROWS);
    expect(sheet.getRow(9).getCell(4).value).toBe("Invoice No");
    expect(sheet.getRow(INV_PRODUCT_HEADER_ROW).getCell(2).value).toBe("Name of the Product / Service");
    expect(sheet.getRow(INV_PRODUCT_DATA_ROW).getCell(2).value).toBeTruthy();
    expect(sheet.getRow(footer.totalRow).getCell(1).value).toBe("Total");
    expect(sheet.getRow(footer.goodsDispatchedRow).getCell(1).value).toBe("✅ GOODS DISPATCHED");
    expect(sheet.getRow(footer.bankHeaderRow).getCell(1).value).toBe("Company's Bank Details :");
    expect(String(sheet.getRow(footer.termsCertRow).getCell(5).value)).toContain(
      "Certified that the particulars given above are true and correct",
    );
  });
});

describe("Prompt 10, section 11 — Purchase Seller Details phone", () => {
  it("shows the supplier's mobile_number when the record has one", async () => {
    const partnerMap = new Map<string, any>([
      ["party-1", { company_name: "Om Traders", gstin: "29CCCCC0000C1Z5", mobile_number: "9876543210" }],
    ]);
    const workbook = await SummaryWorkbookService.build(makeInput({ partnerMap }));
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    // Prompt 15: Phone is paired with Date of Supply, row 7 — a single
    // concatenated "Phone : value" cell at column 4 (merged 4-8).
    expect(sheet.getRow(7).getCell(4).value).toBe("Phone : 9876543210");
  });

  it("stays blank when the supplier record has no mobile_number — never invented", async () => {
    const workbook = await SummaryWorkbookService.build(makeInput());
    const sheet = workbook.getWorksheet("2026-27-P-0000001")!;
    expect(sheet.getRow(7).getCell(4).value).toBe("");
  });
});

describe("Prompt 10, section 25 — large batch", () => {
  it("generates a 200-invoice batch with varying product counts without error, correct sheet count, and no == formulas", async () => {
    const invoices = Array.from({ length: 200 }, (_, i) => {
      const productCount = (i % 5) + 1;
      return invoice({
        id: `inv-${i}`,
        invoice_number: `2026-27-P-${String(i).padStart(7, "0")}`,
        products: Array.from({ length: productCount }, (_, j) =>
          product({ product_id: `p${j}`, product_name: `Product ${j}` }),
        ),
      });
    });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices }));
    const names = workbook.worksheets.map((s) => s.name);
    // Batch Overview + 3 summaries + 200 invoices + hidden data sheet.
    expect(names.length).toBe(205);
    expect(names.slice(4, 204).length).toBe(200);

    const summarySheet = workbook.getWorksheet("Purchase Summary")!;
    // Widest invoice has 5 products -> blocks span columns 5-24, block 5
    // (the last) starting at column 21.
    expect(summarySheet.getRow(3).getCell(21).value).toBe("Product & HSN");
    expect(summarySheet.getRow(3).getCell(25).value).toBe("Invoice Amount");
  });
});

describe("Prompt 14, section 10 — visual separation between product blocks (Purchase/Sales Summary register only — Prompt 15 removed the invoice sheet's own horizontal blocks)", () => {
  it("Purchase/Sales Summary: each block's Total Price column also gets a medium divider border", async () => {
    const products = [product({ product_id: "p1" }), product({ product_id: "p2" })];
    const inv = invoice({ invoice_number: "2026-27-P-0000001", products });
    const workbook = await SummaryWorkbookService.build(makeInput({ invoices: [inv] }));
    const sheet = workbook.getWorksheet("Purchase Summary")!;
    // Block 1 occupies columns 5-8; Total Price is column 8.
    const headerBorder = sheet.getRow(3).getCell(8).border as any;
    const dataBorder = sheet.getRow(4).getCell(8).border as any;
    expect(headerBorder.right.style).toBe("medium");
    expect(dataBorder.right.style).toBe("medium");
  });
});
