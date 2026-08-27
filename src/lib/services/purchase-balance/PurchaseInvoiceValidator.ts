import { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllInvoicesForBatch, fetchRowsByIds } from "@/lib/supabase/fetchAll";
import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";
import {
  BALANCE_LIMITS,
  MONEY_TOLERANCE,
  normaliseCategory,
  ProductConstraint,
  PurchaseBalanceContext,
  PurchaseInvoice,
  PurchaseInvoiceUpdate,
  PurchaseLine,
  roundMoney,
} from "./types";

export class PurchaseInvoiceValidator {
  constructor(private readonly supabase: SupabaseClient) {}

  async loadContext(batchId: string): Promise<PurchaseBalanceContext> {
    const { data: batch, error: batchError } = await this.supabase
      .from("invoice_batch")
      .select(
        "id, batch_type, batch_status, total_amount, supplier_id, major_customers, minimum_invoice_amount, maximum_invoice_amount",
      )
      .eq("id", batchId)
      .single();
    if (batchError || !batch) throw new Error("Purchase batch not found.");
    if (batch.batch_type !== "PURCHASE") {
      throw new Error(
        "Atomic auto balance is available only for purchase batches.",
      );
    }
    if (batch.batch_status === "FINALIZED") {
      throw new Error("Batch is finalized and read-only.");
    }
    if (!batch.supplier_id) {
      throw new Error(
        "Purchase batch must have one supplier before invoices can be edited.",
      );
    }

    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers")
      .select("category")
      .eq("id", batch.supplier_id)
      .single();
    if (supplierError || !supplier?.category) {
      throw new Error("Selected supplier does not have a valid category.");
    }

    const invoices = (await fetchAllInvoicesForBatch(
      this.supabase,
      batchId,
    )) as PurchaseInvoice[];
    if (invoices.length === 0)
      throw new Error("Purchase batch has no invoices.");

    const productIds = new Set<string>();
    for (const invoice of invoices) {
      for (const line of invoice.products || [])
        productIds.add(line.product_id);
    }
    const constraints = new Map<string, ProductConstraint>();
    await this.loadConstraintsInto(constraints, productIds);
    if (constraints.size !== productIds.size) {
      throw new Error(
        "Every invoice product must have a product rule and product master.",
      );
    }

    const majorCustomerIds = new Set<string>(
      (batch.major_customers || [])
        .map((m: any) => m.customer_id)
        .filter(Boolean),
    );

    const clonedInvoices = invoices.map((invoice) =>
      this.cloneInvoice(invoice),
    );
    const originalTotalsById = new Map(
      invoices.map((inv) => [inv.id, Number(inv.total_amount) || 0]),
    );
    const headerTotalCorrections =
      this.selfHealHeaderTotals(clonedInvoices);

    // Hotfix — confirmed as a real, reported bug: when this self-heal
    // corrects one or more invoices' stale header totals, the BATCH's own
    // total_amount (set once at generation/last-save time) never learns
    // about that correction on its own. Every downstream consumer of
    // "the batch total" (the money solver's target, FinalValidator's
    // expected-total check) was still comparing against the STALE raw
    // value — so a batch with even a few drifted invoices made EVERY edit
    // fail with "no valid rebalance plan," demanding an adjustment that
    // had nothing to do with the actual edit (confirmed on a real batch:
    // 15 corrected invoices, +55,713 net correction, batch total left
    // untouched -> the solver was asked to close a ~55,873 gap for a
    // ~160 edit). Folding the correction into batchTotal here — the ONE
    // place every downstream consumer already reads it from — fixes this
    // at the root without needing every call site updated separately.
    // This does NOT persist the correction back to invoice_batch.total_amount
    // in the database (that goes through a separate RPC not touched here)
    // — it's recomputed the same way, safely, on every future edit to this
    // batch until that's addressed too.
    let headerTotalNetCorrection = 0;
    for (const inv of headerTotalCorrections.values()) {
      headerTotalNetCorrection +=
        Number(inv.total_amount || 0) - (originalTotalsById.get(inv.id) || 0);
    }
    headerTotalNetCorrection = Math.round(headerTotalNetCorrection * 100) / 100;
    if (headerTotalCorrections.size > 0) {
      console.log("[HEADERHEAL-DEBUG]", {
        batchId,
        correctedInvoiceCount: headerTotalCorrections.size,
        netCorrection: headerTotalNetCorrection,
        batchTotalOnRecord: Number(batch.total_amount),
        effectiveBatchTotal:
          Number(batch.total_amount) + headerTotalNetCorrection,
      });
    }

    return {
      batchId,
      batchTotal: Number(batch.total_amount) + headerTotalNetCorrection,
      supplierCategory: normaliseCategory(supplier.category),
      invoices: clonedInvoices,
      constraints,
      majorCustomerIds,
      thresholdMin:
        batch.minimum_invoice_amount !== null &&
        batch.minimum_invoice_amount !== undefined
          ? Number(batch.minimum_invoice_amount)
          : null,
      thresholdMax:
        batch.maximum_invoice_amount !== null &&
        batch.maximum_invoice_amount !== undefined
          ? Number(batch.maximum_invoice_amount)
          : null,
      headerTotalCorrections,
    };
  }

  /**
   * Real, confirmed case (not theoretical): a small number of older
   * invoices have a stored total_amount that doesn't match the sum of
   * their own lines, even though every individual line is itself exactly
   * correct (amount === quantity x rate) — e.g. a real invoice with lines
   * summing to 7200 but a stored total of 6254. Left alone,
   * FinalValidator's own total-vs-lines check (the identical computation,
   * correctly enforced) permanently blocks every future edit to the WHOLE
   * batch, not just that one invoice, since every edit revalidates every
   * invoice in the batch.
   *
   * Since every line is already individually exact, the invoice's own
   * header total is unambiguously the wrong number, not the lines —
   * there's nothing to guess. Recomputing it from its own lines here, once
   * per load, self-heals it: the corrected value flows through the rest
   * of this edit like any other change and gets persisted (see
   * AutoBalanceEngine's merge of headerTotalCorrections), so the
   * underlying data is actually fixed, not just worked around in memory.
   *
   * Deliberately narrow: never touches a line's own quantity/rate/amount,
   * and only acts when EVERY line on the invoice is already internally
   * exact. An invoice where a LINE itself is wrong is a genuinely
   * ambiguous kind of corruption (which value is the mistake?) — left
   * alone, and still surfaces as a real validation error requiring a
   * human decision, exactly as it did before this fix.
   */
  private selfHealHeaderTotals(
    invoices: PurchaseInvoice[],
  ): Map<string, PurchaseInvoice> {
    const corrections = new Map<string, PurchaseInvoice>();
    for (const invoice of invoices) {
      if (!invoice.products || invoice.products.length === 0) continue;

      let everyLineExact = true;
      let realTotal = 0;
      for (const line of invoice.products) {
        const expected = computeLineAmount(
          Number(line.quantity),
          Number(line.rate),
        );
        if (Math.abs(Number(line.amount) - expected) > MONEY_TOLERANCE) {
          everyLineExact = false;
          break;
        }
        realTotal += Number(line.amount);
      }
      if (!everyLineExact) continue;

      realTotal = roundMoney(realTotal);
      if (
        realTotal > 0 &&
        Math.abs(realTotal - roundMoney(invoice.total_amount)) >
          MONEY_TOLERANCE
      ) {
        invoice.total_amount = realTotal;
        corrections.set(invoice.id, invoice);
      }
    }
    return corrections;
  }

  /**
   * Fetches product_rules + product master rows for the given IDs and adds
   * them to `constraints` (mutated in place). IDs already present are
   * skipped. Used both by loadContext (existing batch products) and by
   * ensureConstraintsForProducts (a product being newly added to an
   * invoice during edit, which loadContext never saw).
   */
  private async loadConstraintsInto(
    constraints: Map<string, ProductConstraint>,
    productIds: Set<string> | string[],
  ): Promise<void> {
    const ids = [...new Set(productIds)].filter((id) => !constraints.has(id));
    if (ids.length === 0) return;

    const [rules, products] = await Promise.all([
      fetchRowsByIds(
        (chunk) =>
          this.supabase
            .from("product_rules")
            .select(
              "product_id, quantity_min, quantity_max, rate_min, rate_max",
            )
            .in("product_id", chunk),
        ids,
      ).catch((error) => {
        throw new Error(`Unable to load product rules: ${error.message}`);
      }),
      fetchRowsByIds(
        (chunk) =>
          this.supabase
            .from("products")
            .select("id, category, unit_of_measure, hsn_code, product_name")
            .in("id", chunk),
        ids,
      ).catch((error) => {
        throw new Error(`Unable to load products: ${error.message}`);
      }),
    ]);

    const productMap = new Map(
      (products || []).map((product) => [product.id, product]),
    );
    for (const rule of rules || []) {
      const product = productMap.get(rule.product_id);
      if (!product) continue;
      constraints.set(rule.product_id, {
        productId: rule.product_id,
        category: normaliseCategory(product.category),
        unitOfMeasure: String(product.unit_of_measure || ""),
        quantityMin: Number(rule.quantity_min),
        quantityMax: Number(rule.quantity_max),
        rateMin: Number(rule.rate_min),
        rateMax: Number(rule.rate_max),
        hsnCode: product.hsn_code ? String(product.hsn_code) : undefined,
        productName: product.product_name
          ? String(product.product_name)
          : undefined,
      });
    }
  }

  /**
   * Ensures every product ID in the incoming edit payload — including a
   * product being added for the first time on this invoice — has a
   * constraint entry, before normaliseEditedInvoice needs one to build a
   * new line.
   */
  async ensureConstraintsForProducts(
    productIds: string[],
    constraints: Map<string, ProductConstraint>,
  ): Promise<void> {
    await this.loadConstraintsInto(constraints, productIds);
  }

  normaliseEditedInvoice(
    original: PurchaseInvoice,
    update: PurchaseInvoiceUpdate,
    constraints: Map<string, ProductConstraint>,
  ): PurchaseInvoice {
    const originalById = new Map(
      original.products.map((line) => [line.product_id, line]),
    );
    // Every existing line on a purchase invoice shares the same supplier —
    // reuse it for a brand-new line rather than threading batch.supplier_id
    // all the way through.
    const siblingSupplierId = (original.products[0] as any)?.supplier_id;
    const siblingCustomerId = (original.products[0] as any)?.customer_id;
    const seen = new Set<string>();
    const products = update.products.map((input) => {
      if (seen.has(input.product_id))
        throw new Error("Duplicate product lines are not permitted.");
      seen.add(input.product_id);
      const originalLine = originalById.get(input.product_id);
      const constraint = constraints.get(input.product_id);
      if (!constraint) {
        throw new Error(
          `Missing product rule for ${input.product_name || input.product_id}.`,
        );
      }
      const quantity = Number(input.quantity);
      const rate = Number(input.rate);
      if (originalLine) {
        return {
          ...originalLine,
          category: constraint.category,
          unit_of_measure: constraint.unitOfMeasure,
          quantity,
          rate,
          amount: computeLineAmount(quantity, rate),
        };
      }
      // A product being added to this invoice for the first time — build
      // the line from scratch using the product's own master data/rules
      // rather than spreading a nonexistent original.
      return {
        product_id: input.product_id,
        product_name: constraint.productName || input.product_name || "",
        hsn_code: constraint.hsnCode || input.hsn_code || "",
        category: constraint.category,
        unit_of_measure: constraint.unitOfMeasure,
        quantity,
        rate,
        amount: computeLineAmount(quantity, rate),
        customer_id: siblingCustomerId,
        supplier_id: siblingSupplierId,
      } as PurchaseLine;
    });
    if (products.length === 0) {
      throw new Error("Invoice must contain at least one product.");
    }
    return {
      ...original,
      transport_mode: update.transport_mode ?? original.transport_mode,
      vehicle_number: update.vehicle_number ?? original.vehicle_number,
      date_of_supply: update.date_of_supply ?? original.date_of_supply,
      products,
      total_amount: roundMoney(
        products.reduce((sum, line) => sum + line.amount, 0),
      ),
    };
  }

  validateInvoice(
    invoice: PurchaseInvoice,
    context: Pick<
      PurchaseBalanceContext,
      "constraints" | "supplierCategory" | "majorCustomerIds"
    >,
    original?: PurchaseInvoice,
  ) {
    if (!invoice.products.length)
      throw new Error("Invoice must contain at least one product.");
    // Major customer invoices are exempt from the line-count cap — see the
    // matching exemption (and rationale) in FinalValidator.validateSingleInvoice.
    const partyId = (invoice.products?.[0] as any)?.customer_id;
    const isMajorCustomerInvoice =
      !!partyId && context.majorCustomerIds?.has(partyId);
    // Grandfathered: an invoice that already had more than maxInvoiceLines
    // before this edit (e.g. from a generation-time merge bug) must stay
    // editable — only block the count from growing further past whatever
    // it already was. See the matching grandfather in FinalValidator.
    if (
      !isMajorCustomerInvoice &&
      invoice.products.length > BALANCE_LIMITS.maxInvoiceLines &&
      invoice.products.length > (original?.products.length ?? 0)
    ) {
      throw new Error(
        `Purchase invoices may contain at most ${BALANCE_LIMITS.maxInvoiceLines} products.`,
      );
    }
    const originalLinesById = new Map(
      (original?.products || []).map((line) => [line.product_id, line]),
    );
    // Compare new/changed lines against the category this invoice was
    // actually built with (its own stored, untouched lines), not the
    // supplier's live category record. A supplier's category can be
    // re-edited in Masters after invoices were generated against it — that
    // drift shouldn't block adding a product that matches every other line
    // already sitting on this exact invoice.
    const invoiceBaselineCategory =
      original?.products?.[0]?.category !== undefined
        ? normaliseCategory(original.products[0].category)
        : context.supplierCategory;
    const categories = new Set<string>();
    for (const line of invoice.products) {
      const constraint = context.constraints.get(line.product_id);
      if (!constraint)
        throw new Error(
          `Missing product rule for ${line.product_name || line.product_id}.`,
        );
      // Product rules (rate/quantity bounds) can be tightened after an
      // invoice is saved. Lines the user didn't actually touch keep
      // whatever value was already valid at save time — re-checking them
      // against the current bounds would permanently block edits to
      // unrelated fields on old invoices whenever a rule changes.
      const origLine = originalLinesById.get(line.product_id);
      const quantityUnchanged =
        origLine !== undefined &&
        Math.abs(Number(origLine.quantity) - Number(line.quantity)) <
          MONEY_TOLERANCE;
      const rateUnchanged =
        origLine !== undefined &&
        Math.abs(Number(origLine.rate) - Number(line.rate)) < MONEY_TOLERANCE;

      if (
        !quantityUnchanged &&
        !this.isCommercialQuantity(Number(line.quantity), constraint)
      ) {
        throw new Error(
          `Commercial quantity is invalid for ${line.product_name || line.product_id}.`,
        );
      }
      if (
        !rateUnchanged &&
        (!isValidWholeNumber(Number(line.rate)) ||
          Number(line.rate) < constraint.rateMin ||
          Number(line.rate) > constraint.rateMax)
      ) {
        throw new Error(
          `Rate is outside the allowed range for ${line.product_name || line.product_id}.`,
        );
      }
      if (Number(line.amount) <= 0) {
        throw new Error(
          `Line amount must equal quantity × rate for ${line.product_name || line.product_id}.`,
        );
      }
      // Skipped for untouched lines: a newly generated/changed value is
      // always arithmetically exact by construction, so this only matters
      // for lines actually touched. Grandfathers pre-existing rounding
      // drift in older stored data (see FinalValidator for the same logic).
      if (
        (!quantityUnchanged || !rateUnchanged) &&
        Math.abs(
          Number(line.amount) -
            computeLineAmount(Number(line.quantity), Number(line.rate)),
        ) > MONEY_TOLERANCE
      ) {
        throw new Error(
          `Line amount must equal quantity × rate for ${line.product_name || line.product_id}.`,
        );
      }
      // Category is derived live from the product's current master-data
      // category, which (like rate/quantity bounds) can be reclassified
      // after an invoice is saved. Only count lines actually touched by
      // this edit toward the category check — an untouched line's
      // category may have drifted since the invoice was originally saved,
      // and that drift shouldn't block editing an unrelated field.
      if (!quantityUnchanged || !rateUnchanged) {
        categories.add(constraint.category);
      }
    }
    if (categories.size > 1)
      throw new Error("A purchase invoice must contain one category only.");
    if (
      categories.size === 1 &&
      [...categories][0] !== invoiceBaselineCategory
    ) {
      throw new Error(
        `Product category (${[...categories][0]}) does not match this invoice's existing category (${invoiceBaselineCategory}).`,
      );
    }
    const total = roundMoney(
      invoice.products.reduce((sum, line) => sum + Number(line.amount), 0),
    );
    if (total <= 0 || total !== roundMoney(Number(invoice.total_amount))) {
      throw new Error(
        "Invoice total must equal the sum of positive line amounts.",
      );
    }
  }

  validateBatch(invoices: PurchaseInvoice[], expectedTotal: number) {
    const total = roundMoney(
      invoices.reduce((sum, invoice) => sum + Number(invoice.total_amount), 0),
    );
    if (total !== roundMoney(expectedTotal)) {
      throw new Error(
        `Batch total mismatch: expected ₹${roundMoney(expectedTotal).toFixed(2)}, calculated ₹${total.toFixed(2)}.`,
      );
    }
  }

  isCommercialQuantity(quantity: number, constraint: ProductConstraint) {
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity < constraint.quantityMin ||
      quantity > constraint.quantityMax
    )
      return false;
    const uom = constraint.unitOfMeasure.trim().toUpperCase();
    // Weight quantities just need to be a valid quarter-kg increment within
    // range — not restricted to a curated wholesale base list, so manual
    // edits can use any reasonable quantity (e.g. 65kg).
    if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(uom)) {
      return (
        Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
      );
    }
    if (["MT", "TON", "TONNE", "TONNES"].includes(uom)) {
      return (
        Math.abs(quantity * 4 - Math.round(quantity * 4)) < MONEY_TOLERANCE
      );
    }
    return Number.isInteger(quantity);
  }

  commercialQuantities(constraint: ProductConstraint, current: number) {
    const uom = constraint.unitOfMeasure.trim().toUpperCase();
    let values: number[];
    if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(uom)) {
      values = this.weightQuantities(constraint);
    } else if (["MT", "TON", "TONNE", "TONNES"].includes(uom)) {
      const minQuarter = Math.ceil(constraint.quantityMin * 4) / 4;
      const maxQuarter = Math.floor(constraint.quantityMax * 4) / 4;
      values = [];
      for (let value = minQuarter; value <= maxQuarter; value += 0.25)
        values.push(roundMoney(value));
    } else {
      const min = Math.ceil(constraint.quantityMin);
      const max = Math.floor(constraint.quantityMax);
      values = [];
      for (let value = min; value <= max; value++) values.push(value);
    }
    return [
      ...new Set([
        current,
        constraint.quantityMin,
        constraint.quantityMax,
        ...values,
      ]),
    ]
      .filter((value) => this.isCommercialQuantity(value, constraint))
      .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b)
      .slice(0, BALANCE_LIMITS.maxQuantityCandidates);
  }

  private weightQuantities(constraint: ProductConstraint) {
    const values: number[] = [];
    for (
      let value = Math.ceil(constraint.quantityMin * 4) / 4;
      value <= constraint.quantityMax;
      value += 0.25
    )
      values.push(roundMoney(value));
    return values;
  }

  private cloneInvoice(invoice: PurchaseInvoice): PurchaseInvoice {
    return {
      ...invoice,
      products: invoice.products.map((line) => ({ ...line })),
    };
  }
}
