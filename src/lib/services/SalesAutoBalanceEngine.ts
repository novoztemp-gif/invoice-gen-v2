import { SupabaseClient } from "@supabase/supabase-js";
import {
  SalesAuditRecord,
  SalesBalancePersistence,
} from "./sales-balance/SalesBalancePersistence";
import { SalesCandidateSolver } from "./sales-balance/SalesCandidateSolver";
import { SalesFinalValidator } from "./sales-balance/SalesFinalValidator";
import { SalesInvoiceValidator } from "./sales-balance/SalesInvoiceValidator";
import { diffEditedProductIds } from "./sales-balance/SalesLineCapacity";
import { SalesNewInvoiceCreator } from "./sales-balance/SalesNewInvoiceCreator";
import { SalesResidualRepair } from "./sales-balance/SalesResidualRepair";
import {
  roundMoney,
  SalesBalanceContext,
  SalesInvoiceUpdate,
  SalesSolverPlan,
} from "./sales-balance/types";
import { roundToQuarterIncrement } from "@/lib/utils/quantity-rate-utils";

export class SalesAutoBalanceEngine {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Executes the 17-step Sales Atomic Transaction workflow:
   * 1. Receive Edit Request
   * 2. Acquire exclusive lock on Sales Batch
   * 3. Load current Sales Batch
   * 4. Load all Sales Invoices
   * 5. Load Product Totals
   * 6. Load Available Stock
   * 7. Validate Edited Invoice
   * 8. Run Sales Product Redistribution
   * 9. Validate Balancing Invoices
   * 10. Validate Entire Batch
   * 11. Validate Product Totals
   * 12. Validate Batch Total Amount
   * 13. Validate Stock Availability
   * 14. Persist Edited Invoice
   * 15. Persist Balancing Invoice Updates
   * 16. Verify persisted data
   * 17. Commit Transaction & Audit Log
   */
  public async saveEditedInvoiceAndBalance(
    batchId: string,
    editedInvoiceId: string,
    updates: SalesInvoiceUpdate,
    userId: string,
  ): Promise<{
    success: boolean;
    modifiedInvoicesCount: number;
    message: string;
    auditRecord?: SalesAuditRecord;
    impactSummary?: any;
  }> {
    // STEP 1 & STEP 2: Receive Edit Request & Acquire exclusive concurrency lock on Sales Batch
    const lockAcquired = await this.acquireBatchLock(batchId);
    if (!lockAcquired) {
      throw new Error(
        "Concurrent Edit Detected: Sales Batch is currently being edited. Please try again.",
      );
    }

    try {
      // STEP 3, 4, 5, 6: Load Sales Batch, Sales Invoices, Product Totals, & Available Stock
      const context = await SalesInvoiceValidator.loadContext(
        this.supabase,
        batchId,
      );

      // STEP 7: Validate Edited Invoice
      const normalisedEdited = SalesInvoiceValidator.normaliseEditedInvoice(
        context,
        editedInvoiceId,
        updates,
      );
      const originalEditedForValidation = context.invoices.find(
        (i) => i.id === editedInvoiceId,
      );
      const editedValidation = SalesInvoiceValidator.validateInvoice(
        normalisedEdited,
        undefined,
        originalEditedForValidation,
      );
      if (!editedValidation.valid) {
        throw new Error(
          `Invoice Validation Failed: ${editedValidation.message}`,
        );
      }

      // STEP 8: Run Sales Product Redistribution
      const solverResult = SalesCandidateSolver.solveBatchBalance(
        context,
        normalisedEdited,
      );

      console.log("[SalesAutoBalanceEngine] BEFORE LINE 82 - solverResult:", {
        outcome: solverResult.outcome,
        message: solverResult.message,
        planExists: !!solverResult.plan,
        batchDelta: solverResult.plan?.batchDelta,
        productDeltas: solverResult.plan
          ? Object.fromEntries(solverResult.plan.productDeltas.entries())
          : null,
      });

      if (solverResult.outcome !== "solution_found" || !solverResult.plan) {
        throw new Error(
          `Sales Product Redistribution Failed: ${solverResult.message || solverResult.outcome}`,
        );
      }

      let finalPlan = solverResult.plan;
      if (
        finalPlan.batchDelta !== 0 ||
        Array.from(finalPlan.productDeltas.values()).some((d) => d !== 0)
      ) {
        console.log(
          "[SalesAutoBalanceEngine] BEFORE CALLING SalesResidualRepair - finalPlan:",
          {
            batchDelta: finalPlan.batchDelta,
            productDeltas: Object.fromEntries(
              finalPlan.productDeltas.entries(),
            ),
            editedInvoiceTotal: finalPlan.editedInvoice.total_amount,
            balancingInvoicesCount: finalPlan.balancingInvoices.length,
          },
        );

        const repaired = SalesResidualRepair.repairResidual(context, finalPlan);

        console.log(
          "[SalesAutoBalanceEngine] AFTER repairResidual - repaired:",
          {
            repairedSuccess: !!repaired,
            "repaired.batchDelta": repaired?.batchDelta,
            "repaired.productDeltas": repaired
              ? Object.fromEntries(repaired.productDeltas.entries())
              : null,
          },
        );

        if (!repaired) {
          // No balancing invoices existed at all to repair against — the
          // edited product's surplus has nowhere to go except a brand-new
          // invoice. Build a minimal plan directly from the solver's
          // output and let the new-invoice fallback below handle it.
          finalPlan = {
            ...finalPlan,
            balancingInvoices: [],
          };
        } else {
          finalPlan = repaired;
        }
      }

      // Only the products actually edited need checking — every other
      // product is locked to its original quantity throughout the whole
      // pipeline, so it's trivially conserved.
      const editedProductIds = diffEditedProductIds(
        originalEditedForValidation?.products,
        normalisedEdited.products,
      );

      // finalPlan.balancingInvoices is only the small subset of the batch
      // holding an edited product — every other invoice in the batch is
      // untouched, so what the edited invoice + this subset must sum to is
      // whatever they ORIGINALLY summed to, not the whole batch total.
      const originalEditedTotal = originalEditedForValidation
        ? originalEditedForValidation.total_amount
        : 0;
      const originalSubsetTotal = finalPlan.balancingInvoices.reduce(
        (sum, inv) => {
          const orig = context.invoices.find((i) => i.id === inv.id);
          return sum + (orig ? orig.total_amount : 0);
        },
        0,
      );
      const requiredCombinedTotal = originalEditedTotal + originalSubsetTotal;

      // Recompute the TRUE remaining per-product/batch delta from
      // finalPlan's actual resulting invoice quantities against the
      // original totals — repairResidual reports productDeltas as all-zero
      // regardless of whether it actually closed them, so that field can't
      // be trusted here as the failure signal.
      const closeQty = (pid: string): number => {
        let qty =
          finalPlan.editedInvoice.products.find((p) => p.product_id === pid)
            ?.quantity || 0;
        for (const inv of finalPlan.balancingInvoices) {
          qty += inv.products.find((p) => p.product_id === pid)?.quantity || 0;
        }
        return qty;
      };
      const trueProductDeltas = new Map<string, number>();
      for (const pid of editedProductIds) {
        const targetQty = context.originalProductTotals.get(pid) || 0;
        trueProductDeltas.set(
          pid,
          roundToQuarterIncrement(targetQty - closeQty(pid)),
        );
      }
      const trueCurrentTotal = roundMoney(
        finalPlan.editedInvoice.total_amount +
          finalPlan.balancingInvoices.reduce(
            (sum, inv) => sum + inv.total_amount,
            0,
          ),
      );
      const trueBatchDelta = roundMoney(
        requiredCombinedTotal - trueCurrentTotal,
      );

      console.log("[SalesAutoBalanceEngine] TRUE residual after repair:", {
        trueBatchDelta,
        trueProductDeltas: Object.fromEntries(
          Array.from(trueProductDeltas.entries()).filter(
            ([, d]) => Math.abs(d) > 0.001,
          ),
        ),
      });

      if (
        Math.abs(trueBatchDelta) > 0.001 ||
        Array.from(trueProductDeltas.values()).some((d) => Math.abs(d) > 0.001)
      ) {
        const { newInvoices, remainingProductDeltas, blockedReasons } =
          await SalesNewInvoiceCreator.createInvoicesForShortfall(
            this.supabase,
            context,
            {
              ...finalPlan,
              batchDelta: trueBatchDelta,
              productDeltas: trueProductDeltas,
            },
          );

        const stillShort =
          newInvoices.length === 0 ||
          Array.from(remainingProductDeltas.values()).some(
            (d) => Math.abs(d) > 0.001,
          );

        console.log("[SalesAutoBalanceEngine] createInvoicesForShortfall result:", {
          newInvoicesCount: newInvoices.length,
          remainingProductDeltas: Object.fromEntries(
            Array.from(remainingProductDeltas.entries()).filter(
              ([, d]) => Math.abs(d) > 0.001,
            ),
          ),
          blockedReasons: Object.fromEntries(
            Array.from(blockedReasons.entries()).map(([pid, reasons]) => [
              pid,
              Array.from(reasons),
            ]),
          ),
          stillShort,
        });

        if (stillShort && newInvoices.length === 0) {
          // Build a real, specific reason instead of a generic message —
          // which product(s) couldn't be placed, how much, and exactly why
          // (out of stock room, over the invoice cap, etc.) for every
          // product this run genuinely couldn't close, so the user can tell
          // whether this is a real data/capacity limit versus a code gap.
          const productName = (pid: string) =>
            context.invoices
              .flatMap((inv) => inv.products)
              .find((p) => p.product_id === pid)?.product_name || pid;
          const parts: string[] = [];
          for (const [pid, delta] of remainingProductDeltas.entries()) {
            if (Math.abs(delta) <= 0.001) continue;
            const reasons = blockedReasons.get(pid);
            const reasonText =
              reasons && reasons.size > 0
                ? Array.from(reasons).join("; ")
                : "no eligible invoice/date/customer combination found";
            parts.push(
              `${delta > 0 ? "+" : ""}${delta} KG of ${productName(pid)} could not be placed (${reasonText})`,
            );
          }
          const detail =
            parts.length > 0
              ? parts.join(". ")
              : `remaining batch amount residual of ₹${trueBatchDelta}`;
          throw new Error(
            `Residual Repair Failed: ${detail}.`,
          );
        }

        finalPlan = { ...finalPlan, newInvoices };

        // A brand-new invoice holds real, additional money (its own
        // quantity × rate) that nothing accounted for yet — the residual
        // closed inside repairResidual only knew about the invoices that
        // existed at that point. Close whatever's left now that the new
        // invoice(s) are folded into the total, over the combined set
        // (balancing + new), same shared nudge used everywhere else.
        const combinedRealTotal = roundMoney(
          finalPlan.editedInvoice.total_amount +
            finalPlan.balancingInvoices.reduce(
              (sum, inv) => sum + inv.total_amount,
              0,
            ) +
            (finalPlan.newInvoices || []).reduce(
              (sum, inv) => sum + inv.total_amount,
              0,
            ),
        );
        const finalResidual = roundMoney(
          requiredCombinedTotal - combinedRealTotal,
        );
        if (Math.abs(finalResidual) > 0.001) {
          const combinedInvoices = [
            ...finalPlan.balancingInvoices,
            ...(finalPlan.newInvoices || []),
          ];
          SalesResidualRepair.closeAmountResidual(
            combinedInvoices,
            editedProductIds,
            context,
            finalResidual,
          );
        }
      }

      // STEP 9, 10, 11, 12, 13: Validate Balancing Invoices, Entire Batch, Product Totals, Batch Total, & Stock Availability
      const finalValidation = SalesFinalValidator.validateRebalancedBatch(
        context,
        finalPlan,
      );
      if (!finalValidation.valid) {
        throw new Error(
          `Batch Validation Failed: ${(finalValidation.errors || []).join("; ")}`,
        );
      }

      // STEP 14, 15, 16, 17: Persist Edited Invoice, Persist Balancing Invoices, Verify Persisted Data, Commit Transaction & Audit Log
      const persistence = new SalesBalancePersistence(this.supabase);
      const result = await persistence.persistBalancePlan(
        batchId,
        editedInvoiceId,
        finalPlan,
        context.originalProductTotals,
      );

      const impactSummary = this.buildImpactSummary(
        context,
        editedInvoiceId,
        finalPlan,
      );

      return { ...result, impactSummary };
    } catch (err: any) {
      // Transaction Abort & Rollback Handling
      throw new Error(err.message || "Sales Atomic Transaction Failed.");
    } finally {
      await this.releaseBatchLock(batchId);
    }
  }

  /**
   * Builds a summary of exactly which invoices were touched by the
   * rebalance and what changed in them, mirroring the purchase-side
   * impactSummary (AutoBalanceEngine.ts).
   */
  private buildImpactSummary(
    context: SalesBalanceContext,
    editedInvoiceId: string,
    finalPlan: SalesSolverPlan,
  ) {
    const originalEditedInv = context.invoices.find(
      (i) => i.id === editedInvoiceId,
    );
    const updatedEditedInv = finalPlan.editedInvoice;

    const origEditedQty = (originalEditedInv?.products || []).reduce(
      (sum, p) => sum + Number(p.quantity || 0),
      0,
    );
    const updatedEditedQty = (updatedEditedInv.products || []).reduce(
      (sum, p) => sum + Number(p.quantity || 0),
      0,
    );

    const rebalancedInvoices = finalPlan.balancingInvoices.map((inv) => {
      const orig = context.invoices.find((i) => i.id === inv.id);
      const prevTotal = orig ? orig.total_amount : 0;
      const diff = Math.round((inv.total_amount - prevTotal) * 100) / 100;
      return {
        id: inv.id,
        invoice_number: inv.invoice_number,
        party: "",
        previous_total: prevTotal,
        updated_total: inv.total_amount,
        amount_difference: diff,
      };
    });

    const allAffectedInvoices = [
      updatedEditedInv,
      ...finalPlan.balancingInvoices,
    ];
    const productQuantityChanges: Array<{
      invoice_id: string;
      invoice_number: string;
      product_id: string;
      product_name: string;
      previous_quantity: number;
      updated_quantity: number;
      difference: number;
    }> = [];

    let totalQuantityAdjusted = 0;
    let totalAmountAdjusted = 0;

    for (const affectedInv of allAffectedInvoices) {
      const origInv = context.invoices.find((i) => i.id === affectedInv.id);
      // A product can legitimately appear more than once on the same
      // invoice (e.g. two lines for the same product under different
      // customers) — matching "the original line" by product_id alone
      // would collapse duplicates down to just the last one, comparing an
      // untouched duplicate line against the wrong original and reporting
      // a fake change. Match by occurrence order instead, same fix as
      // SalesFinalValidator/SalesInvoiceValidator use for this batch.
      const occurrenceSeen = new Map<string, number>();

      for (const line of affectedInv.products || []) {
        const occIdx = occurrenceSeen.get(line.product_id) || 0;
        occurrenceSeen.set(line.product_id, occIdx + 1);
        const origLine = (origInv?.products || []).filter(
          (p) => p.product_id === line.product_id,
        )[occIdx];
        const prevQty = origLine ? Number(origLine.quantity || 0) : 0;
        const newQty = Number(line.quantity || 0);
        const qtyDiff = Math.round((newQty - prevQty) * 100) / 100;

        if (Math.abs(qtyDiff) > 0.001) {
          totalQuantityAdjusted += Math.abs(qtyDiff);
          productQuantityChanges.push({
            invoice_id: affectedInv.id,
            invoice_number: affectedInv.invoice_number,
            product_id: line.product_id,
            product_name: line.product_name || "Product",
            previous_quantity: prevQty,
            updated_quantity: newQty,
            difference: qtyDiff,
          });
        }
      }
    }

    for (const rebal of rebalancedInvoices) {
      totalAmountAdjusted += Math.abs(rebal.amount_difference);
    }

    return {
      editedInvoice: {
        id: updatedEditedInv.id,
        invoice_number: updatedEditedInv.invoice_number,
        party: "",
        original_total: originalEditedInv?.total_amount || 0,
        updated_total: updatedEditedInv.total_amount,
        original_quantity: Math.round(origEditedQty * 100) / 100,
        updated_quantity: Math.round(updatedEditedQty * 100) / 100,
      },
      rebalancedInvoices,
      productQuantityChanges,
      batchSummary: {
        invoices_rebalanced_count: finalPlan.balancingInvoices.length,
        total_quantity_adjusted: Math.round(totalQuantityAdjusted * 100) / 100,
        total_amount_adjusted: Math.round(totalAmountAdjusted * 100) / 100,
      },
    };
  }

  // If a process crashes mid-balance (e.g. OOM) the `finally` block that
  // releases the lock never runs, leaving is_balancing stuck true forever.
  // Treat locks older than this as abandoned and allow them to be stolen.
  private static readonly LOCK_TIMEOUT_MS = 3 * 60 * 1000;

  private async acquireBatchLock(batchId: string): Promise<boolean> {
    const staleCutoff = new Date(
      Date.now() - SalesAutoBalanceEngine.LOCK_TIMEOUT_MS,
    ).toISOString();

    const { data, error } = await this.supabase
      .from("invoice_batch")
      .update({
        is_balancing: true,
        balancing_locked_at: new Date().toISOString(),
      })
      .eq("id", batchId)
      .or(`is_balancing.eq.false,balancing_locked_at.lt.${staleCutoff}`)
      .select("id");

    if (error || !data || data.length === 0) {
      return false;
    }
    return true;
  }

  private async releaseBatchLock(batchId: string): Promise<void> {
    await this.supabase
      .from("invoice_batch")
      .update({ is_balancing: false, balancing_locked_at: null })
      .eq("id", batchId);
  }
}
