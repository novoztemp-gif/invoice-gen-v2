/**
 * Pure, in-memory specification of the Excel-only two-way synchronization
 * rules for the downloaded finalized-batch filing workbook (Prompt 4).
 *
 * This module does NOT touch Excel, ExcelJS, or any .xlsm file, is not
 * imported by any API route or page, and never calls Supabase or any
 * external service. It exists purely as the tested, authoritative
 * specification that templates/vba/SyncEngine.bas is a hand-written,
 * careful port of — the actual runtime behavior only exists inside
 * Excel's own VBA engine once a user opens the downloaded workbook, which
 * cannot be executed or unit-tested from this Node.js toolchain. Every
 * exported function here has a same-named counterpart in that .bas file;
 * if that VBA's correctness is ever in question, this is the spec to
 * check it against.
 *
 * Every function operates on stable IDs only (invoiceId / productId /
 * partnerId) — never on display names — matching the workbook's hidden
 * identifier data model built in SummaryWorkbookService.ts (Prompt 3).
 */

export interface SyncInvoiceLine {
  invoiceId: string;
  productId: string;
  productName: string;
  hsn: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface SyncInvoice {
  invoiceId: string;
  invoiceNumber: string;
  partnerId: string;
  partnerName: string;
  lines: SyncInvoiceLine[];
}

export interface SyncWorkbookModel {
  invoices: SyncInvoice[];
}

// ---------------------------------------------------------------------------
// Deterministic largest-remainder proportional redistribution
// ---------------------------------------------------------------------------

/** Matches the workbook's own "#,##0.00" quantity/amount cell format. */
const PRECISION = 100;

/**
 * Redistributes `newTotal` across `weights.length` lines, proportional to
 * each line's current weight (quantity or amount), using a deterministic
 * largest-remainder allocation so the result always sums EXACTLY to
 * `newTotal` at 2-decimal precision, never goes negative, and never uses
 * randomness — ties are broken by ascending original index.
 *
 * Matches Prompt 4's own worked example exactly: weights [20,30,50],
 * newTotal 120 -> [24,36,60].
 */
export function redistributeProportionally(
  weights: number[],
  newTotal: number,
): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const safeTotal = Math.max(0, newTotal);
  const targetUnits = Math.round(safeTotal * PRECISION);

  const weightSum = weights.reduce((s, w) => s + Math.max(0, w), 0);

  const shares: number[] = new Array(n).fill(0);
  const fracs: number[] = new Array(n).fill(0);
  let used = 0;

  if (weightSum > 0) {
    for (let i = 0; i < n; i++) {
      const w = Math.max(0, weights[i]);
      const raw = (w / weightSum) * targetUnits;
      shares[i] = Math.floor(raw);
      fracs[i] = raw - shares[i];
      used += shares[i];
    }
  } else {
    const base = Math.floor(targetUnits / n);
    for (let i = 0; i < n; i++) shares[i] = base;
    used = base * n;
  }

  let remaining = targetUnits - used;

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => fracs[b] - fracs[a] || a - b,
  );
  let k = 0;
  while (remaining > 0 && k < order.length) {
    shares[order[k]] += 1;
    remaining--;
    k++;
  }
  // Safety net if remaining still > 0 (more leftover units than lines) —
  // round-robin the rest deterministically from index 0.
  let idx = 0;
  while (remaining > 0) {
    shares[idx % n] += 1;
    remaining--;
    idx++;
  }

  return shares.map((v) => v / PRECISION);
}

// ---------------------------------------------------------------------------
// Rename operations — Product ID / Partner ID are the stable identity,
// name/HSN are editable display data (Prompt 4, section 6).
// ---------------------------------------------------------------------------

export function renamePartner(
  model: SyncWorkbookModel,
  partnerId: string,
  newName: string,
): SyncWorkbookModel {
  return {
    invoices: model.invoices.map((inv) =>
      inv.partnerId === partnerId ? { ...inv, partnerName: newName } : inv,
    ),
  };
}

export function renameProduct(
  model: SyncWorkbookModel,
  productId: string,
  changes: { name?: string; hsn?: string },
): SyncWorkbookModel {
  return {
    invoices: model.invoices.map((inv) => ({
      ...inv,
      lines: inv.lines.map((line) =>
        line.productId === productId
          ? {
              ...line,
              productName: changes.name ?? line.productName,
              hsn: changes.hsn ?? line.hsn,
            }
          : line,
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// Invoice -> Summary direction (Prompt 4, sections 4 and 11): the visible
// invoice cell is the user's edit source; helper data/summaries follow it.
// ---------------------------------------------------------------------------

export function editInvoiceLine(
  model: SyncWorkbookModel,
  invoiceId: string,
  productId: string,
  changes: { qty?: number; rate?: number; productName?: string; hsn?: string },
): SyncWorkbookModel {
  return {
    invoices: model.invoices.map((inv) => {
      if (inv.invoiceId !== invoiceId) return inv;
      return {
        ...inv,
        lines: inv.lines.map((line) => {
          if (line.productId !== productId) return line;
          const qty = changes.qty ?? line.qty;
          const rate = changes.rate ?? line.rate;
          return {
            ...line,
            qty,
            rate,
            amount: qty * rate,
            productName: changes.productName ?? line.productName,
            hsn: changes.hsn ?? line.hsn,
          };
        }),
      };
    }),
  };
}

/**
 * A partner-name edit made directly on an invoice sheet (section 11) is
 * the same underlying operation as editing it from Supplier/Customer
 * Summary (section 9) — both key off the same stable Partner ID and
 * propagate to every invoice sharing it.
 */
export function editInvoicePartnerName(
  model: SyncWorkbookModel,
  invoiceId: string,
  newName: string,
): SyncWorkbookModel {
  const inv = model.invoices.find((i) => i.invoiceId === invoiceId);
  if (!inv) return model;
  return renamePartner(model, inv.partnerId, newName);
}

// ---------------------------------------------------------------------------
// Summary -> Invoice direction (Prompt 4, sections 5, 7, 8): deterministic
// redistribution across every line sharing a Product ID.
// ---------------------------------------------------------------------------

function allLinesForProduct(
  model: SyncWorkbookModel,
  productId: string,
): Array<{ invoiceIndex: number; lineIndex: number }> {
  const refs: Array<{ invoiceIndex: number; lineIndex: number }> = [];
  model.invoices.forEach((inv, invoiceIndex) => {
    inv.lines.forEach((line, lineIndex) => {
      if (line.productId === productId) refs.push({ invoiceIndex, lineIndex });
    });
  });
  return refs;
}

export function redistributeProductQuantity(
  model: SyncWorkbookModel,
  productId: string,
  newTotalQty: number,
): SyncWorkbookModel {
  const refs = allLinesForProduct(model, productId);
  if (refs.length === 0) return model;

  const weights = refs.map(
    ({ invoiceIndex, lineIndex }) => model.invoices[invoiceIndex].lines[lineIndex].qty,
  );
  const newQuantities = redistributeProportionally(weights, newTotalQty);

  const invoices = model.invoices.map((inv) => ({ ...inv, lines: [...inv.lines] }));
  refs.forEach(({ invoiceIndex, lineIndex }, i) => {
    const line = invoices[invoiceIndex].lines[lineIndex];
    const qty = newQuantities[i];
    invoices[invoiceIndex].lines[lineIndex] = { ...line, qty, amount: qty * line.rate };
  });
  return { invoices };
}

export function redistributeProductAmount(
  model: SyncWorkbookModel,
  productId: string,
  newTotalAmount: number,
): SyncWorkbookModel {
  const refs = allLinesForProduct(model, productId);
  if (refs.length === 0) return model;

  const weights = refs.map(
    ({ invoiceIndex, lineIndex }) => model.invoices[invoiceIndex].lines[lineIndex].amount,
  );
  const newAmounts = redistributeProportionally(weights, newTotalAmount);

  const invoices = model.invoices.map((inv) => ({ ...inv, lines: [...inv.lines] }));
  refs.forEach(({ invoiceIndex, lineIndex }, i) => {
    const line = invoices[invoiceIndex].lines[lineIndex];
    const amount = newAmounts[i];
    const rate = line.qty > 0 ? amount / line.qty : line.rate;
    invoices[invoiceIndex].lines[lineIndex] = { ...line, amount, rate };
  });
  return { invoices };
}

// ---------------------------------------------------------------------------
// Derived summary views — used to verify the Invoice -> Summary direction
// (a summary recomputed from the model must reflect a prior line edit).
// ---------------------------------------------------------------------------

export interface ProductSummaryRow {
  productId: string;
  name: string;
  hsn: string;
  totalQty: number;
  totalAmount: number;
}

export function computeProductSummary(model: SyncWorkbookModel): Map<string, ProductSummaryRow> {
  const out = new Map<string, ProductSummaryRow>();
  for (const inv of model.invoices) {
    for (const line of inv.lines) {
      const existing = out.get(line.productId) || {
        productId: line.productId,
        name: line.productName,
        hsn: line.hsn,
        totalQty: 0,
        totalAmount: 0,
      };
      existing.name = line.productName;
      existing.hsn = line.hsn;
      existing.totalQty += line.qty;
      existing.totalAmount += line.amount;
      out.set(line.productId, existing);
    }
  }
  return out;
}

export interface PartnerSummaryRow {
  partnerId: string;
  name: string;
  invoiceCount: number;
  totalAmount: number;
}

export function computePartnerSummary(model: SyncWorkbookModel): Map<string, PartnerSummaryRow> {
  const out = new Map<string, PartnerSummaryRow>();
  for (const inv of model.invoices) {
    const invoiceTotal = inv.lines.reduce((s, l) => s + l.amount, 0);
    const existing = out.get(inv.partnerId) || {
      partnerId: inv.partnerId,
      name: inv.partnerName,
      invoiceCount: 0,
      totalAmount: 0,
    };
    existing.name = inv.partnerName;
    existing.invoiceCount += 1;
    existing.totalAmount += invoiceTotal;
    out.set(inv.partnerId, existing);
  }
  return out;
}

export function computeInvoiceTotal(model: SyncWorkbookModel, invoiceId: string): number {
  const inv = model.invoices.find((i) => i.invoiceId === invoiceId);
  if (!inv) return 0;
  return inv.lines.reduce((s, l) => s + l.amount, 0);
}

// ---------------------------------------------------------------------------
// Dynamic product addition (Prompt 4B, sections 3-9, 18-19) — the tested
// specification that templates/vba/SyncEngine.bas's AddProductBlock is a
// hand-written port of. This only models the DATA decisions (which Product
// ID to use, what the new line looks like); the actual Excel column-insert
// and cell/formatting operations only exist inside Excel and cannot be
// exercised outside it.
// ---------------------------------------------------------------------------

export interface ProductCatalogEntry {
  productId: string;
  name: string;
  hsn: string;
}

/**
 * A practically-unique workbook-local Product ID for a genuinely new
 * product. Not a redistribution-style determinism concern (section 7's
 * "no random allocation" is specifically about quantity splitting) — this
 * only needs to not collide with itself in normal use, which a
 * timestamp + running line count comfortably satisfies.
 */
export function generateWorkbookLocalProductId(
  existingLineCount: number,
  now: Date = new Date(),
): string {
  const ts = now
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `WBLOCAL-${ts}-${existingLineCount + 1}`;
}

export interface ProductResolution {
  productId: string;
  name: string;
  hsn: string;
  isNew: boolean;
}

/**
 * Resolves what "Add Product" should use for a user-entered name: reuse an
 * existing Product ID by exact (case-insensitive) name match against the
 * catalog (section 5/6 — never invent an ID for an existing product), or
 * generate a new one for a genuinely new product.
 */
export function resolveProductForAddition(
  catalog: ProductCatalogEntry[],
  requestedName: string,
  requestedHsn: string | undefined,
  existingLineCount: number,
): ProductResolution {
  const trimmedName = requestedName.trim();
  const match = catalog.find(
    (c) => c.name.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  if (match) {
    return { productId: match.productId, name: match.name, hsn: match.hsn, isNew: false };
  }
  return {
    productId: generateWorkbookLocalProductId(existingLineCount),
    name: trimmedName,
    hsn: (requestedHsn || "").trim(),
    isNew: true,
  };
}

/**
 * Appends a new product line to one invoice — never touches any other
 * invoice's lines, and never removes/reorders existing lines on this one
 * (section 18, step 9: "leaves all existing products untouched").
 */
export function addProductToInvoice(
  model: SyncWorkbookModel,
  invoiceId: string,
  resolution: ProductResolution,
  qty: number,
  rate: number,
): SyncWorkbookModel {
  return {
    invoices: model.invoices.map((inv) => {
      if (inv.invoiceId !== invoiceId) return inv;
      return {
        ...inv,
        lines: [
          ...inv.lines,
          {
            invoiceId,
            productId: resolution.productId,
            productName: resolution.name,
            hsn: resolution.hsn,
            qty,
            rate,
            amount: qty * rate,
          },
        ],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Prompt 5 — invoice creation, deletion, and automatic gap-free renumbering.
// The tested specification that templates/vba/SyncEngine.bas's
// AddNewInvoice / DeleteInvoiceByStableId / RenumberAllInvoices are a
// hand-written port of. Section 12's rule governs everything here: Invoice
// ID is the permanent identity; Invoice Number is workbook-local display
// text that may change on renumbering — every function below preserves the
// former and only ever rewrites the latter.
// ---------------------------------------------------------------------------

/**
 * Splits an invoice number into its non-numeric prefix and trailing digit
 * run (e.g. "AT-2026-27-P-0000042" -> prefix "AT-2026-27-P-", digits
 * "0000042", width 7, value 42). Returns null if the string has no
 * trailing digits to renumber — such a number is left untouched by
 * renumbering rather than guessed at.
 */
export interface TrailingSequence {
  prefix: string;
  digits: string;
  width: number;
  value: number;
}

export function extractTrailingSequence(invoiceNumber: string): TrailingSequence | null {
  const m = invoiceNumber.match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], digits: m[2], width: m[2].length, value: parseInt(m[2], 10) };
}

/**
 * Rewrites only the trailing digit run of `invoiceNumber` to `newSequence`,
 * zero-padded to the SAME width as the original — preserving whatever
 * real, structured prefix the number already had (e.g. the app's own
 * "AT-2026-27-P-" format), exactly like the prompt's own "INV-001 ->
 * INV-002" example only ever changes the trailing digits, never the
 * prefix. A number with no trailing digits is returned unchanged.
 */
export function formatInvoiceNumber(invoiceNumber: string, newSequence: number): string {
  const parsed = extractTrailingSequence(invoiceNumber);
  if (!parsed) return invoiceNumber;
  return `${parsed.prefix}${String(newSequence).padStart(parsed.width, "0")}`;
}

/** The next invoice number after the last one in the current sequence. */
export function nextInvoiceNumber(lastInvoiceNumber: string | undefined): string {
  if (!lastInvoiceNumber) return "INV-0000001";
  const parsed = extractTrailingSequence(lastInvoiceNumber);
  if (!parsed) return `${lastInvoiceNumber}-2`;
  return formatInvoiceNumber(lastInvoiceNumber, parsed.value + 1);
}

// ---------------------------------------------------------------------------
// Prompt 6 — Purchase invoice sheet: display-only invoice number.
// ---------------------------------------------------------------------------

/**
 * Prompt 18 (reverting Prompt 17's over-correction): strips only the
 * leading application/company abbreviation prefix (e.g. "AT-") from an
 * invoice number — "remove the abbreviation and keep the remaining"
 * exactly, e.g. "AT-2021-22-P-00000001" -> "2021-22-P-00000001" — DISPLAY
 * ONLY, on the Purchase invoice sheet's own visible Invoice No cell and
 * Purchase Summary's own Invoice Number column (Prompt 6, section 9; the
 * two are kept in sync deliberately). Never applied to the stable
 * Invoice ID or to _hidden_invoice_data — those keep the real, full
 * number so renumbering math and sheet-name safety are completely
 * unaffected. A number with no leading alphabetic prefix is returned
 * unchanged.
 */
export function stripInvoicePrefixForDisplay(invoiceNumber: string): string {
  const m = invoiceNumber.match(/^[A-Za-z]+-(.*)$/);
  return m ? m[1] : invoiceNumber;
}

/**
 * Reassigns every invoice's display Invoice Number to a gap-free 1..N
 * sequence, in the model's current array order — the natural order
 * becomes the new sequence, exactly matching the prompt's own worked
 * example (delete index 1 from [001,002,003,004] -> renumber the
 * remaining three to [001,002,003]). Invoice IDs are never touched
 * (section 3/12) — only the invoiceNumber field changes.
 */
export function renumberInvoicesSequentially(model: SyncWorkbookModel): SyncWorkbookModel {
  return {
    invoices: model.invoices.map((inv, i) => ({
      ...inv,
      invoiceNumber: formatInvoiceNumber(inv.invoiceNumber, i + 1),
    })),
  };
}

/** Removes one invoice (and all its lines) by its stable Invoice ID. */
export function deleteInvoice(model: SyncWorkbookModel, invoiceId: string): SyncWorkbookModel {
  return { invoices: model.invoices.filter((inv) => inv.invoiceId !== invoiceId) };
}

/** Removes multiple invoices by stable Invoice ID in one operation (section 4). */
export function deleteInvoices(model: SyncWorkbookModel, invoiceIds: string[]): SyncWorkbookModel {
  const idSet = new Set(invoiceIds);
  return { invoices: model.invoices.filter((inv) => !idSet.has(inv.invoiceId)) };
}

/** A practically-unique workbook-local Invoice ID, mirroring generateWorkbookLocalProductId. */
export function generateWorkbookLocalInvoiceId(existingInvoiceCount: number, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `WBLOCAL-INV-${ts}-${existingInvoiceCount + 1}`;
}

export interface PartnerCatalogEntry {
  partnerId: string;
  name: string;
}

/** A practically-unique workbook-local Partner ID, mirroring generateWorkbookLocalProductId. */
export function generateWorkbookLocalPartnerId(existingPartnerCount: number, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `WBLOCAL-PARTNER-${ts}-${existingPartnerCount + 1}`;
}

export interface PartnerResolution {
  partnerId: string;
  name: string;
  isNew: boolean;
}

/**
 * Resolves the Partner ID for a new invoice's customer/supplier (section
 * 6): reuse an existing partner's ID on an exact case-insensitive name
 * match against the current Customer/Supplier Summary, or mint a new
 * workbook-local ID for a genuinely new partner. Mirrors
 * resolveProductForAddition exactly.
 */
export function resolvePartnerForNewInvoice(
  catalog: PartnerCatalogEntry[],
  requestedName: string,
  existingPartnerCount: number,
): PartnerResolution {
  const trimmedName = requestedName.trim();
  const match = catalog.find((c) => c.name.trim().toLowerCase() === trimmedName.toLowerCase());
  if (match) {
    return { partnerId: match.partnerId, name: match.name, isNew: false };
  }
  return {
    partnerId: generateWorkbookLocalPartnerId(existingPartnerCount),
    name: trimmedName,
    isNew: true,
  };
}

/**
 * Creates a brand-new, empty invoice (section 1) — ready for the user to
 * add products via addProductToInvoice/AddProductBlock. Never touches any
 * other invoice.
 */
export function createInvoice(
  model: SyncWorkbookModel,
  invoiceId: string,
  invoiceNumber: string,
  partner: PartnerResolution,
): SyncWorkbookModel {
  return {
    invoices: [
      ...model.invoices,
      {
        invoiceId,
        invoiceNumber,
        partnerId: partner.partnerId,
        partnerName: partner.name,
        lines: [],
      },
    ],
  };
}
