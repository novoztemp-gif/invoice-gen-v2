import {
  computeLineAmount,
  roundToQuarterIncrement,
} from "@/lib/utils/quantity-rate-utils";
import {
  roundMoney,
  SALES_BALANCE_LIMITS,
  SalesBalanceContext,
  SalesInvoice,
  SalesLine,
  SalesSolverPlan,
} from "./types";

export class SalesResidualRepair {
  /**
   * Attempts exact residual repair to close remaining batch amount and product quantity deltas.
   */
  public static repairResidual(
    context: SalesBalanceContext,
    plan: SalesSolverPlan,
  ): SalesSolverPlan | null {
    // 1. Calculate remaining amount delta
    const currentTotalAmount = roundMoney(
      plan.editedInvoice.total_amount +
        plan.balancingInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
    );

    const amountResidual = roundMoney(context.batchTotal - currentTotalAmount);

    // Diagnostic values calculation
    const origEditedInv = context.invoices.find((i) => i.id === plan.editedInvoice.id);
    const origEditedAmt = origEditedInv ? origEditedInv.total_amount : 0;
    const editDelta = roundMoney(plan.editedInvoice.total_amount - origEditedAmt);

    const balancingProductIds = new Set<string>();
    let totalEditableQty = 0;
    let totalBalancingCapacity = 0;

    for (const inv of plan.balancingInvoices) {
      for (const p of inv.products) {
        if (p.product_id) {
          balancingProductIds.add(p.product_id);
          totalEditableQty += p.quantity;
          const maxStock = context.originalProductTotals?.get(p.product_id) ?? p.quantity;
          const rate = p.rate || 1;
          totalBalancingCapacity += Math.max(0, maxStock - p.quantity) * rate;
        }
      }
    }

    console.log("[SalesResidualRepair] INPUT:", {
      inputBatchDelta: amountResidual,
      planBatchDelta: plan.batchDelta,
      productDeltas: Object.fromEntries(plan.productDeltas.entries()),
    });

    console.log("=== AUTO BALANCE ENGINE DIAGNOSTIC LOGS ===");
    console.log("1. Original Batch Total:                  ", context.batchTotal);
    console.log("2. Current Batch Total after edit:        ", currentTotalAmount);
    console.log("3. Edited Invoice Original Amount:        ", origEditedAmt);
    console.log("4. Edited Invoice New Amount:             ", plan.editedInvoice.total_amount);
    console.log("5. Calculated Edit Delta:                 ", editDelta);
    console.log("6. Total Remaining Balancing Capacity:    ", totalBalancingCapacity);
    console.log("7. Remaining Drift entering Repair:       ", amountResidual);
    console.log("9. Number of balancing invoices:          ", plan.balancingInvoices.length);
    console.log("10. Number of balancing products:         ", balancingProductIds.size);
    console.log("11. Total editable quantity available:    ", totalEditableQty);
    console.log("===========================================");

    // 2. Calculate remaining product quantity residuals
    const productResiduals = new Map<string, number>();
    let hasQuantityResidual = false;

    for (const [pid, targetQty] of context.originalProductTotals.entries()) {
      let currentQty =
        plan.editedInvoice.products.find((p) => p.product_id === pid)
          ?.quantity || 0;
      for (const inv of plan.balancingInvoices) {
        currentQty +=
          inv.products.find((p) => p.product_id === pid)?.quantity || 0;
      }
      const qtyDiff = roundToQuarterIncrement(targetQty - currentQty);
      productResiduals.set(pid, qtyDiff);

      if (Math.abs(qtyDiff) > 0.001) {
        hasQuantityResidual = true;
      }
    }

    // If both amount and quantity residuals are already exact 0, return plan as-is
    if (Math.abs(amountResidual) < 0.01 && !hasQuantityResidual) {
      return plan;
    }

    if (plan.balancingInvoices.length === 0) {
      return null; // Cannot repair without balancing invoices
    }

    // Target candidate invoices for repair (up to last 3 invoices)
    const repairInvoices = plan.balancingInvoices.slice(
      -SALES_BALANCE_LIMITS.residualInvoiceCount,
    );
    const unmodifiedInvoices = plan.balancingInvoices.slice(
      0,
      plan.balancingInvoices.length - repairInvoices.length,
    );

    // Bounded search over repair invoices
    const repairedCandidates = this.searchResidualCombinations(
      repairInvoices,
      amountResidual,
      productResiduals,
      context,
    );

    let updatedBalancing = plan.balancingInvoices;

    if (repairedCandidates) {
      updatedBalancing = [...unmodifiedInvoices, ...repairedCandidates];
    } else {
      // Deterministic direct rebalancing fallback: absorb exact monetary residual across balancing invoices
      const adjustedBalancingInvoices = JSON.parse(
        JSON.stringify(plan.balancingInvoices),
      );

      const targetBalancingSum = roundMoney(
        context.batchTotal - plan.editedInvoice.total_amount,
      );

      const currentBalancingSum = roundMoney(
        adjustedBalancingInvoices.reduce(
          (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
          0,
        ),
      );

      let deltaToDistribute = roundMoney(
        targetBalancingSum - currentBalancingSum,
      );

      if (
        Math.abs(deltaToDistribute) >= 0.01 &&
        adjustedBalancingInvoices.length > 0
      ) {
        const perInvoiceDelta =
          deltaToDistribute / adjustedBalancingInvoices.length;

        for (let i = 0; i < adjustedBalancingInvoices.length; i++) {
          const inv = adjustedBalancingInvoices[i];
          if (!inv.products || inv.products.length === 0) continue;

          const isLast = i === adjustedBalancingInvoices.length - 1;
          const targetInvTotal = isLast
            ? roundMoney(
                targetBalancingSum -
                  adjustedBalancingInvoices
                    .slice(0, -1)
                    .reduce(
                      (s: number, b: any) =>
                        s + Math.round(b.total_amount || 0),
                      0,
                    ),
              )
            : roundMoney(inv.total_amount + perInvoiceDelta);

          const invDelta = targetInvTotal - inv.total_amount;
          if (Math.abs(invDelta) >= 0.01 && inv.products.length > 0) {
            // Select product line with greatest monetary adjustment flexibility
            const sortedLines = [...inv.products].sort(
              (a, b) => (b.quantity || 0) * (b.rate || 0) - (a.quantity || 0) * (a.rate || 0),
            );

            for (const targetLine of sortedLines) {
              const pid = targetLine.product_id;
              const maxStock = context.originalProductTotals?.get(pid) ?? Number.POSITIVE_INFINITY;
              const currentRate = Math.max(1, Number(targetLine.rate) || 1);

              // Calculate candidate quantity adjustments (floor and ceil 0.25 steps around ideal delta)
              const idealDelta = invDelta / currentRate;
              const q1 = roundToQuarterIncrement(Math.max(0, targetLine.quantity + Math.floor(idealDelta / 0.25) * 0.25));
              const q2 = roundToQuarterIncrement(Math.max(0, targetLine.quantity + Math.ceil(idealDelta / 0.25) * 0.25));

              const candidates = [targetLine.quantity, q1, q2].filter((q) => q >= 0 && q <= maxStock);

              let bestQty = targetLine.quantity;
              let minErr = Math.abs(invDelta);

              for (const testQty of candidates) {
                const testAmt = Math.round(testQty * currentRate);
                const otherAmtSum = inv.products
                  .filter((p: any) => p !== targetLine)
                  .reduce((s: number, p: any) => s + Math.round(p.amount || 0), 0);
                const testInvTotal = otherAmtSum + testAmt;
                const testErr = Math.abs(targetInvTotal - testInvTotal);

                if (testErr < minErr - 0.001) {
                  minErr = testErr;
                  bestQty = testQty;
                }
              }

              targetLine.quantity = bestQty;
              targetLine.amount = Math.round(targetLine.quantity * currentRate);
              if (minErr < 0.01) break; // Exact match found
            }

            inv.total_amount = Math.round(
              inv.products.reduce(
                (s: number, p: any) => s + Math.round(p.amount || 0),
                0,
              ),
            );
          }
        }

        // Final exact tie-breaking: pick line item quantity adjustment that minimizes absolute error while respecting stock bounds
        const finalBalancingSum = roundMoney(
          adjustedBalancingInvoices.reduce(
            (sum: number, inv: any) => sum + Math.round(inv.total_amount || 0),
            0,
          ),
        );
        const finalRupeeDiff = roundMoney(
          targetBalancingSum - finalBalancingSum,
        );

        if (
          Math.abs(finalRupeeDiff) >= 0.01 &&
          adjustedBalancingInvoices.length > 0
        ) {
          const lastInv =
            adjustedBalancingInvoices[adjustedBalancingInvoices.length - 1];
          if (lastInv.products && lastInv.products.length > 0) {
            const sortedLines = [...lastInv.products].sort(
              (a, b) => (a.rate || 0) - (b.rate || 0), // Prefer lower rate items for fine rupee adjustments
            );

            for (const targetLine of sortedLines) {
              const pid = targetLine.product_id;
              const maxStock = context.originalProductTotals?.get(pid) ?? Number.POSITIVE_INFINITY;
              const currentRate = Math.max(1, Number(targetLine.rate) || 1);

              const idealDelta = finalRupeeDiff / currentRate;
              const q1 = roundToQuarterIncrement(Math.max(0, targetLine.quantity + Math.floor(idealDelta / 0.25) * 0.25));
              const q2 = roundToQuarterIncrement(Math.max(0, targetLine.quantity + Math.ceil(idealDelta / 0.25) * 0.25));

              const candidates = [targetLine.quantity, q1, q2].filter((q) => q >= 0 && q <= maxStock);

              let bestQty = targetLine.quantity;
              let minErr = Math.abs(finalRupeeDiff);

              for (const testQty of candidates) {
                const testAmt = Math.round(testQty * currentRate);
                const otherAmtSum = lastInv.products
                  .filter((p: any) => p !== targetLine)
                  .reduce((s: number, p: any) => s + Math.round(p.amount || 0), 0);
                const testInvTotal = otherAmtSum + testAmt;
                const currentLastInvTarget = targetBalancingSum - adjustedBalancingInvoices.slice(0, -1).reduce((s: number, b: any) => s + Math.round(b.total_amount || 0), 0);
                const testErr = Math.abs(currentLastInvTarget - testInvTotal);

                if (testErr < minErr - 0.001) {
                  minErr = testErr;
                  bestQty = testQty;
                }
              }

              targetLine.quantity = bestQty;
              targetLine.amount = Math.round(targetLine.quantity * currentRate);

              lastInv.total_amount = Math.round(
                lastInv.products.reduce(
                  (s: number, p: any) => s + Math.round(p.amount || 0),
                  0,
                ),
              );

              if (minErr < 0.01) break;
            }
          }
        }
      }

      updatedBalancing = adjustedBalancingInvoices;
    }

    const finalProductDeltas = new Map<string, number>();
    for (const pid of context.originalProductTotals.keys()) {
      finalProductDeltas.set(pid, 0);
    }

    const finalTotalAmt = roundMoney(
      plan.editedInvoice.total_amount +
        updatedBalancing.reduce((sum: number, inv: any) => sum + Math.round(inv.total_amount || 0), 0),
    );
    const amountResidualLeaving = roundMoney(context.batchTotal - finalTotalAmt);
    console.log("8. Remaining Drift leaving Repair:        ", amountResidualLeaving);

    const repairSuccess = amountResidualLeaving === 0;
    console.log("[SalesResidualRepair] OUTPUT:", {
      outputBatchDelta: amountResidualLeaving,
      repairSuccess,
      repairFailureReason: repairSuccess
        ? "None (Repair Succeeded)"
        : `Non-zero residual drift of ₹${amountResidualLeaving} remaining after repair`
    });

    return {
      editedInvoice: plan.editedInvoice,
      balancingInvoices: updatedBalancing,
      totalCost: plan.totalCost,
      batchDelta: amountResidualLeaving,
      productDeltas: finalProductDeltas,
    };
  }

  private static searchResidualCombinations(
    invoices: SalesInvoice[],
    targetAmountResidual: number,
    targetQtyResiduals: Map<string, number>,
    context: SalesBalanceContext,
  ): SalesInvoice[] | null {
    let combinationsTried = 0;
    let solutionFound: SalesInvoice[] | null = null;

    const explore = (
      invoiceIdx: number,
      currentInvoices: SalesInvoice[],
    ): boolean => {
      if (invoiceIdx === invoices.length) {
        combinationsTried++;
        if (combinationsTried > SALES_BALANCE_LIMITS.maxResidualCombinations) {
          return false;
        }

        // Check if current combination closes all residuals
        const currentAmountSum = roundMoney(
          currentInvoices.reduce((sum, inv) => sum + inv.total_amount, 0),
        );
        const expectedAmountSum = roundMoney(
          invoices.reduce((sum, inv) => sum + inv.total_amount, 0) +
            targetAmountResidual,
        );

        if (Math.abs(currentAmountSum - expectedAmountSum) >= 0.01) {
          return false;
        }

        // Check quantity residuals
        for (const [pid, reqQtyDiff] of targetQtyResiduals.entries()) {
          let origSum = 0;
          let currentSum = 0;
          for (let k = 0; k < invoices.length; k++) {
            origSum +=
              invoices[k].products.find((p) => p.product_id === pid)
                ?.quantity || 0;
            currentSum +=
              currentInvoices[k].products.find((p) => p.product_id === pid)
                ?.quantity || 0;
          }
          const actualDiff = roundToQuarterIncrement(currentSum - origSum);
          if (Math.abs(actualDiff - reqQtyDiff) > 0.001) {
            return false;
          }
        }

        solutionFound = currentInvoices;
        return true;
      }

      const inv = invoices[invoiceIdx];
      // Generate small adjustments to lines in inv
      const adjustedInvoiceVariations = this.generateInvoiceVariations(
        inv,
        context,
      );

      for (const varInv of adjustedInvoiceVariations) {
        if (explore(invoiceIdx + 1, [...currentInvoices, varInv])) {
          return true;
        }
      }

      return false;
    };

    explore(0, []);
    return solutionFound;
  }

  private static generateInvoiceVariations(
    invoice: SalesInvoice,
    context: SalesBalanceContext,
  ): SalesInvoice[] {
    const variations: SalesInvoice[] = [invoice]; // Always include unchanged invoice

    for (const p of invoice.products) {
      const uom = p.unit_of_measure || "kg";
      const isWeight =
        uom.toLowerCase().includes("kg") || uom.toLowerCase().includes("ton");
      const step = isWeight ? 0.25 : 1;

      // Small quantity variations
      const qtyOptions = [
        roundToQuarterIncrement(p.quantity - step),
        roundToQuarterIncrement(p.quantity + step),
      ].filter((q) => q >= 0);

      // Small rate variations
      const rateOptions = [p.rate - 1, p.rate + 1].filter((r) => r >= 1);

      for (const q of qtyOptions) {
        const newProducts = invoice.products.map((line) =>
          line.product_id === p.product_id
            ? { ...line, quantity: q, amount: computeLineAmount(q, line.rate) }
            : line,
        );
        const newTotal = roundMoney(
          newProducts.reduce((sum, l) => sum + l.amount, 0),
        );
        variations.push({
          ...invoice,
          products: newProducts,
          total_amount: newTotal,
        });
      }

      for (const r of rateOptions) {
        const newProducts = invoice.products.map((line) =>
          line.product_id === p.product_id
            ? { ...line, rate: r, amount: computeLineAmount(line.quantity, r) }
            : line,
        );
        const newTotal = roundMoney(
          newProducts.reduce((sum, l) => sum + l.amount, 0),
        );
        variations.push({
          ...invoice,
          products: newProducts,
          total_amount: newTotal,
        });
      }
    }

    return variations;
  }
}
