import {
  isValidQuarterIncrement,
  isValidWholeNumber,
  roundToQuarterIncrement,
} from "@/lib/utils/quantity-rate-utils";
import { diffEditedProductIds } from "./SalesLineCapacity";
import { SalesInvoiceValidator } from "./SalesInvoiceValidator";
import {
  roundMoney,
  SalesBalanceContext,
  SalesFinalValidationResult,
  SalesInvoice,
  SalesSolverPlan,
} from "./types";

// A product can legitimately appear more than once on the same invoice
// (e.g. two lines for the same product under different customers/rates).
// Matching "the original line for this product" by product_id alone always
// grabs the FIRST occurrence, so comparing a later duplicate line against
// it produces a false mismatch even when that later line never changed.
// Occurrence order for a given product_id is preserved end-to-end (unaffected
// duplicate lines are never reordered), so matching the Nth occurrence in the
// candidate against the Nth occurrence in the original is correct.
function findNthByProductId<T extends { product_id: string }>(
  lines: T[],
  productId: string,
  occurrenceIndex: number,
): T | undefined {
  let seen = 0;
  for (const line of lines) {
    if (line.product_id === productId) {
      if (seen === occurrenceIndex) return line;
      seen++;
    }
  }
  return undefined;
}

export class SalesFinalValidator {
  /**
   * Comprehensive pre-persistence validation of an entire rebalanced Sales batch plan.
   */
  public static validateRebalancedBatch(
    context: SalesBalanceContext,
    plan: SalesSolverPlan,
  ): SalesFinalValidationResult {
    const errors: string[] = [];
    const allInvoices: SalesInvoice[] = [
      plan.editedInvoice,
      ...plan.balancingInvoices,
      ...(plan.newInvoices || []),
    ];

    // Rule 11 & 12: Validate each affected invoice against single-invoice business rules
    for (const inv of allInvoices) {
      // New invoices have no pre-edit counterpart — origInv stays undefined,
      // which validateInvoice already treats as "nothing to preserve".
      const origInv = context.invoices.find((i) => i.id === inv.id);
      const invValidation = SalesInvoiceValidator.validateInvoice(
        inv,
        context.constraints,
        origInv,
      );
      if (!invValidation.valid && invValidation.message) {
        errors.push(invValidation.message);
      }

      // Maximum Invoice Amount: the edit must never PUSH an invoice further
      // over the configured limit than it already was (a brand-new invoice
      // has no "already was", so it's held to the limit outright). An
      // invoice that was already over the limit before this edit — from
      // generation, before this session's amount-range fixes — is left
      // alone here rather than blocking every future edit to it forever;
      // it just can't get worse.
      const thresholdMax = context.thresholdMax || 0;
      if (thresholdMax > 0) {
        const origTotal = origInv ? origInv.total_amount : 0;
        if (
          inv.total_amount > thresholdMax + 0.01 &&
          inv.total_amount > origTotal + 0.01
        ) {
          errors.push(
            `Maximum Invoice Amount Exceeded: Invoice ${inv.invoice_number} total (₹${inv.total_amount}) exceeds the batch's maximum invoice amount (₹${thresholdMax}).`,
          );
        }
      }

      // Rule 3: Product Preservation Check
      if (origInv) {
        const occurrenceSeen = new Map<string, number>();
        for (const p of inv.products) {
          const occurrenceIndex = occurrenceSeen.get(p.product_id) || 0;
          occurrenceSeen.set(p.product_id, occurrenceIndex + 1);
          const origLine = findNthByProductId(
            origInv.products,
            p.product_id,
            occurrenceIndex,
          );
          if (origLine) {
            if (
              p.hsn_code &&
              origLine.hsn_code &&
              p.hsn_code !== origLine.hsn_code
            ) {
              errors.push(
                `Invalid HSN: HSN code altered for ${p.product_name || p.product_id} on invoice ${inv.invoice_number}. Expected ${origLine.hsn_code}, found ${p.hsn_code}.`,
              );
            }
            if (
              p.unit_of_measure &&
              origLine.unit_of_measure &&
              p.unit_of_measure !== origLine.unit_of_measure
            ) {
              errors.push(
                `Product Rule Violation: Unit of measure altered for ${p.product_name || p.product_id} on invoice ${inv.invoice_number}.`,
              );
            }
          }
        }
      }
    }

    // Balancing is no longer restricted to moving only the directly-edited
    // product — closing a batch-total residual can also nudge OTHER
    // products' quantity/rate on balancing invoices (e.g. when the edited
    // product alone doesn't have enough rate headroom to close a large
    // money gap). The one thing that still can never happen is any
    // product's OWN batch-wide total quantity actually changing — that's
    // enforced exactly below (Rule 7, now checked for every product that
    // appears on a touched invoice, not just the directly-edited one), so a
    // per-invoice "did this specific line change" check here would just
    // reject legitimate, fully-conserving redistribution.
    const origEditedInv = context.invoices.find(
      (i) => i.id === plan.editedInvoice.id,
    );
    const affectedProductIds = diffEditedProductIds(
      origEditedInv?.products,
      plan.editedInvoice.products,
    );

    // Rule 11: Validate Exact Batch Total Amount. `allInvoices` is only the
    // small subset actually touched by this edit (edited + balancing + any
    // new invoices) — every other invoice in the batch is untouched and
    // contributes a fixed amount to context.batchTotal that this subset
    // was never responsible for. What the subset must sum to is whatever
    // the edited invoice + balancing invoices ORIGINALLY summed to (new
    // invoices had no original contribution at all).
    const originalEditedTotalForRule11 = origEditedInv
      ? origEditedInv.total_amount
      : 0;
    const originalSubsetTotalForRule11 = plan.balancingInvoices.reduce(
      (sum, inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        return sum + (orig ? orig.total_amount : 0);
      },
      0,
    );
    const requiredCombinedTotal =
      originalEditedTotalForRule11 + originalSubsetTotalForRule11;

    const calculatedBatchTotal = roundMoney(
      allInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );

    if (Math.abs(calculatedBatchTotal - requiredCombinedTotal) >= 0.01) {
      errors.push(
        `Batch Total Mismatch: Expected ₹${requiredCombinedTotal.toLocaleString()}, calculated ₹${calculatedBatchTotal.toLocaleString()}.`,
      );
    }

    // Rule 7: Validate Exact Total Sold Quantity per Product. Checked for
    // EVERY product that appears anywhere on a touched invoice — not just
    // affectedProductIds — since balancing is now free to use any product
    // as a lever to close a residual, not only the directly-edited one.
    // context.originalProductTotals is a batch-WIDE total; comparing a
    // product's batch-wide total against a sum accumulated only from
    // `allInvoices` (the touched subset) would show a phantom mismatch for
    // any product that happens to also appear elsewhere in the batch on an
    // UNTOUCHED invoice — so only products that were touched at all this
    // run (i.e. appear in the touched subset) are checked; an untouched
    // product's contribution outside this subset is unaffected by
    // definition and doesn't need re-proving here.
    const calculatedProductTotals = new Map<string, number>();
    const touchedProductIds = new Set<string>(affectedProductIds);

    for (const inv of allInvoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          touchedProductIds.add(p.product_id);
          calculatedProductTotals.set(
            p.product_id,
            roundToQuarterIncrement(
              (calculatedProductTotals.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
      }
    }
    for (const inv of [origEditedInv, ...plan.balancingInvoices.map((b) => context.invoices.find((i) => i.id === b.id))]) {
      for (const p of inv?.products || []) {
        if (p.product_id) touchedProductIds.add(p.product_id);
      }
    }

    // `allInvoices` covers every NON-major-customer invoice this run could
    // touch (balancing is scoped to the whole batch minus major-customer
    // invoices) — but major-customer invoices are never part of that
    // subset, so a product's batch-wide expected total must still credit
    // whatever quantity sits on THOSE untouched invoices before comparing.
    const majorCustomerQtyByPid = new Map<string, number>();
    for (const inv of context.invoices) {
      const partyId = inv.products?.[0]?.customer_id;
      if (!partyId || !context.majorCustomerIds.has(partyId)) continue;
      for (const p of inv.products) {
        if (!p.product_id) continue;
        majorCustomerQtyByPid.set(
          p.product_id,
          roundToQuarterIncrement(
            (majorCustomerQtyByPid.get(p.product_id) || 0) + p.quantity,
          ),
        );
      }
    }

    for (const pid of touchedProductIds) {
      const expectedQty = roundToQuarterIncrement(
        (context.originalProductTotals.get(pid) || 0) -
          (majorCustomerQtyByPid.get(pid) || 0),
      );
      const calculatedQty = calculatedProductTotals.get(pid) || 0;
      if (Math.abs(calculatedQty - expectedQty) > 0.001) {
        const prodName = context.constraints.get(pid)?.productId || pid;
        errors.push(
          `Batch Total Mismatch: Product quantity total mismatch for product ID ${prodName}: expected ${expectedQty} KG, calculated ${calculatedQty} KG.`,
        );
      }
    }

    // Rule 8 (per-date stock availability) intentionally removed: once a
    // batch is generated, the daily_stock_ledger's day-by-day breakdown is
    // no longer enforced as a rebalancing constraint — a product can be
    // freely redistributed to any date/invoice in the batch. Rule 7 above
    // still enforces the one invariant that DOES still matter: the
    // product's TOTAL quantity across the whole batch stays exact.

    // Rule 9: batch-wide sold quantity must never exceed what was actually
    // purchased for that product, ignoring date entirely. Historical
    // over-ceiling data from before this edit (e.g. a pre-existing
    // generation-time issue) is left exactly as-is — untouched products, or
    // a product whose total this run leaves unchanged, are never rejected
    // over it, so old data never gets "fixed" by force. But the moment a
    // product's total actually CHANGES this run — whether it's the product
    // the user directly edited, or one used as a money-balancing lever — the
    // resulting total must land at or under the real purchased ceiling, full
    // stop. No grandfathering for a fresh change: "already over before" is
    // not an excuse to add even more.
    for (const pid of touchedProductIds) {
      const ceiling = context.totalPurchasedByProduct.get(pid);
      if (ceiling === undefined) continue;
      const calculatedQty = calculatedProductTotals.get(pid) || 0;
      const priorQty = context.originalProductTotals.get(pid) || 0;
      const quantityChangedThisRun = Math.abs(calculatedQty - priorQty) > 0.001;
      if (calculatedQty > ceiling + 0.01 && quantityChangedThisRun) {
        const prodName = context.constraints.get(pid)?.productId || pid;
        errors.push(
          `Overstock Error: Product ID ${prodName} total sold (${calculatedQty} KG) would exceed total purchased (${ceiling} KG).`,
        );
      }
    }

    console.log("[SalesFinalValidator] Validation Execution Result:", {
      valid: errors.length === 0,
      totalErrors: errors.length,
      failedInvariants: errors.length > 0 ? errors : ["None (All Invariants Satisfied)"]
    });

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }
}
