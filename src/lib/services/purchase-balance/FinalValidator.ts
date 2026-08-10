import {
  computeLineAmount,
  isValidWholeNumber,
} from "@/lib/utils/quantity-rate-utils";
import { CandidateGenerator } from "./CandidateGenerator";
import {
  BALANCE_LIMITS,
  FinalValidationResult,
  MONEY_TOLERANCE,
  normaliseCategory,
  ProductConstraint,
  PurchaseInvoice,
  PurchaseLine,
  roundMoney,
} from "./types";

export class FinalValidator {
  /**
   * Revalidates all invoices, product preservation, commercial rules, and exact batch total.
   * Returns structured validation errors.
   */
  public static validateRebalancedBatch(
    originalInvoices: PurchaseInvoice[],
    plannedInvoices: PurchaseInvoice[],
    expectedBatchTotal: number,
    supplierCategory: string,
    constraints: Map<string, ProductConstraint>,
    editedInvoiceId: string,
    majorCustomerIds: Set<string> = new Set(),
    productConservedInvoiceIds: Set<string> = new Set(),
  ): FinalValidationResult {
    const errors: string[] = [];

    // Positive batch total check
    if (!Number.isFinite(expectedBatchTotal) || expectedBatchTotal <= 0) {
      errors.push("Expected batch total must be a positive number.");
    }

    const originalById = new Map(originalInvoices.map((inv) => [inv.id, inv]));

    // Check count of invoices
    if (plannedInvoices.length !== originalInvoices.length) {
      errors.push(
        "Batch invoice count mismatch between original and planned invoices.",
      );
    }

    let calculatedBatchTotal = 0;

    for (const plannedInv of plannedInvoices) {
      const origInv = originalById.get(plannedInv.id);
      if (!origInv) {
        errors.push(
          `Planned invoice ${plannedInv.invoice_number || plannedInv.id} does not exist in original batch.`,
        );
        continue;
      }

      this.validateSingleInvoice(
        origInv,
        plannedInv,
        supplierCategory,
        constraints,
        errors,
        editedInvoiceId,
        majorCustomerIds,
        productConservedInvoiceIds,
      );
      calculatedBatchTotal = roundMoney(
        calculatedBatchTotal + plannedInv.total_amount,
      );
    }

    // Exact batch total check
    const roundedExpectedBatchTotal = roundMoney(expectedBatchTotal);
    if (
      Math.abs(calculatedBatchTotal - roundedExpectedBatchTotal) >
      MONEY_TOLERANCE
    ) {
      errors.push(
        `Batch total mismatch: expected ₹${roundedExpectedBatchTotal.toFixed(2)}, calculated ₹${calculatedBatchTotal.toFixed(2)}.`,
      );
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Validates line totals, positive values, commercial quantities, rate bounds, product preservation, and category rules for an invoice.
   */
  private static validateSingleInvoice(
    originalInvoice: PurchaseInvoice,
    plannedInvoice: PurchaseInvoice,
    supplierCategory: string,
    constraints: Map<string, ProductConstraint>,
    errors: string[],
    editedInvoiceId: string,
    majorCustomerIds: Set<string>,
    productConservedInvoiceIds: Set<string>,
  ) {
    const invNumber = plannedInvoice.invoice_number || plannedInvoice.id;
    const isEditedInvoice = plannedInvoice.id === editedInvoiceId;
    // Invoices the product-quantity-conservation pass (Stage 1) legitimately
    // added/adjusted a line on to keep some other product's batch-wide total
    // conserved — these are allowed the same product-set flexibility as the
    // directly-edited invoice, since the solver itself never touches them
    // this way (CandidateGenerator only varies existing lines' qty/rate).
    const isProductConservedInvoice = productConservedInvoiceIds.has(
      plannedInvoice.id,
    );
    const allowsProductSetChange = isEditedInvoice || isProductConservedInvoice;
    // Major customer invoices are never part of the balancing solver's
    // combinatorial candidate search (CandidateSolver excludes them
    // entirely), so the maxInvoiceLines cap — which exists purely to bound
    // that search — doesn't need to apply to them. They can also
    // legitimately need far more than 8 lines to reach a large configured
    // amount within realistic per-product rate/quantity limits.
    const partyId = (plannedInvoice.products?.[0] as any)?.customer_id;
    const isMajorCustomerInvoice = !!partyId && majorCustomerIds.has(partyId);

    // 1. Immutable invoice details check
    if (
      plannedInvoice.invoice_number !== originalInvoice.invoice_number ||
      plannedInvoice.invoice_date !== originalInvoice.invoice_date
    ) {
      errors.push(`Immutable header details altered for invoice ${invNumber}.`);
    }

    // 2. Product count and limits
    if (!plannedInvoice.products || plannedInvoice.products.length === 0) {
      errors.push(`Invoice ${invNumber} must contain at least one product.`);
      return;
    }

    if (
      !allowsProductSetChange &&
      plannedInvoice.products.length !== originalInvoice.products.length
    ) {
      errors.push(`Product count is immutable for invoice ${invNumber}.`);
    }

    if (
      !isMajorCustomerInvoice &&
      plannedInvoice.products.length > BALANCE_LIMITS.maxInvoiceLines
    ) {
      errors.push(
        `Invoice ${invNumber} contains ${plannedInvoice.products.length} products, exceeding maximum allowed limit of ${BALANCE_LIMITS.maxInvoiceLines}.`,
      );
    }

    // 3. Positive invoice total
    if (
      !Number.isFinite(plannedInvoice.total_amount) ||
      plannedInvoice.total_amount <= 0
    ) {
      errors.push(
        `Invoice total must be a positive amount for invoice ${invNumber}.`,
      );
    }

    // 4. Product set preservation
    const originalLinesMap = new Map(
      originalInvoice.products.map((line) => [line.product_id, line]),
    );
    // Compare new/changed lines against the category this invoice was
    // actually built with (its own stored, untouched lines), not the
    // supplier's live category record — see the matching note in
    // PurchaseInvoiceValidator.validateInvoice.
    const invoiceBaselineCategory =
      originalInvoice.products?.[0]?.category !== undefined
        ? normaliseCategory(originalInvoice.products[0].category)
        : normaliseCategory(supplierCategory);

    const seenProducts = new Set<string>();
    const invoiceCategories = new Set<string>();
    let calculatedInvoiceTotal = 0;

    for (const line of plannedInvoice.products) {
      if (seenProducts.has(line.product_id)) {
        errors.push(
          `Duplicate product line ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }
      seenProducts.add(line.product_id);

      const origLine = originalLinesMap.get(line.product_id);
      const constraint = constraints.get(line.product_id);
      // A product with no origLine is only legitimate if it's being added
      // for the first time to the invoice actually being edited, or to an
      // invoice the product-quantity-conservation pass legitimately added
      // it to — every other invoice's product set must stay strictly
      // immutable, since the solver itself never adds/removes products from
      // balancing invoices.
      const isNewLineAllowed = !origLine && allowsProductSetChange;

      if (!constraint || (!origLine && !isNewLineAllowed)) {
        errors.push(
          `Product set is immutable; unauthorized product ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
        continue;
      }

      // Check product metadata preservation (nothing to preserve for a
      // brand-new line — there's no prior value to compare against).
      if (
        origLine &&
        ((line.product_name && line.product_name !== origLine.product_name) ||
          (line.hsn_code && line.hsn_code !== origLine.hsn_code) ||
          (line.unit_of_measure &&
            line.unit_of_measure !== origLine.unit_of_measure))
      ) {
        errors.push(
          `Product metadata altered for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Positive value checks
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        errors.push(
          `Quantity must be positive for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }
      if (!Number.isFinite(line.rate) || line.rate <= 0) {
        errors.push(
          `Rate must be positive for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }
      if (!Number.isFinite(line.amount) || line.amount <= 0) {
        errors.push(
          `Line amount must be positive for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Product rule bounds (quantity/rate) can be tightened after an
      // invoice is saved. Lines that weren't actually changed by this edit
      // or by the rebalance solver keep whatever value was already valid
      // at save time — otherwise a rule change would permanently block
      // editing/rebalancing of every older invoice touching that product.
      const quantityUnchanged =
        origLine !== undefined &&
        Math.abs(origLine.quantity - line.quantity) < MONEY_TOLERANCE;
      const rateUnchanged =
        origLine !== undefined &&
        Math.abs(origLine.rate - line.rate) < MONEY_TOLERANCE;

      // Commercial quantity check
      if (
        !quantityUnchanged &&
        !CandidateGenerator.isCommercialQuantity(line.quantity, constraint)
      ) {
        errors.push(
          `Commercial quantity is invalid for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Whole-number rate check
      if (
        !rateUnchanged &&
        (!isValidWholeNumber(line.rate) ||
          line.rate < constraint.rateMin - MONEY_TOLERANCE ||
          line.rate > constraint.rateMax + MONEY_TOLERANCE)
      ) {
        errors.push(
          `Rate is invalid or outside allowed range [${constraint.rateMin}, ${constraint.rateMax}] for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Exact line amount check (quantity × rate rounded to rupee). Any
      // newly generated/changed candidate is arithmetically exact by
      // construction (CandidateGenerator always derives amount this way),
      // so this only ever matters for genuinely touched lines. Skipping it
      // for untouched lines grandfathers pre-existing rounding drift in
      // older stored data — the batch/invoice totals below are summed from
      // the stored `amount` either way, so this drift doesn't affect
      // downstream money correctness, only this line's internal display
      // consistency.
      if (!quantityUnchanged || !rateUnchanged) {
        const expectedAmount = computeLineAmount(line.quantity, line.rate);
        if (Math.abs(line.amount - expectedAmount) > MONEY_TOLERANCE) {
          errors.push(
            `Line amount must equal quantity × rate for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
          );
        }
      }

      calculatedInvoiceTotal += line.amount;
      // Category is derived live from the product's current master-data
      // category, which (like rate/quantity bounds) can be reclassified
      // after an invoice is saved. Only count lines actually touched by
      // this edit/rebalance toward the category check — an untouched
      // line's category may have drifted from what it was when the
      // invoice was originally validated, and that drift shouldn't block
      // editing an unrelated field or rebalancing other invoices.
      if (!quantityUnchanged || !rateUnchanged) {
        invoiceCategories.add(normaliseCategory(constraint.category));
      }
    }

    // Invoice total sum check
    calculatedInvoiceTotal = roundMoney(calculatedInvoiceTotal);
    if (
      Math.abs(
        calculatedInvoiceTotal - roundMoney(plannedInvoice.total_amount),
      ) > MONEY_TOLERANCE
    ) {
      errors.push(
        `Invoice total must equal the sum of line amounts for invoice ${invNumber}.`,
      );
    }

    // Category homogeneity check (only meaningful when at least one line
    // actually changed — see grandfathering note above).
    if (invoiceCategories.size > 1) {
      errors.push(
        `Invoice ${invNumber} contains products from multiple categories.`,
      );
    } else if (invoiceCategories.size === 1) {
      const invoiceCategory = Array.from(invoiceCategories)[0];
      if (invoiceBaselineCategory !== invoiceCategory) {
        errors.push(
          `Product category (${invoiceCategory}) does not match invoice ${invNumber}'s existing category (${invoiceBaselineCategory}).`,
        );
      }
    }
  }
}
