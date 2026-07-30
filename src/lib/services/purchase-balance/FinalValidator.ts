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
  ) {
    const invNumber = plannedInvoice.invoice_number || plannedInvoice.id;

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

    if (plannedInvoice.products.length !== originalInvoice.products.length) {
      errors.push(`Product count is immutable for invoice ${invNumber}.`);
    }

    if (plannedInvoice.products.length > BALANCE_LIMITS.maxInvoiceLines) {
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

      if (!origLine || !constraint) {
        errors.push(
          `Product set is immutable; unauthorized product ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
        continue;
      }

      // Check product metadata preservation
      if (
        (line.product_name && line.product_name !== origLine.product_name) ||
        (line.hsn_code && line.hsn_code !== origLine.hsn_code) ||
        (line.unit_of_measure &&
          line.unit_of_measure !== origLine.unit_of_measure)
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

      // Commercial quantity check
      if (!CandidateGenerator.isCommercialQuantity(line.quantity, constraint)) {
        errors.push(
          `Commercial quantity is invalid for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Whole-number rate check
      if (
        !isValidWholeNumber(line.rate) ||
        line.rate < constraint.rateMin - MONEY_TOLERANCE ||
        line.rate > constraint.rateMax + MONEY_TOLERANCE
      ) {
        errors.push(
          `Rate is invalid or outside allowed range [${constraint.rateMin}, ${constraint.rateMax}] for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      // Exact line amount check (quantity × rate rounded to rupee)
      const expectedAmount = computeLineAmount(line.quantity, line.rate);
      if (Math.abs(line.amount - expectedAmount) > MONEY_TOLERANCE) {
        errors.push(
          `Line amount must equal quantity × rate for ${line.product_name || line.product_id} on invoice ${invNumber}.`,
        );
      }

      calculatedInvoiceTotal += line.amount;
      invoiceCategories.add(normaliseCategory(constraint.category));
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

    // Category homogeneity check
    if (invoiceCategories.size !== 1) {
      errors.push(
        `Invoice ${invNumber} contains products from multiple categories.`,
      );
    } else {
      const invoiceCategory = Array.from(invoiceCategories)[0];
      if (normaliseCategory(supplierCategory) !== invoiceCategory) {
        errors.push(
          `Supplier category (${supplierCategory}) is incompatible with invoice category (${invoiceCategory}) for invoice ${invNumber}.`,
        );
      }
    }
  }
}
