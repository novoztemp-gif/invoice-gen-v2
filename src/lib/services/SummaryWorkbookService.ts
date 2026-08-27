import ExcelJS from "exceljs";
import { numberToWords } from "@/lib/numberToWords";
import { stripInvoicePrefixForDisplay } from "./WorkbookSyncEngine";

/**
 * Builds the finalized-batch filing workbook (the new XLSM-bound content of
 * the existing "Download Summary" button) — three summary sheets followed
 * by one sheet per finalized invoice, with a horizontal, N-products-wide
 * product layout on each invoice sheet.
 *
 * This service only builds workbook CONTENT via ExcelJS — it has no
 * knowledge of XLSM/macro packaging (see src/lib/utils/xlsmPackager.ts for
 * that) and no knowledge of how the data was fetched (the caller passes in
 * already-fetched, already-finalized data; this file issues no queries of
 * its own). It is purely a read-only transformation of finalized data into
 * a workbook — it never mutates anything it's given.
 */

export type FilingPartner = {
  company_name?: string | null;
  supplier_name?: string | null;
  gstin?: string | null;
  address?: string | null;
  pan?: string | null;
  state?: string | null;
  state_code?: string | null;
  // Prompt 10, section 11: the `suppliers` table already has this column
  // (route.ts's existing `select("*")` already returns it) — only the type
  // was too narrow to see it, leaving Purchase invoices' Seller Details
  // Phone field hard-coded blank even when the supplier has a number on
  // file.
  mobile_number?: string | null;
};

export type FilingIssuingCompany = {
  company_name?: string | null;
  address?: string | null;
  gstin?: string | null;
  phone?: string | null;
  pan?: string | null;
  state?: string | null;
  state_code?: string | null;
  // Bank details (Prompt 6) — the same issuing_companies columns the real
  // download-invoice/route.ts export already reads (bank_account_name,
  // bank_name, account_number, ifsc_code, branch); route.ts's existing
  // `select("*")` on issuing_companies already returns these, so no route
  // change is needed — only widening this type to see them.
  bank_account_name?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  ifsc_code?: string | null;
  branch?: string | null;
};

export type FilingProductLine = {
  product_id?: string | null;
  product_name?: string | null;
  hsn_code?: string | null;
  quantity?: number | string | null;
  rate?: number | string | null;
  amount?: number | string | null;
  category?: string | null;
};

export type FilingInvoice = {
  id: string;
  invoice_number: string;
  invoice_date?: string | null;
  date_of_supply?: string | null;
  total_amount?: number | string | null;
  transport_mode?: string | null;
  vehicle_number?: string | null;
  customer_id?: string | null;
  supplier_id?: string | null;
  products?: FilingProductLine[] | null;
};

export type FilingBatch = {
  id?: string;
  batch_type: "PURCHASE" | "SALES" | string;
  financial_year?: string | null;
  transport_mode?: string | null;
  vehicle_number?: string | null;
  supplier_id?: string | null;
  receiving_company_id?: string | null;
};

export interface FilingWorkbookInput {
  batch: FilingBatch;
  invoices: FilingInvoice[];
  partnerMap: Map<string, FilingPartner>;
  issuingCompany: FilingIssuingCompany | null;
}

const THIN_BORDER = {
  top: { style: "thin", color: { argb: "FF000000" } },
  left: { style: "thin", color: { argb: "FF000000" } },
  bottom: { style: "thin", color: { argb: "FF000000" } },
  right: { style: "thin", color: { argb: "FF000000" } },
} as const;

/**
 * Prompt 14, section 10: a uniform thin border on every cell gave adjacent
 * product blocks no visual signal that one product ends and the next
 * begins — the border between block N's Total Price and block N+1's
 * Product & HSN looked identical to the border between Qty and Price
 * within the SAME block. A medium right border on each block's last
 * column reads as a genuine divider, the way a printed invoice's line
 * items are visually grouped.
 */
const PRODUCT_BLOCK_DIVIDER_BORDER = {
  top: { style: "thin", color: { argb: "FF000000" } },
  left: { style: "thin", color: { argb: "FF000000" } },
  bottom: { style: "thin", color: { argb: "FF000000" } },
  right: { style: "medium", color: { argb: "FF000000" } },
} as const;

// Prompt 10: palette lifted directly from the old Sales invoice reference
// (templates/AT-2021-22-S-0000001.xlsx) — navy bold text on a light grey
// band for every header/section-title/total-emphasis element, rather than
// the previous dark-fill/white-text convention. Reserved for genuine
// header-level elements; plain field labels stay unfilled (see
// HEADER_NAVY/HEADER_BAND_FILL usage below vs. addLabelValueRow).
const HEADER_NAVY = "FF000080";
const HEADER_BAND_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFEAEAEA" },
} as const;

const ALT_ROW_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFF2F2F2" },
} as const;

/**
 * Marks a cell as directly user-editable inside the downloaded workbook
 * (Prompt 3, section 5) — a soft yellow, the conventional Excel "input
 * cell" convention — as distinct from formula/computed cells, which keep
 * their existing bold/grey total styling. Purely visual; does not change
 * how the cell behaves.
 */
const EDITABLE_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF2CC" },
} as const;

const CURRENCY_FORMAT = "₹#,##0.00";
const QUANTITY_FORMAT = "#,##0.00";

/** Prompt 9/12: per-column widths within one product block on the
 * Purchase/Sales Summary register sheet (Product & HSN / Qty / Price per
 * KG / Total Price) — that sheet's own horizontal per-invoice-row layout
 * is unchanged by Prompt 15's invoice-sheet redesign. */
const PRODUCT_BLOCK_COL_WIDTHS = [30, 10, 12, 14] as const;

/**
 * Prompt 4B: the ONE normalized source of truth for every invoice product
 * line across the whole batch, on a dedicated very-hidden worksheet rather
 * than rows appended below each invoice's own visible area (Prompt 3's
 * design). Prompt 4 discovered that per-sheet hidden rows get corrupted by
 * a column-insert used to add a new product block to that same sheet — a
 * dedicated sheet grows vertically only, so it is completely unaffected by
 * any invoice sheet's column layout changing, now or from any future
 * "Add Product" action. See templates/vba/SyncEngine.bas for the VBA that
 * reads/writes it.
 */
const HIDDEN_DATA_SHEET_NAME = "_hidden_invoice_data";

/**
 * Prompt 5: Invoice Summary's lifecycle-control trigger cells — row 2,
 * which addTitleBanner already leaves blank as a spacer row directly below
 * the title banner, above the header row. Same trigger-cell convention as
 * ADD_PRODUCT_TRIGGER_* (no VBA button can be generated by this Node.js
 * toolchain, so a clearly labeled, styled cell is the fallback the
 * existing prompts already established and use consistently).
 */
export const ADD_INVOICE_TRIGGER_ROW = 2;
export const ADD_INVOICE_TRIGGER_COL = 1;
export const ADD_INVOICE_TRIGGER_LABEL = "+ ADD NEW INVOICE";
export const DELETE_INVOICE_TRIGGER_ROW = 2;
export const DELETE_INVOICE_TRIGGER_COL = 4;
// No longer a trigger — a type-the-invoice-number InputBox flow proved
// confusing in practice. Deletion is now just native Excel: delete this
// row, or delete the invoice's own sheet tab; SyncEngine notices either
// one (Workbook_SheetBeforeDelete / row reconciliation) and cleans up +
// renumbers automatically. This cell is just a one-line instruction now.
export const DELETE_INVOICE_TRIGGER_LABEL =
  "To delete: delete this row, or delete the invoice's own sheet tab.";
const HIDDEN_DATA_COLUMNS = [
  "BatchID", "InvoiceID", "InvoiceNumber", "ProductID", "ProductName",
  "HSN", "Category", "Qty", "Rate", "Amount", "PartnerID", "PartnerName",
  "SheetName", "BlockIndex",
] as const;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Excel column index (1-based) -> letter, e.g. 1 -> "A", 27 -> "AA". */
function colLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

const INVALID_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;

/**
 * Excel worksheet names: max 31 chars, cannot contain \ / ? * [ ] : ,
 * cannot be blank, cannot start/end with an apostrophe, and must be
 * case-insensitively unique within the workbook. Truncation always leaves
 * room for a numeric de-dupe suffix so a collision can never push the name
 * back over the limit.
 */
export function safeSheetName(
  rawName: string,
  usedNames: Set<string>,
): string {
  let base = String(rawName || "Sheet")
    .replace(INVALID_SHEET_NAME_CHARS, "-")
    .trim();
  base = base.replace(/^'+|'+$/g, "").trim();
  if (base.length === 0) base = "Sheet";
  if (base.length > 31) base = base.slice(0, 31);

  let candidate = base;
  let suffix = 1;
  while (usedNames.has(candidate.toUpperCase())) {
    suffix++;
    const suffixStr = ` (${suffix})`;
    const maxBaseLen = 31 - suffixStr.length;
    candidate = base.slice(0, Math.max(1, maxBaseLen)) + suffixStr;
  }
  usedNames.add(candidate.toUpperCase());
  return candidate;
}

/** Page margins measured directly off the reference invoice's own
 * pageMargins element (templates/AT-2021-22-S-0000001.xlsx) — used for
 * invoice sheets specifically; summary sheets keep their own tighter,
 * data-table-appropriate margins. */
const REFERENCE_INVOICE_MARGINS = {
  left: 0.7,
  right: 0.7,
  top: 0.75,
  bottom: 0.75,
  header: 0.3,
  footer: 0.3,
} as const;

/**
 * Prompt 9, section 11: a wide invoice (many product blocks) squeezed to a
 * single page width becomes illegibly tiny. `pagesWide` lets a sheet span
 * more than one printed page horizontally instead of over-shrinking —
 * "practical for viewing and printing" rather than uniformly forcing
 * everything onto one page regardless of how wide it actually is.
 * Prompt 12: `orientation`/`pagesTall`/`margins` let invoice sheets match
 * the reference invoice's own actual page setup (portrait, fit-to-one-page
 * tall) rather than every sheet in the workbook using the same landscape,
 * table-oriented defaults.
 */
function configurePage(
  sheet: ExcelJS.Worksheet,
  repeatRow?: string,
  pagesWide = 1,
  orientation: "portrait" | "landscape" = "landscape",
  pagesTall = 0,
  margins: typeof REFERENCE_INVOICE_MARGINS | { left: number; right: number; top: number; bottom: number; header: number; footer: number } = {
    left: 0.5,
    right: 0.5,
    top: 0.6,
    bottom: 0.6,
    header: 0.3,
    footer: 0.3,
  },
) {
  sheet.pageSetup = {
    orientation,
    fitToWidth: pagesWide,
    fitToHeight: pagesTall,
    margins,
    horizontalCentered: true,
    showGridLines: true,
  };
  if (repeatRow && sheet.pageSetup) {
    sheet.pageSetup.printTitlesRow = repeatRow;
  }
}

function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.fill = HEADER_BAND_FILL as any;
  cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: HEADER_NAVY } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = THIN_BORDER as any;
}

function styleDataCell(
  cell: ExcelJS.Cell,
  isOdd: boolean,
  align: "left" | "right" | "center" = "left",
  numFmt?: string,
) {
  cell.font = { name: "Calibri", size: 11 };
  cell.fill = (isOdd ? ALT_ROW_FILL : { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } }) as any;
  cell.alignment = { horizontal: align, vertical: "middle" };
  cell.border = THIN_BORDER as any;
  if (numFmt) cell.numFmt = numFmt;
}

function styleTotalCell(cell: ExcelJS.Cell, align: "left" | "right" | "center" = "left", numFmt?: string) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF595959" } } as any;
  cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  cell.alignment = { horizontal: align, vertical: "middle" };
  cell.border = THIN_BORDER as any;
  if (numFmt) cell.numFmt = numFmt;
}

function autoFitWidths(sheet: ExcelJS.Worksheet, minWidth = 12, skipRows = 0) {
  sheet.columns?.forEach((column) => {
    if (!column) return;
    let maxLength = 0;
    column.eachCell?.({ includeEmpty: false }, (cell, rowIdx) => {
      if (rowIdx <= skipRows) return;
      const val = cell.value;
      if (val === null || val === undefined) return;
      let strVal = String(val);
      if (typeof val === "object" && "formula" in (val as any)) {
        strVal = String((val as any).result ?? "");
      }
      if (strVal.length > maxLength) maxLength = strVal.length;
    });
    column.width = Math.max(maxLength + 3, minWidth);
  });
}

function resolvePartner(
  inv: FilingInvoice,
  batch: FilingBatch,
  partnerMap: Map<string, FilingPartner>,
): { id: string | undefined; partner: FilingPartner; name: string } {
  const partnerId =
    inv.customer_id ||
    inv.supplier_id ||
    (inv.products?.[0] as any)?.customer_id ||
    (inv.products?.[0] as any)?.supplier_id ||
    batch.receiving_company_id ||
    batch.supplier_id ||
    undefined;

  const partner =
    (partnerId && partnerMap.get(partnerId)) ||
    (batch.supplier_id ? partnerMap.get(batch.supplier_id) : undefined) ||
    (batch.receiving_company_id
      ? partnerMap.get(batch.receiving_company_id)
      : undefined) ||
    ({ company_name: "Unknown Company", gstin: "N/A" } as FilingPartner);

  const name =
    partner.company_name || partner.supplier_name || "Unknown Company";

  return { id: partnerId, partner, name };
}

// ---------------------------------------------------------------------------
// Summary sheets
// ---------------------------------------------------------------------------

function addTitleBanner(sheet: ExcelJS.Worksheet, title: string, colSpan: number) {
  sheet.mergeCells(1, 1, 1, colSpan);
  const cell = sheet.getCell(1, 1);
  cell.value = title;
  cell.font = { name: "Calibri", size: 16, bold: true, color: { argb: HEADER_NAVY } };
  cell.fill = HEADER_BAND_FILL as any;
  cell.alignment = { horizontal: "center", vertical: "middle" };
  cell.border = THIN_BORDER as any;
  sheet.getRow(1).height = 32;
  sheet.addRow([]);
}

type InvoiceMeta = {
  inv: FilingInvoice;
  sheetName: string;
};

/**
 * Prompt 9, section 5/6: the widest invoice in the batch determines how
 * many 4-column product blocks the Invoice Summary needs. Every row gets
 * the same fixed set of block columns — an invoice with fewer products
 * than the batch max just leaves its trailing blocks blank (never padded,
 * never a separate row).
 */
function maxProductCount(invoices: FilingInvoice[]): number {
  let max = 0;
  for (const inv of invoices) {
    const n = (inv.products || []).length;
    if (n > max) max = n;
  }
  return max;
}

/** First column of the Invoice Summary's product-block region — right
 * after the 4 fixed identity columns (Invoice Number/Date/Date of
 * Supply/Supplier). */
const SUMMARY_PRODUCT_BLOCK_START_COL = 5;

/** Header row on Purchase/Sales Summary — every column past the 4 fixed
 * identity columns is now found by matching this row's text, not by a
 * hardcoded column number (Prompt 11, section 8/9). */
const SUMMARY_HEADER_ROW = 3;

type SummaryColumnLayout = {
  maxProducts: number;
  productBlockStartCol: number;
  /** Column right after the last product block — where Invoice Amount
   * sits. Moves dynamically with the batch's widest invoice. */
  invoiceAmountCol: number;
  transportCol: number;
  vehicleCol: number;
  invoiceIdCol: number;
  partnerIdCol: number;
  totalCols: number;
};

/**
 * Prompt 11: the ONE place that decides where every non-fixed column on
 * Purchase/Sales Summary lands — used by both buildInvoiceListSheet (which
 * writes them) and buildPartnerSummarySheet (which references them by
 * letter in a formula). Columns 1-4 (Invoice Number/Date/Date of Supply/
 * Supplier) are the only ones still at a fixed position (section 8);
 * everything from the first product block onward shifts with the batch's
 * widest invoice, which is exactly why VBA now finds them by header text
 * (FindColumnByHeader in SyncEngine.bas) instead of a hardcoded column.
 */
function computeSummaryColumnLayout(invoices: FilingInvoice[]): SummaryColumnLayout {
  const maxProducts = maxProductCount(invoices);
  const productBlockStartCol = SUMMARY_PRODUCT_BLOCK_START_COL;
  const invoiceAmountCol = productBlockStartCol + maxProducts * 4;
  const transportCol = invoiceAmountCol + 1;
  const vehicleCol = transportCol + 1;
  const invoiceIdCol = vehicleCol + 1;
  const partnerIdCol = invoiceIdCol + 1;
  return {
    maxProducts,
    productBlockStartCol,
    invoiceAmountCol,
    transportCol,
    vehicleCol,
    invoiceIdCol,
    partnerIdCol,
    totalCols: partnerIdCol,
  };
}

function buildInvoiceListSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  partnerLabel: string,
  isSales: boolean,
  batch: FilingBatch,
  invoiceMeta: InvoiceMeta[],
  partnerMap: Map<string, FilingPartner>,
) {
  const sheet = workbook.addWorksheet(sheetName);
  const invoices = invoiceMeta.map((m) => m.inv);
  const layout = computeSummaryColumnLayout(invoices);
  const { maxProducts, invoiceAmountCol, transportCol, vehicleCol, invoiceIdCol, partnerIdCol } = layout;
  // One more visible (never hidden, unlike invoiceIdCol/partnerIdCol) column
  // past the summary's own fixed layout — a per-row jump straight to that
  // invoice's own sheet, since a batch can run to hundreds of sheets and
  // finding one by scrolling the tab bar is impractical.
  const viewInvoiceCol = partnerIdCol + 1;
  const totalCols = viewInvoiceCol;
  const pagesWide = Math.max(1, Math.ceil(totalCols / 16));
  configurePage(sheet, "3:3", pagesWide);
  addTitleBanner(sheet, sheetName.toUpperCase(), Math.max(7, totalCols));

  // Prompt 5: Invoice Summary is the invoice lifecycle control point — an
  // "Add" trigger (green, matching ADD PRODUCT's convention) and a
  // "Delete" trigger (red, to visually flag it as destructive). VBA's
  // Worksheet_Change on this sheet watches both exact cells.
  const addInvoiceCell = sheet.getCell(ADD_INVOICE_TRIGGER_ROW, ADD_INVOICE_TRIGGER_COL);
  addInvoiceCell.value = ADD_INVOICE_TRIGGER_LABEL;
  addInvoiceCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF1B5E20" } };
  addInvoiceCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDFF5E1" } } as any;
  addInvoiceCell.border = THIN_BORDER as any;
  addInvoiceCell.alignment = { horizontal: "center", vertical: "middle" };

  const deleteInvoiceCell = sheet.getCell(DELETE_INVOICE_TRIGGER_ROW, DELETE_INVOICE_TRIGGER_COL);
  deleteInvoiceCell.value = DELETE_INVOICE_TRIGGER_LABEL;
  deleteInvoiceCell.font = { name: "Calibri", size: 9, italic: true, color: { argb: "FF6B7280" } };
  deleteInvoiceCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };

  // Prompt 11, section 4: the 4 fixed identity columns, then a product
  // block IMMEDIATELY after Supplier/Customer — not after Invoice Amount/
  // Transport/Vehicle, which now move to AFTER the last product block.
  const headerRow = sheet.getRow(SUMMARY_HEADER_ROW);
  const fixedHeaders = ["Invoice Number", "Invoice Date", "Date of Supply", partnerLabel];
  fixedHeaders.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });
  for (let i = 0; i < maxProducts; i++) {
    const base = SUMMARY_PRODUCT_BLOCK_START_COL + i * 4;
    const labels = ["Product & HSN", "Qty", "Price per KG", "Total Price"];
    for (let j = 0; j < 4; j++) {
      const cell = sheet.getCell(SUMMARY_HEADER_ROW, base + j);
      cell.value = labels[j];
      styleHeaderCell(cell);
      // Prompt 14, section 10: same block-divider border as the invoice
      // sheet's own product table.
      if (j === 3) cell.border = PRODUCT_BLOCK_DIVIDER_BORDER as any;
    }
  }
  const tailHeaders: [number, string][] = [
    [invoiceAmountCol, "Invoice Amount"],
    [transportCol, "Transport Mode"],
    [vehicleCol, "Vehicle Number"],
    [invoiceIdCol, "Invoice ID"],
    [partnerIdCol, `${partnerLabel} ID`],
    [viewInvoiceCol, "View Invoice"],
  ];
  for (const [col, label] of tailHeaders) {
    const cell = sheet.getCell(SUMMARY_HEADER_ROW, col);
    cell.value = label;
    styleHeaderCell(cell);
  }
  headerRow.height = 22;

  invoiceMeta.forEach(({ inv, sheetName: invSheetName }, index) => {
    const { id: partnerId, name } = resolvePartner(inv, batch, partnerMap);
    const isOdd = index % 2 === 1;
    const rowNum = index + 4;
    const products = inv.products || [];
    // Prompt 9/11, section 7: Invoice Amount is a same-row SUMIF over this
    // row's own "Total Price" block cells (whatever column those land at
    // this batch), not a cross-sheet lookup keyed by invoice sheet name.
    // A zero-product invoice has no "Total Price" cell to sum, so it
    // falls back to its own stored total, same as the individual invoice
    // sheet's own convention.
    const amountValue =
      products.length > 0
        ? {
            formula: `SUMIF(${SUMMARY_HEADER_ROW}:${SUMMARY_HEADER_ROW},"Total Price",${rowNum}:${rowNum})`,
            result: num(inv.total_amount),
          }
        : num(inv.total_amount);
    // Prompt 6 (latest revision): Purchase Summary's own Invoice Number
    // column now ALSO shows the prefix-stripped display number, same as
    // the individual invoice sheet — the user explicitly asked for this.
    // _hidden_invoice_data keeps the FULL real number regardless (it's
    // never user-facing), so the stable identity used for sync/renumbering
    // math is never destroyed by this display-only change.
    const displayInvoiceNumber = isSales
      ? inv.invoice_number
      : stripInvoicePrefixForDisplay(inv.invoice_number || "");
    const row = sheet.getRow(rowNum);
    row.getCell(1).value = displayInvoiceNumber;
    row.getCell(2).value = inv.invoice_date || "";
    // Falls back to invoice_date exactly like the invoice sheet's own
    // Date of Supply cell already does (see row 7 below) — a generated
    // invoice usually has no separately-set date_of_supply at all, and
    // the two are the same date by default until someone edits it.
    row.getCell(3).value = inv.date_of_supply || inv.invoice_date || "";
    row.getCell(4).value = name;
    row.getCell(invoiceAmountCol).value = amountValue;
    row.getCell(transportCol).value = inv.transport_mode || batch.transport_mode || "";
    row.getCell(vehicleCol).value = inv.vehicle_number || batch.vehicle_number || "";
    row.getCell(invoiceIdCol).value = inv.id || "";
    row.getCell(partnerIdCol).value = partnerId || "";
    const viewInvoiceCell = row.getCell(viewInvoiceCol);
    viewInvoiceCell.value = { formula: `HYPERLINK("#'${invSheetName}'!A1","View Invoice")` };

    row.height = 18;
    styleDataCell(row.getCell(1), isOdd, "center");
    styleDataCell(row.getCell(2), isOdd, "center");
    styleDataCell(row.getCell(3), isOdd, "center");
    styleDataCell(row.getCell(4), isOdd, "left");
    styleDataCell(row.getCell(invoiceAmountCol), isOdd, "right", CURRENCY_FORMAT);
    styleDataCell(row.getCell(transportCol), isOdd, "left");
    styleDataCell(row.getCell(vehicleCol), isOdd, "center");
    styleDataCell(viewInvoiceCell, isOdd, "center");
    viewInvoiceCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF1155CC" }, underline: true };

    products.forEach((p, i) => {
      const base = SUMMARY_PRODUCT_BLOCK_START_COL + i * 4;
      const hsn = p.hsn_code ? String(p.hsn_code).trim() : "";
      const nameCell = row.getCell(base);
      nameCell.value = hsn ? `${p.product_name || ""} (${hsn})` : p.product_name || "";
      styleDataCell(nameCell, isOdd, "left");
      nameCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };

      const qtyCell = row.getCell(base + 1);
      qtyCell.value = num(p.quantity);
      styleDataCell(qtyCell, isOdd, "right", QUANTITY_FORMAT);

      const rateCell = row.getCell(base + 2);
      rateCell.value = num(p.rate);
      styleDataCell(rateCell, isOdd, "right", CURRENCY_FORMAT);

      // Prompt 18: a live Qty*Rate formula, not a static snapshot value —
      // editing either cell directly on this sheet now recalculates Total
      // Price (and, through the row's own SUMIF, Invoice Amount) with no
      // VBA involved, matching the invoice sheet's own formula-driven
      // Total Amount column.
      const totalCell = row.getCell(base + 3);
      totalCell.value = { formula: `${colLetter(base + 1)}${rowNum}*${colLetter(base + 2)}${rowNum}` };
      styleDataCell(totalCell, isOdd, "right", CURRENCY_FORMAT);
      totalCell.border = PRODUCT_BLOCK_DIVIDER_BORDER as any;
    });
  });

  const totalsRowNum = invoiceMeta.length + 4;
  const totalsRow = sheet.getRow(totalsRowNum);
  totalsRow.getCell(1).value = "TOTAL";
  const amountColLetter = colLetter(invoiceAmountCol);
  totalsRow.getCell(invoiceAmountCol).value = {
    formula: `SUM(${amountColLetter}4:${amountColLetter}${totalsRowNum - 1})`,
  };
  totalsRow.height = 20;
  styleTotalCell(totalsRow.getCell(1), "center");
  styleTotalCell(totalsRow.getCell(invoiceAmountCol), "right", CURRENCY_FORMAT);
  sheet.mergeCells(totalsRowNum, 1, totalsRowNum, 4);

  const lastColLetter = colLetter(Math.max(7, totalCols));
  sheet.autoFilter = { from: "A3", to: `${lastColLetter}3` };
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.getColumn(invoiceIdCol).hidden = true;
  sheet.getColumn(partnerIdCol).hidden = true;
  autoFitWidths(sheet, 14, 1);
  return sheet;
}

function buildPartnerSummarySheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  partnerLabel: string,
  invoiceListSheetName: string,
  batch: FilingBatch,
  invoices: FilingInvoice[],
  partnerMap: Map<string, FilingPartner>,
) {
  const sheet = workbook.addWorksheet(sheetName);
  configurePage(sheet, "3:3");
  addTitleBanner(sheet, sheetName.toUpperCase(), 3);

  const headerRow = sheet.addRow([partnerLabel, "Invoice Count", "Total Amount"]);
  headerRow.height = 22;
  for (let c = 1; c <= 3; c++) styleHeaderCell(headerRow.getCell(c));
  sheet.getCell(3, 4).value = "Partner ID";
  styleHeaderCell(sheet.getCell(3, 4));

  const aggregate = new Map<string, { name: string; invoiceCount: number; totalAmount: number }>();
  for (const inv of invoices) {
    const { id, name } = resolvePartner(inv, batch, partnerMap);
    const key = id || name;
    if (!aggregate.has(key)) {
      aggregate.set(key, { name, invoiceCount: 0, totalAmount: 0 });
    }
    const item = aggregate.get(key)!;
    item.invoiceCount += 1;
    item.totalAmount += num(inv.total_amount);
  }

  // Prompt 9, section 8: whole-column references, not a range bounded to
  // today's invoice count — see computeSummaryColumnLayout's own doc for
  // why. Prompt 11: those columns are no longer fixed at I/E — they move
  // with the batch's widest invoice, same as everything past column 4 on
  // Purchase/Sales Summary now does, so the letters are computed from the
  // same layout function that sheet itself was built with.
  const layout = computeSummaryColumnLayout(invoices);
  const partnerIdColLetter = colLetter(layout.partnerIdCol);
  const amountColLetter = colLetter(layout.invoiceAmountCol);
  const partnerIdRange = `'${invoiceListSheetName}'!$${partnerIdColLetter}:$${partnerIdColLetter}`;
  const amountRange = `'${invoiceListSheetName}'!$${amountColLetter}:$${amountColLetter}`;

  let idx = 0;
  aggregate.forEach((item, key) => {
    const isOdd = idx % 2 === 1;
    const r = 4 + idx;
    const row = sheet.addRow([
      item.name,
      { formula: `COUNTIF(${partnerIdRange},D${r})`, result: item.invoiceCount },
      { formula: `SUMIF(${partnerIdRange},D${r},${amountRange})`, result: item.totalAmount },
      key,
    ]);
    row.height = 18;
    styleDataCell(row.getCell(1), isOdd, "left");
    styleDataCell(row.getCell(2), isOdd, "right");
    styleDataCell(row.getCell(3), isOdd, "right", CURRENCY_FORMAT);
    idx++;
  });

  const totalsRowNum = aggregate.size + 4;
  const totalsRow = sheet.addRow([
    "TOTAL",
    { formula: `SUM(B4:B${totalsRowNum - 1})` },
    { formula: `SUM(C4:C${totalsRowNum - 1})` },
  ]);
  totalsRow.height = 20;
  styleTotalCell(totalsRow.getCell(1), "center");
  styleTotalCell(totalsRow.getCell(2), "right");
  styleTotalCell(totalsRow.getCell(3), "right", CURRENCY_FORMAT);

  sheet.autoFilter = { from: "A3", to: "C3" };
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.getColumn(4).hidden = true;
  autoFitWidths(sheet, 16, 1);
  return sheet;
}

type LineItem = {
  batchId: string;
  invoiceId: string;
  invoiceNumber: string;
  productId: string;
  productName: string;
  hsn: string;
  category: string;
  qty: number;
  rate: number;
  amount: number;
  partnerId: string;
  partnerName: string;
  sheetName: string;
  blockIndex: number;
};

/**
 * Every invoice product line across the whole batch, computed once and
 * shared by buildProductSummarySheet (for row identity) and
 * buildHiddenInvoiceDataSheet (for the actual stored data) — a single
 * pass over `invoices`, never two divergent copies of the same facts.
 */
function collectLineItems(
  batch: FilingBatch,
  invoiceMeta: InvoiceMeta[],
  partnerMap: Map<string, FilingPartner>,
): LineItem[] {
  const lineItems: LineItem[] = [];
  for (const { inv, sheetName } of invoiceMeta) {
    const { id: partnerId, partner } = resolvePartner(inv, batch, partnerMap);
    const partnerName = partner.company_name || partner.supplier_name || "";
    const products = inv.products || [];
    if (products.length === 0) {
      // A sentinel row (blank ProductID) so this invoice's identity is
      // still resolvable from the hidden sheet by SheetName alone, even
      // with zero product lines — see GetSheetIdentity in SyncEngine.bas.
      lineItems.push({
        batchId: batch.id || "",
        invoiceId: inv.id || "",
        invoiceNumber: inv.invoice_number || "",
        productId: "",
        productName: "",
        hsn: "",
        category: "",
        qty: 0,
        rate: 0,
        amount: 0,
        partnerId: partnerId || "",
        partnerName,
        sheetName,
        blockIndex: -1,
      });
      continue;
    }
    products.forEach((p, i) => {
      lineItems.push({
        batchId: batch.id || "",
        invoiceId: inv.id || "",
        invoiceNumber: inv.invoice_number || "",
        productId: p.product_id || p.product_name || "unknown",
        productName: p.product_name || "",
        hsn: p.hsn_code || "",
        category: p.category || "",
        qty: num(p.quantity),
        rate: num(p.rate),
        amount: num(p.amount),
        partnerId: partnerId || "",
        partnerName,
        sheetName,
        blockIndex: i,
      });
    });
  }
  return lineItems;
}

function buildProductSummarySheet(workbook: ExcelJS.Workbook, lineItems: LineItem[]) {
  const sheet = workbook.addWorksheet("Product Summary");
  configurePage(sheet, "3:3");
  addTitleBanner(sheet, "PRODUCT SUMMARY", 4);

  const headerRow = sheet.addRow(["Product", "HSN", "Total Quantity", "Total Amount"]);
  headerRow.height = 22;
  for (let c = 1; c <= 4; c++) styleHeaderCell(headerRow.getCell(c));
  sheet.getCell(3, 5).value = "Product ID";
  styleHeaderCell(sheet.getCell(3, 5));

  const aggregate = new Map<
    string,
    { name: string; hsn: string; totalQuantity: number; totalAmount: number }
  >();
  for (const li of lineItems) {
    if (!li.productId) continue; // skip zero-product sentinel rows
    if (!aggregate.has(li.productId)) {
      aggregate.set(li.productId, {
        name: li.productName || "Unknown Product",
        hsn: li.hsn,
        totalQuantity: 0,
        totalAmount: 0,
      });
    }
    const item = aggregate.get(li.productId)!;
    item.totalQuantity += li.qty;
    item.totalAmount += li.amount;
  }

  // Totals are formulas against the ONE normalized source of truth — the
  // dedicated hidden worksheet (Prompt 4B, section 6) — using WHOLE-COLUMN
  // references rather than a precisely bounded range. This is deliberate:
  // that sheet can grow (a workbook-local "Add Product" appends a row to
  // it), and a bounded range would need every other product's formula
  // rewritten every time it grows; a whole-column reference never goes
  // stale, at the cost of a (negligible, for realistic batch sizes) wider
  // scan range.
  const productIdRange = `${HIDDEN_DATA_SHEET_NAME}!$D:$D`;
  const qtyRange = `${HIDDEN_DATA_SHEET_NAME}!$H:$H`;
  const amountRange = `${HIDDEN_DATA_SHEET_NAME}!$J:$J`;

  let idx = 0;
  aggregate.forEach((item, key) => {
    const isOdd = idx % 2 === 1;
    const r = 4 + idx;
    const row = sheet.addRow([
      item.name,
      item.hsn,
      { formula: `SUMIF(${productIdRange},E${r},${qtyRange})`, result: item.totalQuantity },
      { formula: `SUMIF(${productIdRange},E${r},${amountRange})`, result: item.totalAmount },
      key,
    ]);
    row.height = 18;
    styleDataCell(row.getCell(1), isOdd, "left");
    styleDataCell(row.getCell(2), isOdd, "center");
    styleDataCell(row.getCell(3), isOdd, "right", QUANTITY_FORMAT);
    styleDataCell(row.getCell(4), isOdd, "right", CURRENCY_FORMAT);
    idx++;
  });

  const totalsRowNum = aggregate.size + 4;
  const totalsRow = sheet.addRow([
    "TOTAL",
    "",
    { formula: `SUM(C4:C${totalsRowNum - 1})` },
    { formula: `SUM(D4:D${totalsRowNum - 1})` },
  ]);
  totalsRow.height = 20;
  styleTotalCell(totalsRow.getCell(1), "center");
  styleTotalCell(totalsRow.getCell(2), "center");
  styleTotalCell(totalsRow.getCell(3), "right", QUANTITY_FORMAT);
  styleTotalCell(totalsRow.getCell(4), "right", CURRENCY_FORMAT);

  sheet.autoFilter = { from: "A3", to: "D3" };
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.getColumn(5).hidden = true;
  autoFitWidths(sheet, 16, 1);
  return sheet;
}

/**
 * The dedicated hidden worksheet (Prompt 4B, section 16) — the single
 * normalized source of truth for every invoice product line in the batch.
 * Grows vertically only, so it is never affected by a column-insert on any
 * invoice sheet (the exact corruption risk Prompt 4 identified with the
 * old per-invoice-sheet hidden rows). Very-hidden, not just hidden, so it
 * doesn't appear in Excel's normal right-click "Unhide" list.
 */
function buildHiddenInvoiceDataSheet(workbook: ExcelJS.Workbook, lineItems: LineItem[]) {
  const sheet = workbook.addWorksheet(HIDDEN_DATA_SHEET_NAME, { state: "veryHidden" });
  sheet.addRow([...HIDDEN_DATA_COLUMNS]);
  for (const li of lineItems) {
    sheet.addRow([
      li.batchId,
      li.invoiceId,
      li.invoiceNumber,
      li.productId,
      li.productName,
      li.hsn,
      li.category,
      li.qty,
      li.rate,
      li.amount,
      li.partnerId,
      li.partnerName,
      li.sheetName,
      li.blockIndex,
    ]);
  }
  return sheet;
}

/**
 * Prompt 16: batch-level statistics shown on Batch Overview — computed
 * from the exact same finalized data every other sheet in this workbook
 * already uses (no separate query, nothing invented). Shared by both
 * batch types now (Prompt 16 gave Sales the same statistics Purchase
 * already had; previously Sales showed only its own editable bank-detail
 * section).
 */
function computeBatchOverviewStats(
  batch: FilingBatch,
  invoiceMeta: InvoiceMeta[],
  partnerMap: Map<string, FilingPartner>,
  lineItems: LineItem[],
) {
  const invoices = invoiceMeta.map((m) => m.inv);
  const amounts = invoices.map((inv) => num(inv.total_amount));
  const grandTotal = amounts.reduce((s, a) => s + a, 0);
  const invoiceCount = invoices.length;

  const partnerIds = new Set<string>();
  for (const inv of invoices) {
    const { id } = resolvePartner(inv, batch, partnerMap);
    if (id) partnerIds.add(id);
  }

  const productIds = new Set<string>();
  for (const li of lineItems) {
    if (li.productId) productIds.add(li.productId);
  }

  const dates = invoices
    .map((inv) => inv.invoice_date)
    .filter((d): d is string => Boolean(d))
    .sort();

  return {
    invoiceCount,
    grandTotal,
    averageInvoice: invoiceCount > 0 ? grandTotal / invoiceCount : 0,
    highestInvoice: amounts.length > 0 ? Math.max(...amounts) : 0,
    lowestInvoice: amounts.length > 0 ? Math.min(...amounts) : 0,
    partnerCount: partnerIds.size,
    productCount: productIds.size,
    dateRange: dates.length > 0 ? `${dates[0]} to ${dates[dates.length - 1]}` : "",
  };
}

/** A polished section-header band for Batch Overview — same grey-fill,
 * navy-bold, bordered convention as the invoice sheet's own section
 * headers, spanning columns 1-3, instead of Batch Overview's previous
 * plain unstyled black text. */
function batchOverviewSectionHeader(sheet: ExcelJS.Worksheet, row: number, title: string) {
  sheet.mergeCells(row, 1, row, 3);
  const cell = sheet.getCell(row, 1);
  cell.value = title;
  cell.font = { name: "Calibri", size: 12, bold: true, color: { argb: HEADER_NAVY } };
  cell.fill = HEADER_BAND_FILL as any;
  cell.border = THIN_BORDER as any;
  cell.alignment = { vertical: "middle" };
  sheet.getRow(row).height = 20;
}

/** One "hero" stat card — a small uppercase label over a large bold
 * value, boxed with a border and fill, spanning 3 columns x 2 rows.
 * Batch Overview leads with three of these (Grand Total, Invoice Count,
 * Average Invoice) instead of burying every number in a single uniform
 * list. */
function writeStatCard(
  sheet: ExcelJS.Worksheet,
  row: number,
  colStart: number,
  label: string,
  value: ExcelJS.CellValue,
  numFmt?: string,
) {
  const colEnd = colStart + 2;
  sheet.mergeCells(row, colStart, row, colEnd);
  const labelCell = sheet.getCell(row, colStart);
  labelCell.value = label.toUpperCase();
  labelCell.font = { name: "Calibri", size: 9, bold: true, color: { argb: "FF595959" } };
  labelCell.alignment = { horizontal: "center", vertical: "middle" };

  sheet.mergeCells(row + 1, colStart, row + 1, colEnd);
  const valueCell = sheet.getCell(row + 1, colStart);
  valueCell.value = value;
  if (numFmt) valueCell.numFmt = numFmt;
  valueCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: HEADER_NAVY } };
  valueCell.alignment = { horizontal: "center", vertical: "middle" };

  sheet.getRow(row).height = 16;
  sheet.getRow(row + 1).height = 28;
  for (let r = row; r <= row + 1; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      const cell = sheet.getCell(r, c);
      cell.fill = HEADER_BAND_FILL as any;
      cell.border = THIN_BORDER as any;
    }
  }
}

/**
 * Writes the shared block of detail sections both batch types show below
 * their hero cards (Sales additionally has its own bank-details block
 * above this, which stays exclusive to Sales — Prompt 9's original
 * "do not add invented fields to Sales" concern doesn't apply any more
 * now that these ARE the fields the client explicitly asked for on both).
 * Grand Total/Average/Invoice Count are deliberately not repeated here —
 * they already lead the sheet as hero cards. Returns the next free row.
 */
function writeBatchOverviewDetailSections(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  batch: FilingBatch,
  stats: ReturnType<typeof computeBatchOverviewStats>,
  partnerLabel: string,
): number {
  let row = startRow;

  batchOverviewSectionHeader(sheet, row, "Batch Information");
  row++;
  writeBankDetailRow(sheet, row++, "Batch Type", batch.batch_type || "", false);
  writeBankDetailRow(sheet, row++, "Financial Year", batch.financial_year || "", false);
  row++; // spacer

  batchOverviewSectionHeader(sheet, row, "Invoice Statistics");
  row++;
  writeBankDetailRow(sheet, row, "Highest Invoice", stats.highestInvoice, false);
  sheet.getCell(row, 3).numFmt = CURRENCY_FORMAT;
  row++;
  writeBankDetailRow(sheet, row, "Lowest Invoice", stats.lowestInvoice, false);
  sheet.getCell(row, 3).numFmt = CURRENCY_FORMAT;
  row++;
  row++; // spacer

  batchOverviewSectionHeader(sheet, row, `${partnerLabel} Statistics`);
  row++;
  writeBankDetailRow(sheet, row++, `${partnerLabel} Count`, stats.partnerCount, false);
  row++; // spacer

  batchOverviewSectionHeader(sheet, row, "Product Statistics");
  row++;
  writeBankDetailRow(sheet, row++, "Total Products Used", stats.productCount, false);
  row++; // spacer

  batchOverviewSectionHeader(sheet, row, "Generation Configuration");
  row++;
  writeBankDetailRow(sheet, row++, "Transport Mode", batch.transport_mode || "", false);
  writeBankDetailRow(sheet, row++, "Vehicle Number", batch.vehicle_number || "", false);
  writeBankDetailRow(sheet, row++, "Date Range", stats.dateRange, false);

  return row;
}

/** Column widths shared by both Batch Overview sheets — columns 1-3 carry
 * every detail-section label|colon|value row (and, for Sales, the bank
 * rows); columns 4-9 exist only to give hero cards 2/3 the same footprint
 * as card 1's own columns 1-3. */
function setBatchOverviewColumnWidths(sheet: ExcelJS.Worksheet) {
  sheet.getColumn(1).width = 22;
  sheet.getColumn(2).width = 3;
  sheet.getColumn(3).width = 28;
  sheet.getColumn(4).width = 18;
  sheet.getColumn(5).width = 3;
  sheet.getColumn(6).width = 18;
  sheet.getColumn(7).width = 18;
  sheet.getColumn(8).width = 3;
  sheet.getColumn(9).width = 18;
}

const BATCH_OVERVIEW_HERO_ROW = 3;

/**
 * Sales-only bank-detail block (Prompt 6, sections 2-3): a dedicated
 * editable "control" section for the company bank-detail fields common to
 * every Sales invoice in the batch. Every Sales invoice sheet's own
 * bank-detail VALUE cells are plain cross-sheet FORMULAS pointing back
 * here (see buildInvoiceSheet's `bankValue`), so editing a value here
 * propagates to every Sales invoice the moment Excel recalculates — no
 * VBA needed for this one-way direction. Prompt 16 additionally gave
 * Sales the same hero cards and detail-statistics sections Purchase
 * already had, in the space below this block.
 */
function buildSalesBatchOverviewSheet(
  workbook: ExcelJS.Workbook,
  batch: FilingBatch,
  invoiceMeta: InvoiceMeta[],
  partnerMap: Map<string, FilingPartner>,
  lineItems: LineItem[],
  issuingCompany: FilingIssuingCompany | null,
) {
  const sheet = workbook.addWorksheet(BATCH_OVERVIEW_SHEET_NAME);
  configurePage(sheet);
  addTitleBanner(sheet, "BATCH OVERVIEW", 9);

  const stats = computeBatchOverviewStats(batch, invoiceMeta, partnerMap, lineItems);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 1, "Grand Total", stats.grandTotal, CURRENCY_FORMAT);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 4, "Invoice Count", stats.invoiceCount);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 7, "Average Invoice", stats.averageInvoice, CURRENCY_FORMAT);

  let row = BATCH_OVERVIEW_HERO_ROW + 3; // 2 card rows + 1 spacer
  batchOverviewSectionHeader(sheet, row, "Company's Bank Details");
  row++;
  writeBankDetailRow(sheet, row++, "Name of Account", issuingCompany?.bank_account_name || "", true);
  writeBankDetailRow(sheet, row++, "Name of Bank", issuingCompany?.bank_name || "", true);
  writeBankDetailRow(sheet, row++, "Branch Name", issuingCompany?.branch || "", true);
  writeBankDetailRow(sheet, row++, "Account No.", issuingCompany?.account_number || "", true);
  writeBankDetailRow(sheet, row++, "IFSC Code", issuingCompany?.ifsc_code || "", true);
  writeBankDetailRow(sheet, row++, "PAN", issuingCompany?.pan || "", true);
  row++; // spacer

  writeBatchOverviewDetailSections(sheet, row, batch, stats, "Customer");

  setBatchOverviewColumnWidths(sheet);
  return sheet;
}

function buildPurchaseBatchOverviewSheet(
  workbook: ExcelJS.Workbook,
  batch: FilingBatch,
  invoiceMeta: InvoiceMeta[],
  partnerLabel: string,
  partnerMap: Map<string, FilingPartner>,
  lineItems: LineItem[],
) {
  const sheet = workbook.addWorksheet(BATCH_OVERVIEW_SHEET_NAME);
  configurePage(sheet);
  addTitleBanner(sheet, "BATCH OVERVIEW", 9);

  const stats = computeBatchOverviewStats(batch, invoiceMeta, partnerMap, lineItems);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 1, "Grand Total", stats.grandTotal, CURRENCY_FORMAT);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 4, "Invoice Count", stats.invoiceCount);
  writeStatCard(sheet, BATCH_OVERVIEW_HERO_ROW, 7, "Average Invoice", stats.averageInvoice, CURRENCY_FORMAT);

  const row = BATCH_OVERVIEW_HERO_ROW + 3; // 2 card rows + 1 spacer
  writeBatchOverviewDetailSections(sheet, row, batch, stats, partnerLabel);

  setBatchOverviewColumnWidths(sheet);
  return sheet;
}

// ---------------------------------------------------------------------------
// Invoice sheets
// ---------------------------------------------------------------------------

/**
 * A row of paired section-title cells (e.g. "Delivery Details" at col 1,
 * "Seller Details" at col 3) — matches the reference invoice's own
 * two-column section grouping exactly, distinct from a label:value row.
 */
/**
 * Prompt 13: real merged cells — A:C for the left title, D:H for the
 * right — matching the reference invoice's own A4:C4/D4:H4 (and
 * A8:C8/D8:H8) merges exactly, rather than two unmerged single cells with
 * blank gaps between them.
 */
function addSectionHeaderRow(sheet: ExcelJS.Worksheet, row: number, titles: [string, string]) {
  const [leftTitle, rightTitle] = titles;
  sheet.mergeCells(row, 1, row, 3);
  const leftCell = sheet.getCell(row, 1);
  leftCell.value = leftTitle;
  // Prompt 15: plain bold black, matching the reference invoice exactly —
  // navy is reserved for the header banner (rows 1-3) and GSTIN/Phone.
  leftCell.font = { name: "Calibri", size: 10, bold: true };
  leftCell.fill = HEADER_BAND_FILL as any;
  leftCell.border = THIN_BORDER as any;
  leftCell.alignment = { vertical: "middle" };

  sheet.mergeCells(row, 4, row, 8);
  const rightCell = sheet.getCell(row, 4);
  rightCell.value = rightTitle;
  rightCell.font = { name: "Calibri", size: 10, bold: true };
  rightCell.fill = HEADER_BAND_FILL as any;
  rightCell.border = THIN_BORDER as any;
  rightCell.alignment = { vertical: "middle" };
}

/**
 * Prompt 15: the invoice sheet is now a direct, cell-for-cell port of the
 * real reference invoice's own generator (download-invoice/route.ts's
 * generateExcelBuffer, which literally produced templates/
 * AT-2021-22-S-0000001.xlsx) — a single vertical product table (Sl. No. /
 * Name / HSN / Qty / Rate / Total Amount) padded to MIN_PRODUCT_ROWS blank
 * editable rows, not the old N-products-wide horizontal block layout. Rows
 * 1-13 (header banner, Delivery/Seller Details, Details of Receiver/
 * Original for Recipient) are always at the same fixed rows regardless of
 * product count. Everything from the product table downward is anchored
 * relative to MIN_PRODUCT_ROWS via invoiceFooterRows() below, so it stays
 * correct even for the rare invoice with more than 16 products.
 */
export const INV_PARTNER_ROW = 9;
export const INV_PARTNER_VALUE_COL = 3;
export const INV_INVOICE_NUMBER_ROW = 9;
export const INV_INVOICE_NUMBER_VALUE_COL = 7;
export const INV_PRODUCT_HEADER_ROW = 14;
export const INV_PRODUCT_DATA_ROW = 16;
/** Every invoice sheet reserves at least this many product rows (blank,
 * editable, live-totaling) even when the invoice has fewer real product
 * lines — matches the reference invoice's own `minProductRows = 16`
 * exactly, and is what makes "type a new product into a blank row" work
 * with no VBA/button involved for the common case. */
export const MIN_PRODUCT_ROWS = 16;

/**
 * Every row from the product table's "Total" line downward, derived from
 * how many product rows the sheet actually has — always
 * INV_PRODUCT_DATA_ROW + 16 and below for a normal (<=16 product) invoice,
 * shifting down only for the rare invoice with more products than that.
 * templates/vba/SyncEngine.bas locates these at runtime the same way
 * (search column A for "Total" from INV_PRODUCT_DATA_ROW), so this function
 * is the single source of truth for both sides.
 */
export function invoiceFooterRows(productRowCount: number) {
  const totalRow = INV_PRODUCT_DATA_ROW + Math.max(productRowCount, MIN_PRODUCT_ROWS);
  return {
    totalRow,
    goodsDispatchedRow: totalRow + 1,
    wordsRow: totalRow + 2,
    sgstRow: totalRow + 3,
    bankHeaderRow: totalRow + 4,
    bankAccountRow: totalRow + 5,
    bankNameRow: totalRow + 6,
    bankBranchRow: totalRow + 7,
    bankAcctNoRow: totalRow + 8,
    bankIfscRow: totalRow + 9,
    panRow: totalRow + 10,
    termsCertRow: totalRow + 11,
  };
}

/** Batch Overview's own bank-detail row layout (Sales only) — Prompt 6,
 * row numbers updated by Prompt 16's hero-cards redesign (rows 3-5 are now
 * the hero stat cards + spacer, pushing this block from 3-9 to 6-13). */
export const BATCH_OVERVIEW_SHEET_NAME = "Batch Overview";
export const BATCH_OVERVIEW_NAME_OF_ACCOUNT_ROW = 7;
export const BATCH_OVERVIEW_NAME_OF_BANK_ROW = 8;
export const BATCH_OVERVIEW_BRANCH_ROW = 9;
export const BATCH_OVERVIEW_ACCOUNT_NO_ROW = 10;
export const BATCH_OVERVIEW_IFSC_ROW = 11;
export const BATCH_OVERVIEW_PAN_ROW = 12;
export const BATCH_OVERVIEW_VALUE_COL = 2;

function writeBankDetailRow(
  sheet: ExcelJS.Worksheet,
  row: number,
  label: string,
  value: ExcelJS.CellValue,
  editable: boolean,
) {
  const labelCell = sheet.getCell(row, 1);
  labelCell.value = label;
  // Prompt 10, section 9: plain field labels stay unfilled, matching the
  // reference invoice's own convention (fill reserved for header rows).
  labelCell.font = { name: "Calibri", size: 10, bold: true };
  labelCell.border = THIN_BORDER as any;
  labelCell.alignment = { vertical: "middle" };

  // Prompt 13: label | colon | value, matching the reference's own bank
  // detail rows (A37/B37/C37 = "Name of Account" / ":" / "ASSURE
  // TECHNOLOGY") exactly, instead of a plain 2-cell pair.
  const colonCell = sheet.getCell(row, 2);
  colonCell.value = ":";
  colonCell.font = { name: "Calibri", size: 10 };
  colonCell.border = THIN_BORDER as any;
  colonCell.alignment = { horizontal: "center", vertical: "middle" };

  const valueCell = sheet.getCell(row, 3);
  valueCell.value = value;
  valueCell.font = { name: "Calibri", size: 10 };
  valueCell.border = THIN_BORDER as any;
  valueCell.alignment = { vertical: "middle" };
  if (editable) valueCell.fill = EDITABLE_FILL as any;
}

function buildInvoiceSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  isSales: boolean,
  batch: FilingBatch,
  inv: FilingInvoice,
  partner: FilingPartner,
  issuingCompany: FilingIssuingCompany | null,
  batchOverviewSheetName: string | null,
) {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ showGridLines: false }],
  });

  const products = inv.products || [];
  const TOTAL_COLS = 8;

  // Prompt 15: a direct cell-for-cell port of download-invoice/route.ts's
  // own generateExcelBuffer — the actual code that produced templates/
  // AT-2021-22-S-0000001.xlsx — rather than a fresh approximation of it.
  // Products now stack vertically in a single vertical table (matching the
  // reference exactly), so this sheet is always this same 8-column
  // portrait layout regardless of product count; there is no more "wide
  // invoice needs landscape" case to estimate.
  configurePage(sheet, undefined, 1, "portrait", 1, REFERENCE_INVOICE_MARGINS);
  [18, 3, 24, 15, 10, 3, 12, 18].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const rect = (r1: number, c1: number, r2: number, c2: number) => {
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        sheet.getCell(r, c).border = THIN_BORDER as any;
      }
    }
  };

  // Prompt 6, sections 6-9: for Purchase, the SUPPLIER is the issuing/
  // seller identity at the top of the sheet, and OUR OWN COMPANY becomes
  // the Receiver/Billed To — a full reversal of the Sales roles. `seller`
  // and `receiver` below are chosen once so every row that follows just
  // reads from the right one, rather than branching on isSales repeatedly.
  const seller = isSales ? issuingCompany : partner;
  const sellerName = isSales
    ? issuingCompany?.company_name || ""
    : partner.company_name || partner.supplier_name || "";
  const receiver = isSales ? partner : issuingCompany;
  const receiverName = isSales
    ? partner.company_name || partner.supplier_name || ""
    : issuingCompany?.company_name || "";

  // Rows 1-3: seller identity header banner.
  sheet.mergeCells(1, 1, 1, TOTAL_COLS);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = sellerName;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: HEADER_NAVY } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  titleCell.fill = HEADER_BAND_FILL as any;
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, TOTAL_COLS);
  const addrCell = sheet.getCell(2, 1);
  addrCell.value = seller?.address || "";
  addrCell.font = { name: "Calibri", size: 10, bold: true };
  addrCell.alignment = { horizontal: "center", vertical: "middle" };
  addrCell.fill = HEADER_BAND_FILL as any;
  sheet.getRow(2).height = 20;

  sheet.mergeCells(3, 1, 3, TOTAL_COLS);
  const docTitleCell = sheet.getCell(3, 1);
  docTitleCell.value = "INVOICE";
  docTitleCell.font = { name: "Calibri", size: 12, bold: true, underline: true, color: { argb: HEADER_NAVY } };
  docTitleCell.alignment = { horizontal: "center", vertical: "middle" };
  docTitleCell.fill = HEADER_BAND_FILL as any;
  sheet.getRow(3).height = 20;

  // A batch can run to hundreds of invoice sheets — one click back to
  // Batch Overview from wherever the user currently is. Column 9 sits just
  // past the invoice sheet's own 8-column layout, so this never collides
  // with the merged banner cells above.
  if (batchOverviewSheetName) {
    const homeCell = sheet.getCell(1, 9);
    homeCell.value = { formula: `HYPERLINK("#'${batchOverviewSheetName}'!A1","🏠 Home")` };
    homeCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF1155CC" }, underline: true };
    homeCell.alignment = { horizontal: "left", vertical: "middle" };
  }
  rect(1, 1, 3, TOTAL_COLS);

  // Row 4: paired section headers, matching the reference exactly.
  addSectionHeaderRow(sheet, 4, ["Delivery Details", "Seller Details"]);

  // Row 5: Transport Mode (editable) paired with the seller's GSTIN as a
  // single concatenated cell — matches the reference exactly (no separate
  // colon column on this side, unlike rows 9-13 below).
  sheet.mergeCells(5, 1, 5, 2);
  sheet.getCell(5, 1).value = "Transport Mode";
  sheet.getCell(5, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(5, 3).value = inv.transport_mode || batch.transport_mode || "";
  sheet.getCell(5, 3).font = { name: "Calibri", size: 10 };
  sheet.mergeCells(5, 4, 5, 8);
  sheet.getCell(5, 4).value = `GSTIN : ${seller?.gstin || ""}`;
  sheet.getCell(5, 4).font = { name: "Calibri", size: 10, bold: true, color: { argb: HEADER_NAVY } };

  // Row 6: Vehicle Number (editable), right side blank.
  sheet.mergeCells(6, 1, 6, 2);
  sheet.getCell(6, 1).value = "Vehicle Number";
  sheet.getCell(6, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(6, 3).value = inv.vehicle_number || batch.vehicle_number || "";
  sheet.getCell(6, 3).font = { name: "Calibri", size: 10 };
  sheet.mergeCells(6, 4, 6, 8);

  // Row 7: Date of Supply paired with Phone — Prompt 10, section 11: the
  // supplier's own mobile_number when the record has one, left blank
  // rather than substituted when it doesn't (never invented).
  sheet.mergeCells(7, 1, 7, 2);
  sheet.getCell(7, 1).value = "Date of Supply";
  sheet.getCell(7, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(7, 3).value = inv.date_of_supply || inv.invoice_date || "";
  sheet.getCell(7, 3).font = { name: "Calibri", size: 10 };
  sheet.mergeCells(7, 4, 7, 8);
  const phoneValue = isSales ? issuingCompany?.phone || "" : partner.mobile_number || "";
  sheet.getCell(7, 4).value = phoneValue ? `Phone : ${phoneValue}` : "";
  sheet.getCell(7, 4).font = { name: "Calibri", size: 10, bold: true, color: { argb: HEADER_NAVY } };

  rect(5, 1, 7, 3);
  rect(5, 4, 7, 8);

  // Row 8: paired section headers — receiver details vs. this invoice's
  // own filing details, matching the reference exactly.
  addSectionHeaderRow(sheet, 8, ["Details of Receiver / Billed to :", "Original for Recipient"]);

  // Row 9: Name (partner-rename sync trigger for Sales) paired with
  // Invoice No.
  sheet.getCell(9, 1).value = "Name";
  sheet.getCell(9, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(9, 2).value = ":";
  sheet.getCell(9, 2).alignment = { horizontal: "center" };
  sheet.getCell(9, 3).value = receiverName;
  sheet.getCell(9, 3).font = { name: "Calibri", size: 10, bold: true };
  sheet.mergeCells(9, 4, 9, 5);
  sheet.getCell(9, 4).value = "Invoice No";
  sheet.getCell(9, 4).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(9, 6).value = ":";
  sheet.getCell(9, 6).alignment = { horizontal: "center" };
  sheet.mergeCells(9, 7, 9, 8);
  const displayInvoiceNumber = isSales
    ? inv.invoice_number || ""
    : stripInvoicePrefixForDisplay(inv.invoice_number || "");
  sheet.getCell(9, 7).value = displayInvoiceNumber;
  sheet.getCell(9, 7).font = { name: "Calibri", size: 10, bold: true };
  // Prompt 6: this is the partner-rename sync TRIGGER cell for Sales (row
  // 9 = customer name) — editing it stays inside the workbook only, never
  // written back to the app/DB. For Purchase, this row is now "Receiver"
  // = our own company (section 8) — the partner (supplier) sync trigger
  // is the top-banner cell (1,1) instead.

  // Row 10: Address (extra height + wrap, matching the reference) paired
  // with Date.
  sheet.getCell(10, 1).value = "Address";
  sheet.getCell(10, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(10, 2).value = ":";
  sheet.getCell(10, 2).alignment = { horizontal: "center" };
  sheet.getCell(10, 3).value = isSales ? receiver?.address || "" : issuingCompany?.address || "";
  sheet.getCell(10, 3).font = { name: "Calibri", size: 10 };
  sheet.getCell(10, 3).alignment = { vertical: "top", wrapText: true };
  sheet.getRow(10).height = 40;
  sheet.mergeCells(10, 4, 10, 5);
  sheet.getCell(10, 4).value = "Date";
  sheet.getCell(10, 4).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(10, 6).value = ":";
  sheet.getCell(10, 6).alignment = { horizontal: "center" };
  sheet.mergeCells(10, 7, 10, 8);
  sheet.getCell(10, 7).value = inv.invoice_date || "";
  sheet.getCell(10, 7).font = { name: "Calibri", size: 10, bold: true };

  // Row 11: GSTIN paired with a single concatenated Financial Year cell.
  sheet.getCell(11, 1).value = "GSTIN";
  sheet.getCell(11, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(11, 2).value = ":";
  sheet.getCell(11, 2).alignment = { horizontal: "center" };
  sheet.getCell(11, 3).value = isSales ? receiver?.gstin || "Unregistered" : issuingCompany?.gstin || "N/A";
  sheet.getCell(11, 3).font = { name: "Calibri", size: 10, bold: true };
  sheet.mergeCells(11, 4, 11, 8);
  sheet.getCell(11, 4).value = `Financial Year: ${batch.financial_year || ""}`;
  sheet.getCell(11, 4).font = { name: "Calibri", size: 10 };

  // Row 12: PAN, right side blank.
  sheet.getCell(12, 1).value = "PAN";
  sheet.getCell(12, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(12, 2).value = ":";
  sheet.getCell(12, 2).alignment = { horizontal: "center" };
  sheet.getCell(12, 3).value = isSales ? receiver?.pan || "" : issuingCompany?.pan || "";
  sheet.getCell(12, 3).font = { name: "Calibri", size: 10, bold: true };
  sheet.mergeCells(12, 4, 12, 8);

  // Row 13: State paired with a single concatenated State Code cell.
  // Prompt 17: Purchase always shows Tamil Nadu / 33 here — the receiver
  // is our own company on a Purchase invoice, always based there,
  // regardless of whether issuing_companies.state happens to be populated.
  sheet.getCell(13, 1).value = "State";
  sheet.getCell(13, 1).font = { name: "Calibri", size: 10, bold: true };
  sheet.getCell(13, 2).value = ":";
  sheet.getCell(13, 2).alignment = { horizontal: "center" };
  sheet.getCell(13, 3).value = isSales ? receiver?.state || "" : "Tamil Nadu";
  sheet.getCell(13, 3).font = { name: "Calibri", size: 10, bold: true };
  sheet.mergeCells(13, 4, 13, 8);
  const stateCode = isSales ? receiver?.state_code || "" : "33";
  sheet.getCell(13, 4).value = stateCode ? `State Code : ${stateCode}` : "";
  sheet.getCell(13, 4).font = { name: "Calibri", size: 10, bold: true };

  rect(9, 1, 13, 3);
  rect(9, 4, 13, 8);

  // Rows 14-15: a two-row-merged product table header — Sl. No. / Name of
  // the Product / HSN / Qty in KG / Rate Per KG (Rs.) / Total Amount —
  // matching the reference's exact column set (never the old per-product
  // 4-column horizontal block).
  sheet.mergeCells(14, 1, 15, 1);
  sheet.getCell(14, 1).value = "Sl.\nNo.";
  sheet.mergeCells(14, 2, 15, 3);
  sheet.getCell(14, 2).value = "Name of the Product / Service";
  sheet.mergeCells(14, 4, 15, 4);
  sheet.getCell(14, 4).value = "HSN/ ACS";
  sheet.mergeCells(14, 5, 15, 5);
  sheet.getCell(14, 5).value = "Qty in KG";
  sheet.mergeCells(14, 6, 14, 7);
  sheet.getCell(14, 6).value = "Rate Per KG";
  sheet.mergeCells(15, 6, 15, 7);
  sheet.getCell(15, 6).value = "Rs.";
  sheet.mergeCells(14, 8, 15, 8);
  sheet.getCell(14, 8).value = "Total Amount";
  for (const r of [14, 15]) {
    for (let c = 1; c <= 8; c++) {
      const cell = sheet.getCell(r, c);
      cell.fill = HEADER_BAND_FILL as any;
      cell.font = { name: "Calibri", size: 10, bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    }
  }
  rect(14, 1, 15, 8);

  // Rows 16+: product data, padded to MIN_PRODUCT_ROWS blank editable rows
  // (matching the reference's own `minProductRows = 16`) so a new product
  // can simply be typed into the next blank row — no "ADD PRODUCT" button
  // or column-insert needed for the common case any more. Total Amount is
  // a live formula per row: blank until both Qty and Rate are filled in,
  // then computes itself immediately, with no VBA involved.
  const productRowCount = Math.max(products.length, MIN_PRODUCT_ROWS);
  for (let i = 0; i < productRowCount; i++) {
    const r = INV_PRODUCT_DATA_ROW + i;
    const p = products[i];

    const slCell = sheet.getCell(r, 1);
    slCell.value = p ? i + 1 : null;
    slCell.alignment = { horizontal: "center", vertical: "middle" };

    sheet.mergeCells(r, 2, r, 3);
    const nameCell = sheet.getCell(r, 2);
    nameCell.value = p?.product_name || "";
    nameCell.alignment = { vertical: "middle" };

    const hsnCell = sheet.getCell(r, 4);
    hsnCell.value = p?.hsn_code || "";
    hsnCell.alignment = { horizontal: "center", vertical: "middle" };

    const qtyCell = sheet.getCell(r, 5);
    qtyCell.value = p ? num(p.quantity) : null;
    qtyCell.alignment = { horizontal: "center", vertical: "middle" };

    sheet.mergeCells(r, 6, r, 7);
    const rateCell = sheet.getCell(r, 6);
    rateCell.value = p ? num(p.rate) : null;
    rateCell.numFmt = "0.00";
    rateCell.alignment = { horizontal: "right", vertical: "middle" };

    const totalCell = sheet.getCell(r, 8);
    totalCell.value = { formula: `IF(AND(E${r}<>"",F${r}<>""),E${r}*F${r},"")` };
    totalCell.numFmt = "0.00";
    totalCell.alignment = { horizontal: "right", vertical: "middle" };

    for (let c = 1; c <= 8; c++) sheet.getCell(r, c).font = { name: "Calibri", size: 10 };
  }
  const lastProductRow = INV_PRODUCT_DATA_ROW + productRowCount - 1;
  rect(INV_PRODUCT_DATA_ROW, 1, lastProductRow, 8);

  const footer = invoiceFooterRows(productRowCount);

  // Total row — a plain SUM over the product table's own Total Amount
  // column, so it always includes whatever rows are actually filled in,
  // however many that turns out to be.
  sheet.mergeCells(footer.totalRow, 1, footer.totalRow, 7);
  const totalTitleCell = sheet.getCell(footer.totalRow, 1);
  totalTitleCell.value = "Total";
  totalTitleCell.font = { name: "Calibri", size: 10, bold: true };
  totalTitleCell.alignment = { horizontal: "center", vertical: "middle" };
  totalTitleCell.fill = HEADER_BAND_FILL as any;
  const grandTotalCell = sheet.getCell(footer.totalRow, 8);
  grandTotalCell.value = { formula: `SUM(H${INV_PRODUCT_DATA_ROW}:H${lastProductRow})` };
  grandTotalCell.numFmt = "0.00";
  grandTotalCell.font = { name: "Calibri", size: 10, bold: true };
  grandTotalCell.fill = HEADER_BAND_FILL as any;
  grandTotalCell.alignment = { vertical: "middle" };

  // Goods Dispatched / Total Amount Before Tax — exact existing wording,
  // preserved verbatim (section 11: "Do not invent replacement wording").
  sheet.mergeCells(footer.goodsDispatchedRow, 1, footer.goodsDispatchedRow, 3);
  const goodsCell = sheet.getCell(footer.goodsDispatchedRow, 1);
  goodsCell.value = "✅ GOODS DISPATCHED";
  goodsCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: HEADER_NAVY } };
  goodsCell.alignment = { horizontal: "center", vertical: "middle" };
  sheet.mergeCells(footer.goodsDispatchedRow, 4, footer.goodsDispatchedRow, 5);
  sheet.getCell(footer.goodsDispatchedRow, 4).value = "Total Amount Before Tax";
  sheet.mergeCells(footer.goodsDispatchedRow, 6, footer.goodsDispatchedRow, 7);
  sheet.getCell(footer.goodsDispatchedRow, 6).value = "Rs.";
  const beforeTaxCell = sheet.getCell(footer.goodsDispatchedRow, 8);
  beforeTaxCell.value = { formula: `H${footer.totalRow}` };
  beforeTaxCell.numFmt = "0.00";
  beforeTaxCell.font = { name: "Calibri", size: 10, bold: true };

  // Rupees in words (Prompt 6, section 4/14 — the one part of this sheet
  // that genuinely needs VBA afterward, since Excel formulas alone cannot
  // produce word text) spans 2 rows, paired with CGST on the first.
  sheet.mergeCells(footer.wordsRow, 1, footer.wordsRow + 1, 3);
  const wordsCell = sheet.getCell(footer.wordsRow, 1);
  wordsCell.value = `Rupees in words: ${numberToWords(num(inv.total_amount))}`;
  wordsCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: HEADER_NAVY } };
  wordsCell.alignment = { vertical: "top", wrapText: true };
  sheet.mergeCells(footer.wordsRow, 4, footer.wordsRow, 5);
  sheet.getCell(footer.wordsRow, 4).value = "Add : CGST*";
  sheet.mergeCells(footer.wordsRow, 6, footer.wordsRow, 7);
  sheet.getCell(footer.wordsRow, 6).value = "Rs.";
  sheet.getCell(footer.wordsRow, 8).value = "Nil";
  sheet.getCell(footer.wordsRow, 8).font = { name: "Calibri", size: 10, bold: true };

  // SGST, on the second words row.
  sheet.mergeCells(footer.sgstRow, 4, footer.sgstRow, 5);
  sheet.getCell(footer.sgstRow, 4).value = "Add : SGST*";
  sheet.mergeCells(footer.sgstRow, 6, footer.sgstRow, 7);
  sheet.getCell(footer.sgstRow, 6).value = "Rs.";
  sheet.getCell(footer.sgstRow, 8).value = "Nil";
  sheet.getCell(footer.sgstRow, 8).font = { name: "Calibri", size: 10, bold: true };

  // Company's Bank Details header (Sales only — see the Purchase note
  // below) / Total Amount After GST.
  if (isSales) {
    const bankHeaderCell = sheet.getCell(footer.bankHeaderRow, 1);
    bankHeaderCell.value = "Company's Bank Details :";
    bankHeaderCell.font = { name: "Calibri", size: 10, bold: true };
  }
  sheet.mergeCells(footer.bankHeaderRow, 4, footer.bankHeaderRow, 5);
  sheet.getCell(footer.bankHeaderRow, 4).value = "Total Amount After GST";
  sheet.mergeCells(footer.bankHeaderRow, 6, footer.bankHeaderRow, 7);
  sheet.getCell(footer.bankHeaderRow, 6).value = "Rs.";
  const afterGstCell = sheet.getCell(footer.bankHeaderRow, 8);
  afterGstCell.value = { formula: `H${footer.goodsDispatchedRow}` };
  afterGstCell.numFmt = "0.00";
  afterGstCell.font = { name: "Calibri", size: 10, bold: true };

  // Rows 37-42: Company's Bank Details. Sales — values are FORMULAS
  // pointing at the Batch Overview sheet, so editing Batch Overview
  // propagates to every Sales invoice automatically via Excel's own
  // recalculation, with no VBA needed for this one-way direction. Purchase
  // never has real bank data here (section 12) — Prompt 17: rather than
  // showing labels beside permanently-empty values, Purchase leaves this
  // whole left-hand block (header + 6 rows) completely blank, keeping only
  // the bordered box grid the reference invoice's own layout provides.
  if (isSales) {
    function bankValue(cell: string): ExcelJS.CellValue {
      return batchOverviewSheetName ? { formula: `'${batchOverviewSheetName}'!${cell}` } : "";
    }
    writeBankDetailRow(sheet, footer.bankAccountRow, "Name of Account", bankValue(`C${BATCH_OVERVIEW_NAME_OF_ACCOUNT_ROW}`), false);
    writeBankDetailRow(sheet, footer.bankNameRow, "Name of Bank", bankValue(`C${BATCH_OVERVIEW_NAME_OF_BANK_ROW}`), false);
    writeBankDetailRow(sheet, footer.bankBranchRow, "Branch Name", bankValue(`C${BATCH_OVERVIEW_BRANCH_ROW}`), false);
    writeBankDetailRow(sheet, footer.bankAcctNoRow, "Account No.", bankValue(`C${BATCH_OVERVIEW_ACCOUNT_NO_ROW}`), false);
    writeBankDetailRow(sheet, footer.bankIfscRow, "IFSC Code", bankValue(`C${BATCH_OVERVIEW_IFSC_ROW}`), false);
    writeBankDetailRow(sheet, footer.panRow, "PAN", bankValue(`C${BATCH_OVERVIEW_PAN_ROW}`), false);
  }

  // Right column beside the bank rows: Forwarding / Postage / Other
  // charges / Rounded off — editable manual-entry numbers (default 0)
  // that Net Total below adds in automatically via formula.
  const charges: [number, string][] = [
    [footer.bankAccountRow, "Forwarding"],
    [footer.bankNameRow, "Postage"],
    [footer.bankBranchRow, "Other charges if any"],
    [footer.bankAcctNoRow, "Ps.Rounded Off"],
  ];
  for (const [r, label] of charges) {
    sheet.mergeCells(r, 4, r, 5);
    sheet.getCell(r, 4).value = label;
    sheet.mergeCells(r, 6, r, 7);
    sheet.getCell(r, 6).value = "Rs.";
    const cell = sheet.getCell(r, 8);
    cell.value = 0;
    cell.numFmt = "0.00";
  }

  // Net Total — sums Total Amount After GST plus the four charge rows
  // above; a live formula, so editing any manual charge recalculates it
  // immediately.
  sheet.mergeCells(footer.bankIfscRow, 4, footer.bankIfscRow, 7);
  const netTotalLabelCell = sheet.getCell(footer.bankIfscRow, 4);
  netTotalLabelCell.value = "Net Total";
  netTotalLabelCell.font = { name: "Calibri", size: 12, bold: true };
  netTotalLabelCell.fill = HEADER_BAND_FILL as any;
  const netTotalCell = sheet.getCell(footer.bankIfscRow, 8);
  netTotalCell.value = {
    formula: `H${footer.bankHeaderRow}+H${footer.bankAccountRow}+H${footer.bankNameRow}+H${footer.bankBranchRow}+H${footer.bankAcctNoRow}`,
  };
  netTotalCell.numFmt = "0.00";
  netTotalCell.font = { name: "Calibri", size: 12, bold: true };
  netTotalCell.fill = HEADER_BAND_FILL as any;

  sheet.mergeCells(footer.panRow, 4, footer.panRow, 8);
  rect(footer.goodsDispatchedRow, 1, footer.panRow, 8);

  // Terms & Conditions (left) / Certification (right) — exact existing
  // wording, "For {name}" using the SUPPLIER for Purchase (never
  // hard-coded), our own company for Sales.
  const certRowEnd = footer.termsCertRow + 3;
  sheet.mergeCells(footer.termsCertRow, 1, certRowEnd, 4);
  const termsCell = sheet.getCell(footer.termsCertRow, 1);
  termsCell.value =
    "Terms & Conditions :\n1. Interest @ 24% p.a. Will be charged for overdue bills (more than 30 days).\n2. All disputes are subject to Chennai Jurisdiction";
  termsCell.alignment = { vertical: "top", wrapText: true };
  termsCell.font = { name: "Calibri", size: 9 };

  sheet.mergeCells(footer.termsCertRow, 5, certRowEnd, 8);
  const certCell = sheet.getCell(footer.termsCertRow, 5);
  certCell.value = `Certified that the particulars given above are true and correct\nFor ${sellerName}\n\n\nAuthorised Signatory`;
  certCell.alignment = { horizontal: "center", vertical: "top", wrapText: true };
  certCell.font = { name: "Calibri", size: 9, bold: true, color: { argb: HEADER_NAVY } };

  rect(footer.termsCertRow, 1, certRowEnd, 8);

  return sheet;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export class SummaryWorkbookService {
  static async build(input: FilingWorkbookInput): Promise<ExcelJS.Workbook> {
    const { batch, invoices, partnerMap, issuingCompany } = input;
    const isSales = batch.batch_type === "SALES";
    const partnerLabel = isSales ? "Customer" : "Supplier";

    const workbook = new ExcelJS.Workbook();
    // Force Excel to recompute every formula from scratch the moment the
    // file opens, rather than trusting whatever (or however little) is
    // cached in each formula cell's <v> — cheap insurance against a stale
    // Total Amount/grand Total ever being what the user sees first.
    workbook.calcProperties.fullCalcOnLoad = true;

    const summarySheetName = isSales ? "Sales Summary" : "Purchase Summary";
    const partnerSummarySheetName = isSales ? "Customer Summary" : "Supplier Summary";

    // Reserve every sheet name up front (summary sheets + one per invoice)
    // BEFORE building any sheet content. This lets the summary sheets —
    // which must stay first in the workbook per the required ordering —
    // reference each invoice's final sheet name in a real formula, instead
    // of a value copied out of the same source data twice.
    const usedSheetNames = new Set<string>();
    usedSheetNames.add(summarySheetName.toUpperCase());
    usedSheetNames.add(partnerSummarySheetName.toUpperCase());
    usedSheetNames.add("PRODUCT SUMMARY");
    usedSheetNames.add(HIDDEN_DATA_SHEET_NAME.toUpperCase());
    usedSheetNames.add(BATCH_OVERVIEW_SHEET_NAME.toUpperCase());
    // Sheet tab = exactly the invoice number as displayed everywhere else
    // (prefix-stripped for Purchase, full for Sales) — never the internal
    // full number with its abbreviation prefix.
    const invoiceMeta: InvoiceMeta[] = invoices.map((inv) => {
      const displayNumber = isSales
        ? inv.invoice_number
        : stripInvoicePrefixForDisplay(inv.invoice_number || "");
      return {
        inv,
        sheetName: safeSheetName(displayNumber || inv.id, usedSheetNames),
      };
    });

    const lineItems = collectLineItems(batch, invoiceMeta, partnerMap);

    // Prompt 9, section 2: Batch Overview, Purchase/Sales Summary, Product
    // Summary, Supplier/Customer Summary, THEN every invoice sheet — in
    // that exact order. Sheet build order = worksheet tab order in
    // ExcelJS, so the summary sheets are built first, in this sequence,
    // rather than appended after the fact.

    // Sheet 1: Batch Overview (both batch types now — section 3/4).
    const batchOverviewSheetName = BATCH_OVERVIEW_SHEET_NAME;
    if (isSales) {
      buildSalesBatchOverviewSheet(workbook, batch, invoiceMeta, partnerMap, lineItems, issuingCompany);
    } else {
      buildPurchaseBatchOverviewSheet(workbook, batch, invoiceMeta, partnerLabel, partnerMap, lineItems);
    }

    // Sheet 2: Purchase/Sales Summary
    buildInvoiceListSheet(
      workbook,
      summarySheetName,
      partnerLabel,
      isSales,
      batch,
      invoiceMeta,
      partnerMap,
    );

    // Sheet 3: Product Summary
    buildProductSummarySheet(workbook, lineItems);

    // Sheet 4: Supplier/Customer Summary
    buildPartnerSummarySheet(
      workbook,
      partnerSummarySheetName,
      `${partnerLabel} Name`,
      summarySheetName,
      batch,
      invoices,
      partnerMap,
    );

    // Sheet 5+: one per finalized invoice, in the same order as `invoices`,
    // reusing the exact sheet names already reserved above. Individual
    // invoice sheets always come after every summary sheet (section 2).
    for (const { inv, sheetName } of invoiceMeta) {
      const { partner } = resolvePartner(inv, batch, partnerMap);
      buildInvoiceSheet(workbook, sheetName, isSales, batch, inv, partner, issuingCompany, batchOverviewSheetName);
    }

    // Last sheet: the one normalized source of truth for every invoice
    // product line (Prompt 4B) — appended after every invoice sheet so
    // it never disturbs the "summary sheets, then invoice sheets" order;
    // only code that looks past the invoice sheets needs to know it's
    // there (Prompt 4B, still true after Prompt 9's reordering).
    buildHiddenInvoiceDataSheet(workbook, lineItems);

    return workbook;
  }
}
