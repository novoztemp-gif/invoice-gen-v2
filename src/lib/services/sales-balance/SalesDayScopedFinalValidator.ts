import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";
import { SalesInvoiceValidator } from "./SalesInvoiceValidator";
import {
  roundMoney,
  SalesBalanceContext,
  SalesFinalValidationResult,
  SalesInvoice,
  SalesSolverPlan,
} from "./types";

/**
 * Narrower sibling of SalesFinalValidator, for the day-scoped edit model.
 * Cannot reuse SalesFinalValidator directly: its Rule 7 demands every
 * touched product's batch-wide quantity total stay byte-identical to what
 * it was before the edit — exactly the invariant this new model
 * intentionally breaks for the edited product(s) (a day-capped increase
 * genuinely adds to that product's batch total; an unreused decrease
 * genuinely removes from it). What must still hold, unconditionally: the
 * batch's grand total never moves, every OTHER product's batch-wide
 * quantity stays exact, and no invoice is pushed further outside its
 * amount bounds than it already was.
 */
export class SalesDayScopedFinalValidator {
  public static validate(
    context: SalesBalanceContext,
    plan: SalesSolverPlan,
    editedProductIds: Set<string>,
  ): SalesFinalValidationResult {
    const errors: string[] = [];
    const touchedInvoices: SalesInvoice[] = [
      plan.editedInvoice,
      ...plan.balancingInvoices,
    ];

    const origEditedInv = context.invoices.find(
      (i) => i.id === plan.editedInvoice.id,
    );

    // 1 & 2: per-invoice business rules + threshold grandfather rule
    // (never push an invoice further past thresholdMin/thresholdMax than it
    // already was), mirroring SalesFinalValidator.ts:97-141 exactly.
    const thresholdMax = context.thresholdMax || 0;
    const thresholdMin = context.thresholdMin || 0;
    for (const inv of touchedInvoices) {
      const origInv = context.invoices.find((i) => i.id === inv.id);

      const invValidation = SalesInvoiceValidator.validateInvoice(
        inv,
        context.constraints,
        origInv,
      );
      if (!invValidation.valid && invValidation.message) {
        errors.push(invValidation.message);
      }

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

      if (thresholdMin > 0) {
        const origTotal = origInv ? origInv.total_amount : Infinity;
        if (
          inv.total_amount < thresholdMin - 0.01 &&
          inv.total_amount < origTotal - 0.01
        ) {
          errors.push(
            `Minimum Invoice Amount Violation: Invoice ${inv.invoice_number} total (₹${inv.total_amount}) is below the batch's minimum invoice amount (₹${thresholdMin}).`,
          );
        }
      }
    }

    // 3: Grand-total conservation over the touched subset only — every
    // other invoice in the batch is untouched and contributes a fixed
    // amount that this edit was never responsible for.
    const originalTouchedTotal = roundMoney(
      touchedInvoices.reduce((sum, inv) => {
        const orig = context.invoices.find((i) => i.id === inv.id);
        return sum + (orig ? orig.total_amount : 0);
      }, 0),
    );
    const newTouchedTotal = roundMoney(
      touchedInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );
    if (Math.abs(newTouchedTotal - originalTouchedTotal) >= 0.01) {
      errors.push(
        `Batch Total Mismatch: Expected ₹${originalTouchedTotal.toLocaleString()}, calculated ₹${newTouchedTotal.toLocaleString()}.`,
      );
    }

    // 4: Every product OTHER than the edited one(s) must keep an exactly
    // conserved quantity across the touched subset — a rate-nudge only ever
    // moves that product's quantity between two touched invoices, never
    // changes its total.
    const newQtyByPid = new Map<string, number>();
    for (const inv of touchedInvoices) {
      for (const p of inv.products) {
        if (!p.product_id) continue;
        newQtyByPid.set(
          p.product_id,
          roundToQuarterIncrement(
            (newQtyByPid.get(p.product_id) || 0) + p.quantity,
          ),
        );
      }
    }
    const origQtyByPid = new Map<string, number>();
    for (const inv of touchedInvoices) {
      const orig = context.invoices.find((i) => i.id === inv.id);
      for (const p of orig?.products || []) {
        if (!p.product_id) continue;
        origQtyByPid.set(
          p.product_id,
          roundToQuarterIncrement(
            (origQtyByPid.get(p.product_id) || 0) + p.quantity,
          ),
        );
      }
    }
    const allTouchedPids = new Set([
      ...newQtyByPid.keys(),
      ...origQtyByPid.keys(),
    ]);
    for (const pid of allTouchedPids) {
      if (editedProductIds.has(pid)) continue;
      const newQty = newQtyByPid.get(pid) || 0;
      const origQty = origQtyByPid.get(pid) || 0;
      if (Math.abs(newQty - origQty) > 0.001) {
        errors.push(
          `Batch Total Mismatch: Product quantity total mismatch for product ID ${pid}: expected ${origQty} KG, calculated ${newQty} KG.`,
        );
      }
    }

    // 5: Overstock ceiling cross-check for the edited product(s) — the only
    // ones whose batch-wide total genuinely changed this run.
    for (const pid of editedProductIds) {
      const ceiling = context.totalPurchasedByProduct.get(pid);
      if (ceiling === undefined) continue;
      const priorQty = context.originalProductTotals.get(pid) || 0;
      const editedInvOldQty =
        origEditedInv?.products
          .filter((p) => p.product_id === pid)
          .reduce((s, p) => s + p.quantity, 0) || 0;
      const editedInvNewQty = plan.editedInvoice.products
        .filter((p) => p.product_id === pid)
        .reduce((s, p) => s + p.quantity, 0);
      const newBatchQty = roundToQuarterIncrement(
        priorQty - editedInvOldQty + editedInvNewQty,
      );
      if (newBatchQty > ceiling + 0.01) {
        errors.push(
          `Overstock Error: Product ID ${pid} total sold (${newBatchQty} KG) would exceed total purchased (${ceiling} KG).`,
        );
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }
    return { valid: true };
  }
}
