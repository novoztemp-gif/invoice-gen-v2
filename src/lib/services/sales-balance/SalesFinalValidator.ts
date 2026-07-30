import {
  isValidQuarterIncrement,
  isValidWholeNumber,
  roundToQuarterIncrement,
} from "@/lib/utils/quantity-rate-utils";
import { SalesInvoiceValidator } from "./SalesInvoiceValidator";
import {
  roundMoney,
  SalesBalanceContext,
  SalesFinalValidationResult,
  SalesInvoice,
  SalesSolverPlan,
} from "./types";

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
    ];

    // Rule 11 & 12: Validate each affected invoice against single-invoice business rules
    for (const inv of allInvoices) {
      const invValidation = SalesInvoiceValidator.validateInvoice(
        inv,
        context.constraints,
      );
      if (!invValidation.valid && invValidation.message) {
        errors.push(invValidation.message);
      }

      // Rule 3: Product Preservation Check
      const origInv = context.invoices.find((i) => i.id === inv.id);
      if (origInv) {
        for (const p of inv.products) {
          const origLine = origInv.products.find(
            (lp) => lp.product_id === p.product_id,
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

    // Independent Product Redistribution Validation:
    // Verify that products NOT edited on the edited invoice were NOT altered on any balancing invoice
    const origEditedInv = context.invoices.find(
      (i) => i.id === plan.editedInvoice.id,
    );
    const affectedProductIds = new Set<string>();
    const allPids = new Set<string>();

    if (origEditedInv) {
      for (const p of origEditedInv.products) allPids.add(p.product_id);
    }
    for (const p of plan.editedInvoice.products) allPids.add(p.product_id);

    for (const pid of allPids) {
      const origQty =
        origEditedInv?.products.find((p) => p.product_id === pid)?.quantity ||
        0;
      const newQty =
        plan.editedInvoice.products.find((p) => p.product_id === pid)
          ?.quantity || 0;
      if (Math.abs(newQty - origQty) > 0.001) {
        affectedProductIds.add(pid);
      }
    }

    for (const balancingInv of plan.balancingInvoices) {
      const origBalancingInv = context.invoices.find(
        (i) => i.id === balancingInv.id,
      );
      if (origBalancingInv) {
        for (const p of balancingInv.products) {
          if (!affectedProductIds.has(p.product_id)) {
            const origQty =
              origBalancingInv.products.find(
                (lp) => lp.product_id === p.product_id,
              )?.quantity || 0;
            if (Math.abs(p.quantity - origQty) > 0.001) {
              errors.push(
                `Independent Product Redistribution Violation: Unaffected product "${p.product_name || p.product_id}" quantity altered on balancing invoice ${balancingInv.invoice_number} (expected ${origQty}, found ${p.quantity}).`,
              );
            }
          }
        }
      }
    }

    // Rule 11: Validate Exact Batch Total Amount
    const calculatedBatchTotal = roundMoney(
      allInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );

    if (Math.abs(calculatedBatchTotal - context.batchTotal) >= 0.01) {
      errors.push(
        `Batch Total Mismatch: Expected ₹${context.batchTotal.toLocaleString()}, calculated ₹${calculatedBatchTotal.toLocaleString()}.`,
      );
    }

    // Rule 7: Validate Exact Total Sold Quantity per Product across Batch
    const calculatedProductTotals = new Map<string, number>();

    for (const inv of allInvoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          calculatedProductTotals.set(
            p.product_id,
            roundToQuarterIncrement(
              (calculatedProductTotals.get(p.product_id) || 0) + p.quantity,
            ),
          );
        }
      }
    }

    for (const [pid, expectedQty] of context.originalProductTotals.entries()) {
      const calculatedQty = calculatedProductTotals.get(pid) || 0;
      if (Math.abs(calculatedQty - expectedQty) > 0.001) {
        const prodName = context.constraints.get(pid)?.productId || pid;
        errors.push(
          `Batch Total Mismatch: Product quantity total mismatch for product ID ${prodName}: expected ${expectedQty} KG, calculated ${calculatedQty} KG.`,
        );
      }
    }

    // Rule 8: Validate Stock Availability per Date per Product
    if (context.availableStockMap.size > 0) {
      const soldByDateAndProduct = new Map<string, number>();
      for (const inv of allInvoices) {
        const dateStr = inv.invoice_date;
        for (const p of inv.products) {
          if (p.product_id) {
            const key = `${dateStr}_${p.product_id}`;
            soldByDateAndProduct.set(
              key,
              roundToQuarterIncrement(
                (soldByDateAndProduct.get(key) || 0) + p.quantity,
              ),
            );
          }
        }
      }

      for (const [key, soldQty] of soldByDateAndProduct.entries()) {
        const availableStock = context.availableStockMap.get(key);
        if (availableStock !== undefined && soldQty > availableStock + 0.001) {
          const [dateStr, pid] = key.split("_");
          errors.push(
            `Stock Limit Exceeded: Stock allocation exceeds available inventory on ${dateStr} for product ID ${pid}: proposed ${soldQty} KG, available ${availableStock} KG.`,
          );
        }
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
